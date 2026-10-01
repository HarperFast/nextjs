import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildIdOfKey, oldBuildSweepEnabled, sweepOtherBuilds, type BuildSweepDeps } from './buildSweep.js';

/** A "use cache" key the way Next serializes it: `encodeReply([buildId, functionId, args])`. */
function keyFor(buildId: string, props: unknown = { itemName: 'herozone' }) {
	return JSON.stringify([buildId, 'c0fcbc549a9c66d11cf876f55f0f42138f07999a44', [props]]);
}

function makeTable<Row extends object>(rows: Array<Row & { id: string }>) {
	const byId = new Map(rows.map((row) => [row.id, row]));
	return {
		byId,
		deleted: [] as string[],
		search() {
			return (async function* () {
				for (const row of byId.values()) yield { ...row };
			})();
		},
		async delete(id: string) {
			this.deleted.push(id);
			byId.delete(id);
		},
	};
}

function makeDeps(
	useCacheKeys: string[],
	builds: Array<{ appName: string; buildId: string | null; status: string }>
): BuildSweepDeps & { useCache: ReturnType<typeof makeTable>; logs: unknown[][] } {
	const useCache = makeTable(useCacheKeys.map((id) => ({ id })));
	const buildInfo = makeTable(builds.map((build) => ({ id: build.appName, ...build })));
	const logs: unknown[][] = [];
	return {
		useCache,
		logs,
		databases: { harperfast_nextjs: { nextjs_use_cache: useCache, nextjs_build_info: buildInfo } } as never,
		logger: { info: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) },
		sleep: async () => {},
	};
}

describe('oldBuildSweepEnabled', () => {
	it('is off unless the environment opts in', () => {
		assert.equal(oldBuildSweepEnabled({}), false);
		assert.equal(oldBuildSweepEnabled({ HARPER_NEXTJS_SWEEP_OLD_BUILDS: 'false' }), false);
		assert.equal(oldBuildSweepEnabled({ HARPER_NEXTJS_SWEEP_OLD_BUILDS: '' }), false);
	});

	it('is on for true or 1', () => {
		assert.equal(oldBuildSweepEnabled({ HARPER_NEXTJS_SWEEP_OLD_BUILDS: 'true' }), true);
		assert.equal(oldBuildSweepEnabled({ HARPER_NEXTJS_SWEEP_OLD_BUILDS: ' TRUE ' }), true);
		assert.equal(oldBuildSweepEnabled({ HARPER_NEXTJS_SWEEP_OLD_BUILDS: '1' }), true);
	});
});

describe('buildIdOfKey', () => {
	it('reads the build ID Next puts first in every key', () => {
		assert.equal(buildIdOfKey(keyFor('B4tcOHFZN-dXMjHgx26oG')), 'B4tcOHFZN-dXMjHgx26oG');
	});

	// Truncation keeps the prefix, and Next appends a root-params suffix after the array.
	it('reads it from a truncated key and from a key with a root-params suffix', () => {
		const truncated = `${keyFor('abc', { big: 'x'.repeat(2000) }).slice(0, 1480)}\u0000#0123456789abcdef`;
		assert.equal(buildIdOfKey(truncated), 'abc');
		assert.equal(buildIdOfKey(`${keyFor('abc')}[["lang","en"]]`), 'abc');
	});

	// Next falls back to a FormData encoding for arguments that are not plain JSON.
	it('attributes no build to a key of any other shape', () => {
		assert.equal(buildIdOfKey('1:0["abc","fn",[]]'), undefined);
		assert.equal(buildIdOfKey('["abc"]'), undefined);
		assert.equal(buildIdOfKey(JSON.stringify(['has"quote', 'fn', []])), undefined);
	});
});

describe('sweepOtherBuilds', () => {
	it("deletes entries from earlier builds and keeps the current build's", async () => {
		const deps = makeDeps(
			[keyFor('old-1'), keyFor('old-2', { itemName: 'popularbrands' }), keyFor('current')],
			[{ appName: 'home', buildId: 'current', status: 'success' }]
		);

		const deleted = await sweepOtherBuilds('current', deps);

		assert.equal(deleted, 2);
		assert.deepEqual([...deps.useCache.byId.keys()], [keyFor('current')]);
	});

	// The database is shared by every Next app on the instance.
	it("keeps entries of another app's current build", async () => {
		const deps = makeDeps(
			[keyFor('home-build'), keyFor('plp-build'), keyFor('plp-previous')],
			[
				{ appName: 'home', buildId: 'home-build', status: 'success' },
				{ appName: 'plp', buildId: 'plp-build', status: 'success' },
			]
		);

		await sweepOtherBuilds('home-build', deps);

		assert.deepEqual(deps.useCache.deleted, [keyFor('plp-previous')]);
	});

	// The current build is kept even when the record has since been overwritten, e.g. by another node.
	it('keeps the build it was given whatever the build record says', async () => {
		const deps = makeDeps([keyFor('mine')], [{ appName: 'home', buildId: 'theirs', status: 'success' }]);

		await sweepOtherBuilds('mine', deps);

		assert.deepEqual(deps.useCache.deleted, []);
	});

	it('does not keep a build that failed, and keeps entries it cannot attribute and a dev server’s', async () => {
		const deps = makeDeps(
			[keyFor('failed'), '1:0["abc","fn",[]]', keyFor('development')],
			[{ appName: 'home', buildId: 'failed', status: 'failure' }]
		);

		await sweepOtherBuilds('current', deps);

		assert.deepEqual(deps.useCache.deleted, [keyFor('failed')]);
	});

	it('deletes in chunks across more entries than one chunk holds', async () => {
		const keys = Array.from({ length: 250 }, (_, index) => keyFor('old', { index }));
		const deps = makeDeps([...keys, keyFor('current')], []);
		let pauses = 0;
		deps.sleep = async () => {
			pauses++;
		};

		assert.equal(await sweepOtherBuilds('current', deps), 250);
		assert.equal(pauses, 2, 'a pause between each of the three chunks');
		assert.deepEqual([...deps.useCache.byId.keys()], [keyFor('current')]);
	});

	it('does nothing when the tables are not reachable', async () => {
		assert.equal(await sweepOtherBuilds('current', { databases: {} as never }), 0);
	});
});
