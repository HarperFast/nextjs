import { test, expect } from '@playwright/test';
import { createHarperContext, startHarper, killHarper, teardownHarper, type StartedHarperTestContext } from '@harperfast/integration-testing';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdtemp, cp, mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const fixtureName = 'next-16-versioned-cache';
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

async function htmlFiles(directory: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const contents: string[] = [];
	for (const entry of entries) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) contents.push(...await htmlFiles(file));
		else if (entry.name.endsWith('.html')) contents.push(await readFile(file, 'utf8'));
	}
	return contents;
}

function nonce(html: string): string {
	const match = html.match(/<p data-nonce="true">([^<]+)<\/p>/);
	expect(match).not.toBeNull();
	return match![1];
}

const loaderModes = [
	['native', { lockdown: 'none', moduleLoader: 'none', dependencyLoader: 'native', allowedDirectory: 'any' }],
	['default', undefined],
] as const;

for (const [mode, applications] of loaderModes) test(`an old regeneration cannot pollute the next release, and regenerated pages survive restarts (${mode} loader)`, async ({ request }) => {
	test.setTimeout(300_000);
	const gate = await mkdtemp(join(tmpdir(), 'next-cache-render-gate-'));
	const dataRootDir = await mkdtemp(join(tmpdir(), 'next-cache-deployment-'));
	const cacheDirectory = join(dataRootDir, 'cache-by-build');
	const context = createHarperContext(fixtureName);
	context.harper = { dataRootDir };
	const options = {
		harperBinPath: join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
		startupTimeoutMs: 120_000,
		env: {
			HARPER_NEXTJS_CACHE_GATE: gate,
			...(process.env.HARPER_NEXTJS_CACHE_BASELINE && { HARPER_NEXTJS_CACHE_BASELINE: process.env.HARPER_NEXTJS_CACHE_BASELINE }),
		},
		config: { threads: { count: 1 }, ...(applications && { applications }) },
	};
	let started: StartedHarperTestContext | undefined;
	try {
		const app = join(dataRootDir, 'components', fixtureName);
		await cp(join(import.meta.dirname, '..', 'fixtures', fixtureName), app, { recursive: true, dereference: true });
		const configFile = join(app, 'config.yaml');
		await writeFile(configFile, await readFile(configFile, 'utf8') + `  cacheDirectory: ${JSON.stringify(cacheDirectory)}\n`);
		started = await startHarper(context, options);
		const { httpURL } = started.harper;
		const candidate = join(dataRootDir, 'candidate');
		await cp(app, candidate, { recursive: true, dereference: true, filter: (file) => file !== join(app, '.next') });
		await writeFile(join(candidate, 'release.mjs'), "export const release = 'v2';\n");
		await writeFile(join(candidate, 'config.yaml'), await readFile(join(candidate, 'config.yaml'), 'utf8') + '  prebuilt: true\n');
		await exec(process.execPath, [join(candidate, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build', '--webpack'], {
			cwd: candidate, env: { ...process.env, ...options.env }, timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
		});

		const initial = await (await request.get(httpURL)).text();
		expect(initial).toContain('<h1 data-release="true">v1</h1>');
		await writeFile(join(gate, 'hold'), '');
		expect((await request.post(`${httpURL}/api/revalidate`)).status()).toBe(200);
		const held = request.get(httpURL);
		await expect.poll(async () => readFile(join(gate, 'entered'), 'utf8').catch(() => '')).toBe('v1');
		await mkdir(join(dataRootDir, 'aside'));
		await rename(app, join(dataRootDir, 'aside', fixtureName));
		await rename(candidate, app);
		await writeFile(join(gate, 'release'), '');
		const late = await (await held).text();
		expect(late).toContain('<h1 data-release="true">v1</h1>');
		const lateNonce = nonce(late);
		expect(lateNonce).not.toBe(nonce(initial));
		const baseline = process.env.HARPER_NEXTJS_CACHE_BASELINE === '1';
		const writeRoot = baseline ? join(app, '.next', 'server', 'route-cache') : cacheDirectory;
		await expect.poll(async () => (await htmlFiles(writeRoot)).some((html) => html.includes(lateNonce))).toBe(true);

		await killHarper(started);
		started = await startHarper(context, options);
		const first = await (await request.get(httpURL)).text();
		expect(first).toContain('<h1 data-release="true">v2</h1>');
		expect(await htmlFiles(join(app, '.next', 'server', 'route-cache'))).toEqual([]);
		const seedNonce = nonce(first);
		expect((await request.post(`${httpURL}/api/revalidate`)).status()).toBe(200);
		let regenerated = '';
		await expect.poll(async () => {
			regenerated = nonce(await (await request.get(httpURL)).text());
			return regenerated;
		}).not.toBe(seedNonce);
		await expect.poll(async () => (await htmlFiles(cacheDirectory)).some((html) => html.includes(regenerated))).toBe(true);
		await killHarper(started);
		started = await startHarper(context, options);
		const afterRestart = await request.get(httpURL);
		expect(nonce(await afterRestart.text())).toBe(regenerated);
		expect(afterRestart.headers()['x-nextjs-cache']).toBe('HIT');
	} finally {
		await writeFile(join(gate, 'release'), '').catch(() => {});
		if (started) await teardownHarper(started);
		await rm(dataRootDir, { recursive: true, force: true });
		await rm(gate, { recursive: true, force: true });
	}
});
