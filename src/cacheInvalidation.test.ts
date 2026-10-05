import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
	cacheInvalidations,
	chunk,
	entryExpiresAt,
	hydrateInvalidations,
	initializeInvalidationSubscription,
	invalidationFor,
	noteInvalidation,
	passedExpiration,
	pruneInvalidations,
	recordInvalidation,
	resetInvalidationStateForTesting,
	runWithConcurrency,
	sweepTag,
	tagState,
	tombstoneLifetimeMs,
	tombstoneToInvalidation,
	toStoredLife,
	type InvalidationDeps,
	type TagInvalidation,
} from './cacheInvalidation.cjs';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const MARGIN_MS = 3_600_000;

function invalidation(fields: Partial<TagInvalidation> & { at: number }): TagInvalidation {
	return { lapsesAt: Number.MAX_SAFE_INTEGER, ...fields };
}

type CacheRecord = { id: string; tags: string[]; lastModified?: number; timestamp?: number };

/**
 * A stand-in for a Harper cache table. `equals` on an array attribute matches an element exactly, the
 * way Harper's per-element index does — not a substring, which is what `contains` would do.
 */
function makeCacheTable(records: CacheRecord[], expirationMS = WEEK_MS) {
	const rows = new Map(records.map((record) => [record.id, record]));
	return {
		rows,
		expirationMS,
		deleted: [] as string[],
		conditions: [] as Array<{ attribute: string; comparator: string; value: unknown }>,
		search(request: { conditions: Array<{ attribute: string; comparator: string; value: unknown }> }) {
			this.conditions.push(...request.conditions);
			const matches = [...rows.values()].filter((record) =>
				request.conditions.every((condition) => {
					const actual = (record as unknown as Record<string, unknown>)[condition.attribute];
					if (condition.comparator !== 'equals') throw new Error(`unexpected comparator ${condition.comparator}`);
					return Array.isArray(actual) ? actual.includes(condition.value) : actual === condition.value;
				})
			);
			return (async function* () {
				for (const match of matches) yield { ...match };
			})();
		},
		async get(id: string) {
			return rows.get(id);
		},
		async delete(id: string) {
			this.deleted.push(id);
			rows.delete(id);
		},
	};
}

/**
 * A stand-in for the tombstone table. `put` keeps the row it would leave in storage, under Harper's
 * write-version rule: a write whose `context.timestamp` precedes the stored record's version "loses to
 * the existing record version" (`harper/resources/Table.ts:4770`) rather than replacing it. A write
 * carrying no version always lands, the way an unversioned `put` does. Modelling this is what lets a
 * test read a row back the way a worker that restarts would.
 */
function makeInvalidationTable(rows: Array<{ id: string } & Record<string, unknown>> = []) {
	return {
		rows,
		expirationMS: WEEK_MS,
		versions: new Map<string, number>(),
		puts: [] as Array<{
			key: string;
			value: Record<string, unknown>;
			context?: { expiresAt?: number; timestamp?: number };
		}>,
		async put(key: string, value: Record<string, unknown>, context?: { expiresAt?: number; timestamp?: number }) {
			this.puts.push({ key, value, context });
			const version = context?.timestamp;
			const stored = this.versions.get(key);
			if (version !== undefined && stored !== undefined && version < stored) return;
			if (version !== undefined) this.versions.set(key, version);
			const row = { id: key, ...value };
			const index = rows.findIndex((existing) => existing.id === key);
			if (index === -1) rows.push(row);
			else rows[index] = row;
		},
		searchCalls: 0,
		search() {
			this.searchCalls++;
			return (async function* () {
				for (const row of rows) yield row;
			})();
		},
		listener: undefined as undefined | ((event: { type: string; id: string; value?: Record<string, unknown> }) => void),
		/** Ends the latest subscription the way Harper does, with 'close'. */
		close: undefined as undefined | (() => void),
		errorListener: undefined as undefined | ((error: unknown) => void),
		subscribeCalls: 0,
		async subscribe() {
			this.subscribeCalls++;
			return {
				on: (event: string, listener: never) => {
					if (event === 'data') this.listener = listener;
					if (event === 'close') this.close = listener;
					if (event === 'error') this.errorListener = listener;
				},
			};
		},
	};
}

