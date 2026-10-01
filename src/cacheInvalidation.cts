import type { databases as DatabasesType } from 'harper';

const DATABASE = 'harperfast_nextjs';
const ISR_TABLE = 'nextjs_isr_cache';
const USE_CACHE_TABLE = 'nextjs_use_cache';
const INVALIDATION_TABLE = 'nextjs_cache_invalidation';

// Matches the `expiration` of the cache tables in schema.graphql; used when a table does not report its own.
const DEFAULT_CACHE_TTL_MS = 604_800_000;

// The longest an entry is kept, whatever Next asks for: one year, which is Next's own `max` profile. It is
// independent of the tables' `expiration`, which only applies to an entry written without an `expire` —
// Harper honours a record's own `expiresAt` beyond it. Tombstones are sized from it, so raising it makes
// every tombstone, and the in-memory map of them, live that much longer.
export const MAX_ENTRY_LIFETIME_MS = 31_536_000_000;
const MAX_ENTRY_LIFETIME_SECONDS = MAX_ENTRY_LIFETIME_MS / 1000;

// Covers an entry that was rendered before an invalidation but stored after it, and replication lag: both
// let an entry's own TTL start after the invalidation was issued.
const TOMBSTONE_MARGIN_MS = 3_600_000;

// Chunks bound transaction length — a single long-running transaction is a documented Harper failure
// mode ("Transaction was open too long") — while the concurrency limits bound how much of a worker a
// sweep can take.
const SWEEP_RECORD_CONCURRENCY = 10;
const SWEEP_CHUNK_SIZE = 100;
const SWEEP_CHUNK_PAUSE_MAX_MS = 100;
const SWEEP_TAG_CONCURRENCY = 2;
const PRUNE_INTERVAL_MS = 300_000;
const SUBSCRIPTION_RETRY_MIN_MS = 1_000;
const SUBSCRIPTION_RETRY_MAX_MS = 60_000;

/**
 * One tag's invalidation, in Next's own terms: `stale` marks entries written before it for background
 * revalidation, `expired` makes them unusable once it has passed. `at` is when it was issued, and orders
 * competing views of the same tag. `lapsesAt` is when its tombstone expires.
 */
export interface TagInvalidation {
	stale?: number;
	expired?: number;
	at: number;
	lapsesAt: number;
}

export type TagState = 'expired' | 'stale' | undefined;

interface TombstoneRow {
	id: string;
	timestamp?: number;
	stale?: number;
	expired?: number;
	lapsesAt?: number;
}

interface CacheRow {
	id: string;
	tags?: string[];
	timestamp?: number;
	lastModified?: number;
}

interface SweepableTable {
	search(request: {
		conditions: Array<{ attribute: string; comparator: string; value: unknown }>;
		select?: string[];
	}): AsyncIterable<CacheRow>;
	get(id: string): Promise<CacheRow | undefined> | CacheRow | undefined;
	delete(id: string): Promise<unknown> | unknown;
	expirationMS?: number;
}

interface InvalidationTable {
	put(id: string, value: Omit<TombstoneRow, 'id'>, context?: { expiresAt?: number }): Promise<unknown> | unknown;
	search(): AsyncIterable<TombstoneRow>;
	subscribe(request: { omitCurrent?: boolean }): Promise<{
		on(event: string, listener: (event: { type: string; id: string; value?: Omit<TombstoneRow, 'id'> }) => void): void;
	}>;
}

export interface InvalidationDeps {
	databases?: typeof DatabasesType;
	sleep?: (ms: number) => Promise<void>;
	logger?: { info?(...args: unknown[]): void; error(...args: unknown[]): void };
	/** Runs a sweep. Defaults to the worker's sweep queue; tests substitute a collector. */
	scheduleSweep?: (task: () => Promise<void>) => void;
	/** Stand-in for Next's tags-manifest module; `null` means Next has none. */
	tagsManifestModule?: unknown;
	/** False skips the periodic prune timer. */
	maintenance?: boolean;
	now?: () => number;
}

/** Tag → its newest invalidation. Shared by both cache handlers in the worker. */
export const cacheInvalidations = new Map<string, TagInvalidation>();

/**
 * `databases` is a Harper-provided global, read lazily so that loading this module from a non-Harper
 * context (a bundler resolving the cache-handler path) does not pull in the harper runtime.
 */
function getDatabases(deps: InvalidationDeps): typeof DatabasesType | undefined {
	return deps.databases ?? (globalThis as { databases?: typeof DatabasesType }).databases;
}

