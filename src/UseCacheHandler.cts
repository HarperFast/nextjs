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

/** Harper returns a Blob for a Blob column; unit tests and older rows may hold raw bytes. */
async function toBuffer(value: unknown): Promise<Buffer | undefined> {
	if (value === undefined || value === null) return undefined;
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	const blob = value as { arrayBuffer?: () => Promise<ArrayBuffer> };
	if (typeof blob.arrayBuffer === 'function') return Buffer.from(await blob.arrayBuffer());
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

		const record = await table.get(cacheKey);
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
			const staleAt = now - revalidate * 1000 - 1;
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

			await table.put(cacheKey, {
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
