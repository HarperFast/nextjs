import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
	NEXT_IMPLICIT_TAG_PREFIX,
	cacheInvalidations,
	chunk,
	isInvalidated,
	isSweepableTag,
	noteInvalidation,
	recordInvalidation,
	runWithConcurrency,
	sweepTag,
	hydrateInvalidations,
	type InvalidationDeps,
} from './cacheInvalidation.cjs';

/** A stand-in for a Harper cache table: records in a Map, with search/invalidate/delete recorded. */
function makeCacheTable(records: Array<{ id: string; tags: string[]; lastModified?: number; timestamp?: number }>) {
	return {
		records,
		patched: [] as string[],
		deleted: [] as string[],
		search(request: { conditions: Array<{ attribute: string; comparator: string; value: unknown }>; select?: string[] }) {
			const matches = records.filter((record) =>
				request.conditions.every((condition) => {
					const actual = (record as unknown as Record<string, unknown>)[condition.attribute];
					if (condition.comparator === 'contains') return Array.isArray(actual) && actual.includes(condition.value as string);
					if (condition.comparator === 'less_than') return (actual as number) < (condition.value as number);
					return actual === condition.value;
				})
			);
			return (async function* () {
				for (const match of matches) yield match;
			})();
		},
		async patch(id: string, value: { invalidatedAt: number }) {
			this.patched.push(id);
			const record = records.find((candidate) => candidate.id === id);
			if (record) (record as Record<string, unknown>).invalidatedAt = value.invalidatedAt;
		},
		async delete(id: string) {
			this.deleted.push(id);
		},
	};
}

function makeInvalidationTable(recordCount = 0) {
	return {
		puts: [] as Array<{ key: string; value: { timestamp: number } }>,
		deleted: [] as string[],
		async put(key: string, value: { timestamp: number }) {
			this.puts.push({ key, value });
		},
		async delete(key: string) {
			this.deleted.push(key);
		},
		async getRecordCount() {
			return { recordCount };
		},
	};
}