function getScope(deps: InvalidationDeps): Record<string, unknown> | undefined {
	const databases = getDatabases(deps);
	return databases ? (databases as unknown as Record<string, Record<string, unknown>>)[DATABASE] : undefined;
}

function getLogger(deps: InvalidationDeps): NonNullable<InvalidationDeps['logger']> {
	return deps.logger ?? (globalThis as { logger?: InvalidationDeps['logger'] }).logger ?? console;
}

function nowFor(deps: InvalidationDeps): number {
	return deps.now ? deps.now() : Date.now();
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

let unboundedCacheReported = false;

/**
 * Harper's per-record expiry for a cache entry: when Next says it stops being usable (`expire` seconds
 * after `writtenAt`), capped at `MAX_ENTRY_LIFETIME_MS` from now. The cap is what `tombstoneLifetimeMs`
 * relies on — no entry may outlive the tombstones that can invalidate it — so the handlers set it
 * explicitly rather than leave the record's lifetime to whatever a write's context happens to carry.
 * Undefined leaves the table default in place.
 */
export function entryExpiresAt(
	writtenAt: number,
	expireSeconds: number | undefined,
	now: number = Date.now()
): number | undefined {
	if (typeof expireSeconds !== 'number' || !Number.isFinite(expireSeconds) || expireSeconds <= 0) return undefined;
	return Math.min(writtenAt + expireSeconds * 1000, now + MAX_ENTRY_LIFETIME_MS);
}

/**
 * A cache life (`stale`, `revalidate`, `expire`, in seconds) as it can be stored. Harper rejects a
 * non-integer, or one outside the 32-bit range, for an Int column, and the rejection is caught — so the
 * entry silently never lands. Next's `default` profile sets `expire` to `INFINITE_CACHE` (0xfffffffe),
 * which is out of range; no entry is kept past `MAX_ENTRY_LIFETIME_MS` anyway, so longer lives are stored
 * as that.
 */
export function toStoredLife(seconds: number | undefined): number | undefined {
	if (typeof seconds !== 'number' || Number.isNaN(seconds)) return undefined;
	return Math.max(0, Math.min(Math.floor(seconds), MAX_ENTRY_LIFETIME_SECONDS));
}

/**
 * How long a tombstone must live: past the last moment any entry written before the invalidation can
 * still be read. An entry with an `expire` lives at most `MAX_ENTRY_LIFETIME_MS` (see `entryExpiresAt`);
 * one without lives its table's `expiration`. The bound is the longest of those, plus the margin.
 */
export function tombstoneLifetimeMs(deps: InvalidationDeps = {}): number {
	const scope = getScope(deps);
	let longest = MAX_ENTRY_LIFETIME_MS;
	for (const name of [ISR_TABLE, USE_CACHE_TABLE]) {
		const ttl = (scope?.[name] as { expirationMS?: number } | undefined)?.expirationMS;
		if (ttl === undefined) {
			longest = Math.max(longest, DEFAULT_CACHE_TTL_MS);
		} else if (ttl > 0) {
			longest = Math.max(longest, ttl);
		} else if (!unboundedCacheReported) {
			unboundedCacheReported = true;
			getLogger(deps).error(
				`[CacheHandler] ${DATABASE}.${name} has no expiration, so its entries can outlive any invalidation tombstone; invalidated entries may be served again once a tombstone lapses`
			);
		}
	}
	return longest + TOMBSTONE_MARGIN_MS;
}

/**
 * Next 16 `updateTags` semantics: with durations a tag goes stale now and expires `durations.expire`
 * seconds later; without, it expires now.
 */
export function invalidationFor(
	now: number,
	durations: { expire?: number } | undefined,
	lifetimeMs: number
): TagInvalidation {
	const lapsesAt = now + lifetimeMs;
	if (!durations) return { expired: now, at: now, lapsesAt };
	return {
		stale: now,
		expired: durations.expire !== undefined ? now + durations.expire * 1000 : undefined,
		at: now,
		lapsesAt,
	};
}

/**
 * Rows written before `stale`/`expired` existed carry only `timestamp`, which meant "expired then". The
 * previous plugin wrote a deferred invalidation as `now + expire`, so a legacy timestamp can be in the
 * future; it was issued no later than now, and ordering it by that future time would make it outrank
 * every invalidation of the tag issued after it.
 */
export function tombstoneToInvalidation(
	row: Omit<TombstoneRow, 'id'> | undefined,
	now: number = Date.now()
): TagInvalidation | undefined {
	if (typeof row?.timestamp !== 'number') return undefined;
	const legacy = row.stale == undefined && row.expired == undefined;
	return {
		stale: row.stale ?? undefined,
		expired: legacy ? row.timestamp : (row.expired ?? undefined),
		at: legacy ? Math.min(row.timestamp, now) : row.timestamp,
		lapsesAt: row.lapsesAt ?? row.timestamp + DEFAULT_CACHE_TTL_MS,
	};
}

/** True when the invalidation expires entries immediately rather than marking them stale first. */
export function isHardExpiry(invalidation: TagInvalidation): boolean {
	return invalidation.expired !== undefined && invalidation.expired <= invalidation.at;
}

/** The state of an entry written at `writtenAt`, given the invalidations of its tags this worker knows. */
export function tagState(tags: Iterable<string>, writtenAt: number, now: number = Date.now()): TagState {
	let state: TagState;
	for (const tag of tags) {
		const invalidation = cacheInvalidations.get(tag);
		if (!invalidation) continue;
		const { stale, expired } = invalidation;
		if (expired !== undefined && expired <= now && expired > writtenAt) return 'expired';
		if (stale !== undefined && stale > writtenAt) state = 'stale';
	}
	return state;
}

/**
 * Newest expiration among `tags` that has already passed. An expiration still in the future is not yet
 * an expiration: reporting it would make Next discard every entry created before it, including ones
 * regenerated after the invalidation.
 */
export function passedExpiration(tags: Iterable<string>, now: number = Date.now()): number {
	let newest = 0;
	for (const tag of tags) {
		const expired = cacheInvalidations.get(tag)?.expired;
		if (expired !== undefined && expired <= now && expired > newest) newest = expired;
	}
	return newest;
}

type TagsManifest =
	| { kind: 'none' }
	| { kind: 'entries'; manifest: Map<string, { stale?: number; expired?: number } | undefined> }
	| { kind: 'timestamps'; manifest: Map<string, number | undefined> };

let loadedTagsManifest: TagsManifest | undefined;

/**
 * Next 16 keys `{stale, expired}` per tag; Next 15 keys a single revalidation timestamp; Next 14 has no
 * such module. Writing the wrong shape either throws (a property set on a number, in strict mode) or
 * poisons Next's own reads (`Math.max` over an object is NaN).
 */
function getTagsManifest(deps: InvalidationDeps): TagsManifest | undefined {
	if (deps.tagsManifestModule !== undefined) return classifyTagsManifest(deps.tagsManifestModule);
	if (loadedTagsManifest) return loadedTagsManifest;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		loadedTagsManifest = classifyTagsManifest(require('next/dist/server/lib/incremental-cache/tags-manifest.external.js'));
	} catch (error) {
		if ((error as { code?: string } | undefined)?.code !== 'MODULE_NOT_FOUND') {
			getLogger(deps).error('[CacheHandler] could not load the Next tags manifest', error);
			return undefined;
		}
		loadedTagsManifest = { kind: 'none' };
	}
	return loadedTagsManifest;
}

