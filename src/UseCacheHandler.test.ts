import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { cacheInvalidations } from './cacheInvalidation.cjs';
import { toStorageKey } from './UseCacheHandler.cjs';

interface UseCacheEntry {
	value: ReadableStream<Uint8Array>;
	tags: string[];
	stale: number;
	timestamp: number;
	expire: number;
	revalidate: number;
}

interface UseCacheHandler {
	get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined>;
	set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>;
	refreshTags(): Promise<void>;
	getExpiration(tags: string[]): Promise<number>;
	updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

// Next loads this module with `interopDefault(await import(...))` and uses the result directly, so the
// default export is an instance rather than a class.
const handler = createRequire(import.meta.url)('./UseCacheHandler.cjs').default as UseCacheHandler;

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function erroringStream(partial: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(partial));
			controller.error(new Error('render aborted'));
		},
	});
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function entry(overrides: Partial<UseCacheEntry> = {}): UseCacheEntry {
	return {
		value: streamOf('hello'),
		tags: [],
		stale: 60,
		timestamp: Date.now(),
		expire: 3600,
		revalidate: 300,
		...overrides,
	};
}

/**
 * Harper rejects a non-integer for a Long/Int column. Next derives entry timestamps from
 * `performance.timeOrigin + performance.now()`, which is fractional, so a mock that accepts anything
 * hides a write that real Harper refuses outright.
 */
const INTEGER_COLUMNS = ['timestamp', 'stale', 'revalidate', 'expire'];

/**
 * Harper caps a primary key at MAX_KEY_BYTES = 1978 (harper/resources/Table.ts:146) and
 * throws `Primary key size is too large`. The mock must too: Next puts no limit on a
 * "use cache" key, and a mock that accepts any key is exactly how an 87,465-byte key
 * reached production and killed the stream.
 */
const HARPER_MAX_KEY_BYTES = 1978;

function enforcePrimaryKey(key: string) {
	const bytes = Buffer.byteLength(String(key), 'utf8');
	if (bytes > HARPER_MAX_KEY_BYTES) {
		throw new Error(`Primary key size is too large: ${bytes}`);
	}
}

function enforceSchema(value: Record<string, unknown>) {
	for (const column of INTEGER_COLUMNS) {
		const columnValue = value[column];
		if (columnValue !== undefined && columnValue !== null && !Number.isInteger(columnValue)) {
			throw new Error(`Value ${String(columnValue)} in property ${column} must be an integer`);
		}
	}
}

function installDatabases() {
	const rows = new Map<string, Record<string, unknown>>();
	(globalThis as Record<string, unknown>).databases = {
		harperfast_nextjs: {
			nextjs_use_cache: {
				async get(key: string) {
					return rows.get(key);
				},
				async put(key: string, value: Record<string, unknown>) {
					enforcePrimaryKey(key);
					enforceSchema(value);
					rows.set(key, { id: key, ...value });
				},
				search() {
					return (async function* () {})();
				},
				async invalidate() {},
			},
			nextjs_isr_cache: {
				search() {
					return (async function* () {})();
				},
				async invalidate() {},
			},
			nextjs_cache_invalidation: {
				puts: [] as Array<{ key: string; value: { timestamp: number } }>,
				async put(key: string, value: { timestamp: number }) {
					this.puts.push({ key, value });
				},
				async delete() {},
				async getRecordCount() {
					return { recordCount: 0 };
				},
			},
		},
	};
	return rows;
}

