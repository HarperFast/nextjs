import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	type HarperContext,
} from '@harperfast/integration-testing';
import { test as base, expect } from '@playwright/test';

const require = createRequire(import.meta.url);

/**
 * Resolve the Harper binary path based on the HARPER_DISTRIBUTION environment variable.
 *
 * - `harper` (default): uses the `harper` npm package (`dist/bin/harper.js` resolved via require)
 * - `harper-pro`: uses the `@harperfast/harper-pro` package (`dist/bin/harper.js`)
 *
 * Set via `HARPER_DISTRIBUTION=harper-pro npm run test:integration` or use the
 * dedicated `test:integration:harper-pro` npm script.
 */
function getHarperBinPath(): string {
	const distribution = process.env.HARPER_DISTRIBUTION ?? 'harper';
	if (distribution === 'harper-pro') {
		return join(dirname(require.resolve('@harperfast/harper-pro/package.json')), 'dist', 'bin', 'harper.js');
	}
	return join(dirname(require.resolve('harper')), 'bin', 'harper.js');
}

// Next.js build can take a while — give it 2 minutes.
const STARTUP_TIMEOUT_MS = 120_000;

export function makeHarperFixture(fixtureName: string) {
	return async ({}: {}, use: (harper: HarperContext) => Promise<void>) => {
		const fixturePath = join(import.meta.dirname, '..', 'fixtures', fixtureName);
		const ctx = createHarperContext(fixtureName);

		const started = await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath: getHarperBinPath(),
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
			config: {
				logging: {
					stdStreams: true,
				},
				applications: {
					lockdown: 'none',
					moduleLoader: 'native',
					dependencyLoader: 'native',
				},
			},
		});

		await use(started.harper);

		await teardownHarper(started);
	};
}

export function fixture(fixtureName: string) {
	const test = base.extend<{}, { harper: HarperContext }>({
		harper: [makeHarperFixture(fixtureName), { scope: 'worker', timeout: 120_000 }],
	});
	return { test, expect };
}