function makeDeps(
	overrides: {
		isr?: ReturnType<typeof makeCacheTable>;
		useCache?: ReturnType<typeof makeCacheTable>;
		invalidation?: ReturnType<typeof makeInvalidationTable>;
		now?: number;
	} = {}
): InvalidationDeps & { sleeps: number[]; errors: unknown[]; runSweeps: () => Promise<void>; sweepCount: () => number } {
	const isr = overrides.isr ?? makeCacheTable([]);
	const useCache = overrides.useCache ?? makeCacheTable([]);
	const invalidationTable = overrides.invalidation ?? makeInvalidationTable();
	const sleeps: number[] = [];
	const errors: unknown[] = [];
	const sweeps: Array<() => Promise<void>> = [];
	let swept = 0;
	return {
		sleeps,
		errors,
		maintenance: false,
		tagsManifestModule: null,
		now: overrides.now !== undefined ? () => overrides.now as number : undefined,
		scheduleSweep: (task) => {
			sweeps.push(task);
		},
		runSweeps: async () => {
			for (const sweep of sweeps.splice(0)) {
				swept++;
				await sweep();
			}
		},
		sweepCount: () => swept + sweeps.length,
		databases: {
			harperfast_nextjs: {
				nextjs_isr_cache: isr,
				nextjs_use_cache: useCache,
				nextjs_cache_invalidation: invalidationTable,
			},
		} as never,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		logger: {
			info: () => {},
			error: (...args: unknown[]) => {
				errors.push(args);
			},
		},
	};
}

describe('invalidationFor', () => {
	it('expires immediately when Next passes no durations', () => {
		assert.deepEqual(invalidationFor(1000, undefined, 10), { expired: 1000, at: 1000, lapsesAt: 1010 });
	});

	it('goes stale now and expires later when Next passes an expire duration', () => {
		const result = invalidationFor(1000, { expire: 60 }, 10);
		assert.equal(result.stale, 1000);
		assert.equal(result.expired, 61_000);
	});

	it('only goes stale when durations carry no expire', () => {
		const result = invalidationFor(1000, {}, 10);
		assert.equal(result.stale, 1000);
		assert.equal(result.expired, undefined);
	});
});

describe('tombstoneToInvalidation', () => {
	it('reads a row written before stale/expired existed as expired at its timestamp', () => {
		const result = tombstoneToInvalidation({ timestamp: 5000 });
		assert.equal(result?.expired, 5000);
		assert.equal(result?.stale, undefined);
		assert.equal(result?.lapsesAt, 5000 + WEEK_MS);
	});

	it('keeps the stale and expired a current row carries', () => {
		const result = tombstoneToInvalidation({ timestamp: 5000, stale: 5000, expired: 65_000, lapsesAt: 99_000 });
		assert.deepEqual(result, { stale: 5000, expired: 65_000, at: 5000, lapsesAt: 99_000 });
	});

	it('ignores an event that carries no timestamp', () => {
		assert.equal(tombstoneToInvalidation({}), undefined);
	});

	// The previous plugin wrote revalidateTag(tag, 'max') as `now + 1 year`. Ordered by that, the legacy
	// row outranked every invalidation issued after it, and they were all ignored until a restart.
	it('dates a legacy row written in the future no later than now, so newer invalidations win', () => {
		const now = 1_000_000;
		const legacy = tombstoneToInvalidation({ timestamp: now + 365 * DAY_MS }, now);
		assert.equal(legacy?.at, now);

		resetInvalidationStateForTesting();
		noteInvalidation('posts', legacy as TagInvalidation, { tagsManifestModule: null, now: () => now });
		noteInvalidation('posts', invalidation({ stale: now + 10, at: now + 10 }), { tagsManifestModule: null, now: () => now });
		assert.equal(cacheInvalidations.get('posts')?.stale, now + 10);
	});
});

describe('tagState', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('is expired when the tag expired after the entry was written', () => {
		cacheInvalidations.set('products', invalidation({ expired: 2000, at: 2000 }));
		assert.equal(tagState(['products'], 1000, 3000), 'expired');
	});

	it('is fresh when the entry was written after the invalidation', () => {
		cacheInvalidations.set('products', invalidation({ expired: 1000, at: 1000 }));
		assert.equal(tagState(['products'], 2000, 3000), undefined);
	});

	// revalidateTag(tag, 'max'): stale now, expired a year out. Treating the expiry as the stale time
	// kept every entry — including ones regenerated afterwards — stale or missing for the whole year.
	it('treats a deferred expiry as stale until it passes, and only for entries written before it', () => {
		const now = 10_000;
		cacheInvalidations.set('products', invalidation({ stale: now, expired: now + 365 * DAY_MS, at: now }));

		assert.equal(tagState(['products'], now - 1, now + 1), 'stale');
		assert.equal(tagState(['products'], now + 5, now + 10), undefined, 'a regenerated entry must be fresh');
		assert.equal(tagState(['products'], now - 1, now + 366 * DAY_MS), 'expired');
	});
});