describe('UseCacheHandler streaming', () => {
	beforeEach(() => {
		cacheInvalidations.clear();
		installDatabases();
	});

	it('round-trips a cached value', async () => {
		await handler.set('k1', Promise.resolve(entry({ value: streamOf('payload') })));

		const result = await handler.get('k1', []);

		assert.ok(result);
		assert.equal(await readAll(result.value), 'payload');
	});

	it('hands every reader its own stream', async () => {
		await handler.set('k2', Promise.resolve(entry({ value: streamOf('payload') })));

		const first = await handler.get('k2', []);
		const second = await handler.get('k2', []);

		assert.ok(first && second);
		// A shared stream would leave the second reader with an empty (already-consumed) body.
		assert.equal(await readAll(first.value), 'payload');
		assert.equal(await readAll(second.value), 'payload');
	});

	it('persists nothing when the value stream errors part way', async () => {
		await handler.set('k3', Promise.resolve(entry({ value: erroringStream('half') })));

		assert.equal(await handler.get('k3', []), undefined, 'a partial render must not be cached');
	});

	it('persists nothing when the pending entry itself rejects', async () => {
		await handler.set('k4', Promise.reject(new Error('render failed')));

		assert.equal(await handler.get('k4', []), undefined);
	});

	it('makes a concurrent get wait for an in-flight set rather than reporting a miss', async () => {
		let release: (value: UseCacheEntry) => void = () => {};
		const pending = new Promise<UseCacheEntry>((resolve) => {
			release = resolve;
		});

		// Not awaited: the contract is that `get` observes the in-flight set synchronously.
		const setPromise = handler.set('k5', pending);
		const getPromise = handler.get('k5', []);

		release(entry({ value: streamOf('deferred') }));
		await setPromise;

		const result = await getPromise;
		assert.ok(result, 'a concurrent get must wait, not return undefined');
		assert.equal(await readAll(result.value), 'deferred');
	});
});

describe('UseCacheHandler cache lives', () => {
	beforeEach(() => {
		cacheInvalidations.clear();
		installDatabases();
	});

	it('withholds an entry past its expire window', async () => {
		await handler.set(
			'expired',
			Promise.resolve(entry({ timestamp: Date.now() - 120_000, expire: 60 }))
		);

		assert.equal(await handler.get('expired', []), undefined);
	});

	it('stores a fractional timestamp as an integer', async () => {
		// Next supplies `performance.timeOrigin + performance.now()`, which is fractional. Uncoerced,
		// Harper refuses the write and — because the failure is caught — the cache silently stores
		// nothing while appearing to work.
		// Offset from now, not a pinned epoch value: a hardcoded timestamp goes stale as wall-clock
		// advances past the default 3600s `expire`, so the test would pass when written and fail an
		// hour later. The .713 is what makes it fractional, which is the thing under test.
		await handler.set('fractional', Promise.resolve(entry({ timestamp: Date.now() + 0.713 })));

		const result = await handler.get('fractional', []);

		assert.ok(result, 'the write must not be rejected by the integer column');
		assert.ok(Number.isInteger(result.timestamp));
	});

	it('stores fractional cache lives as integers', async () => {
		await handler.set(
			'fractional-lives',
			Promise.resolve(entry({ stale: 30.5, revalidate: 120.9, expire: 900.1 }))
		);

		const result = await handler.get('fractional-lives', []);

		assert.ok(result);
		assert.ok(Number.isInteger(result.stale));
		assert.ok(Number.isInteger(result.revalidate));
		assert.ok(Number.isInteger(result.expire));
	});

	it('preserves the entry cache lives across the round trip', async () => {
		await handler.set('lives', Promise.resolve(entry({ stale: 30, revalidate: 120, expire: 900 })));

		const result = await handler.get('lives', []);

		assert.ok(result);
		assert.equal(result.stale, 30);
		assert.equal(result.revalidate, 120);
		assert.equal(result.expire, 900);
	});
});

