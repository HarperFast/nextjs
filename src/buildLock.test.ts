import { databases, type Scope } from 'harper';
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { withBuildLock, type BuildLockDeps } from './buildLock.js';

// The build lock coordinates through `databases.harperfast_nextjs.nextjs_build_info` (imported from
// `harper`). These unit tests run "outside Harper", so clear any real `harperfast_nextjs` database a local
// Harper install may have opened on import, then inject a mock table per test. Because `databases` is a
// shared singleton, assigning at that path is what makes the module under test see the mock — this is why
// `buildLock` imports `databases` instead of reading `globalThis`.
(databases as any).harperfast_nextjs = {};

const TABLE = 'nextjs_build_info';

describe('withBuildLock', () => {
	/** Records as Harper returns them from `table.get`: a status/buildId plus the time last written. */
	const building = (ageMs = 0) => ({ status: 'building', buildId: null, getUpdatedTime: () => Date.now() - ageMs });
	const success = (buildId: string, ageMs = 0) => ({ status: 'success', buildId, getUpdatedTime: () => Date.now() - ageMs });
	const failure = (ageMs = 0) => ({ status: 'failure', buildId: null, getUpdatedTime: () => Date.now() - ageMs });

	/**
	 * A stand-in for the Harper build-info table. `get` returns the scripted records in order (the last one
	 * repeats); every `put` is appended to `events` so a test can assert the exact claim → build → record
	 * interleaving.
	 */
	function makeTable(events: string[], getReturns: any[] = [undefined]) {
		let i = 0;
		return {
			puts: [] as Array<{ key: string; value: any }>,
			async get(_key: string) {
				return getReturns[Math.min(i++, getReturns.length - 1)];
			},
			async put(key: string, value: any) {
				this.puts.push({ key, value });
				events.push(`put:${value.status}`);
			},
		};
	}

	/** Install `table` as the build-info table for one test, removing it afterward so tests don't leak state. */
	function useTable(t: any, table: unknown) {
		(databases as any).harperfast_nextjs[TABLE] = table;
		t.after(() => delete (databases as any).harperfast_nextjs[TABLE]);
	}

	// A minimal Scope: `withBuildLock` only touches `appName`/`directory` (for logs) and the `logger`.
	const scope = { appName: 'test-app', directory: '/test/dir', logger: {} } as unknown as Scope;

	/** Yield to the microtask/macrotask queue so awaited puts settle (setImmediate is not mock-timed here). */
	const tick = () => new Promise((resolve) => setImmediate(resolve));

	/** Build deps whose `runBuild` records that it ran and resolves with a BUILD_ID. */
	function makeDeps(events: string[], buildId = 'new-build', getBuildId: () => string | null = () => 'on-disk'): BuildLockDeps {
		return {
			getBuildId,
			runBuild: async () => {
				events.push('build');
				return buildId;
			},
		};
	}

	it('runs the build directly when no Harper table is available (e.g. unit tests / outside Harper)', async () => {
		delete (databases as any).harperfast_nextjs[TABLE];
		const events: string[] = [];

		await withBuildLock(scope, makeDeps(events));

		assert.deepStrictEqual(events, ['build'], 'builds without any locking when there is no table');
	});

	it('claims the build, runs it, then records success when no record exists', async (t) => {
		const events: string[] = [];
		const table = makeTable(events); // get → undefined (no existing record)
		useTable(t, table);

		await withBuildLock(scope, makeDeps(events, 'abc123'));

		assert.deepStrictEqual(
			events,
			['put:building', 'build', 'put:success'],
			'claims (building) before building and records success (with the new BUILD_ID) after'
		);
		assert.deepStrictEqual(table.puts.map((p) => p.value.status), ['building', 'success']);
		assert.strictEqual(table.puts[1].value.buildId, 'abc123', 'stores the BUILD_ID returned by the build');
		assert.deepStrictEqual(table.puts.map((p) => p.key), ['test-app', 'test-app'], 'keyed by appName');
	});

	it('waits without building when another worker holds a fresh claim, returning once it succeeds', async (t) => {
		const events: string[] = [];
		// Gate sees a fresh "building" claim; after one poll the sibling has finished with a matching build.
		const table = makeTable(events, [building(), success('done')]);
		useTable(t, table);

		await withBuildLock(scope, makeDeps(events, 'ignored', () => 'done'));

		assert.ok(!events.includes('build'), 'does not build while another worker holds the claim');
		assert.deepStrictEqual(table.puts, [], 'never writes a claim of its own — the sibling produced the output');
	});

	it('treats a "building" record with no recent heartbeat as abandoned and builds anyway', async (t) => {
		const events: string[] = [];
		// No heartbeat for longer than the stale threshold → the holder is assumed crashed.
		const table = makeTable(events, [building(5 * 60 * 1000)]);
		useTable(t, table);

		await withBuildLock(scope, makeDeps(events));

		assert.deepStrictEqual(events, ['put:building', 'build', 'put:success'], 'reclaims and builds past a stale claim');
	});

	it('reuses a fresh successful build without building when the on-disk BUILD_ID matches', async (t) => {
		const events: string[] = [];
		const table = makeTable(events, [success('match')]);
		useTable(t, table);

		await withBuildLock(scope, makeDeps(events, 'ignored', () => 'match'));

		assert.deepStrictEqual(events, [], 'no build and no writes — the existing build is reused');
	});

	it('rebuilds when a fresh successful record does not match the on-disk BUILD_ID', async (t) => {
		const events: string[] = [];
		const table = makeTable(events, [success('old')]);
		useTable(t, table);

		await withBuildLock(scope, makeDeps(events, 'fresh', () => 'different'));

		assert.deepStrictEqual(events, ['put:building', 'build', 'put:success'], 'a BUILD_ID mismatch forces a rebuild');
	});

	it('rebuilds when the last successful build is older than the fresh-build window', async (t) => {
		const events: string[] = [];
		// Matching BUILD_ID but older than 5s → not reusable; a restart should rebuild.
		const table = makeTable(events, [success('match', 6000)]);
		useTable(t, table);

		await withBuildLock(scope, makeDeps(events, 'fresh', () => 'match'));

		assert.deepStrictEqual(events, ['put:building', 'build', 'put:success'], 'a stale success record is rebuilt');
	});

	it('skips building when a sibling just recorded a failure (avoids failing on every thread)', async (t) => {
		const events: string[] = [];
		const table = makeTable(events, [failure()]);
		useTable(t, table);

		await withBuildLock(scope, makeDeps(events));

		assert.deepStrictEqual(events, [], 'does not rebuild while a fresh failure is recorded');
	});

	it('records failure and rethrows when the build it runs throws', async (t) => {
		const events: string[] = [];
		const table = makeTable(events);
		useTable(t, table);
		const deps: BuildLockDeps = {
			getBuildId: () => null,
			runBuild: async () => {
				events.push('build');
				throw new Error('boom');
			},
		};

		await assert.rejects(withBuildLock(scope, deps), /boom/);

		assert.deepStrictEqual(events, ['put:building', 'build', 'put:failure'], 'claims, fails, then records the failure');
	});

	it('re-stamps the claim on a heartbeat while a long build runs, then records success', async (t) => {
		// Mock only setInterval — the heartbeat's timer. This path never reaches the waiter's sleep().
		t.mock.timers.enable({ apis: ['setInterval'] });
		const events: string[] = [];
		const table = makeTable(events); // get → undefined (no existing record)
		useTable(t, table);

		let finishBuild!: () => void;
		const deps: BuildLockDeps = {
			getBuildId: () => null,
			runBuild: () => new Promise<string>((resolve) => (finishBuild = () => resolve('hb-id'))),
		};

		const done = withBuildLock(scope, deps);
		await tick(); // claim the build, start the build, and arm the heartbeat
		assert.deepStrictEqual(events, ['put:building'], 'claims once up front');

		// Simulate a build long enough to cross two heartbeat intervals (30s each).
		t.mock.timers.tick(30_000);
		await tick();
		t.mock.timers.tick(30_000);
		await tick();
		assert.deepStrictEqual(
			events,
			['put:building', 'put:building', 'put:building'],
			'each heartbeat re-stamps the building claim so a live build never looks abandoned'
		);

		finishBuild();
		await done;
		assert.strictEqual(events.at(-1), 'put:success', 'the terminal record is the last write — no heartbeat re-stamp after it');
		assert.strictEqual(table.puts.at(-1)?.value.buildId, 'hb-id');
	});
});
