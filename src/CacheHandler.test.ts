import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createRequire } from 'node:module';

import {
	cacheInvalidations,
	resetInvalidationStateForTesting,
	useTagsManifestModuleForTesting,
	type TagInvalidation,
} from './cacheInvalidation.cjs';

// Load the handler through `require`, the way Next.js loads it, rather than through ESM interop — a
// default import would bind to `module.exports` itself rather than the class.
const HarperCacheHandler = createRequire(import.meta.url)('./CacheHandler.cjs')
	.default as new (ctx?: { revalidatedTags?: string[] }) => {
	get(key: string, ctx: unknown): Promise<{ lastModified?: number } | null>;
	set(key: string, data: unknown, ctx: unknown): Promise<void>;
	revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
};

const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';
const NEXT_16_MANIFEST = { tagsManifest: new Map(), areTagsStale: () => false };
const NEXT_15_MANIFEST = { tagsManifest: new Map(), isStale: () => false };

interface StoredRecord {
	data: unknown;
	tags?: string[];
	revalidate?: number;
	expire?: number;
	lastModified?: number;
}

/** Tombstone rows the worker would hydrate, and whether that scan is allowed to succeed. */
interface InvalidationStorage {
	tombstones?: Array<{ id: string } & Record<string, unknown>>;
	failSearch?: boolean;
}

function installDatabases(records: Record<string, StoredRecord> = {}, invalidation: InvalidationStorage = {}) {
	const puts: Array<{ key: string; value: Record<string, unknown>; context?: { expiresAt?: number } }> = [];
	const invalidationPuts: Array<{ key: string; value: Record<string, unknown> }> = [];

	(globalThis as Record<string, unknown>).databases = {
		harperfast_nextjs: {
			nextjs_isr_cache: {
				expirationMS: 604_800_000,
				async get(key: string) {
					return records[key];
				},
				async put(key: string, value: Record<string, unknown>, context?: { expiresAt?: number }) {
					puts.push({ key, value, context });
					records[key] = { ...(value as unknown as StoredRecord), lastModified: Date.now() };
				},
				search() {
					return (async function* () {})();
				},
			},
			nextjs_use_cache: {
				expirationMS: 604_800_000,
				search() {
					return (async function* () {})();
				},
			},
			nextjs_cache_invalidation: {
				async put(key: string, value: Record<string, unknown>) {
					invalidationPuts.push({ key, value });
				},
				search() {
					if (invalidation.failSearch) {
						return (async function* () {
							throw new Error('storage unavailable');
						})();
					}
					const tombstones = invalidation.tombstones ?? [];
					return (async function* () {
						for (const row of tombstones) yield row;
					})();
				},
				async subscribe() {
					return { on() {} };
				},
			},
		},
	};

	return { puts, invalidationPuts };
}

/** Make reading the tombstones back fail, so this worker's view of them never becomes complete. */
function failTombstoneScan() {
	const { databases } = globalThis as unknown as { databases: Record<string, Record<string, { search(): unknown }>> };
	databases.harperfast_nextjs.nextjs_cache_invalidation.search = () => {
		throw new Error('scan failed');
	};
}

function invalidate(tag: string, fields: Omit<TagInvalidation, 'lapsesAt'>) {
	cacheInvalidations.set(tag, { lapsesAt: Number.MAX_SAFE_INTEGER, ...fields });
}

/** An APP_PAGE value, which Next 16 tag-checks through the header it wrote into the entry. */
function appPage(tags: string[]) {
	return { kind: 'APP_PAGE', headers: { [NEXT_CACHE_TAGS_HEADER]: tags.join(',') } };
}

function fetchValue() {
	return { kind: 'FETCH', data: { body: 'x' }, revalidate: 60 };
}

function pagesValue() {
	return { kind: 'PAGES' };
}

const pageCtx = { kind: 'APP_PAGE' } as never;
const fetchCtx = (tags: string[]) => ({ kind: 'FETCH', tags, softTags: [] }) as never;