describe('UseCacheHandler tags', () => {
	beforeEach(() => {
		cacheInvalidations.clear();
		installDatabases();
	});

	it('reports the newest invalidation timestamp for the given tags', async () => {
		cacheInvalidations.set('a', 1000);
		cacheInvalidations.set('b', 5000);

		assert.equal(await handler.getExpiration(['a', 'b']), 5000);
	});

	it('reports 0 when no tag was ever invalidated', async () => {
		assert.equal(await handler.getExpiration(['never']), 0);
	});

	it('records an invalidation for every tag', async () => {
		await handler.updateTags(['products'], undefined);

		assert.ok(cacheInvalidations.has('products'));
	});

	it('serves an invalidated entry as stale rather than missing, while it is still inside expire', async () => {
		const now = Date.now();
		await handler.set(
			'tagged',
			Promise.resolve(entry({ tags: ['products'], timestamp: now, revalidate: 300, expire: 3600 }))
		);
		cacheInvalidations.set('products', now + 1000);

		const result = await handler.get('tagged', []);

		assert.ok(result, 'a miss here costs a full render; stale-then-regenerate is the point');
		// Backdated past its revalidate window so Next regenerates, but still inside expire so it is usable.
		assert.ok(result.timestamp + result.revalidate * 1000 < Date.now());
		assert.ok(result.timestamp + result.expire * 1000 > Date.now());
	});

	it('withholds an invalidated entry that is also past expire', async () => {
		const now = Date.now();
		await handler.set(
			'gone',
			Promise.resolve(entry({ tags: ['products'], timestamp: now - 120_000, revalidate: 10, expire: 60 }))
		);
		cacheInvalidations.set('products', now);

		assert.equal(await handler.get('gone', []), undefined);
	});

});

describe('UseCacheHandler oversized keys', () => {
	let rows: Map<string, Record<string, unknown>>;

	beforeEach(() => {
		cacheInvalidations.clear();
		rows = installDatabases();
	});

	it('passes a short key through untouched, so upgrading does not invalidate the cache', () => {
		const key = 'a'.repeat(200);
		assert.equal(toStorageKey(key), key);
	});

	it('keeps an oversized key under the Harper primary-key limit', () => {
		const stored = toStorageKey('x'.repeat(87465));
		assert.ok(Buffer.byteLength(stored, 'utf8') <= HARPER_MAX_KEY_BYTES);
	});

	it('keeps distinct oversized keys distinct', () => {
		assert.notEqual(toStorageKey('x'.repeat(90000) + 'A'), toStorageKey('x'.repeat(90000) + 'B'));
	});

	it('is deterministic, so every node derives the same key', () => {
		const key = 'y'.repeat(90000);
		assert.equal(toStorageKey(key), toStorageKey(key));
	});

	it('does not split a multi-byte character', () => {
		const stored = toStorageKey('\u00e9'.repeat(60000));
		assert.ok(!stored.includes('\uFFFD'), 'truncation left a replacement character');
	});

	// The real failure: an 87,465-byte key from a component handed a large prop.
	it('round-trips an oversized entry through set and get', async () => {
		const key = 'z'.repeat(87465);
		await handler.set(key, Promise.resolve(entry({ value: streamOf('big') })));

		const result = await handler.get(key, []);

		assert.ok(result, 'an oversized key must not be rejected by the primary-key limit');
		assert.equal(await readAll(result.value), 'big');
	});

	// A key-mangling function is only correct if EVERY table access applies it. A get that
	// skips it misses forever, silently — which is the shape of bug this whole change exists for.
	it('never hands a raw oversized key to the table', async () => {
		const key = 'q'.repeat(87465);
		await handler.set(key, Promise.resolve(entry({ value: streamOf('v') })));
		await handler.get(key, []);

		assert.ok(rows.size > 0, 'nothing was stored');
		for (const id of rows.keys()) {
			assert.ok(Buffer.byteLength(id, 'utf8') <= HARPER_MAX_KEY_BYTES, `raw key reached the table: ${id.length}`);
		}
	});

	it('preserves the untruncated key on the row for debuggability', async () => {
		const key = 'w'.repeat(87465);
		await handler.set(key, Promise.resolve(entry({ value: streamOf('v') })));

		const [row] = [...rows.values()];
		assert.equal(row.cacheKey, key);
	});
});