describe('passedExpiration', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('reports the newest expiration that has passed', () => {
		cacheInvalidations.set('a', invalidation({ expired: 1000, at: 1000 }));
		cacheInvalidations.set('b', invalidation({ expired: 5000, at: 5000 }));
		assert.equal(passedExpiration(['a', 'b'], 6000), 5000);
	});

	it('does not report an expiration still in the future', () => {
		cacheInvalidations.set('a', invalidation({ stale: 1000, expired: 1000 + 365 * DAY_MS, at: 1000 }));
		assert.equal(passedExpiration(['a'], 2000), 0);
	});
});

describe('noteInvalidation', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('keeps the newest invalidation when views arrive out of order', () => {
		noteInvalidation('a', invalidation({ expired: 2000, at: 2000 }), { tagsManifestModule: null });
		noteInvalidation('a', invalidation({ expired: 1000, at: 1000 }), { tagsManifestModule: null });
		assert.equal(cacheInvalidations.get('a')?.at, 2000);
	});

	it('ignores an invalidation whose tombstone has already lapsed', () => {
		noteInvalidation('a', invalidation({ expired: 1000, at: 1000, lapsesAt: 1500 }), {
			tagsManifestModule: null,
			now: () => 2000,
		});
		assert.equal(cacheInvalidations.has('a'), false);
	});
});

describe('Next tags manifest mirror', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('writes {stale, expired} for Next 16', () => {
		const tagsManifest = new Map<string, unknown>();
		const next16 = { tagsManifest, areTagsStale: () => false };

		noteInvalidation('a', invalidation({ stale: 1000, expired: 61_000, at: 1000 }), { tagsManifestModule: next16 });

		assert.deepEqual(tagsManifest.get('a'), { stale: 1000, expired: 61_000 });
	});

	// Next 15 keys a number per tag. Setting `.stale` on that number throws in strict mode, and writing an
	// object makes Next's own `Math.max` over the manifest NaN.
	it('writes a timestamp, not an object, for Next 15', () => {
		const tagsManifest = new Map<string, unknown>([['a', 500]]);
		const next15 = { tagsManifest, isStale: () => false };

		noteInvalidation('a', invalidation({ expired: 1000, at: 1000 }), { tagsManifestModule: next15 });

		assert.equal(tagsManifest.get('a'), 1000);
	});

	it('does nothing for Next 14, which has no manifest', () => {
		assert.doesNotThrow(() => noteInvalidation('a', invalidation({ expired: 1000, at: 1000 }), { tagsManifestModule: null }));
	});

	it('withdraws a pruned invalidation only if the manifest still holds it', () => {
		const tagsManifest = new Map<string, unknown>();
		const deps = { tagsManifestModule: { tagsManifest, areTagsStale: () => false }, now: () => 5000 };
		noteInvalidation('mine', invalidation({ expired: 1000, at: 1000, lapsesAt: 6000 }), deps);
		noteInvalidation('rewritten', invalidation({ expired: 1000, at: 1000, lapsesAt: 6000 }), deps);
		tagsManifest.set('rewritten', { expired: 4000 });

		pruneInvalidations({ ...deps, now: () => 7000 });

		assert.equal(tagsManifest.has('mine'), false);
		assert.deepEqual(tagsManifest.get('rewritten'), { expired: 4000 }, 'Next wrote this tag itself since');
	});
});

describe('pruneInvalidations', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('drops invalidations whose tombstone has lapsed and keeps the rest', () => {
		cacheInvalidations.set('old', invalidation({ expired: 1, at: 1, lapsesAt: 100 }));
		cacheInvalidations.set('live', invalidation({ expired: 1, at: 1, lapsesAt: 10_000 }));

		pruneInvalidations({ tagsManifestModule: null, now: () => 5000 });

		assert.deepEqual([...cacheInvalidations.keys()], ['live']);
	});
});

