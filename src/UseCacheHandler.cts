import { createHash } from 'node:crypto';
import type { CacheEntry, CacheHandler, Timestamp } from 'next/dist/server/lib/cache-handlers/types.d.ts';

import type { databases as DatabasesType } from 'harper';

import { cacheInvalidations, initializeInvalidationSubscription, recordInvalidation } from './cacheInvalidation.cjs';

const DATABASE = 'harperfast_nextjs';
const TABLE = 'nextjs_use_cache';

interface StoredEntry {
	value: unknown;
	tags?: string[];
	timestamp?: number;
	stale?: number;
	revalidate?: number;
	expire?: number;
	invalidatedAt?: number;
}

interface UseCacheTable {
	get(key: string): Promise<StoredEntry | undefined>;
	put(key: string, value: Record<string, unknown>): Promise<unknown> | unknown;
}

/**
 * Cache keys whose `set` is still in flight. The interface requires a `get` arriving before a pending
 * entry completes to wait for it rather than report a miss, so entries are registered here
 * synchronously — before the first `await` in `set`.
 */
const pendingEntries = new Map<string, Promise<Buffer | undefined>>();

function getDatabases(): typeof DatabasesType | undefined {
	return (globalThis as { databases?: typeof DatabasesType }).databases;
}

let missingTableReported = false;

/**
 * The table, or undefined when the Harper globals are not reachable from this module's context. A
 * silent undefined here turns every write into a no-op that looks like a working cache, so the first
 * occurrence is logged.
 */
function getTable(): UseCacheTable | undefined {
	const databases = getDatabases();
	const table = databases
		? (databases as unknown as Record<string, Record<string, UseCacheTable>>)[DATABASE]?.[TABLE]
		: undefined;

	if (!table && !missingTableReported) {
		missingTableReported = true;
		getLogger().error(
			`[UseCacheHandler] ${DATABASE}.${TABLE} is unreachable (databases global ${databases ? 'present' : 'missing'}); "use cache" entries are not being persisted`
		);
	}

	return table;
}

function getLogger(): { error(...args: unknown[]): void; info?(...args: unknown[]): void } {
	return (globalThis as { logger?: { error(...args: unknown[]): void; info?(...args: unknown[]): void } }).logger ?? console;
}

/** Drain the entry's stream. Returns undefined if it errors, so a partial render is never cached. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(Buffer.from(value));
		}
	} catch {
		return undefined;
	}
	return Buffer.concat(chunks);
}

/**
 * Harper's primary key limit is MAX_KEY_BYTES = 1978 (harper/resources/Table.ts:146).
 * Next imposes NO size limit on a "use cache" key — it is composed from the cached
 * component's serializable props, so a component handed a large prop produces a
 * correspondingly large key. Observed in the wild at 87,465 bytes, which Harper
 * rejects with `Primary key size is too large`. The rejection surfaces as a rejected
 * cache boundary, which aborts the streamed subtree: a dead page with nothing in the
 * server log, because the error is a Next streaming rejection rather than a Harper one.
 *
 * Oversized keys are truncated and suffixed with a hash of the FULL key. Short keys are
 * passed through untouched, deliberately: hashing unconditionally would change every
 * key and silently invalidate the whole cache on upgrade, and it would throw away a
 * readable id for no benefit.
 *
 * Budgeted well under 1978 rather than up to it — Harper's check serializes the key, and
 * the encoded form can exceed the raw byte count.
 */
const MAX_KEY_BYTES = 1500;
const KEY_HASH_BYTES = 16;
/** Cannot occur in a Next cache key, so a short key can never collide with a truncated one. */
const KEY_HASH_SEPARATOR = '\u0000#';

export function toStorageKey(cacheKey: string): string {
	if (Buffer.byteLength(cacheKey, 'utf8') <= MAX_KEY_BYTES) return cacheKey;

	const digest = createHash('sha256').update(cacheKey, 'utf8').digest('hex').slice(0, KEY_HASH_BYTES);
	const budget = MAX_KEY_BYTES - Buffer.byteLength(KEY_HASH_SEPARATOR, 'utf8') - digest.length;

	// Truncate by BYTES on a character boundary. Slicing by .length would overshoot on
	// multi-byte input, and slicing mid-codepoint could re-encode differently on another
	// node — two nodes must derive the same key for the same entry.
	const truncated = Buffer.from(cacheKey, 'utf8').subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '');

	return `${truncated}${KEY_HASH_SEPARATOR}${digest}`;
}

