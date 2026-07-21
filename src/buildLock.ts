import { databases, type Scope } from 'harper';
import { setTimeout as sleep } from 'node:timers/promises';

// Coordinates production builds across Harper worker threads (and processes sharing a database). Harper
// runs `handleApplication` in every worker, so without coordination each worker runs its own `next build`
// concurrently into the same `.next` directory. `next build` clears and rewrites `.next` at the start, so
// one worker deletes `.next/BUILD_ID` while another is reading it → `ENOENT` → the build worker exits and
// nothing serves (issue #52). To serialize builds, a worker claims the shared build-info record with
// status `building` before compiling; sibling workers observe the fresh claim and wait for it to finish
// rather than building in parallel. This mirrors the `@harperfast/vite` `buildLock` pattern.

const DATABASE = 'harperfast_nextjs';
const TABLE = 'nextjs_build_info';

// A completed build (`success`/`failure`) is reused for this long; after it, a restart triggers a rebuild.
const FRESH_BUILD_MS = 5000;
// A `building` claim older than this is treated as abandoned — e.g. the worker holding it crashed (the
// issue notes `process.exit(1)` in a build worker is swallowed to keep Harper alive). Must exceed the
// longest expected `next build`.
const STALE_CLAIM_MS = 5 * 60 * 1000;
// How often a waiting worker re-checks the claim, and how long it waits before building anyway.
const CLAIM_POLL_MS = 150;
const CLAIM_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/** A build-info record as Harper returns it from `table.get`. */
interface BuildInfoRecord {
	buildId: string | null;
	status: string;
	getUpdatedTime(): number;
}

/** The subset of the Harper build-info table the lock uses. */
interface BuildInfoTable {
	get(key: string): Promise<BuildInfoRecord | undefined>;
	put(key: string, value: { buildId: string | null; status: string }): Promise<unknown> | unknown;
}

/** The build-info table, or `undefined` when running outside Harper (e.g. unit tests). */
function buildInfoTable(): BuildInfoTable | undefined {
	return (databases as unknown as Record<string, Record<string, BuildInfoTable>>)?.[DATABASE]?.[TABLE];
}

export interface BuildLockDeps {
	/** Reads the current on-disk `.next/BUILD_ID` (or `null` if absent). Validates a fresh `success` record. */
	getBuildId: () => string | null;
	/** Runs `next build` and resolves with the resulting BUILD_ID. Rejects if the build fails. */
	runBuild: () => Promise<string>;
}

/**
 * Run `deps.runBuild` once across the workers sharing this app's build-info record. Resolves once a usable
 * build exists — whether this worker built it, reused a fresh one, or waited for a sibling — so the caller
 * can proceed to serve. Rejects only if the build this worker itself ran fails.
 *
 * Outside Harper (no coordination table), it simply runs the build.
 */
export async function withBuildLock(scope: Scope, deps: BuildLockDeps): Promise<void> {
	const table = buildInfoTable();
	if (!table) {
		await deps.runBuild();
		return;
	}

	const key = scope.appName;

	// Wait for any build already in progress on a sibling worker, then decide whether we still need to
	// build. Looping means that once a claim clears we re-read the record it produced (fresh success or
	// failure) instead of racing straight into our own build.
	const waitStart = Date.now();
	while (true) {
		const buildInfo = await table.get(key);
		const age = buildInfo ? Date.now() - buildInfo.getUpdatedTime() : Infinity;

		// Another worker is actively building. Poll-wait for it to finish, then re-evaluate.
		if (buildInfo?.status === 'building' && age < STALE_CLAIM_MS) {
			if (Date.now() - waitStart > CLAIM_WAIT_TIMEOUT_MS) {
				scope.logger.warn?.(`Timed out waiting for another worker to build ${key}; building anyway`);
				break;
			}
			scope.logger.debug?.(`Another worker is building ${key}; waiting`);
			await sleep(CLAIM_POLL_MS);
			continue;
		}

		if (age < FRESH_BUILD_MS) {
			// A sibling just finished a failed build — return immediately to avoid building (and failing)
			// on every thread.
			if (buildInfo?.status === 'failure') {
				scope.logger.debug?.(`Failure build of ${key} detected`);
				return;
			}

			// A sibling just finished a successful build — reuse it if the on-disk BUILD_ID matches.
			if (buildInfo?.status === 'success' && deps.getBuildId() === buildInfo.buildId) {
				scope.logger.debug?.(`Fresh build of ${key} (id: ${buildInfo.buildId}) detected`);
				return;
			}
		}

		// No fresh build and nobody is building — it's our turn.
		break;
	}

	// Claim the build so sibling workers wait (above) instead of compiling into the same `.next`
	// concurrently. `getUpdatedTime()` on this record is what the checks above compare against.
	await table.put(key, { buildId: null, status: 'building' });

	scope.logger.debug?.(`Building Next.js application at ${scope.directory}`);

	try {
		const buildId = await deps.runBuild();
		await table.put(key, { buildId, status: 'success' });
		scope.logger.debug?.(`Successful build for ${key} (id ${buildId})`);
	} catch (error) {
		await table.put(key, { buildId: null, status: 'failure' });
		scope.logger.debug?.(`Error building ${key}`);
		throw error;
	}
}
