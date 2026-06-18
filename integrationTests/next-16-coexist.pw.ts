import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-coexist');

test('Next.js page is served on the Harper port', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.locator('h1')).toHaveText('Next.js on Harper');
});

test('Harper REST API is reachable on the same port as Next.js', async ({ request, harper }) => {
	const response = await request.get(`${harper.httpURL}/Greeting`);
	expect(response.status()).toBe(200);
	const body = await response.json();
	expect(body.message).toBe('hello from harper');
});
