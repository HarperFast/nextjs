/**
 * Next.js 15 + Node.js Integration Test
 *
 * Verifies that the @harperfast/nextjs plugin correctly serves a Next.js 15
 * application when deployed as a Harper component.
 *
 * This test:
 * 1. Starts a Harper (harperdb v4) instance with the next-15 fixture pre-installed
 * 2. Waits for Harper and Next.js to fully start (Next.js build included)
 * 3. Verifies the app is reachable and returns expected content
 *
 * The next-15 fixture at fixtures/next-15/ contains:
 * - A minimal Next.js 15 app with a single page rendering "Next.js v15"
 * - config.yaml referencing @harperdb/nextjs plugin
 * - node_modules/@harperdb/nextjs symlinked to the plugin root
 */

import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing-framework';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Resolve the path to harperdb v4's CLI script from the nextjs plugin's node_modules.
 * The nextjs plugin depends on harperdb@4.x as a devDependency.
 */
function getHarperdbBinPath(): string {
	const { join: pathJoin, dirname: pathDirname } = { join, dirname };
	const harperdbMain = require.resolve('harperdb');
	return pathJoin(pathDirname(harperdbMain), 'bin', 'harperdb.js');
}

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'next-15');
const HARPER_BIN_PATH = getHarperdbBinPath();

// Next.js builds take time — give the instance plenty of time to start
const STARTUP_TIMEOUT_MS = 120_000;

suite('Next.js 15 plugin integration', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			harperBinPath: HARPER_BIN_PATH,
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Harper instance is running and reachable', async () => {
		const response = await fetch(ctx.harper.httpURL);
		ok(response.status < 500, `Expected non-5xx status, got ${response.status}`);
	});

	test('Next.js app serves the index page', async () => {
		const response = await fetch(ctx.harper.httpURL + '/');
		strictEqual(response.status, 200, `Expected 200, got ${response.status}`);
		const body = await response.text();
		ok(body.includes('Next.js v15'), `Expected page to contain "Next.js v15", got:\n${body.substring(0, 500)}`);
	});
});
