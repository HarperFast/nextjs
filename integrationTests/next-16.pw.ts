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

// §5.3(c) — Harper REST API coexists with Next.js on the same port.
test('Harper REST API is reachable on the same port as Next.js', async ({ request, harper }) => {
	const response = await request.get(`${harper.httpURL}/Greeting`);
	expect(response.status()).toBe(200);
	const body = await response.json();
	expect(body.message).toBe('hello from harper');
});

// §5.3(a) — Startup secrets injected via loadEnv before Next.js boots.
test('startup secrets are injected before Next.js boots', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.getByTestId('api-key')).toHaveText('harper-secret-abc123');
});
