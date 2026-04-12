import { test, expect } from '@playwright/test';

const baseURL = 'http://localhost:9926';

test('home page', async ({ page }) => {
	await page.goto(baseURL);
	await expect(page.locator('h1')).toHaveText('Next.js v14');
	await expect(page.locator('img')).toBeVisible();
});

test('title', async ({ page }) => {
	await page.goto(baseURL);
	await expect(page).toHaveTitle('HarperDB - Next.js v14 App');
});

test.describe('caching', () => {
	test('isr', async ({ page }) => {
		const url = `${baseURL}/isr-dogs/0`;

		// ISR Timing is flaky based on build time and test execution time, so do three renders in sequence and only test the last two.
		// If the first render is STALE, then the second two will be HITs.
		// If the first render is a HIT, then so should the second and third.

		// Reset revalidation time
		await page.goto(url);

		// First render
		const response1 = await page.goto(url);
		const when1 = await page.getByTestId('when').innerText();
		// Should be a Next.js cache hit
		expect(response1.headers()['x-nextjs-cache']).toBe('HIT');

		// Second render, within revalidate time
		const response2 = await page.goto(url);
		const when2 = await page.getByTestId('when').innerText();
		// Should be a Next.js cache hit
		expect(response2.headers()['x-nextjs-cache']).toBe('HIT');

		expect(when1).toBe(when2);

		// Wait for revalidate time to pass
		await page.waitForTimeout(1001);

		// Third render, after revalidate time
		const response3 = await page.goto(url);
		const when3 = await page.getByTestId('when').innerText();

		expect(response3.headers()['x-nextjs-cache']).toBe('STALE');
		// Stale hit, so expect page to still be same as before
		expect(when2).toBe(when3);

		// Page should be updated after revalidation
		const response4 = await page.goto(url);
		const when4 = await page.getByTestId('when').innerText();
		// Should be a Next.js cache hit
		expect(response4.headers()['x-nextjs-cache']).toBe('HIT');

		// Assert time has changed
		expect(when3).not.toBe(when4);
	});

	test('ssg', async ({ page }) => {
		const url = `${baseURL}/ssg-dogs/0`;

		// Every render should be a cache hit and the page should not change

		// First render
		const response1 = await page.goto(url);
		const when1 = await page.getByTestId('when').innerText();
		expect(response1.headers()['x-nextjs-cache']).toBe('HIT');

		// Second render
		const response2 = await page.goto(url);
		const when2 = await page.getByTestId('when').innerText();
		expect(response2.headers()['x-nextjs-cache']).toBe('HIT');

		expect(when1).toBe(when2);
	});

	test('ssr', async ({ page }) => {
		const url = `${baseURL}/ssr-dogs/0`;

		// Every render should be a cache miss and the page should dynamically change

		// First render
		const response1 = await page.goto(url);
		const when1 = await page.getByTestId('when').innerText();
		expect(response1.headers()['cache-control']).toBe('private, no-cache, no-store, max-age=0, must-revalidate');

		// Second render
		const response2 = await page.goto(url);
		const when2 = await page.getByTestId('when').innerText();
		expect(response2.headers()['cache-control']).toBe('private, no-cache, no-store, max-age=0, must-revalidate');

		expect(when1).not.toBe(when2);
	});
});

test('middleware', async ({ page }) => {
	const response = await fetch(`${baseURL}/test-middleware`);
	expect(response.headers.get('x-middleware')).toBe('true');
	const text = await response.text();
	expect(text).toBe('Hello from middleware');
});
