import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	type HarperContext,
} from '@harperfast/integration-testing-framework';

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

		const started = await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath: getHarperBinPath(),
			startupTimeoutMs: STARTUP_TIMEOUT_MS,
		});

		await use(started.harper);

		await teardownHarper(started);
	};
}