function classifyTagsManifest(module: unknown): TagsManifest {
	const exports = module as { tagsManifest?: unknown; areTagsStale?: unknown } | null;
	if (!(exports?.tagsManifest instanceof Map)) return { kind: 'none' };
	return typeof exports.areTagsStale === 'function'
		? { kind: 'entries', manifest: exports.tagsManifest }
		: { kind: 'timestamps', manifest: exports.tagsManifest };
}

/** True when Next itself serves tag-stale ISR entries stale-while-revalidate from its manifest (Next 16). */
export function nextServesStaleTags(deps: InvalidationDeps = {}): boolean {
	return getTagsManifest(deps)?.kind === 'entries';
}

/**
 * Mirror an invalidation into Next's own tags manifest, so Next's in-process checks agree with this
 * worker's view — including for an invalidation that arrived from another worker or node. `undefined`
 * withdraws one, but only if the manifest still holds what was mirrored: Next may have written the tag
 * itself since.
 */
function mirrorToTagsManifest(
	tag: string,
	invalidation: TagInvalidation | undefined,
	previous: TagInvalidation | undefined,
	deps: InvalidationDeps
): void {
	const tagsManifest = getTagsManifest(deps);
	if (!tagsManifest || tagsManifest.kind === 'none') return;
	if (tagsManifest.kind === 'timestamps') {
		const existing = tagsManifest.manifest.get(tag);
		if (!invalidation) {
			if (previous && existing === revalidatedAtOf(previous)) tagsManifest.manifest.delete(tag);
			return;
		}
		const revalidatedAt = revalidatedAtOf(invalidation);
		if (typeof existing !== 'number' || existing < revalidatedAt) tagsManifest.manifest.set(tag, revalidatedAt);
		return;
	}
	const existing = tagsManifest.manifest.get(tag);
	if (!invalidation) {
		if (previous && existing?.stale === previous.stale && existing?.expired === previous.expired) {
			tagsManifest.manifest.delete(tag);
		}
		return;
	}
	tagsManifest.manifest.set(tag, {
		...(existing && typeof existing === 'object' ? existing : {}),
		...(invalidation.stale !== undefined ? { stale: invalidation.stale } : {}),
		...(invalidation.expired !== undefined ? { expired: invalidation.expired } : {}),
	});
}