describe('entryExpiresAt', () => {
	it("expires an entry when Next says it stops being usable", () => {
		assert.equal(entryExpiresAt(1000, 3600, 1000), 1000 + 3_600_000);
	});

	// Past the 7-day table TTL, so the `weeks` and `max` profiles keep their stale-while-revalidate window.
	it("keeps an entry past the table's expiration", () => {
		assert.equal(entryExpiresAt(1000, 30 * 86_400, 1000), 1000 + 30 * DAY_MS);
	});

	// The cap is what keeps every entry inside the lifetime its tombstones are sized for.
	it('caps an entry at a year', () => {
		assert.equal(entryExpiresAt(1000, 0xfffffffe, 1000), 1000 + YEAR_MS);
	});

	it('leaves the table default when Next gives no usable expire', () => {
		assert.equal(entryExpiresAt(1000, undefined), undefined);
		assert.equal(entryExpiresAt(1000, 0), undefined);
	});
});

describe('toStoredLife', () => {
	it('floors a fractional life', () => {
		assert.equal(toStoredLife(900.7), 900);
	});

	// Next's INFINITE_CACHE (0xfffffffe) does not fit Harper's 32-bit Int column.
	it('bounds a life to a year, which fits an Int column', () => {
		assert.equal(toStoredLife(0xfffffffe), 31_536_000);
		assert.equal(toStoredLife(Infinity), 31_536_000);
		assert.ok(toStoredLife(0xfffffffe)! <= 2_147_483_647);
	});

	it('never stores a negative life', () => {
		assert.equal(toStoredLife(-Infinity), 0);
		assert.equal(toStoredLife(-5), 0);
	});

	it('stores nothing for a missing life', () => {
		assert.equal(toStoredLife(undefined), undefined);
		assert.equal(toStoredLife(NaN), undefined);
	});
});

describe('tombstoneLifetimeMs', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('outlives the longest an entry is kept, by the margin', () => {
		const deps = makeDeps({ isr: makeCacheTable([], 2 * DAY_MS), useCache: makeCacheTable([], 9 * DAY_MS) });
		assert.equal(tombstoneLifetimeMs(deps), YEAR_MS + MARGIN_MS);
	});

	// A row written without an expire lives the table's expiration, which may be set longer than the cap.
	it('outlives a cache table whose expiration is longer than a year', () => {
		const deps = makeDeps({ useCache: makeCacheTable([], 2 * YEAR_MS) });
		assert.equal(tombstoneLifetimeMs(deps), 2 * YEAR_MS + MARGIN_MS);
	});

	it('reports once when a cache table has no expiration, since nothing can then bound a tombstone', () => {
		const deps = makeDeps({ useCache: makeCacheTable([], 0) });
		tombstoneLifetimeMs(deps);
		tombstoneLifetimeMs(deps);
		assert.equal(deps.errors.length, 1);
	});
});

