import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-mounted-basepath');

// The Next.js basePath equals the Harper urlPath, so the URL as it arrived already carries the basePath and
// Next.js strips it itself; handing Next.js Harper's mount-stripped URL instead would 404.
test.describe('basePath equal to the urlPath mount', () => {
	test('mount root reaches the Next.js home page', async ({ request, harper }) => {
		const response = await request.get(`${harper.httpURL}/mounted`);
		expect(response.status()).toBe(200);
		expect(await response.text()).toContain('BasePath Home');
	});

	test('a nested page under the mount reaches its Next.js route', async ({ request, harper }) => {
		const response = await request.get(`${harper.httpURL}/mounted/about`);
		expect(response.status()).toBe(200);
		expect(await response.text()).toContain('BasePath About');
	});

	test('the page and its basePath-prefixed assets load in a browser', async ({ page, harper }) => {
		const assets: { url: string; status: number }[] = [];
		page.on('response', (response) => {
			if (new URL(response.url()).pathname.startsWith('/mounted/_next/static/')) {
				assets.push({ url: response.url(), status: response.status() });
			}
		});
		await page.goto(`${harper.httpURL}/mounted`);
		await expect(page.locator('h1')).toHaveText('BasePath Home');
		expect(assets.length).toBeGreaterThan(0);
		expect(assets.filter(({ status }) => status !== 200)).toEqual([]);
	});
});
