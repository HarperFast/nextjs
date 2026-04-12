import { fixture } from "./fixture.ts";

const { test, expect } = fixture('next-15');

test('home page renders', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.locator('h1')).toHaveText('Next.js v15');
});

test('page title is set', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page).toHaveTitle('Harper - Next.js v15 App');
});

test('status endpoint returns 200', async ({ request, harper }) => {
	const response = await request.get(`${harper.operationsAPIURL}/health`);
	expect(response.status()).toBe(200);
});
