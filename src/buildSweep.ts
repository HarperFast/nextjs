import type { databases as DatabasesType } from 'harper';

const DATABASE = 'harperfast_nextjs';
const USE_CACHE_TABLE = 'nextjs_use_cache';
const BUILD_INFO_TABLE = 'nextjs_build_info';

/** Set to `true` (or `1`) to enable the sweep; it is off by default. */
export const OLD_BUILD_SWEEP_ENV = 'HARPER_NEXTJS_SWEEP_OLD_BUILDS';

// Long enough for a rolling restart to reach the other nodes, so a node still on the previous build is not
// stripped of the entries it is serving while it waits its turn. Deleting them early would only cost it
// renders, never correctness.
export const OLD_BUILD_SWEEP_DELAY_MS = 300_000;

// Same bounds as the tag sweep in cacheInvalidation.cts: short transactions, and a bounded share of a worker.
const SWEEP_RECORD_CONCURRENCY = 10;
const SWEEP_CHUNK_SIZE = 100;
const SWEEP_CHUNK_PAUSE_MAX_MS = 100;

// `next dev` keys every entry with this build ID. A dev server sharing the instance writes no build record,
// so it is kept explicitly.
const DEV_BUILD_ID = 'development';

interface KeyRow {
	id: string;
}

interface BuildRow {
	buildId?: string | null;
	status?: string;
}

interface SweepTable<Row> {
	search(request: { conditions: never[]; select: string[] }): AsyncIterable<Row>;
	delete(id: string): Promise<unknown> | unknown;
}

export interface BuildSweepDeps {
	databases?: typeof DatabasesType;
	logger?: { info?(...args: unknown[]): void; error(...args: unknown[]): void };
	sleep?: (ms: number) => Promise<void>;
}

/**
 * The build ID a "use cache" entry was written under. Next keys each entry `[buildId, functionId, args]`,
 * serialized with React's `encodeReply`, so a key starts `["<buildId>",` — truncated storage keys keep
 * that prefix. Undefined when the key has any other shape (Next falls back to a FormData encoding for
 * arguments that are not plain JSON) or the build ID needed escaping: an entry that cannot be attributed
 * to a build is left to its own expiry rather than guessed at.
 */
export function buildIdOfKey(id: string): string | undefined {
	if (!id.startsWith('["')) return undefined;
	const end = id.indexOf('"', 2);
	if (end < 0 || id[end + 1] !== ',') return undefined;
	const buildId = id.slice(2, end);
	return buildId.includes('\\') ? undefined : buildId;
}

/**
 * Whether deleting earlier builds' entries is enabled. Opt-in, because it deletes rows on its own
 * schedule: entries from other builds are otherwise left to expire, up to a year.
 */
export function oldBuildSweepEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env[OLD_BUILD_SWEEP_ENV]?.trim().toLowerCase();
	return value === 'true' || value === '1';
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delete the "use cache" entries written by a build no app on this instance runs any more. Next puts the
 * build ID in every key, so those entries can never be read again; left alone, each one stays until its
 * own `expire`, up to a year. The build IDs kept are `currentBuildId` and the latest successful build of
 * every app in `nextjs_build_info`, so apps sharing the database keep each other's entries. Returns the
 * number of entries deleted.
 */
export async function sweepOtherBuilds(currentBuildId: string, deps: BuildSweepDeps = {}): Promise<number> {
	const databases = deps.databases ?? (globalThis as { databases?: typeof DatabasesType }).databases;
	const scope = databases
		? (databases as unknown as Record<string, Record<string, unknown>>)[DATABASE]
		: undefined;
	const table = scope?.[USE_CACHE_TABLE] as SweepTable<KeyRow> | undefined;
	const buildInfo = scope?.[BUILD_INFO_TABLE] as SweepTable<BuildRow> | undefined;
	if (!table || !buildInfo) return 0;
	const sleep = deps.sleep ?? defaultSleep;

	const keep = new Set([currentBuildId, DEV_BUILD_ID]);
	for await (const row of buildInfo.search({ conditions: [], select: ['buildId', 'status'] })) {
		if (row.status === 'success' && row.buildId) keep.add(row.buildId);
	}

	const ids: string[] = [];
	for await (const row of table.search({ conditions: [], select: ['id'] })) {
		const buildId = buildIdOfKey(row.id);
		if (buildId !== undefined && !keep.has(buildId)) ids.push(row.id);
	}

	let deleted = 0;
	for (let start = 0; start < ids.length; start += SWEEP_CHUNK_SIZE) {
		const batch = ids.slice(start, start + SWEEP_CHUNK_SIZE);
		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(SWEEP_RECORD_CONCURRENCY, batch.length) }, async () => {
				while (cursor < batch.length) {
					await table.delete(batch[cursor++]);
					deleted++;
				}
			})
		);
		if (start + SWEEP_CHUNK_SIZE < ids.length) await sleep(Math.floor(Math.random() * SWEEP_CHUNK_PAUSE_MAX_MS));
	}

	const logger = deps.logger ?? (globalThis as { logger?: BuildSweepDeps['logger'] }).logger ?? console;
	logger.info?.(`[UseCacheHandler] deleted ${deleted} "use cache" entries from builds other than ${[...keep].join(', ')}`);
	return deleted;
}
