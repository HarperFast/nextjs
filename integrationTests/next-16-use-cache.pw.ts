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

test('the entry survives a revalidateTag as stale rather than disappearing', async ({ page, request, harper }) => {
	const url = `${harper.httpURL}/cached`;

	await page.goto(url);
	const before = await page.getByTestId('nonce').innerText();

	const revalidated = await request.post(`${harper.httpURL}/api/revalidate?tag=use-cache-tag`);
	expect(revalidated.status()).toBe(200);

	// An invalidation row is written for the tag.
	const invalidations = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', Authorization: authHeader(harper) },
		data: {
			operation: 'search_by_value',
			database: DATABASE,
			table: 'nextjs_cache_invalidation',
			search_attribute: 'id',
			search_value: 'use-cache-tag',
			get_attributes: ['id', 'timestamp'],
		},
	});
	expect(await invalidations.json()).toHaveLength(1);

	// The content regenerates rather than being served stale forever.
	await expect(async () => {
		await page.goto(url);
		expect(await page.getByTestId('nonce').innerText()).not.toBe(before);
	}).toPass({ timeout: 15_000 });
});

test('cache lives from cacheLife round-trip into the stored entry', async ({ page, request, harper }) => {
	await page.goto(`${harper.httpURL}/cached`);
	await expect(page.getByTestId('nonce')).not.toHaveText('loading');

	const rows = await searchUseCache(request, harper, ['id', 'revalidate', 'expire', 'stale']);
	const withLives = rows.find((row: { revalidate?: number }) => typeof row.revalidate === 'number');

	// Without these persisted, another node reads the entry but not its cache lives, and
	// `calculateRevalidate` falls back to a 1-second default there.
	expect(withLives, 'no entry carried its cache lives').toBeTruthy();
	expect(withLives.expire).toBeGreaterThan(withLives.revalidate);
});
