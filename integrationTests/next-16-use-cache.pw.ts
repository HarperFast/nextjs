import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-use-cache');

const DATABASE = 'harperfast_nextjs';
const TABLE = 'nextjs_use_cache';

function authHeader(harper: { admin: { username: string; password: string } }) {
	return `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString('base64')}`;
}

async function searchUseCache(request: any, harper: any, attributes = ['id', 'tags', 'timestamp']) {
	const response = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', Authorization: authHeader(harper) },
		data: {
			operation: 'search_by_value',
			database: DATABASE,
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: attributes,
		},
	});
	expect(response.status()).toBe(200);
	return response.json();
}

// The gap this fixture exists to close: with only `cacheHandler` set, `'use cache'` entries go to
// Next's in-memory default handler, so nothing reaches Harper and the cache is per-worker.
test('a "use cache" entry is persisted in Harper', async ({ page, request, harper }) => {
	await page.goto(`${harper.httpURL}/cached`);
	await expect(page.getByTestId('nonce')).not.toHaveText('loading');

	const rows = await searchUseCache(request, harper);

	expect(rows.length).toBeGreaterThan(0);
	expect(typeof rows[0].id).toBe('string');
});

test('the cached value is stable across reads', async ({ page, harper }) => {
	const url = `${harper.httpURL}/cached`;

	await page.goto(url);
	const first = await page.getByTestId('nonce').innerText();

	await page.goto(url);
	const second = await page.getByTestId('nonce').innerText();

	expect(second).toBe(first);
});

// Harper runs several worker threads. A per-worker in-memory cache shows up as the value changing
// between requests as they land on different workers — this is the assertion that would have caught
// the original gap.
test('every worker serves the same cached value', async ({ page, harper }) => {
	const url = `${harper.httpURL}/cached`;
	const seen = new Set<string>();

	for (let i = 0; i < 12; i++) {
		await page.goto(url);
		seen.add(await page.getByTestId('nonce').innerText());
	}

	expect(seen.size, `expected one shared value, saw ${[...seen].join(', ')}`).toBe(1);
});

async function searchTombstone(request: any, harper: any, tag: string) {
	const response = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', Authorization: authHeader(harper) },
		data: {
			operation: 'search_by_value',
			database: DATABASE,
			table: 'nextjs_cache_invalidation',
			search_attribute: 'id',
			search_value: tag,
			get_attributes: ['id', 'timestamp', 'stale', 'expired', 'lapsesAt', '$expiresAt'],
		},
	});
	expect(response.status()).toBe(200);
	const [row] = await response.json();
	return row as { timestamp: number; stale?: number; expired?: number; lapsesAt: number; $expiresAt?: number } | undefined;
}

const WEEK_MS = 604_800_000;

// revalidateTag(tag) with no profile expires the tag immediately in Next 16: the old entry is unusable,
// so it is regenerated on the next read and swept out of storage.
test('revalidateTag expires the entry, and the sweep deletes it', async ({ page, request, harper }) => {
	const url = `${harper.httpURL}/cached`;

	await page.goto(url);
	const before = await page.getByTestId('nonce').innerText();

	const revalidated = await request.post(`${harper.httpURL}/api/revalidate?tag=use-cache-tag`);
	expect(revalidated.status()).toBe(200);

	const tombstone = await searchTombstone(request, harper, 'use-cache-tag');
	expect(tombstone, 'no tombstone was written').toBeTruthy();
	expect(tombstone!.expired).toBe(tombstone!.timestamp);
	// It must outlive every entry it invalidates: those live at most the table's 7 days from their last write.
	expect(tombstone!.lapsesAt).toBeGreaterThan(tombstone!.timestamp + WEEK_MS);
	// Harper's own expiry for the row, which is what actually evicts it — not the table's 7-day default.
	expect(tombstone!.$expiresAt).toBe(tombstone!.lapsesAt);

	await expect(async () => {
		await page.goto(url);
		expect(await page.getByTestId('nonce').innerText()).not.toBe(before);
	}).toPass({ timeout: 15_000 });

	await expect(async () => {
		const rows = await searchUseCache(request, harper);
		const predating = rows.filter(
			(row: { tags?: string[]; timestamp: number }) =>
				row.tags?.includes('use-cache-tag') && row.timestamp < tombstone!.timestamp
		);
		expect(predating, 'the sweep left an expired entry in storage').toHaveLength(0);
	}).toPass({ timeout: 15_000 });
});

// revalidateTag(tag, 'max') marks the tag stale now and expires it a year out. The entry keeps being
// served while it regenerates in the background, and the regenerated one is fresh — not stale or
// missing for the whole year, which is what storing the expiry as the stale time used to cause.
test('revalidateTag with a profile serves the entry stale, then regenerates it once', async ({
	page,
	request,
	harper,
}) => {
	const url = `${harper.httpURL}/cached`;

	await page.goto(url);
	const before = await page.getByTestId('nonce').innerText();
	await page.goto(url);
	expect(await page.getByTestId('nonce').innerText()).toBe(before);

	const revalidated = await request.post(`${harper.httpURL}/api/revalidate?tag=use-cache-tag&profile=max`);
	expect(revalidated.status()).toBe(200);

	const tombstone = await searchTombstone(request, harper, 'use-cache-tag');
	expect(tombstone!.stale).toBe(tombstone!.timestamp);
	expect(tombstone!.expired).toBeGreaterThan(tombstone!.timestamp + 300 * 24 * 3600 * 1000);

	// Stale, not expired: the first read is still served the old value rather than blocking on a render.
	await page.goto(url);
	expect(await page.getByTestId('nonce').innerText()).toBe(before);

	let regenerated = '';
	await expect(async () => {
		await page.goto(url);
		regenerated = await page.getByTestId('nonce').innerText();
		expect(regenerated).not.toBe(before);
	}).toPass({ timeout: 15_000 });

	// Once regenerated, the entry is fresh again: every later read is a hit on the same value.
	for (let i = 0; i < 5; i++) {
		await page.goto(url);
		expect(await page.getByTestId('nonce').innerText()).toBe(regenerated);
	}
});

test('cache lives from cacheLife round-trip into the stored entry', async ({ page, request, harper }) => {
	await page.goto(`${harper.httpURL}/cached`);
	await expect(page.getByTestId('nonce')).not.toHaveText('loading');

	const rows = await searchUseCache(request, harper, ['id', 'revalidate', 'expire', 'stale']);
	const withLives = rows.find((row: { revalidate?: number }) => typeof row.revalidate === 'number');

	// Without these persisted, the entry reads back as revalidate: 0 and is regenerated on every read.
	expect(withLives, 'no entry carried its cache lives').toBeTruthy();
	expect(withLives.expire).toBeGreaterThan(withLives.revalidate);
});
