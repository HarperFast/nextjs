import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
	createHarperContext,
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	HarperStartupError,
	type HarperContext,
	type StartHarperOptions,
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

export interface FixtureOptions {
	/** Extra environment variables for the Harper process (inherited by its workers and their children). */
	env?: Record<string, string>;
	/** Overrides merged over the default `applications` config, e.g. `{ moduleLoader: 'native' }`. */
	applications?: Record<string, string>;
	/** Harper `http` config. Setting `mtls`, even to `false`, is what makes the harness bind the secure port (9927). */
	http?: Record<string, unknown>;
}

function startOptions({ env, applications, http }: FixtureOptions = {}): StartHarperOptions {
	return {
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
				allowedDirectory: 'any',
				...applications,
			},
			...(http && { http }),
		},
	};
}

async function reportStartupFailure<T>(fixtureName: string, start: () => Promise<T>): Promise<T> {
	try {
		return await start();
	} catch (error) {
		if (error instanceof HarperStartupError) {
			console.error(`[${fixtureName}] Harper failed to start`);
			if (error.stdout) console.error(`[${fixtureName}] stdout:\n${error.stdout}`);
			if (error.stderr) console.error(`[${fixtureName}] stderr:\n${error.stderr}`);
		}
		throw error;
	}
}

export interface FixtureInstance {
	readonly harper: HarperContext;
	/** Stop the Harper process and start it again on the same data directory and address. */
	restart(): Promise<void>;
	stop(): Promise<void>;
}

/** Start a Harper instance for a fixture outside the worker-scoped `harper` fixture, e.g. a second node. */
export async function startFixture(fixtureName: string, options?: FixtureOptions): Promise<FixtureInstance> {
	const fixturePath = join(import.meta.dirname, '..', 'fixtures', fixtureName);
	const startHarperOptions = startOptions(options);
	let started = await reportStartupFailure(fixtureName, () =>
		setupHarperWithFixture(createHarperContext(fixtureName), fixturePath, startHarperOptions)
	);
	return {
		get harper() {
			return started.harper;
		},
		async restart() {
			await killHarper(started);
			started = await reportStartupFailure(fixtureName, () => startHarper(started, startHarperOptions));
		},
		stop: () => teardownHarper(started),
	};
}

export function makeHarperFixture(fixtureName: string, options?: FixtureOptions) {
	return async ({}: {}, use: (harper: HarperContext) => Promise<void>) => {
		const instance = await startFixture(fixtureName, options);
		await use(instance.harper);
		await instance.stop();
	};
}

export function fixture(fixtureName: string, options?: FixtureOptions) {
	const test = base.extend<{}, { harper: HarperContext }>({
		harper: [makeHarperFixture(fixtureName, options), { scope: 'worker', timeout: 120_000 }],
	});
	return { test, expect };
}
