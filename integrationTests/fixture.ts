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

// Next.js build can take a while — give it 2 minutes.
const STARTUP_TIMEOUT_MS = 120_000;

export function makeHarperFixture(fixtureName: string) {
	return async ({}: {}, use: (harper: HarperContext) => Promise<void>) => {
		const fixturePath = join(import.meta.dirname, '..', 'fixtures', fixtureName);
		const ctx = createHarperContext(fixtureName);

		let started;
		try {
			started = await setupHarperWithFixture(ctx, fixturePath, {
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

export function fixture(fixtureName: string) {
	const test = base.extend<{}, { harper: HarperContext }>({
		harper: [makeHarperFixture(fixtureName), { scope: 'worker', timeout: 120_000 }],
	});
	return { test, expect };
}
