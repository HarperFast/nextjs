import type { databases as DatabasesType } from 'harper';

/**
 * Next.js prefixes the implicit route/layout tags it attaches to every APP_PAGE and APP_ROUTE entry.
 * A tag like `_N_T_/layout` is carried by every page in the app, so sweeping one would scan and rewrite
 * the entire cache. Those are left to TTL; only explicit user tags are swept.
 */
export const NEXT_IMPLICIT_TAG_PREFIX = '_N_T_';

const DATABASE = 'harperfast_nextjs';
const ISR_TABLE = 'nextjs_isr_cache';
const USE_CACHE_TABLE = 'nextjs_use_cache';
const INVALIDATION_TABLE = 'nextjs_cache_invalidation';

// Throttling for the background sweep. Chunks bound transaction length — a single long-running
// transaction is a documented Harper failure mode ("Transaction was open too long") — while the
// concurrency limit bounds how much of a worker the sweep can take.
const INVALIDATE_CONCURRENCY = 10;
const INVALIDATE_CHUNK_SIZE = 100;
const CHUNK_PAUSE_MAX_MS = 100;

// Backpressure: above this many outstanding invalidation rows the sweep is shed. Soft invalidation still
// covers reads, so shedding costs cache-hit rate, never correctness.
const MAX_PENDING_INVALIDATIONS = 75_000;

/**
 * The background sweep is off by default. It works — tests cover the throttling, the race guard and the
 * scope limits — but it does not yet coexist with Next.js's staleness model, and both failure modes are
 * silent:
 *
 * - Harper's `invalidate()` on a table with no `sourcedFrom` leaves the record awaiting a refresh that
 *   never arrives, so every later read of that key blocks.
 * - Writing a marker with `patch` instead bumps `lastModified` (`@updatedTime`), which makes the entry
 *   look *newer* than the invalidation to Next's own `areTagsStale`. Next then treats it as fresh and
 *   never regenerates, so the entry is served stale indefinitely.
 *
 * Marking an entry stale without disturbing the timestamp Next derives staleness from needs a primitive
 * this schema does not have yet. Until then the tombstone remains the invalidation, which is the
 * behaviour that shipped previously and is covered by the existing tests; the 7-day expiry bounds table
 * growth on its own.
 */
const SWEEP_ENABLED = process.env.HARPER_NEXTJS_EXPERIMENTAL_SWEEP === 'true';

/** Tag → invalidation timestamp (ms). Shared by every cache handler in the worker. */
export const cacheInvalidations = new Map<string, number>();

interface CacheRecord {
	id: string;
}

interface SweepableTable {
	search(request: {
		conditions: Array<{ attribute: string; comparator: string; value: unknown }>;
		select?: string[];
	}): AsyncIterable<CacheRecord>;
	patch(id: string, value: { invalidatedAt: number }): Promise<unknown> | unknown;
}

interface InvalidationTable {
	put(key: string, value: { timestamp: number }): Promise<unknown> | unknown;
	delete(key: string): Promise<unknown> | unknown;
	getRecordCount?(): Promise<{ recordCount: number }>;
}

export interface InvalidationDeps {
	databases?: typeof DatabasesType;
	sleep?: (ms: number) => Promise<void>;
	logger?: { info(...args: unknown[]): void; error(...args: unknown[]): void };
	/** Runs the background sweep. Defaults to fire-and-forget; tests substitute a collector. */
	scheduleSweep?: (task: () => Promise<void>) => void;
}

/**
 * `databases` is a Harper-provided global, read lazily so that loading this module from a non-Harper
 * context (a bundler resolving the cache-handler path) does not pull in the harper runtime.
 */
function getDatabases(deps: InvalidationDeps): typeof DatabasesType | undefined {
	return deps.databases ?? (globalThis as { databases?: typeof DatabasesType }).databases;
}

function getLogger(deps: InvalidationDeps) {
	return deps.logger ?? (globalThis as { logger?: InvalidationDeps['logger'] }).logger ?? console;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitter(maxMs: number): number {
	return Math.floor(Math.random() * maxMs);
}

export function chunk<T>(items: T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		batches.push(items.slice(index, index + size));
	}
	return batches;
}

export async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<void>
): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const item = items[cursor++];
			await task(item);
		}
	});
	await Promise.all(workers);
}

/** Only explicit user tags are swept; see NEXT_IMPLICIT_TAG_PREFIX. */
export function isSweepableTag(tag: string): boolean {

	return !tag.startsWith(NEXT_IMPLICIT_TAG_PREFIX);
}

/**
 * `markedInvalidAt` is the record's own `invalidatedAt`, written by the sweep. It has to be consulted
 * separately because the sweep's write bumps `lastModified`, which would otherwise make the tag
 * timestamps below stop matching — and because the tombstone is dropped once the sweep finishes, so
 * after that the record's own marker is the only remaining evidence.
 */