function revalidatedAtOf(invalidation: TagInvalidation): number {
	return invalidation.expired ?? invalidation.stale ?? invalidation.at;
}

/**
 * Adopt an invalidation into this worker's view. The newest (by `at`) wins, so the subscription, the
 * start-up hydration and this worker's own writes can arrive in any order.
 */
export function noteInvalidation(tag: string, invalidation: TagInvalidation, deps: InvalidationDeps = {}): void {
	const existing = cacheInvalidations.get(tag);
	if (existing && existing.at > invalidation.at) return;
	if (invalidation.lapsesAt <= nowFor(deps)) return;
	cacheInvalidations.set(tag, invalidation);
	mirrorToTagsManifest(tag, invalidation, existing, deps);
}

function forgetInvalidation(tag: string, deps: InvalidationDeps): void {
	const existing = cacheInvalidations.get(tag);
	if (!existing) return;
	cacheInvalidations.delete(tag);
	mirrorToTagsManifest(tag, undefined, existing, deps);
}

/** Drop invalidations whose tombstone has lapsed. TTL eviction does not emit a delete event. */
export function pruneInvalidations(deps: InvalidationDeps = {}): void {
	const now = nowFor(deps);
	for (const [tag, invalidation] of cacheInvalidations) {
		if (invalidation.lapsesAt <= now) forgetInvalidation(tag, deps);
	}
}

/**
 * Rebuild the in-memory invalidation map from the tombstone table, so a worker that restarts between
 * `revalidateTag` and the entry's regeneration still knows the entry is invalid.
 */
export async function hydrateInvalidations(
	table: Pick<InvalidationTable, 'search'>,
	deps: InvalidationDeps = {}
): Promise<void> {
	for await (const row of table.search()) {
		const invalidation = tombstoneToInvalidation(row, nowFor(deps));
		if (invalidation) noteInvalidation(row.id, invalidation, deps);
	}
}

let subscription: Awaited<ReturnType<InvalidationTable['subscribe']>> | undefined;
let initialization: Promise<void> | undefined;
let initialized = false;
let subscriptionRetryAt = 0;
let subscriptionRetryMs = SUBSCRIPTION_RETRY_MIN_MS;
let pruneTimerStarted = false;

function onTombstoneEvent(
	event: { type: string; id: string; value?: Omit<TombstoneRow, 'id'> },
	deps: InvalidationDeps
): void {
	if (!event.id) return;
	if (event.type === 'delete') {
		forgetInvalidation(event.id, deps);
		return;
	}
	const invalidation = tombstoneToInvalidation(event.value, nowFor(deps));
	if (invalidation) noteInvalidation(event.id, invalidation, deps);
}

function startPruneTimer(deps: InvalidationDeps): void {
	if (pruneTimerStarted || deps.maintenance === false) return;
	pruneTimerStarted = true;
	setInterval(() => pruneInvalidations(deps), PRUNE_INTERVAL_MS).unref();
}

/**
 * Subscribe to tombstones, then hydrate from storage. Subscribing first means an invalidation written
 * while the hydration scan runs is still observed; `noteInvalidation` makes the overlap harmless.
 * Concurrent callers share one attempt, and a failure backs off rather than retrying on every request.
 */
