import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16');

test('home page renders', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.locator('h1')).toHaveText('Next.js v16');
});

test('page title is set', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page).toHaveTitle('Harper - Next.js v16 App');
});

test('status endpoint returns 200', async ({ request, harper }) => {
	const response = await request.get(`${harper.operationsAPIURL}/health`);
	expect(response.status()).toBe(200);
});

// These are meant for `next-16-caching` when we get that all working
test.describe.skip('ISR caching', () => {
	test('ISR page serves cached response and revalidates after expiry', async ({ page, harper }) => {
		const url = `${harper.httpURL}/isr`;

		// Warm the cache. The very first render after boot may be a MISS or STALE
		// depending on whether Next.js prerendered the page at build time. We do an
		// initial throw-away request to ensure the page is in the cache before we
		// start asserting behaviour.
		await page.goto(url);

		// ── First cached request ──────────────────────────────────────────────────
		const response1 = await page.goto(url);
		const nonce1 = await page.getByTestId('nonce').innerText();

		// Should be a cache HIT (served from the Harper-backed ISR cache).
		expect(response1!.headers()['x-nextjs-cache']).toBe('HIT');

		// ── Second request within revalidation window ─────────────────────────────
		const response2 = await page.goto(url);
		const nonce2 = await page.getByTestId('nonce').innerText();

		expect(response2!.headers()['x-nextjs-cache']).toBe('HIT');
		// Content must be identical — the cached page has not been regenerated.
		expect(nonce1).toBe(nonce2);

		// ── Wait for the revalidation window to expire (revalidate = 2s) ──────────
		await page.waitForTimeout(2500);

		// ── Stale request ─────────────────────────────────────────────────────────
		// Next.js serves the stale cached page while triggering a background regen.
		const response3 = await page.goto(url);
		const nonce3 = await page.getByTestId('nonce').innerText();

		expect(response3!.headers()['x-nextjs-cache']).toBe('STALE');
		// Still the old content while revalidation is in flight.
		expect(nonce2).toBe(nonce3);

		// ── Revalidated request ───────────────────────────────────────────────────
		// Background revalidation should have completed; next hit is the fresh page.
		const response4 = await page.goto(url);
		const nonce4 = await page.getByTestId('nonce').innerText();

		expect(response4!.headers()['x-nextjs-cache']).toBe('HIT');
		// Content must have changed — the page was regenerated with a new nonce.
		expect(nonce3).not.toBe(nonce4);
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
		// lastModified should be a recent Unix nonce in milliseconds.
		expect(typeof record.lastModified).toBe('number');
		expect(record.lastModified).toBeGreaterThan(Date.now() - 60_000);
	});

	test('ISR cache record is updated after revalidation', async ({ request, harper }) => {
		const isrURL = `${harper.httpURL}/isr`;

		// Warm the cache.
		await request.get(isrURL);
		await request.get(isrURL);

		// Capture the initial lastModified nonce from the DB.
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

		// The record's lastModified nonce must have advanced.
		expect(lastModifiedAfter).toBeGreaterThan(lastModifiedBefore);
	});
});
