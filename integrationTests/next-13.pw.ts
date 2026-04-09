import { makeHarperFixture } from "./makeHarperFixture.ts";
import { test as base, expect } from "@playwright/test";

const test = base.extend({
	harper: [makeHarperFixture('next-13'), { scope: 'worker', timeout: 120_000 }]
})

test('home page renders', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.locator('h1')).toHaveText('Next.js v13');
});

test('page title is set', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page).toHaveTitle('Harper - Next.js v13 App');
});
