import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-caching');

test('ISR page serves cached response and revalidates after expiry', async ({ page, harper }) => {
	const url = `${harper.httpURL}/isr`;

	// Warm the cache. The very first render after boot may be a MISS or STALE
	// depending on whether Next.js prerendered the page at build time. We do an
	// initial throw-away request to ensure the page is in the cache before we
	// start asserting behaviour.
	await page.goto(url);

	// ── First cached request ──────────────────────────────────────────────────
	const response1 = await page.goto(url);
	const timestamp1 = await page.getByTestId('timestamp').innerText();

	// Should be a cache HIT (served from the Harper-backed ISR cache).
	expect(response1!.headers()['x-nextjs-cache']).toBe('HIT');

	// ── Second request within revalidation window ─────────────────────────────
	const response2 = await page.goto(url);
	const timestamp2 = await page.getByTestId('timestamp').innerText();

	expect(response2!.headers()['x-nextjs-cache']).toBe('HIT');
	// Content must be identical — the cached page has not been regenerated.
	expect(timestamp1).toBe(timestamp2);

	// ── Wait for the revalidation window to expire (revalidate = 2s) ──────────
	await page.waitForTimeout(2500);

	// ── Stale request ─────────────────────────────────────────────────────────
	// Next.js serves the stale cached page while triggering a background regen.
	const response3 = await page.goto(url);
	const timestamp3 = await page.getByTestId('timestamp').innerText();

	expect(response3!.headers()['x-nextjs-cache']).toBe('STALE');
	// Still the old content while revalidation is in flight.
	expect(timestamp2).toBe(timestamp3);

	// ── Revalidated request ───────────────────────────────────────────────────
	// Background revalidation should have completed; next hit is the fresh page.
	const response4 = await page.goto(url);
	const timestamp4 = await page.getByTestId('timestamp').innerText();

	expect(response4!.headers()['x-nextjs-cache']).toBe('HIT');
	// Content must have changed — the page was regenerated with a new timestamp.
	expect(timestamp3).not.toBe(timestamp4);
});