export function initializeInvalidationSubscription(deps: InvalidationDeps = {}): Promise<void> {
	if (initialized) return Promise.resolve();
	if (initialization) return initialization;
	if (nowFor(deps) < subscriptionRetryAt) return Promise.resolve();
	const table = getScope(deps)?.[INVALIDATION_TABLE] as InvalidationTable | undefined;
	if (!table) return Promise.resolve();

	initialization = (async () => {
		try {
			if (!subscription) {
				// Harper's TypeScript types require a SubscriptionRequest, but the runtime accepts a plain literal.
				subscription = await table.subscribe({ omitCurrent: true });
				subscription.on('data', (event) => onTombstoneEvent(event, deps));
				subscription.on('error', (error) => {
					getLogger(deps).error('[CacheHandler] invalidation subscription error', error);
				});
			}
			await hydrateInvalidations(table, deps);
			startPruneTimer(deps);
			initialized = true;
			subscriptionRetryMs = SUBSCRIPTION_RETRY_MIN_MS;
		} catch (error) {
			subscriptionRetryAt = nowFor(deps) + subscriptionRetryMs;
			subscriptionRetryMs = Math.min(subscriptionRetryMs * 2, SUBSCRIPTION_RETRY_MAX_MS);
			getLogger(deps).error('[CacheHandler] failed to initialize invalidation subscription', error);
		} finally {
			initialization = undefined;
		}
	})();
	return initialization;
}

/** Test hook: stand in for Next's tags-manifest module; `null` simulates Next 14, which has none. */
export function useTagsManifestModuleForTesting(module: unknown): void {
	loadedTagsManifest = classifyTagsManifest(module);
}

/** Test hook: forget state held at module level. */
export function resetInvalidationStateForTesting(): void {
	cacheInvalidations.clear();
	subscription = undefined;
	initialization = undefined;
	initialized = false;
	subscriptionRetryAt = 0;
	subscriptionRetryMs = SUBSCRIPTION_RETRY_MIN_MS;
	loadedTagsManifest = undefined;
	unboundedCacheReported = false;
	queuedSweeps.clear();
	activeSweeps = 0;
	recordedThisTurn.clear();
}

function writtenAtOf(row: CacheRow): number {
	return row.timestamp ?? row.lastModified ?? 0;
}

/**
 * Delete every record in `table` carrying `tag` that was written before `expiredAt`. Reads already treat
 * those entries as misses while the tombstone lives; deleting them commits that permanently and returns
 * the space. A regeneration racing the sweep can at worst lose its fresh entry, costing one render.
 */
function isIndexRebuilding(error: unknown): boolean {
	return (error as { name?: string } | undefined)?.name === 'IndexRebuildingError';
}

/**
 * The records carrying `tag`, through the `tags` index. While Harper reports that index as rebuilding it
 * refuses the lookup, so fall back to scanning with the same exact-element match. Harper 5.2.0 can leave
 * that report stuck on every worker thread but the one that ran the rebuild until they restart, so the
 * fallback is not just a brief upgrade window.
 */
async function* rowsTagged(table: SweepableTable, tag: string): AsyncIterable<CacheRow> {
	const select = ['id', 'tags', 'timestamp', 'lastModified'];
	try {
		yield* table.search({ conditions: [{ attribute: 'tags', comparator: 'equals', value: tag }], select });
		return;
	} catch (error) {
		if (!isIndexRebuilding(error)) throw error;
	}
	for await (const row of table.search({ conditions: [], select })) {
		if (row.tags?.includes(tag)) yield row;
	}
}

async function sweepTable(table: SweepableTable, tag: string, expiredAt: number, deps: InvalidationDeps): Promise<number> {
	const sleep = deps.sleep ?? defaultSleep;
	const ids: string[] = [];
	for await (const row of rowsTagged(table, tag)) {
		if (writtenAtOf(row) < expiredAt) ids.push(row.id);
	}

	let deleted = 0;
	const batches = chunk(ids, SWEEP_CHUNK_SIZE);
	for (let index = 0; index < batches.length; index++) {
		await runWithConcurrency(batches[index], SWEEP_RECORD_CONCURRENCY, async (id) => {
			// Re-read so an entry regenerated since the search survives.
			const current = await table.get(id);
			if (!current || writtenAtOf(current) >= expiredAt) return;
			await table.delete(id);
			deleted++;
		});
		if (index < batches.length - 1) await sleep(jitter(SWEEP_CHUNK_PAUSE_MAX_MS));
	}
	return deleted;
}

/**
 * Delete the entries a hard expiry of `tag` made unusable. Only reclaims space: correctness rests on the
 * tombstone, so a failed or skipped sweep leaves reads unaffected.
 */