describe('recordInvalidation', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('persists a tombstone per tag, dated now, that outlives every entry it can invalidate', async () => {
		const invalidationTable = makeInvalidationTable();
		const deps = makeDeps({ invalidation: invalidationTable, now: 1_000_000 });

		await recordInvalidation(['products', 'deals', 'products'], undefined, deps);

		assert.deepEqual(invalidationTable.puts.map((put) => put.key).sort(), ['deals', 'products'], 'deduplicated');
		const [put] = invalidationTable.puts;
		assert.equal(put.value.timestamp, 1_000_000);
		assert.equal(put.value.expired, 1_000_000);
		assert.equal(put.value.lapsesAt, 1_000_000 + YEAR_MS + MARGIN_MS);
		assert.equal(put.context?.expiresAt, put.value.lapsesAt, 'the per-record expiry is what outlasts the table TTL');
		assert.ok(cacheInvalidations.has('products'), 'this worker sees it before the write returns');
	});

	it('dates a deferred expiry from now, not from when it expires', async () => {
		const invalidationTable = makeInvalidationTable();
		const deps = makeDeps({ invalidation: invalidationTable, now: 1_000_000 });

		await recordInvalidation(['products'], { expire: 60 }, deps);

		const [put] = invalidationTable.puts;
		assert.equal(put.value.timestamp, 1_000_000);
		assert.equal(put.value.stale, 1_000_000);
		assert.equal(put.value.expired, 1_060_000);
	});

	// Harper drops a write whose version precedes the stored one, so an invalidation that is issued first
	// but lands last cannot replace a newer tombstone.
	it('makes each tombstone write versioned by its issue time', async () => {
		const invalidationTable = makeInvalidationTable();

		await recordInvalidation(['products'], undefined, makeDeps({ invalidation: invalidationTable, now: 1000 }));

		assert.equal(invalidationTable.puts[0].context?.timestamp, 1000);
	});

	it('versions a second invalidation issued in the same millisecond after the first', async () => {
		const invalidationTable = makeInvalidationTable();
		const deps = makeDeps({ invalidation: invalidationTable, now: 1000 });

		await recordInvalidation(['products'], { expire: 60 }, deps);
		await new Promise((resolve) => setImmediate(resolve));
		await recordInvalidation(['products'], undefined, deps);

		const [first, second] = invalidationTable.puts.map((put) => put.context?.timestamp as number);
		assert.ok(second > first, 'a tie keeps the stored record, which would drop the newer invalidation');
		assert.ok(second - first < 1, 'the version stays within the millisecond it was issued in');
	});

	it('keeps the stale time of an earlier invalidation a hard expiry does not replace', async () => {
		const invalidationTable = makeInvalidationTable();
		await recordInvalidation(['products'], { expire: 60 }, makeDeps({ invalidation: invalidationTable, now: 1000 }));
		await recordInvalidation(['products'], undefined, makeDeps({ invalidation: invalidationTable, now: 2000 }));

		assert.deepEqual(invalidationTable.puts[1].value, {
			timestamp: 2000,
			stale: 1000,
			expired: 2000,
			lapsesAt: 2000 + YEAR_MS + MARGIN_MS,
		});
	});

	// Next reaches both handlers for one revalidateTag, in the same turn.
	it('records a revalidateTag that reaches both handlers only once', async () => {
		const invalidationTable = makeInvalidationTable();
		const deps = makeDeps({ invalidation: invalidationTable, now: 1000 });

		await Promise.all([recordInvalidation(['products'], undefined, deps), recordInvalidation(['products'], undefined, deps)]);

		assert.equal(invalidationTable.puts.length, 1);
		assert.equal(deps.sweepCount(), 1);

		await new Promise((resolve) => setImmediate(resolve));
		await recordInvalidation(['products'], undefined, deps);
		assert.equal(invalidationTable.puts.length, 2, 'a later invalidation of the same tag is recorded');
	});

	it('sweeps a hard expiry, including implicit route tags', async () => {
		const isr = makeCacheTable([{ id: '/a', tags: ['_N_T_/layout'], lastModified: 500 }]);
		const deps = makeDeps({ isr, now: 1000 });

		await recordInvalidation(['_N_T_/layout'], undefined, deps);
		await deps.runSweeps();

		assert.deepEqual(isr.deleted, ['/a']);
	});

	it('does not sweep a stale-then-expire invalidation, which the tombstone alone must carry', async () => {
		const isr = makeCacheTable([{ id: '/a', tags: ['products'], lastModified: 500 }]);
		const deps = makeDeps({ isr, now: 1000 });

		await recordInvalidation(['products'], { expire: 60 }, deps);

		assert.equal(deps.sweepCount(), 0);
		assert.deepEqual(isr.deleted, [], 'a stale entry must stay servable while it regenerates');
	});
});