test('ISR cache record is persisted in Harper', async ({ request, harper }) => {
	// Hit the ISR page so Next.js writes to the cache handler.
	await request.get(`${harper.httpURL}/isr`);
	// Second request ensures the cache is populated (first may be a build-time miss).
	await request.get(`${harper.httpURL}/isr`);

	// Query the Harper Operations API to inspect the nextjs_isr_cache table.
	// The key Next.js uses for app-router pages is the route path (e.g. "/isr").
	const response = await request.post(harper.operationsAPIURL, {
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString('base64')}`,
		},
		data: {
			operation: 'search_by_value',
			database: 'harperfast_nextjs',
			table: 'nextjs_isr_cache',
			search_attribute: 'id',
			search_value: '/isr',
			get_attributes: ['id', 'lastModified'],
		},
	});

	expect(response.status()).toBe(200);

	const records = await response.json();
	expect(records).toHaveLength(1);

	const record = records[0];
	expect(record.id).toBe('/isr');
	// lastModified should be a recent Unix timestamp in milliseconds.
	expect(typeof record.lastModified).toBe('number');
	expect(record.lastModified).toBeGreaterThan(Date.now() - 60_000);
});

test('ISR cache record is updated after revalidation', async ({ request, harper }) => {
	const isrURL = `${harper.httpURL}/isr`;

	// Warm the cache.
	await request.get(isrURL);
	await request.get(isrURL);

	// Capture the initial lastModified timestamp from the DB.
	const authHeader = `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString('base64')}`;
	const queryPayload = {
		operation: 'search_by_value',
		database: 'harperfast_nextjs',
		table: 'nextjs_isr_cache',
		search_attribute: 'id',
		search_value: '/isr',
		get_attributes: ['id', 'lastModified'],
	};

	const before = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
		data: queryPayload,
	});
	const [beforeRecord] = await before.json();
	const lastModifiedBefore: number = beforeRecord.lastModified;

	// Wait past the revalidation window and trigger a stale response (which
	// kicks off background regeneration).
	await request.get(isrURL); // ensure we have a fresh HIT first
	await new Promise((resolve) => setTimeout(resolve, 2500));
	await request.get(isrURL); // STALE — triggers background regen
	// Give Next.js a moment to complete background regeneration and write to the cache.
	await new Promise((resolve) => setTimeout(resolve, 500));

	// Query again.
	const after = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
		data: queryPayload,
	});
	const [afterRecord] = await after.json();
	const lastModifiedAfter: number = afterRecord.lastModified;

	// The record's lastModified timestamp must have advanced.
	expect(lastModifiedAfter).toBeGreaterThan(lastModifiedBefore);
});

test('revalidateTag records the invalidation and regenerates the entry', async ({ request, harper, page }) => {
	const taggedURL = `${harper.httpURL}/tagged`;
	const revalidateURL = `${harper.httpURL}/api/revalidate?tag=test-tag`;
	const authHeader = `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString('base64')}`;

	// Warm the cache.
	await page.goto(taggedURL);
	const nonceBefore = await page.getByTestId('nonce').innerText();

	// Sanity: a second hit returns the cached value (same nonce).
	await page.goto(taggedURL);
	const nonceCached = await page.getByTestId('nonce').innerText();
	expect(nonceCached).toBe(nonceBefore);

	// Trigger revalidateTag('test-tag') via the route handler.
	const revalidateResponse = await request.post(revalidateURL);
	expect(revalidateResponse.status()).toBe(200);

	// The tombstone is what every worker and node compares entries against, so it must outlive every
	// entry it invalidates — those live at most the table's 7 days from their last write.
	const tombstones = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', Authorization: authHeader },
		data: {
			operation: 'search_by_value',
			database: 'harperfast_nextjs',
			table: 'nextjs_cache_invalidation',
			search_attribute: 'id',
			search_value: 'test-tag',
			get_attributes: ['id', 'timestamp', 'expired', 'lapsesAt'],
		},
	});
	const [tombstone] = await tombstones.json();
	expect(tombstone, 'the invalidation left no tombstone').toBeTruthy();
	expect(tombstone.expired).toBe(tombstone.timestamp);
	expect(tombstone.lapsesAt).toBeGreaterThan(tombstone.timestamp + 604_800_000);

	// revalidateTag(tag) with no profile expires the tag, so the entry is regenerated. Polled because the
	// next request can land on a worker the replicated tombstone has not reached yet.
	await expect(async () => {
		await page.goto(taggedURL);
		expect(await page.getByTestId('nonce').innerText()).not.toBe(nonceBefore);
	}).toPass({ timeout: 15_000 });
});

// revalidateTag(tag, 'max'): stale now, expired a year out. Next 16 serves the page stale while it
// regenerates, and the regenerated page is a HIT again — rather than the pre-fix behaviour, where the
// expiry was stored as the stale time and every entry stayed stale (or, for fetches, missing) for a year.
test('revalidateTag with a profile serves the page stale, then a fresh HIT', async ({ request, harper, page }) => {
	const taggedURL = `${harper.httpURL}/tagged`;

	await page.goto(taggedURL);
	const warmed = await page.goto(taggedURL);
	expect(warmed!.headers()['x-nextjs-cache']).toBe('HIT');
	const nonceBefore = await page.getByTestId('nonce').innerText();

	const revalidateResponse = await request.post(`${harper.httpURL}/api/revalidate?tag=test-tag&profile=max`);
	expect(revalidateResponse.status()).toBe(200);

	// Served stale, not expired: somewhere before the new content appears, the old page is served with a
	// STALE header rather than blocking on a render.
	let servedStale = false;
	let regenerated = '';
	await expect(async () => {
		const response = await page.goto(taggedURL);
		regenerated = await page.getByTestId('nonce').innerText();
		if (response!.headers()['x-nextjs-cache'] === 'STALE' && regenerated === nonceBefore) servedStale = true;
		expect(regenerated).not.toBe(nonceBefore);
	}).toPass({ timeout: 15_000 });
	expect(servedStale, 'the page was never served stale while it regenerated').toBe(true);

	await expect(async () => {
		const response = await page.goto(taggedURL);
		expect(response!.headers()['x-nextjs-cache']).toBe('HIT');
		expect(await page.getByTestId('nonce').innerText()).toBe(regenerated);
	}).toPass({ timeout: 15_000 });
});
