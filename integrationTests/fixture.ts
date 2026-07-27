import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	HarperStartupError,
	type HarperContext,
} from '@harperfast/integration-testing';
import { test as base, expect } from '@playwright/test';

const require = createRequire(import.meta.url);

function getHarperBinPath(): string {
	return join(dirname(require.resolve('harper')), 'bin', 'harper.js');
}

/**
 * Absolute path to Harper's module entry, for fixtures whose app code needs to import Harper from a
 * `next build` child process. Fixtures can't depend on `harper` themselves — the harness deep-copies
 * the fixture directory and the package is ~577MB — so the resolved path is passed through the
 * environment instead. See fixtures/next-16-static-data/app/dogs/page.js.
 */
export function harperModuleEntry(): string {
	return require.resolve('harper');
}

// Next.js build can take a while — give it 2 minutes.
const STARTUP_TIMEOUT_MS = 120_000;

export function makeHarperFixture(fixtureName: string, env?: Record<string, string>) {
	return async ({}: {}, use: (harper: HarperContext) => Promise<void>) => {
		const fixturePath = join(import.meta.dirname, '..', 'fixtures', fixtureName);
		const ctx = createHarperContext(fixtureName);

		let started;
		try {
			started = await setupHarperWithFixture(ctx, fixturePath, {
				harperBinPath: getHarperBinPath(),
				startupTimeoutMs: STARTUP_TIMEOUT_MS,
				...(env && { env }),
				config: {
					logging: {
						stdStreams: true,
					},
					applications: {
						lockdown: 'none',
						moduleLoader: 'none',
						dependencyLoader: 'native',
						allowedDirectory: 'any'
					},
				},
			});
		} catch (error) {
			if (error instanceof HarperStartupError) {
				console.error(`[${fixtureName}] Harper failed to start`);
				if (error.stdout) console.error(`[${fixtureName}] stdout:\n${error.stdout}`);
				if (error.stderr) console.error(`[${fixtureName}] stderr:\n${error.stderr}`);
			}
			throw error;
		}

		await use(started.harper);

		await teardownHarper(started);
	};
}

export function fixture(fixtureName: string, env?: Record<string, string>) {
	const test = base.extend<{}, { harper: HarperContext }>({
		harper: [makeHarperFixture(fixtureName, env), { scope: 'worker', timeout: 120_000 }],
	});
	return { test, expect };
}
