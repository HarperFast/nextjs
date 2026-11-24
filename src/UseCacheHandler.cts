import type { CacheEntry, CacheHandler, Timestamp } from 'next/dist/server/lib/cache-handlers/types.d.ts';

import type { databases as DatabasesType } from 'harper';

import {
	entryExpiresAt,
	initializeInvalidationSubscription,
	passedExpiration,
	recordInvalidation,
	tagState,
	toStoredLife,
} from './cacheInvalidation.cjs';
import { toStorageKey } from './storageKey.cjs';

export { toStorageKey };

const DATABASE = 'harperfast_nextjs';
const TABLE = 'nextjs_use_cache';

interface StoredEntry {
	value: unknown;
	tags?: string[];
	timestamp?: number;
	stale?: number;
	revalidate?: number;
	expire?: number;
}

interface UseCacheTable {
	get(key: string): Promise<StoredEntry | undefined>;
	put(key: string, value: Record<string, unknown>, context?: { expiresAt: number }): Promise<unknown> | unknown;
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
 * A fresh stream over the stored value, or undefined when it cannot be read. Harper returns a Blob for
 * a Blob column, which is streamed straight from storage rather than read whole: `arrayBuffer()` would
 * buffer the file and copy it. The first chunk is pulled before returning so a missing or unreadable
 * blob still degrades to a cache MISS; `get` has no surrounding try, so a rejection here would surface
 * as a request error instead. Unit tests and older rows may hold raw bytes.
 */
async function openValue(value: unknown): Promise<ReadableStream<Uint8Array> | undefined> {
	if (value === undefined || value === null) return undefined;
	if (value instanceof Uint8Array) return streamOf(value);
	const blob = value as { stream?: () => ReadableStream<Uint8Array>; arrayBuffer?: () => Promise<ArrayBuffer> };
	if (typeof blob.stream === 'function') {
		const reader = blob.stream().getReader();
		let first: ReadableStreamReadResult<Uint8Array>;
		try {
			first = await reader.read();
		} catch {
			return undefined;
		}
		return new ReadableStream<Uint8Array>({
			start(controller) {
				if (first.done) controller.close();
				else controller.enqueue(first.value);
			},
			async pull(controller) {
				const { done, value: chunk } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(chunk);
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		});
	}
	if (typeof blob.arrayBuffer === 'function') {
		try {
			return streamOf(new Uint8Array(await blob.arrayBuffer()));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Next derives entry timestamps from `performance.timeOrigin + performance.now()`, which is
 * fractional. Harper rejects a non-integer for a Long column, so an uncoerced write is refused
 * outright — and, being caught, looks like a working cache that simply never stored anything. Cache
 * lives go through `toStoredLife`, which also bounds them.
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
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

class HarperUseCacheHandler implements CacheHandler {
	/**
	 * Soft (implicit route) tags are left to Next, which compares them against `getExpiration`; the entry
	 * does not carry them, so there is nothing more to check here.
	 */
	async get(cacheKey: string, _softTags: string[]): Promise<CacheEntry | undefined> {
		const table = getTable();
		if (!table) return undefined;
		// A worker that has not read the tombstones back cannot tell an invalidated entry from a fresh one.
		if (!(await initializeInvalidationSubscription())) return undefined;

		// An in-flight set for this key must be awaited rather than reported as a miss. Its failure is the
		// set's to report; the read falls through to whatever is stored.
		const pending = pendingEntries.get(cacheKey);
		if (pending) await pending.catch(() => undefined);

		const record = await table.get(toStorageKey(cacheKey));
		if (!record) return undefined;

		const now = Date.now();
		const timestamp = record.timestamp ?? 0;
		const expire = record.expire ?? 0;
		const tags = record.tags ?? [];

		// Decided before touching the blob, so an unusable entry costs no read.
		if (expire > 0 && timestamp + expire * 1000 < now) return undefined;
		const state = tagState(tags, timestamp, now);
		if (state === 'expired') return undefined;

		const value = await openValue(record.value);
		if (!value) return undefined;

		return {
			value,
			tags,
			stale: record.stale ?? 0,
			timestamp,
			expire,
			// Next's own handler signals a tag-stale entry this way: serve it, and regenerate in the background.
			revalidate: state === 'stale' ? -1 : (record.revalidate ?? 0),
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

			const storageKey = toStorageKey(cacheKey);
			const timestamp = toInteger(entry.timestamp) ?? Date.now();
			const expire = toStoredLife(entry.expire);
			// The raw `expire`, not the stored one: `toStoredLife` bounds an unbounded life to a year to fit
			// the Int column, and `entryExpiresAt` has to be able to tell that apart from a deliberate year.
			const expiresAt = entryExpiresAt(timestamp, entry.expire);
			await table.put(
				storageKey,
				{
					// The untruncated key, only for a row whose id had to be shortened. Not indexed.
					...(storageKey === cacheKey ? {} : { cacheKey }),
					value: toStoredValue(bytes),
					tags: entry.tags ?? [],
					timestamp,
					stale: toStoredLife(entry.stale),
					revalidate: toStoredLife(entry.revalidate),
					expire,
				},
				expiresAt === undefined ? undefined : { expiresAt }
			);

			return bytes;
		})();

		pendingEntries.set(cacheKey, work);

		try {
			await work;
		} catch (error) {
			// The storage key: the full one is unbounded, and has been seen at 87KB.
			getLogger().error(`[UseCacheHandler] failed to store "${toStorageKey(cacheKey)}"`, error);
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

	/** Newest expiration across the tags that has already passed, or 0 if there is none. */
	async getExpiration(tags: string[]): Promise<Timestamp> {
		return passedExpiration(tags);
	}

	async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
		await recordInvalidation(tags, durations);
	}
}

export default new HarperUseCacheHandler();