export async function sweepTag(tag: string, expiredAt: number, deps: InvalidationDeps = {}): Promise<void> {
	const scope = getScope(deps);
	if (!scope) return;
	const isrCount = await sweepTable(scope[ISR_TABLE] as SweepableTable, tag, expiredAt, deps);
	const useCacheCount = await sweepTable(scope[USE_CACHE_TABLE] as SweepableTable, tag, expiredAt, deps);
	getLogger(deps).info?.(
		`[CacheHandler] deleted ${isrCount + useCacheCount} entries expired by "${tag}" (isr=${isrCount}, useCache=${useCacheCount})`
	);
}

const queuedSweeps = new Map<string, number>();
let activeSweeps = 0;

function drainSweeps(deps: InvalidationDeps): void {
	while (activeSweeps < SWEEP_TAG_CONCURRENCY && queuedSweeps.size > 0) {
		const [tag, expiredAt] = queuedSweeps.entries().next().value as [string, number];
		queuedSweeps.delete(tag);
		activeSweeps++;
		void sweepTag(tag, expiredAt, deps)
			.catch((error) => {
				getLogger(deps).error(`[CacheHandler] sweep failed for "${tag}"; entries are left to their TTL`, error);
			})
			.finally(() => {
				activeSweeps--;
				drainSweeps(deps);
			});
	}
}

function scheduleSweep(tag: string, expiredAt: number, deps: InvalidationDeps): void {
	if (deps.scheduleSweep) {
		deps.scheduleSweep(() => sweepTag(tag, expiredAt, deps));
		return;
	}
	queuedSweeps.set(tag, Math.max(queuedSweeps.get(tag) ?? 0, expiredAt));
	drainSweeps(deps);
}

/**
 * Record a tag invalidation: adopt it on this worker immediately, then persist a tombstone for every
 * other worker and node that lives as long as any entry it invalidates can. A hard expiry is also swept
 * onto the entries. The caller is never blocked on the sweep.
 */
// A single `revalidateTag` reaches both handlers: Next calls the "use cache" handler's `updateTags` and
// the incremental cache's `revalidateTag` in the same turn. Both land here with the same tags and
// durations, so the second is dropped rather than writing every tombstone and running every sweep twice.
const recordedThisTurn = new Set<string>();

function claimForThisTurn(tag: string, durations: { expire?: number } | undefined): boolean {
	const key = `${tag}\u0000${durations ? (durations.expire ?? 'stale') : 'expired'}`;
	if (recordedThisTurn.has(key)) return false;
	if (recordedThisTurn.size === 0) setImmediate(() => recordedThisTurn.clear());
	recordedThisTurn.add(key);
	return true;
}

export async function recordInvalidation(
	tags: string[],
	durations: { expire?: number } | undefined,
	deps: InvalidationDeps = {}
): Promise<void> {
	// Duplicates would each cost a redundant tombstone write and a redundant sweep.
	const uniqueTags = Array.from(new Set(tags)).filter((tag) => claimForThisTurn(tag, durations));
	if (uniqueTags.length === 0) return;

	const scope = getScope(deps);
	if (!scope) return;
	const tombstones = scope[INVALIDATION_TABLE] as InvalidationTable;

	const now = nowFor(deps);
	const issued = invalidationFor(now, durations, tombstoneLifetimeMs(deps));

	const merged = uniqueTags.map((tag) => {
		// Like Next's own `{...existing, stale, expired}`: a later invalidation keeps the parts of an
		// earlier one it does not replace.
		const existing = cacheInvalidations.get(tag);
		const invalidation: TagInvalidation = {
			...issued,
			stale: issued.stale ?? existing?.stale,
			expired: issued.expired ?? existing?.expired,
		};
		noteInvalidation(tag, invalidation, deps);
		return { tag, invalidation };
	});

	await Promise.all(
		merged.map(({ tag, invalidation }) =>
			tombstones.put(
				tag,
				{ timestamp: now, stale: invalidation.stale, expired: invalidation.expired, lapsesAt: invalidation.lapsesAt },
				// Outlives the table's own expiration, which only bounds the entries, not their tombstones.
				{ expiresAt: invalidation.lapsesAt }
			)
		)
	);

	if (isHardExpiry(issued)) {
		for (const tag of uniqueTags) scheduleSweep(tag, issued.expired as number, deps);
	}
}