describe('HarperCacheHandler per-entry cache lives', () => {
	beforeEach(() => {
		resetInvalidationStateForTesting();
		useTagsManifestModuleForTesting(NEXT_16_MANIFEST);
	});

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

	it("sets the record's Harper expiry from Next's expire", async () => {
		const { puts } = installDatabases();
		const handler = new HarperCacheHandler();
		const before = Date.now();

		await handler.set('/short', appPage([]) as never, { cacheControl: { revalidate: 60, expire: 3600 } } as never);
		await handler.set('/weeks', appPage([]) as never, { cacheControl: { revalidate: 60, expire: 2_592_000 } } as never);
		await handler.set('/none', appPage([]) as never, { cacheControl: { revalidate: 60 } } as never);

		const [short, weeks, none] = puts.map((put) => put.context?.expiresAt);
		assert.ok(short! >= before + 3_600_000 && short! <= Date.now() + 3_600_000);
		assert.ok(weeks! > Date.now() + 604_800_000, 'not cut to the 7-day table TTL');
		assert.ok(weeks! <= Date.now() + 31_536_000_000, 'no entry may outlive the year its tombstones are sized for');
		assert.equal(none, undefined);
	});

	// An unbounded `expire` is left to the table's own expiration rather than pinned for the year the
	// Int column bounds it to. See entryExpiresAt.
	it("leaves an unbounded expire to the table's expiration, but still stores a usable life", async () => {
		const { puts } = installDatabases();
		const handler = new HarperCacheHandler();

		await handler.set('/long', appPage([]) as never, { cacheControl: { revalidate: 60, expire: 0xfffffffe } } as never);

		assert.equal(puts[0].context?.expiresAt, undefined);
		assert.equal(puts[0].value.expire, 31_536_000, 'bounded to fit the Int column');
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

		assert.equal(await handler.get('/page', pageCtx), null);
	});

	it('serves an entry still inside its expire window', async () => {
		installDatabases({
			'/page': { data: appPage([]), expire: 600, lastModified: Date.now() - 1000 },
		});
		const handler = new HarperCacheHandler();

		assert.notEqual(await handler.get('/page', pageCtx), null);
	});

	it('treats a row with no data as a miss rather than serving an empty value', async () => {
		installDatabases({ '/ghost': { data: undefined, lastModified: Date.now() } });
		const handler = new HarperCacheHandler();

		assert.equal(await handler.get('/ghost', pageCtx), null);
	});

	it('records revalidateTag durations in Next terms: stale now, expired later', async () => {
		const { invalidationPuts } = installDatabases();
		const handler = new HarperCacheHandler();
		const before = Date.now();

		await handler.revalidateTag('products', { expire: 60 });

		const [{ value }] = invalidationPuts;
		assert.ok((value.timestamp as number) < before + 1000, 'the invalidation is dated now, not when it expires');
		assert.ok((value.stale as number) >= before);
		assert.ok((value.expired as number) >= before + 60_000);
	});
});