describe('sweepTag', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	// Harper 5.2.0 refuses an indexed lookup while it reports the index as rebuilding — and can keep
	// reporting that on every worker but one until they restart.
	it('falls back to an exact-match scan while Harper reports the tags index as rebuilding', async () => {
		const isr = makeCacheTable([
			{ id: '/posts', tags: ['posts'], lastModified: 500 },
			{ id: '/archive', tags: ['posts-archive'], lastModified: 500 },
		]);
		const search = isr.search.bind(isr);
		isr.search = (request) => {
			if (request.conditions.length > 0) {
				const error = new Error('"tags" is not indexed yet, can not search for this attribute');
				error.name = 'IndexRebuildingError';
				return (async function* () {
					throw error;
				})();
			}
			return (async function* () {
				for (const row of isr.rows.values()) yield { ...row };
			})();
		};
		void search;
		const deps = makeDeps({ isr });

		await sweepTag('posts', 1000, deps);

		assert.deepEqual(isr.deleted, ['/posts']);
	});

	it('looks entries up by tag with an index-backed equals, not a substring scan', async () => {
		const isr = makeCacheTable([
			{ id: '/posts', tags: ['posts'], lastModified: 500 },
			{ id: '/archive', tags: ['posts-archive'], lastModified: 500 },
		]);
		const deps = makeDeps({ isr });

		await sweepTag('posts', 1000, deps);

		assert.deepEqual(isr.deleted, ['/posts'], '`contains` would also have matched posts-archive');
		assert.deepEqual(
			isr.conditions.map((condition) => condition.comparator),
			['equals']
		);
	});

	it('leaves entries written after the invalidation', async () => {
		const isr = makeCacheTable([
			{ id: '/stale', tags: ['products'], lastModified: 500 },
			{ id: '/fresh', tags: ['products'], lastModified: 1500 },
		]);
		const deps = makeDeps({ isr });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(isr.deleted, ['/stale']);
	});

	it('spares an entry regenerated between the search and the delete', async () => {
		const isr = makeCacheTable([{ id: '/raced', tags: ['products'], lastModified: 500 }]);
		const search = isr.search.bind(isr);
		isr.search = (request) => {
			const results = search(request);
			isr.rows.set('/raced', { id: '/raced', tags: ['products'], lastModified: 1500 });
			return results;
		};
		const deps = makeDeps({ isr });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(isr.deleted, []);
	});

	it('sweeps both cache tables, each on its own write-time column', async () => {
		const isr = makeCacheTable([{ id: '/page', tags: ['products'], lastModified: 500 }]);
		const useCache = makeCacheTable([{ id: 'uc-1', tags: ['products'], timestamp: 500 }]);
		const deps = makeDeps({ isr, useCache });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(isr.deleted, ['/page']);
		assert.deepEqual(useCache.deleted, ['uc-1']);
	});

	it('pauses between chunks but not after the final one', async () => {
		const many = Array.from({ length: 250 }, (_, index) => ({
			id: `/page-${index}`,
			tags: ['products'],
			lastModified: 500,
		}));
		const deps = makeDeps({ isr: makeCacheTable(many) });

		await sweepTag('products', 1000, deps);

		// 250 records over a 100-record chunk size = 3 chunks = 2 inter-chunk pauses.
		assert.equal(deps.sleeps.length, 2);
	});
});

describe('surviving a worker restart', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('restores an invalidation the dead worker had only in memory', async () => {
		await hydrateInvalidations(makeInvalidationTable([{ id: 'products', timestamp: 2000 }]), {
			tagsManifestModule: null,
			now: () => 3000,
		});

		assert.equal(tagState(['products'], 1000, 3000), 'expired', 'the invalidation did not survive the restart');
	});

	it('does not resurrect an entry written after the invalidation', async () => {
		await hydrateInvalidations(makeInvalidationTable([{ id: 'products', timestamp: 2000 }]), {
			tagsManifestModule: null,
			now: () => 3000,
		});

		assert.equal(tagState(['products'], 5000, 6000), undefined);
	});
});

