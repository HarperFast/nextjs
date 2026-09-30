import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-mounted');

// Un-skip once harper's `Request.withNodeAdapter()` can serve Next.js — today an adapted request 500s
// on `headers.hasOwnProperty` and a missing `appendHeader`/`_implicitHeader`, and any response over
// the adapter's 16 KB buffer stalls. Skipped rather than left red because with CI disabled a green
// local run is this repo's only regression signal. See HarperFast/nextjs#61.
test.describe.fixme('served under a urlPath mount', () => {
	test('mount root reaches the Next.js home page', async ({ request, harper }) => {
		const response = await request.get(`${harper.httpURL}/mounted`);
		expect(response.status()).toBe(200);
		expect(await response.text()).toContain('Mounted Home');
	});

	test('a nested page under the mount reaches its Next.js route', async ({ request, harper }) => {
		const response = await request.get(`${harper.httpURL}/mounted/about`);
		expect(response.status()).toBe(200);
		expect(await response.text()).toContain('Mounted About');
	});

	test('Next.js sees the mount-relative path, not the requested one', async ({ request, harper }) => {
		const response = await request.get(`${harper.httpURL}/mounted/api/echo`);
		expect(response.status()).toBe(200);
		expect(await response.json()).toEqual({ pathname: '/api/echo', search: '' });
	});

	test('the query string survives mount stripping', async ({ request, harper }) => {
		const response = await request.get(`${harper.httpURL}/mounted/api/echo?q=1`);
		expect(response.status()).toBe(200);
		expect(await response.json()).toEqual({ pathname: '/api/echo', search: '?q=1' });
	});

	// Asserts on the server-rendered markup only: Next.js still emits its `/_next/*` asset URLs at the
	// root, outside the mount, until the app is built with a matching `basePath`.
	test('the mount root renders in a browser', async ({ page, harper }) => {
		await page.goto(`${harper.httpURL}/mounted`);
		await expect(page.locator('h1')).toHaveText('Mounted Home');
	});
});

// Outside the fixme block: nothing rewrites this URL, so it never reaches the adapter.
test('paths outside the mount are not served by Next.js', async ({ request, harper }) => {
	const response = await request.get(`${harper.httpURL}/about`);
	expect(response.status()).toBe(404);
	expect(await response.text()).not.toContain('Mounted About');
});