describe('HarperCacheHandler on tag invalidation', () => {
	beforeEach(() => {
		resetInvalidationStateForTesting();
		useTagsManifestModuleForTesting(NEXT_16_MANIFEST);
	});

	it('hands a tag-stale APP_PAGE to Next 16 with its real age, which serves it while regenerating', async () => {
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 1000 },
		});
		invalidate('products', { stale: 2000, at: 2000 });
		const handler = new HarperCacheHandler();

		const result = await handler.get('/page', pageCtx);

		assert.equal(result?.lastModified, 1000, 'a blocking miss here is what an invalidation must not cause');
	});

	it('hands a tag-stale FETCH to Next 16, which tag-checks it against the request tags', async () => {
		installDatabases({
			'/data': { data: fetchValue(), tags: ['products'], lastModified: 1000 },
		});
		invalidate('products', { stale: 2000, at: 2000 });
		const handler = new HarperCacheHandler();

		assert.notEqual(await handler.get('/data', fetchCtx(['products'])), null);
	});

	it('treats every read as a miss until the tombstones have been read back', async () => {
		installDatabases({ '/page': { data: appPage(['products']), tags: ['products'], lastModified: 1000 } });
		failTombstoneScan();
		const handler = new HarperCacheHandler();

		const result = await handler.get('/page', pageCtx);

		assert.equal(result, null, 'an invalidated entry would otherwise be served as fresh');
	});

	it('withholds a tag-stale entry of a kind Next never tag-checks', async () => {
		installDatabases({ '/legacy': { data: pagesValue(), tags: ['products'], lastModified: 1000 } });
		invalidate('products', { stale: 2000, at: 2000 });
		const handler = new HarperCacheHandler();

		assert.equal(await handler.get('/legacy', pageCtx), null, 'Next would otherwise serve it as fresh');
	});

	it('withholds a tag-stale entry on Next 15, whose IncrementalCache does not serve tags stale', async () => {
		useTagsManifestModuleForTesting(NEXT_15_MANIFEST);
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 1000 },
		});
		invalidate('products', { stale: 2000, at: 2000 });
		const handler = new HarperCacheHandler();

		assert.equal(await handler.get('/page', pageCtx), null);
	});

	it('withholds a tag-expired entry', async () => {
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 1000 },
		});
		invalidate('products', { expired: 2000, at: 2000 });
		const handler = new HarperCacheHandler();

		assert.equal(await handler.get('/page', pageCtx), null);
	});

	it('withholds a FETCH whose page path was revalidated, through the soft tags', async () => {
		installDatabases({ '/data': { data: fetchValue(), tags: [], lastModified: 1000 } });
		invalidate('_N_T_/blog', { expired: 2000, at: 2000 });
		const handler = new HarperCacheHandler();

		const result = await handler.get('/data', { kind: 'FETCH', tags: [], softTags: ['_N_T_/blog'] } as never);

		assert.equal(result, null);
	});

	// revalidateTag(tag, 'max') on the fetch cache: an entry written after the invalidation read back
	// as null for the whole year, refetching from origin on every request.
	it('serves a FETCH written after a deferred-expiry invalidation', async () => {
		installDatabases();
		const handler = new HarperCacheHandler();
		await handler.revalidateTag(['posts'], { expire: 31_536_000 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await handler.set('/f', fetchValue(), { fetchCache: true, tags: ['posts'], cacheControl: { revalidate: 60 } } as never);

		assert.notEqual(await handler.get('/f', fetchCtx(['posts'])), null);
	});

	it('withholds an entry whose tag was revalidated on demand for this request', async () => {
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 1000 },
		});
		const handler = new HarperCacheHandler({ revalidatedTags: ['products'] });

		assert.equal(await handler.get('/page', pageCtx), null, 'on-demand revalidation demands fresh content');
	});

	it('serves a valid entry untouched', async () => {
		installDatabases({
			'/page': { data: appPage(['products']), tags: ['products'], lastModified: 5000 },
		});
		invalidate('products', { expired: 1000, at: 1000 });
		const handler = new HarperCacheHandler();

		const result = await handler.get('/page', pageCtx);

		assert.equal(result?.lastModified, 5000);
	});
});

// What a read must do while the invalidation map is incomplete, and what failing closed must not cost.
describe('HarperCacheHandler reads before the tombstones are loaded', () => {
	beforeEach(() => {
		resetInvalidationStateForTesting();
		useTagsManifestModuleForTesting(NEXT_16_MANIFEST);
	});

	// A swallowed hydration failure leaves the invalidation map empty, which is indistinguishable from
	// "nothing is invalidated" — so the read has to withhold rather than hand Next a stale entry.
	it('does not serve an entry a stored tombstone invalidated', async () => {
		const now = Date.now();
		installDatabases(
			{ '/page': { data: appPage(['products']), tags: ['products'], lastModified: now - 10_000 } },
			{ tombstones: [{ id: 'products', timestamp: now - 5000 }], failSearch: true }
		);
		const handler = new HarperCacheHandler();

		assert.equal(
			await handler.get('/page', pageCtx),
			null,
			'the tombstone could not be read, so a miss is the only safe answer'
		);
	});

	// The same entry, withheld for the ordinary reason rather than because reads stayed closed.
	it('withholds the same entry once the tombstones load', async () => {
		const now = Date.now();
		installDatabases(
			{ '/page': { data: appPage(['products']), tags: ['products'], lastModified: now - 10_000 } },
			{ tombstones: [{ id: 'products', timestamp: now - 5000 }] }
		);
		const handler = new HarperCacheHandler();

		assert.equal(await handler.get('/page', pageCtx), null);
	});

	// Withholding cannot generalise into "miss everything": an entry nothing invalidated still serves.
	it('serves an uninvalidated entry when the scan succeeds', async () => {
		installDatabases({ '/page': { data: appPage([]), tags: [], lastModified: Date.now() } });
		const handler = new HarperCacheHandler();

		assert.notEqual(await handler.get('/page', pageCtx), null);
	});
});
