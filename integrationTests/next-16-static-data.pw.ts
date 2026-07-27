import { fixture, harperModuleEntry } from './fixture.ts';

// Regression coverage for Harper read-only mode during `next build`.
//
// Next.js runs static generation in child processes. When a prerendered page reads Harper data, that
// child loads Harper's storage layer and opens the same RocksDB databases the parent Harper process
// already holds — which fails on the LOCK file unless the build sets `HARPER_READONLY`. Every other
// fixture either never touches Harper data or marks its data pages `force-dynamic`, so nothing else
// in this suite covers the build-time path.
const { test, expect } = fixture('next-16-static-data', {
	HARPER_FIXTURE_HARPER_ENTRY: harperModuleEntry(),
});

test('home page renders', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.locator('h1')).toHaveText('Next.js v16 Static Data');
});

// The core assertion. Without `HARPER_READONLY` the prerender of /dogs throws on the RocksDB LOCK,
// `next build` exits non-zero, and the plugin never reaches `serve()` — so no route exists at all and
// this fails on a connection error rather than a missing element. Reaching a rendered list means the
// build child opened the locked databases read-only.
test('statically generated page builds while Harper holds the databases open', async ({ page, harper }) => {
	await page.goto(`${harper.httpURL}/dogs`);
	await expect(page.getByTestId('dogs')).toBeAttached();
});

// Known gap, not a flake: the read-only child reads the on-disk state, so rows the parent has
// committed but not yet flushed are invisible to it — this page prerenders an empty list even though
// `GET /Dog/rex` returns Rex. `runNextBuild` calls `flushDatabases()` to close exactly this hole, but
// Harper does not expose that export to components (its component `harper` module is a fixed
// allowlist in security/jsLoader.ts), so the call is currently a no-op and the plugin logs a warning.
// Un-skip once Harper exposes `flushDatabases`; that is the assertion proving the flush works.
test.fixme('statically generated page sees data committed before the build', async ({ page, harper }) => {
	await page.goto(`${harper.httpURL}/dogs`);
	await expect(page.getByTestId('dog-rex')).toHaveText('Rex');
});

// The build must not leave the serving process read-only, or writes after the build fail.
test('Harper still accepts writes after the build', async ({ request, harper }) => {
	const headers = {
		authorization: `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString('base64')}`,
		'content-type': 'application/json',
	};

	const response = await request.put(`${harper.httpURL}/Dog/fido`, { data: { name: 'Fido' }, headers });
	expect(response.ok()).toBe(true);

	const created = await request.get(`${harper.httpURL}/Dog/fido`, { headers });
	expect(created.status()).toBe(200);
	expect((await created.json()).name).toBe('Fido');
});
