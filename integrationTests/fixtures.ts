import { test as base, type WorkerInfo } from '@playwright/test';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	type HarperContext,
} from '@harperfast/integration-testing-framework';

const require = createRequire(import.meta.url);

/**
 * Resolve the harperdb v4 CLI binary from this package's node_modules.
 */
function getHarperBinPath(): string {
	const harperMain = require.resolve('harper');
	return join(dirname(harperMain), 'bin', 'harper.js');
}

// Next.js build can take a while — give it 2 minutes.
const STARTUP_TIMEOUT_MS = 120_000;

export type HarperFixtures = {
	/** The running Harper instance for this worker. Use harper.httpURL as the baseURL. */
	harper: HarperContext;
};

/**
 * Creates a worker-scoped Playwright fixture that starts a Harper instance
 * with the given Next.js fixture pre-installed as a component.
 *
 * Worker-scoped means one Harper instance per Playwright worker process.
 * Multiple workers can run in parallel, each on their own loopback address
 * from the loopback pool (see harper-integration-test-setup-loopback).
 *
 * Usage: extend `test` with one of the exported fixture sets below.
 */
function makeHarperFixture(fixtureName: string) {
	return async ({ }: {}, use: (harper: HarperContext) => Promise<void>, workerInfo: WorkerInfo) => {
		const fixturePath = join(import.meta.dirname, '..', 'fixtures', fixtureName);
		const ctx = createHarperContext(fixtureName);

		const started = await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath: getHarperBinPath(),
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
		});

		await use(started.harper);

		await teardownHarper(started);
	};
}

/**
 * Playwright test extended with a worker-scoped Harper fixture running the next-15 app.
 *
 * @example
 * ```ts
 * import { test, expect } from './fixtures.js';
 *
 * test('home page', async ({ page, harper }) => {
 *   await page.goto(harper.httpURL);
 *   await expect(page.locator('h1')).toHaveText('Next.js v15');
 * });
 * ```
 */
export const test = base.extend<HarperFixtures>({
	harper: [makeHarperFixture('next-15'), { timeout: STARTUP_TIMEOUT_MS }],
});

export { expect } from '@playwright/test';
