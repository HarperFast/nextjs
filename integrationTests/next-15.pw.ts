/**
 * Next.js 15 integration tests.
 *
 * Verifies that the @harperfast/nextjs plugin correctly serves a Next.js 15
 * application when deployed as a Harper component.
 *
 * The `harper` fixture (worker-scoped) starts an isolated Harper instance with
 * the next-15 fixture pre-installed. Playwright connects to harper.httpURL.
 * Each parallel worker gets its own loopback address, so tests are fully isolated.
 */

import { test, expect } from './fixtures.js';

test('home page renders', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.locator('h1')).toHaveText('Next.js v15');
});

test('page title is set', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page).toHaveTitle('HarperDB - Next.js v15 App');
});
