import type { APIRequestContext } from '@playwright/test';
import type { HarperContext } from '@harperfast/integration-testing';
import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-caching');

interface ISRCacheRecord {
	id: string;
	lastModified: number;
}

function authHeader(harper: HarperContext): string {
	return `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString('base64')}`;
}

// Next.js response-cache keys are opaque: a route's row is the one whose key is, or ends with
// `/$` plus, the pathname in `normalizePagePath` form (`/` becomes `/index`).
function isCacheKeyForRoute(id: string, pathname: string): boolean {
	const normalized = pathname === '/' ? '/index' : pathname;
	return id === normalized || id.endsWith(`/$${normalized}`);
}

// `search_value: '*'` is an unconditional full scan. The table also holds `unstable_cache` fetch
// rows and every other cached route, so callers must filter.
async function getISRCacheRecords(
	request: APIRequestContext,
	harper: HarperContext,
	pathname: string
): Promise<ISRCacheRecord[]> {
	const response = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(harper) },
		data: {
			operation: 'search_by_value',
			database: 'harperfast_nextjs',
			table: 'nextjs_isr_cache',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'lastModified'],
		},
	});

	expect(response.status()).toBe(200);

	const records: ISRCacheRecord[] = await response.json();
	return records.filter((record) => isCacheKeyForRoute(record.id, pathname));
}

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

	const records = await getISRCacheRecords(request, harper, '/isr');
	expect(records).toHaveLength(1);

	// lastModified should be a recent Unix timestamp in milliseconds.
	expect(typeof records[0].lastModified).toBe('number');
	expect(records[0].lastModified).toBeGreaterThan(Date.now() - 60_000);
});

test('ISR cache record is updated after revalidation', async ({ request, harper }) => {
	const isrURL = `${harper.httpURL}/isr`;

	// Warm the cache.
	await request.get(isrURL);
	await request.get(isrURL);

	// Capture the initial lastModified timestamp from the DB.
	const before = await getISRCacheRecords(request, harper, '/isr');
	expect(before).toHaveLength(1);
	const lastModifiedBefore = before[0].lastModified;

	// Wait past the revalidation window and trigger a stale response (which
	// kicks off background regeneration).
	await request.get(isrURL); // ensure we have a fresh HIT first
	await new Promise((resolve) => setTimeout(resolve, 2500));
	await request.get(isrURL); // STALE — triggers background regen
	// Give Next.js a moment to complete background regeneration and write to the cache.
	await new Promise((resolve) => setTimeout(resolve, 500));

	// Query again.
	const after = await getISRCacheRecords(request, harper, '/isr');
	expect(after).toHaveLength(1);

	// The record's lastModified timestamp must have advanced.
	expect(after[0].lastModified).toBeGreaterThan(lastModifiedBefore);
});

test('revalidateTag writes invalidation row and forces regeneration', async ({ request, harper, page }) => {
	const taggedURL = `${harper.httpURL}/tagged`;
	const revalidateURL = `${harper.httpURL}/api/revalidate?tag=test-tag`;

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

	// nextjs_cache_invalidation is keyed by the tag itself, so an exact match is correct here.
	const invalidationRow = await request.post(harper.operationsAPIURL, {
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(harper) },
		data: {
			operation: 'search_by_value',
			database: 'harperfast_nextjs',
			table: 'nextjs_cache_invalidation',
			search_attribute: 'id',
			search_value: 'test-tag',
			get_attributes: ['id', 'timestamp'],
		},
	});
	const rows = await invalidationRow.json();
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe('test-tag');
	expect(typeof rows[0].timestamp).toBe('number');

	// Next page request must regenerate (new nonce).
	await page.goto(taggedURL);
	const nonceAfter = await page.getByTestId('nonce').innerText();
	expect(nonceAfter).not.toBe(nonceBefore);
});