describe('initializeInvalidationSubscription', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('subscribes before hydrating, so an invalidation written during the scan is not lost', async () => {
		const invalidationTable = makeInvalidationTable([{ id: 'old', timestamp: 1000 }]);
		const search = invalidationTable.search.bind(invalidationTable);
		invalidationTable.search = () => {
			// Another worker's invalidation lands while this one is still reading the table back.
			invalidationTable.listener?.({ type: 'put', id: 'during', value: { timestamp: 2000 } });
			return search();
		};
		const deps = makeDeps({ invalidation: invalidationTable, now: 3000 });

		await initializeInvalidationSubscription(deps);

		assert.ok(cacheInvalidations.has('old'));
		assert.ok(cacheInvalidations.has('during'));
	});

	it('shares one attempt between concurrent callers, and reads are only served after it completes', async () => {
		const invalidationTable = makeInvalidationTable([{ id: 'products', timestamp: 2000 }]);
		const deps = makeDeps({ invalidation: invalidationTable, now: 3000 });

		const first = initializeInvalidationSubscription(deps);
		const second = initializeInvalidationSubscription(deps);
		await Promise.all([first, second]);

		assert.equal(invalidationTable.subscribeCalls, 1);
		assert.ok(cacheInvalidations.has('products'), 'awaiting the shared attempt yields a hydrated map');
	});

	it('backs off after a failure rather than retrying on every request', async () => {
		const invalidationTable = makeInvalidationTable();
		invalidationTable.subscribe = async () => {
			invalidationTable.subscribeCalls++;
			throw new Error('subscribe failed');
		};
		const deps = makeDeps({ invalidation: invalidationTable, now: 1000 });

		await initializeInvalidationSubscription(deps);
		await initializeInvalidationSubscription(deps);
		await initializeInvalidationSubscription(deps);

		assert.equal(invalidationTable.subscribeCalls, 1);
		assert.equal(deps.errors.length, 1);
	});

	it('reports the view as not ready until hydration succeeds', async () => {
		let now = 1000;
		const invalidationTable = makeInvalidationTable([{ id: 'products', timestamp: 500 }]);
		const search = invalidationTable.search.bind(invalidationTable);
		let failing = true;
		invalidationTable.search = () => {
			if (failing) throw new Error('scan failed');
			return search();
		};
		const deps = { ...makeDeps({ invalidation: invalidationTable }), now: () => now };

		assert.equal(await initializeInvalidationSubscription(deps), false);
		assert.equal(await initializeInvalidationSubscription(deps), false, 'still not ready while backing off');

		failing = false;
		now += 60_000;
		assert.equal(await initializeInvalidationSubscription(deps), true);
		assert.equal(invalidationTable.subscribeCalls, 1, 'the retry reuses the live subscription');
		assert.ok(cacheInvalidations.has('products'));
	});

	it('re-subscribes and re-hydrates after the subscription ends', async () => {
		const invalidationTable = makeInvalidationTable([{ id: 'old', timestamp: 1000 }]);
		const deps = makeDeps({ invalidation: invalidationTable, now: 3000 });
		assert.equal(await initializeInvalidationSubscription(deps), true);

		invalidationTable.close?.();
		// Written while nothing was listening.
		invalidationTable.rows.push({ id: 'missed', timestamp: 2000 });

		assert.equal(await initializeInvalidationSubscription(deps), true);
		assert.equal(invalidationTable.subscribeCalls, 2);
		assert.ok(cacheInvalidations.has('missed'), 'the re-hydration recovers what the dead subscription missed');
		assert.equal(deps.errors.length, 1, 'the lost subscription is logged');
	});

	it('ignores the end of a subscription it has already replaced', async () => {
		const invalidationTable = makeInvalidationTable();
		const deps = makeDeps({ invalidation: invalidationTable, now: 3000 });
		await initializeInvalidationSubscription(deps);
		const staleClose = invalidationTable.close;
		staleClose?.();
		await initializeInvalidationSubscription(deps);

		staleClose?.();

		assert.equal(await initializeInvalidationSubscription(deps), true);
		assert.equal(invalidationTable.subscribeCalls, 2);
	});

	it('forgets an invalidation when its tombstone is deleted', async () => {
		const invalidationTable = makeInvalidationTable([{ id: 'products', timestamp: 2000 }]);
		const deps = makeDeps({ invalidation: invalidationTable, now: 3000 });
		await initializeInvalidationSubscription(deps);

		invalidationTable.listener?.({ type: 'delete', id: 'products' });

		assert.equal(cacheInvalidations.has('products'), false);
	});
});

// The read-path half of this defect is asserted through the handlers themselves, in
// CacheHandler.test.ts and UseCacheHandler.test.ts: what has to hold is that a read misses, not where
// in the call chain that is decided.
describe('recovering from a failed start-up', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	// Failing a read closed while the tombstones are unreadable must not become permanent. Passes today;
	// it pins that whatever makes the handler tests pass still recovers once storage answers again.
	it('knows the invalidation once the retry succeeds', async () => {
		const table = makeInvalidationTable([{ id: 'products', timestamp: 2000 }]);
		const search = table.search.bind(table);
		let failing = true;
		table.search = () =>
			failing
				? (async function* () {
						throw new Error('storage unavailable');
					})()
				: search();
		const deps = makeDeps({ invalidation: table });
		let clock = 3000;
		deps.now = () => clock;

		await initializeInvalidationSubscription(deps);
		failing = false;
		// Past the 1s minimum backoff, so the next read is allowed to retry.
		clock += 2000;
		await initializeInvalidationSubscription(deps);

		assert.equal(tagState(['products'], 1000, clock), 'expired');
	});
});