export function isInvalidated(
	recordTags: string[],
	lastModified: number,
	revalidatedTags: string[],
	ctxTags: string[],
	markedInvalidAt?: number
): boolean {
	if (typeof markedInvalidAt === 'number' && markedInvalidAt > 0) return true;

	const allTags = recordTags.length > 0 ? recordTags : ctxTags;
	for (const tag of allTags) {
		if (revalidatedTags.includes(tag)) return true;
		const invalidatedAt = cacheInvalidations.get(tag);
		if (invalidatedAt !== undefined && invalidatedAt > lastModified) return true;
	}
	return false;
}

/**
 * Mirror an invalidation into Next's own tags manifest so Next classifies affected APP_PAGE/APP_ROUTE
 * entries as *stale* (serve the cached response, regenerate in the background) rather than missing.
 * Without this the handler's only way to signal invalidation is returning null, which Next reads as a
 * miss and turns into a blocking render — the behaviour we specifically want to avoid under load.
 */
function mirrorToNextTagsManifest(tags: string[], timestamp: number, deps: InvalidationDeps): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { tagsManifest } = require('next/dist/server/lib/incremental-cache/tags-manifest.external.js') as {
			tagsManifest: Map<string, { stale?: number; expired?: number }>;
		};
		for (const tag of tags) {
			const entry = tagsManifest.get(tag) ?? {};
			entry.stale = timestamp;
			tagsManifest.set(tag, entry);
		}
	} catch (error) {
		getLogger(deps).error('[CacheHandler] could not mirror invalidation into the Next tags manifest', error);
	}
}

let subscriptionInitialized = false;

interface SubscribableTable {
	search(): AsyncIterable<{ id: string; timestamp: number }>;
	subscribe(request: { omitCurrent?: boolean }): Promise<{
		on(event: string, listener: (event: { type: string; id: string; value?: { timestamp: number } }) => void): void;
	}>;
}

/**
 * Hydrate the invalidation map from storage, then track it via a Harper subscription so an invalidation
 * issued on any worker or node is observed here within milliseconds.
 *
 * This is why `refreshTags()` on the "use cache" handler is a no-op: the framework expects handlers to
 * poll a tags service, and Harper pushes instead.
 */
/**
 * Rebuild the in-memory invalidation map from the tombstone table.
 *
 * This is what makes an invalidation survive the process holding it. The map is worker-local, so a
 * worker that dies between `revalidateTag` and the entry being regenerated would otherwise come back
 * with no record of the invalidation and start serving the stale entry as though it were fresh. The
 * tombstone is the durable half of that pair, and this is the half that reads it back.
 */
export async function hydrateInvalidations(
	table: Pick<SubscribableTable, 'search'>,
	deps: InvalidationDeps = {}
): Promise<void> {
	for await (const row of table.search()) {
		cacheInvalidations.set(row.id, row.timestamp);
		mirrorToNextTagsManifest([row.id], row.timestamp, deps);
	}
}

export async function initializeInvalidationSubscription(deps: InvalidationDeps = {}): Promise<void> {
	if (subscriptionInitialized) return;
	const databases = getDatabases(deps);
	if (!databases) return;
	subscriptionInitialized = true;

	const scope = (databases as unknown as Record<string, Record<string, unknown>>)[DATABASE];
	// Harper's TypeScript types require RequestTarget/SubscriptionRequest objects, but the runtime
	// accepts plain object literals (and search() accepts no args).
	const table = scope?.[INVALIDATION_TABLE] as unknown as SubscribableTable | undefined;
	if (!table) {
		subscriptionInitialized = false;
		return;
	}

	try {
		await hydrateInvalidations(table, deps);

		const subscription = await table.subscribe({ omitCurrent: true });

		subscription.on('data', (event) => {
			if (!event.id) return;
			if (event.type === 'delete') {
				// The sweep has finished for this tag, so the tombstone is no longer load-bearing.
				cacheInvalidations.delete(event.id);
			} else if (event.type === 'put' && event.value) {
				cacheInvalidations.set(event.id, event.value.timestamp);
				// Mirror here too, so an invalidation issued on another node still yields stale-serving
				// rather than a blocking miss on this one.
				mirrorToNextTagsManifest([event.id], event.value.timestamp, deps);
			}
		});

		subscription.on('error', (error) => {
			getLogger(deps).error('[CacheHandler] invalidation subscription error', error);
		});
	} catch (error) {
		// Reset so a future construction can retry — failure here means we lose cross-worker visibility,
		// but the cache still works (just falls back to per-request revalidatedTags).
		subscriptionInitialized = false;
		getLogger(deps).error('[CacheHandler] failed to initialize invalidation subscription', error);
	}
}

/** Update this worker's view of an invalidation without touching storage. */
export function noteInvalidation(tags: string[], timestamp: number, deps: InvalidationDeps = {}): void {
	for (const tag of tags) {
		cacheInvalidations.set(tag, timestamp);
	}
	mirrorToNextTagsManifest(tags, timestamp, deps);
}

