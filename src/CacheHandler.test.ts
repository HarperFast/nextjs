import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createRequire } from 'node:module';

import { cacheInvalidations } from './cacheInvalidation.cjs';

// Load the handler through `require`, the way Next.js loads it, rather than through ESM interop — a
// default import would bind to `module.exports` itself rather than the class.
const HarperCacheHandler = createRequire(import.meta.url)('./CacheHandler.cjs')
	.default as new (ctx?: { revalidatedTags?: string[] }) => {
	get(key: string, ctx: unknown): Promise<{ lastModified?: number } | null>;
	set(key: string, data: unknown, ctx: unknown): Promise<void>;
	revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
};

const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';

interface StoredRecord {
	data: unknown;
	tags?: string[];
	revalidate?: number;
	expire?: number;
	lastModified?: number;
}

function installDatabases(records: Record<string, StoredRecord> = {}) {
	const puts: Array<{ key: string; value: Record<string, unknown> }> = [];
	const invalidationPuts: Array<{ key: string; value: { timestamp: number } }> = [];

	(globalThis as Record<string, unknown>).databases = {
		harperfast_nextjs: {
			nextjs_isr_cache: {
				async get(key: string) {
					return records[key];
				},
				async put(key: string, value: Record<string, unknown>) {
					puts.push({ key, value });
				},
				search() {
					return (async function* () {})();
				},
				async invalidate() {},
			},
			nextjs_use_cache: {
				search() {
					return (async function* () {})();
				},
				async invalidate() {},
			},
			nextjs_cache_invalidation: {
				async put(key: string, value: { timestamp: number }) {
					invalidationPuts.push({ key, value });
				},
				async delete() {},
				async getRecordCount() {
					return { recordCount: 0 };
				},
			},
		},
	};

	return { puts, invalidationPuts };
}

/** An APP_PAGE value, which is the kind Next re-checks against its tags manifest. */
function appPage(tags: string[]) {
	return { kind: 'APP_PAGE', headers: { [NEXT_CACHE_TAGS_HEADER]: tags.join(',') } };
}

/** A FETCH value, which Next does not tag-recheck — an invalidated one must be withheld. */
function fetchValue() {
	return { kind: 'FETCH' };
}

const getCtx = { kind: 'APP_PAGE' } as never;

describe('HarperCacheHandler per-entry cache lives', () => {
	beforeEach(() => cacheInvalidations.clear());

	it('persists revalidate and expire from the set context', async () => {
		const { puts } = installDatabases();
		const handler = new HarperCacheHandler();

		await handler.set('/page', appPage([]) as never, {
			cacheControl: { revalidate: 300, expire: 3600 },
		} as never);

		assert.equal(puts.length, 1);
		assert.equal(puts[0].value.revalidate, 300);
		assert.equal(puts[0].value.expire, 3600);
	});

	it('stores no revalidate when Next supplies false', async () => {
		const { puts } = installDatabases();
		const handler = new HarperCacheHandler();

		await handler.set('/page', appPage([]) as never, {
			cacheControl: { revalidate: false, expire: 3600 },
		} as never);

		assert.equal(puts[0].value.revalidate, undefined);
	});

	it('withholds an entry that is past its own expire', async () => {
		installDatabases({
			'/page': { data: appPage([]), expire: 60, lastModified: Date.now() - 120_000 },
		});
		const handler = new HarperCacheHandler();

		assert.equal(await handler.get('/page', getCtx), null);
	});

	it('serves an entry still inside its expire window', async () => {
		installDatabases({
			'/page': { data: appPage([]), expire: 600, lastModified: Date.now() - 1000 },
		});
		const handler = new HarperCacheHandler();

		assert.notEqual(await handler.get('/page', getCtx), null);
	});

	it('forwards revalidateTag durations so a deferred expiry lands in the future', async () => {
		const { invalidationPuts } = installDatabases();
		const handler = new HarperCacheHandler();
		const before = Date.now();

		await handler.revalidateTag('products', { expire: 60 });

		assert.equal(invalidationPuts.length, 1);
		assert.ok(invalidationPuts[0].value.timestamp >= before + 60_000);
	});
});

describe('HarperCacheHandler stale-while-revalidate on invalidation', () => {
	beforeEach(() => cacheInvalidations.clear());

	it('serves an invalidated APP_PAGE so Next can regenerate it in the background', async () => {
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 1000 },
		});
		cacheInvalidations.set('products', 2000);
		const handler = new HarperCacheHandler();

		const result = await handler.get('/page', getCtx);

		assert.notEqual(result, null, 'a blocking miss here is what an invalidation storm must not cause');
	});

	it('withholds an invalidated entry Next will not tag-recheck', async () => {
		installDatabases({
			'/data': { data: fetchValue(), tags: ['products'], lastModified: 1000 },
		});
		cacheInvalidations.set('products', 2000);
		const handler = new HarperCacheHandler();

		assert.equal(await handler.get('/data', getCtx), null, 'FETCH entries would otherwise be served forever');
	});

	it('withholds an entry whose tag was revalidated on demand for this request', async () => {
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 1000 },
		});
		const handler = new HarperCacheHandler({ revalidatedTags: ["products"] });

		assert.equal(await handler.get('/page', getCtx), null, 'on-demand revalidation demands fresh content');
	});

	it('serves a valid entry untouched', async () => {
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 5000 },
		});
		cacheInvalidations.set('products', 1000);
		const handler = new HarperCacheHandler();

		const result = await handler.get('/page', getCtx);

		assert.equal(result?.lastModified, 5000);
	});
});