describe('recovering from a lost subscription', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	// The 'error' half of the fix: 'close' is Harper's own end event, but a subscription reported as
	// errored has equally stopped delivering, and a worker that kept `initialized` set would serve
	// entries other nodes invalidated until it restarted.
	it('reloads the tombstones after the subscription errors', async () => {
		const table = makeInvalidationTable();
		const deps = makeDeps({ invalidation: table });
		let clock = 3000;
		deps.now = () => clock;

		await initializeInvalidationSubscription(deps);
		assert.equal(table.searchCalls, 1);

		// The subscription drops, then another node invalidates the tag. No event is delivered.
		table.errorListener?.(new Error('subscription closed'));
		table.rows.push({ id: 'products', timestamp: 4000 });
		clock = 5000;

		// The next read, which every `get` makes.
		await initializeInvalidationSubscription(deps);

		assert.equal(table.searchCalls, 2, 'the worker kept trusting a map that had stopped updating');
		assert.equal(tagState(['products'], 1000, clock), 'expired');
	});
});

describe('concurrent invalidations of one tag', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	// Two nodes invalidate the same tag and the older `put` commits last. What has to hold is the row
	// left in storage, so this reads it back the way a worker that restarts would: the in-memory map
	// orders the two correctly on a running worker and would hide a regression there.
	it('does not let an older write replace a newer tombstone', async () => {
		const table = makeInvalidationTable();
		let releaseOlder = () => {};
		const held = new Promise<void>((resolve) => {
			releaseOlder = resolve;
		});
		const put = table.put.bind(table);
		table.put = async (key, value, context) => {
			if (value.timestamp === 1000) await held;
			return put(key, value, context);
		};

		const older = recordInvalidation(['products'], undefined, makeDeps({ invalidation: table, now: 1000 }));
		// A later turn, so the per-turn deduplication does not swallow the second node's invalidation.
		await new Promise((resolve) => setImmediate(resolve));
		await recordInvalidation(['products'], undefined, makeDeps({ invalidation: table, now: 2000 }));
		releaseOlder();
		await older;

		// A worker that starts now sees only what storage holds.
		resetInvalidationStateForTesting();
		await hydrateInvalidations(table, { tagsManifestModule: null, now: () => 3000 });

		assert.equal(
			tagState(['products'], 1500, 3000),
			'expired',
			'an entry written between the two invalidations survived the newer one'
		);
	});
});

// FAILS: still open. `recordInvalidation` nudges each write's Harper version past the last so a
// same-millisecond pair cannot tie, but that version lives only in the write context — the row's own
// `timestamp` stays the whole millisecond, and events carry no version at all. `noteInvalidation`
// orders by that integer and lets an equal `at` overwrite, so on the one path where the two orderings
// disagree the older view can win.
describe('two invalidations issued in the same millisecond', () => {
	beforeEach(() => resetInvalidationStateForTesting());

	it('does not let an older hydration row downgrade a newer hard expiry', async () => {
		const lapsesAt = 1000 + YEAR_MS;
		// What the start-up scan finds: the earlier, profiled invalidation.
		const table = makeInvalidationTable([{ id: 'products', timestamp: 1000, stale: 1000, expired: 61_000, lapsesAt }]);
		const search = table.search.bind(table);
		table.search = () => {
			// The later hard expiry arrives on the subscription while that scan is still running, so the
			// scan's older row is applied second.
			table.listener?.({ type: 'put', id: 'products', value: { timestamp: 1000, expired: 1000, lapsesAt } });
			return search();
		};
		const deps = makeDeps({ invalidation: table, now: 2000 });

		await initializeInvalidationSubscription(deps);

		assert.equal(
			tagState(['products'], 500, 2000),
			'expired',
			'the hard expiry was downgraded to stale, so the worker serves what it had to withhold'
		);
	});
});

describe('chunk', () => {
	it('splits into fixed-size batches with a short tail', () => {
		assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	});

	it('returns nothing for an empty input', () => {
		assert.deepEqual(chunk([], 10), []);
	});
});

describe('runWithConcurrency', () => {
	it('never exceeds the concurrency limit', async () => {
		let active = 0;
		let peak = 0;
		await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
			active += 1;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active -= 1;
		});
		assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
	});

	it('processes every item', async () => {
		const seen: number[] = [];
		await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
			seen.push(item);
		});
		assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
	});
});