async function sweepTable(
	table: SweepableTable,
	timeAttribute: string,
	tag: string,
	timestamp: number,
	deps: InvalidationDeps
): Promise<number> {
	const sleep = deps.sleep ?? defaultSleep;

	// The time condition is the race guard: a record written after the invalidation was issued is
	// semantically fresh, so the sweep must leave it alone.
	const matches = table.search({
		conditions: [
			{ attribute: 'tags', comparator: 'contains', value: tag },
			{ attribute: timeAttribute, comparator: 'less_than', value: timestamp },
		],
		select: ['id'],
	});

	const ids: string[] = [];
	for await (const record of matches) {
		ids.push(record.id);
	}

	const batches = chunk(ids, INVALIDATE_CHUNK_SIZE);
	for (let index = 0; index < batches.length; index++) {
		await runWithConcurrency(batches[index], INVALIDATE_CONCURRENCY, async (id) => {
			await table.patch(id, { invalidatedAt: timestamp });
		});
		if (index < batches.length - 1) {
			await sleep(jitter(CHUNK_PAUSE_MAX_MS));
		}
	}

	return ids.length;
}

/**
 * Invalidate every cached entry carrying `tag` that predates `timestamp`, then drop the invalidation row
 * so the subscription clears it from every worker's map. Entries are invalidated, never deleted, so Next
 * can still serve them stale while regenerating.
 *
 * The invalidation row is removed only on success: while it remains, soft invalidation keeps reads
 * correct, so a failed sweep degrades to the pre-sweep behaviour rather than losing the invalidation.
 */
export async function sweepTag(tag: string, timestamp: number, deps: InvalidationDeps = {}): Promise<void> {
	const databases = getDatabases(deps);
	if (!databases) return;

	const scope = (databases as unknown as Record<string, Record<string, unknown>>)[DATABASE];
	if (!scope) return;

	const logger = getLogger(deps);

	try {
		const isrCount = await sweepTable(scope[ISR_TABLE] as SweepableTable, 'lastModified', tag, timestamp, deps);
		const useCacheCount = await sweepTable(scope[USE_CACHE_TABLE] as SweepableTable, 'timestamp', tag, timestamp, deps);

		logger.info(
			`[CacheHandler] invalidated ${isrCount + useCacheCount} entries for "${tag}" (isr=${isrCount}, useCache=${useCacheCount})`
		);

		await (scope[INVALIDATION_TABLE] as InvalidationTable).delete(tag);
	} catch (error) {
		logger.error(`[CacheHandler] sweep failed for "${tag}"; soft invalidation remains in effect`, error);
	}
}

async function isOverAdmissionThreshold(table: InvalidationTable, deps: InvalidationDeps): Promise<boolean> {
	if (typeof table.getRecordCount !== 'function') return false;
	try {
		const { recordCount } = await table.getRecordCount();
		return recordCount > MAX_PENDING_INVALIDATIONS;
	} catch (error) {
		getLogger(deps).error('[CacheHandler] could not read invalidation record count', error);
		return false;
	}
}

/**
 * Record a tag invalidation: update this worker immediately, persist a row for every other worker and
 * node, then schedule the background sweep. The caller is never blocked on the sweep.
 */
export async function recordInvalidation(
	tags: string[],
	durations: { expire?: number } | undefined,
	deps: InvalidationDeps = {}
): Promise<void> {
	if (tags.length === 0) return;

	const databases = getDatabases(deps);
	if (!databases) return;

	const scope = (databases as unknown as Record<string, Record<string, unknown>>)[DATABASE];
	if (!scope) return;

	const invalidationTable = scope[INVALIDATION_TABLE] as InvalidationTable;

	// `durations.expire` defers the invalidation: Next uses it to expire a tag at a future point rather
	// than immediately.
	const timestamp = Date.now() + (durations?.expire !== undefined ? durations.expire * 1000 : 0);

	noteInvalidation(tags, timestamp, deps);

	await Promise.all(tags.map((tag) => invalidationTable.put(tag, { timestamp })));

	if (await isOverAdmissionThreshold(invalidationTable, deps)) {
		getLogger(deps).error(
			`[CacheHandler] ${MAX_PENDING_INVALIDATIONS}+ pending invalidations; shedding sweep for ${tags.length} tag(s)`
		);
		return;
	}

	// `deps.scheduleSweep` is how the tests drive the sweep regardless of the default.
	if (!SWEEP_ENABLED && !deps.scheduleSweep) return;

	const schedule = deps.scheduleSweep ?? ((task: () => Promise<void>) => void task());
	for (const tag of tags) {
		if (!isSweepableTag(tag)) continue;
		schedule(() => sweepTag(tag, timestamp, deps));
	}
}
