import { fixture, harperModuleEntry } from './fixture.ts';

// The same fixture as next-16-static-data.pw.ts, under `applications.moduleLoader: native`.
//
// Harper's default VM loader hands components a `harper` module built from a fixed allowlist
// (`getHarperExports` in harper's security/jsLoader.ts) that omits `flushDatabases`, so the plugin's
// pre-build flush is a no-op and a read-only build child can't see writes the parent hasn't flushed.
// `native` mode skips the VM loader entirely and resolves the real package, so the flush runs — which
// makes this the only place the suite actually covers `flushDatabases()` doing its job.
//
// The trade-off is real and documented: native mode gives up per-app tagged logging and `config`.
const { test, expect } = fixture('next-16-static-data', {
	env: { HARPER_FIXTURE_HARPER_ENTRY: harperModuleEntry() },
	applications: { moduleLoader: 'native' },
});

// The counterpart to 'without a reachable flush...' in next-16-static-data.pw.ts: same page, same
// seeded row, but the flush ran before `next build`, so the statically generated page sees the row.
test('a reachable flush lets the build child see writes committed before the build', async ({ page, harper }) => {
	await page.goto(`${harper.httpURL}/dogs`);
	await expect(page.getByTestId('dog-rex')).toHaveText('Rex');
});

test('Harper still accepts writes after the build', async ({ request, harper }) => {
	const headers = {
		authorization: `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString('base64')}`,
		'content-type': 'application/json',
	};

	const response = await request.put(`${harper.httpURL}/Dog/fido`, { data: { name: 'Fido' }, headers });
	expect(response.ok()).toBe(true);
});