/** Harper returns a Blob for a Blob column; unit tests and older rows may hold raw bytes. */
async function toBuffer(value: unknown): Promise<Buffer | undefined> {
	if (value === undefined || value === null) return undefined;
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	const blob = value as { arrayBuffer?: () => Promise<ArrayBuffer> };
	if (typeof blob.arrayBuffer === 'function') {
		// A rejecting arrayBuffer() (corrupt row, read error) must degrade to a cache MISS. `get` has no
		// surrounding try, so an unhandled rejection here would surface as a request error instead.
		try {
			return Buffer.from(await blob.arrayBuffer());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Next derives entry timestamps from `performance.timeOrigin + performance.now()`, which is
 * fractional, and cache lives can arrive fractional too. Harper rejects a non-integer for a Long/Int
 * column, so an uncoerced write is refused outright — and, being caught, looks like a working cache
 * that simply never stored anything.
 */
function toInteger(value: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function toStoredValue(bytes: Buffer): unknown {
	const createBlob = (globalThis as { createBlob?: (input: Buffer) => unknown }).createBlob;
	return typeof createBlob === 'function' ? createBlob(bytes) : bytes;
}

/**
 * A ReadableStream is single-use, so every read builds a new one over the stored bytes. Returning a
 * shared stream would serve the first reader and hand every later one an empty body.
 */
function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(bytes));
			controller.close();
		},
	});
}

function newestInvalidation(tags: string[]): number {
	let newest = 0;
	for (const tag of tags) {
		const invalidatedAt = cacheInvalidations.get(tag);
		if (invalidatedAt !== undefined && invalidatedAt > newest) newest = invalidatedAt;
	}
	return newest;
}

class HarperUseCacheHandler implements CacheHandler {
	async get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined> {
		const table = getTable();
		if (!table) return undefined;

		// An in-flight set for this key must be awaited rather than reported as a miss.
		const pending = pendingEntries.get(cacheKey);
		if (pending) await pending;

		const record = await table.get(toStorageKey(cacheKey));
		if (!record) return undefined;

		const bytes = await toBuffer(record.value);
		if (!bytes) return undefined;

		const now = Date.now();
		const timestamp = record.timestamp ?? 0;
		const expire = record.expire ?? 0;
		const revalidate = record.revalidate ?? 0;

		if (expire > 0 && timestamp + expire * 1000 < now) return undefined;

		// Hard tags live on the record; soft tags are handled by getExpiration, which reports the
		// invalidation timestamp for Next to compare itself. `invalidatedAt` is the sweep's own marker,
		// which outlives the tombstone it was derived from.
		const invalidatedAt = Math.max(newestInvalidation(record.tags ?? []), record.invalidatedAt ?? 0);

		let effectiveTimestamp = timestamp;
		if (invalidatedAt > timestamp) {
			// Backdate past the revalidate window so Next regenerates, while staying inside expire so the
			// entry is still served meanwhile. A miss here would cost a full render, which is exactly what
			// an invalidation storm must not produce.
			// Math.min: an entry already older than the revalidate window must not be forward-dated to
			// staleAt, which would extend how long Next keeps serving it stale.
			const staleAt = Math.min(timestamp, now - revalidate * 1000 - 1);
			if (expire > 0 && staleAt + expire * 1000 <= now) return undefined;
			effectiveTimestamp = staleAt;
		}

		return {
			value: streamOf(bytes),
			tags: record.tags ?? [],
			stale: record.stale ?? 0,
			timestamp: effectiveTimestamp,
			expire,
			revalidate,
		};
	}

	async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
		const table = getTable();
		if (!table) return;

		// Registered before the first await so a concurrent get observes it.
		const work = (async (): Promise<Buffer | undefined> => {
			const entry = await pendingEntry;
			const bytes = await drain(entry.value);
			if (!bytes) return undefined;

			await table.put(toStorageKey(cacheKey), {
				// The untruncated key, for identifying a row whose id was hashed. Not indexed.
				cacheKey,
				value: toStoredValue(bytes),
				tags: entry.tags ?? [],
				timestamp: toInteger(entry.timestamp) ?? Date.now(),
				stale: toInteger(entry.stale),
				revalidate: toInteger(entry.revalidate),
				expire: toInteger(entry.expire),
			});

			return bytes;
		})();

		pendingEntries.set(cacheKey, work);

		try {
			await work;
		} catch (error) {
			getLogger().error(`[UseCacheHandler] failed to store "${cacheKey}"`, error);
		} finally {
			if (pendingEntries.get(cacheKey) === work) pendingEntries.delete(cacheKey);
		}
	}

	/**
	 * A no-op beyond ensuring the subscription is live. The interface expects handlers to poll a tags
	 * service here; Harper replicates invalidations and pushes them to every worker instead, so the map
	 * this consults is already current.
	 */
	async refreshTags(): Promise<void> {
		await initializeInvalidationSubscription();
	}

	/** Newest invalidation across the tags, or 0 if none were ever invalidated. */
	async getExpiration(tags: string[]): Promise<Timestamp> {
		return newestInvalidation(tags);
	}

	async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
		await recordInvalidation(tags, durations);
	}
}

export default new HarperUseCacheHandler();
