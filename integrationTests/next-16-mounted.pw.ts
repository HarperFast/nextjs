import { fixture } from './fixture.ts';

// The fixture mounts the app at `urlPath: /mounted`. Harper's router strips that prefix before the
// plugin's handler runs, so every assertion here is really about Next.js seeing the stripped path.
const { test, expect } = fixture('next-16-mounted');

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
	expect(await response.json()).toEqual({ pathname: '/api/echo' });
});

test('the query string survives mount stripping', async ({ request, harper }) => {
	const response = await request.get(`${harper.httpURL}/mounted/api/echo?q=1`);
	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({ pathname: '/api/echo' });
});

test('paths outside the mount are not served by Next.js', async ({ request, harper }) => {
	const response = await request.get(`${harper.httpURL}/about`);
	expect(response.status()).toBe(404);
	expect(await response.text()).not.toContain('Mounted About');
});