function makeDeps(
	overrides: {
		isr?: ReturnType<typeof makeCacheTable>;
		useCache?: ReturnType<typeof makeCacheTable>;
		invalidation?: ReturnType<typeof makeInvalidationTable>;
	} = {}
): InvalidationDeps & { sleeps: number[]; errors: unknown[]; pendingSweeps: () => Promise<void> } {
	const isr = overrides.isr ?? makeCacheTable([]);
	const useCache = overrides.useCache ?? makeCacheTable([]);
	const invalidation = overrides.invalidation ?? makeInvalidationTable();
	const sleeps: number[] = [];
	const errors: unknown[] = [];
	const sweeps: Array<() => Promise<void>> = [];
	return {
		sleeps,
		errors,
		scheduleSweep: (task) => {
			sweeps.push(task);
		},
		pendingSweeps: async () => {
			for (const sweep of sweeps.splice(0)) await sweep();
		},
		databases: {
			harperfast_nextjs: {
				nextjs_isr_cache: isr,
				nextjs_use_cache: useCache,
				nextjs_cache_invalidation: invalidation,
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

describe('isInvalidated', () => {
	beforeEach(() => cacheInvalidations.clear());

	it('is true when a tag was invalidated after the entry was written', () => {
		cacheInvalidations.set('products', 2000);
		assert.equal(isInvalidated(['products'], 1000, [], []), true);
	});

	it('is false when the entry was written after the invalidation', () => {
		cacheInvalidations.set('products', 1000);
		assert.equal(isInvalidated(['products'], 2000, [], []), false);
	});

	it('honours per-request revalidatedTags', () => {
		assert.equal(isInvalidated(['products'], 5000, ['products'], []), true);
	});

	it('falls back to context tags when the record carries none', () => {
		cacheInvalidations.set('products', 2000);
		assert.equal(isInvalidated([], 1000, [], ['products']), true);
	});
});

describe('isSweepableTag', () => {
	it('rejects Next implicit route tags, which can match the whole cache', () => {
		assert.equal(isSweepableTag(`${NEXT_IMPLICIT_TAG_PREFIX}/layout`), false);
		assert.equal(isSweepableTag(`${NEXT_IMPLICIT_TAG_PREFIX}/guest-home/page`), false);
	});

	it('accepts explicit user tags', () => {
		assert.equal(isSweepableTag('products'), true);
		assert.equal(isSweepableTag('home:TN:12'), true);
	});
});

describe('noteInvalidation', () => {
	beforeEach(() => cacheInvalidations.clear());

	it('records the timestamp so reads on this worker see it immediately', () => {
		noteInvalidation(['a', 'b'], 1234);
		assert.equal(cacheInvalidations.get('a'), 1234);
		assert.equal(cacheInvalidations.get('b'), 1234);
	});
});

describe('sweepTag', () => {
	beforeEach(() => cacheInvalidations.clear());

	it('invalidates matching records rather than deleting them, preserving stale-while-revalidate', async () => {
		const isr = makeCacheTable([
			{ id: '/a', tags: ['products'], lastModified: 500 },
			{ id: '/b', tags: ['products'], lastModified: 500 },
		]);
		const deps = makeDeps({ isr });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(isr.patched.sort(), ['/a', '/b']);
		assert.deepEqual(isr.deleted, [], 'must mark, not destroy — a miss costs a full render');
	});

	it('skips records written after the invalidation timestamp', async () => {
		const isr = makeCacheTable([
			{ id: '/stale', tags: ['products'], lastModified: 500 },
			{ id: '/fresh', tags: ['products'], lastModified: 1500 },
		]);
		const deps = makeDeps({ isr });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(isr.patched, ['/stale']);
	});

	it('sweeps both cache tables, each on its own time column', async () => {
		const isr = makeCacheTable([{ id: '/page', tags: ['products'], lastModified: 500 }]);
		const useCache = makeCacheTable([{ id: 'uc-1', tags: ['products'], timestamp: 500 }]);
		const deps = makeDeps({ isr, useCache });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(isr.patched, ['/page']);
		assert.deepEqual(useCache.patched, ['uc-1']);
	});

	it('clears the invalidation row once the sweep completes', async () => {
		const invalidation = makeInvalidationTable();
		const deps = makeDeps({ invalidation });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(invalidation.deleted, ['products']);
	});

	it('pauses between chunks but not after the final one', async () => {
		const many = Array.from({ length: 250 }, (_, index) => ({
			id: `/page-${index}`,
			tags: ['products'],
			lastModified: 500,
		}));
		const deps = makeDeps({ isr: makeCacheTable(many) });

		await sweepTag('products', 1000, deps);

		// 250 records over a 100-record chunk size = 3 chunks = 2 inter-chunk pauses, per table.
		assert.equal(deps.sleeps.length, 2);
	});

	it('leaves the invalidation row in place when the sweep fails, so soft invalidation still covers reads', async () => {
		const isr = makeCacheTable([{ id: '/a', tags: ['products'], lastModified: 500 }]);
		isr.patch = async () => {
			throw new Error('boom');
		};
		const invalidation = makeInvalidationTable();
		const deps = makeDeps({ isr, invalidation });

		await sweepTag('products', 1000, deps);

		assert.deepEqual(invalidation.deleted, [], 'row must survive a failed sweep');
		assert.equal(deps.errors.length, 1, 'failure is logged, not thrown');
	});
});

describe('recordInvalidation', () => {
	beforeEach(() => cacheInvalidations.clear());

	it('writes a row per tag and updates the in-memory map synchronously', async () => {
		const invalidation = makeInvalidationTable();
		const deps = makeDeps({ invalidation });

		await recordInvalidation(['products', 'deals'], undefined, deps);

		assert.deepEqual(
			invalidation.puts.map((put) => put.key).sort(),
			['deals', 'products']
		);
		assert.ok(cacheInvalidations.has('products'));
		assert.ok(cacheInvalidations.has('deals'));
	});

	it('does not sweep Next implicit tags', async () => {
		const isr = makeCacheTable([{ id: '/a', tags: [`${NEXT_IMPLICIT_TAG_PREFIX}/layout`], lastModified: 500 }]);
		const deps = makeDeps({ isr });

		await recordInvalidation([`${NEXT_IMPLICIT_TAG_PREFIX}/layout`], undefined, deps);
		await deps.pendingSweeps?.();

		assert.deepEqual(isr.patched, [], 'implicit tags are left to TTL');
	});

	it('skips sweeping when the invalidation table is over the admission threshold', async () => {
		const isr = makeCacheTable([{ id: '/a', tags: ['products'], lastModified: 500 }]);
		const deps = makeDeps({ isr, invalidation: makeInvalidationTable(100_000) });

		await recordInvalidation(['products'], undefined, deps);
		await deps.pendingSweeps?.();

		assert.deepEqual(isr.patched, [], 'sweep is shed under backpressure; soft invalidation still applies');
	});
});

describe('surviving a worker restart', () => {
	beforeEach(() => cacheInvalidations.clear());

	/** A tombstone table as a restarted worker would find it. */
	function tombstoneTable(rows: Array<{ id: string; timestamp: number }>) {
		return {
			search() {
				return (async function* () {
					for (const row of rows) yield row;
				})();
			},
		};
	}

	it('restores an invalidation the dead worker had only in memory', async () => {
		// A worker invalidated a tag, then died before the entry was regenerated. Coming back with an
		// empty map, it would serve the stale entry as fresh if the tombstone were not read back.
		cacheInvalidations.set('products', 2000);
		cacheInvalidations.clear();

		await hydrateInvalidations(tombstoneTable([{ id: 'products', timestamp: 2000 }]));

		assert.equal(
			isInvalidated(['products'], 1000, [], []),
			true,
			'the invalidation did not survive the restart'
		);
	});

	it('does not resurrect an entry written after the invalidation', async () => {
		await hydrateInvalidations(tombstoneTable([{ id: 'products', timestamp: 2000 }]));

		assert.equal(isInvalidated(['products'], 5000, [], []), false);
	});

	it('leaves the tombstone in place when the sweep fails, so the next restart still sees it', async () => {
		const isr = makeCacheTable([{ id: '/a', tags: ['products'], lastModified: 500 }]);
		isr.patch = async () => {
			throw new Error('sweep died mid-run');
		};
		const invalidation = makeInvalidationTable();
		const deps = makeDeps({ isr, invalidation });

		await sweepTag('products', 1000, deps);
		cacheInvalidations.clear();
		await hydrateInvalidations(tombstoneTable([{ id: 'products', timestamp: 1000 }]));

		assert.deepEqual(invalidation.deleted, []);
		assert.equal(isInvalidated(['products'], 500, [], []), true);
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
