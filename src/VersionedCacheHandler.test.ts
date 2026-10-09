import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setImmediate } from 'node:timers/promises';
import type { FileSystemCacheContext } from './versionedCache.cjs';

const require = createRequire(import.meta.url);
const { bindVersionedCache, assertVersionedCacheBuild, assertVersionedCacheConfig, markProductionCache } = require('./versionedCache.cjs') as typeof import('./versionedCache.cjs');
const Handler = require('./VersionedCacheHandler.cjs').default as typeof import('./VersionedCacheHandler.cjs').default;
const pluginDirectory = dirname(import.meta.dirname);
const exec = promisify(execFile);
const versions = ['next-14', 'next-15', 'next-16', 'next-16-route-cache'];

async function createApp(app: string, version: string, release: string, handler = true) {
	await mkdir(join(app, '.next', 'server', 'app'), { recursive: true });
	await mkdir(join(app, 'node_modules', '@harperfast'), { recursive: true });
	await symlink(dirname(require.resolve(`${version}/package.json`)), join(app, 'node_modules', 'next'), 'junction');
	await symlink(pluginDirectory, join(app, 'node_modules', '@harperfast', 'nextjs'), 'junction');
	await writeFile(join(app, 'package.json'), '{}');
	await writeFile(join(app, '.next', 'BUILD_ID'), 'reused-build-id');
	await writeFile(join(app, '.next', 'server', 'app', 'page.js'), release);
	await writeFile(join(app, '.next', 'required-server-files.json'), JSON.stringify({ config: {
		distDir: '.next',
		...(handler && { cacheHandler: join(app, 'node_modules', '@harperfast', 'nextjs', 'dist', 'VersionedCacheHandler.cjs') }),
	} }));
}

function context(app: string): FileSystemCacheContext {
	return {
		fs: createRequire(join(app, 'package.json'))('next/dist/server/lib/node-fs-methods.js').nodeFs,
		serverDistDir: join(app, '.next', 'server'),
		flushToDisk: true,
		maxMemoryCacheSize: 0,
		revalidatedTags: [],
		_requestHeaders: {},
		experimental: { ppr: false },
		appDir: true,
		pagesDir: true,
	} as FileSystemCacheContext;
}

function pageValue(version: string, html: string) {
	return version === 'next-14'
		? { kind: 'PAGE', html, pageData: html, headers: { 'x-test': html } }
		: { kind: 'APP_PAGE', html, rscData: Buffer.from(html), headers: { 'x-test': html } };
}
const pageContext = { kind: 'APP_PAGE', kindHint: 'app', isFallback: false, isRoutePPREnabled: false } as Parameters<InstanceType<typeof Handler>['get']>[1];

async function pageHTML(cache: InstanceType<typeof Handler>, key: string): Promise<string> {
	const entry = await cache.get(key, pageContext);
	assert.ok(entry?.value && 'html' in entry.value);
	return entry.value.html;
}

async function invalidateWrittenTag(cache: InstanceType<typeof Handler>, key: string, tag: string) {
	const entry = await cache.get(key, pageContext);
	assert.ok(entry);
	// Next 16.3 expires tags only when invalidation is strictly later than the write.
	while (Date.now() <= entry.lastModified) await setImmediate();
	await cache.revalidateTag(tag);
}

function pageKey(version: string): string {
	return version === 'next-16-route-cache'
		? require(`${version}/dist/server/lib/route-cache-key.js`).getRouteCacheKey('/isr', { kind: 'APP_PAGE', sourceRoute: '/isr/page' })
		: 'isr';
}

async function temporaryApp(t: TestContext, version: string) {
	const root = await mkdtemp(join(tmpdir(), 'next-versioned-cache-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const app = join(root, 'components', 'app');
	await createApp(app, version, 'v1');
	return { root, app };
}

async function seed(app: string, version: string, html: string) {
	const Native = require(`${version}/dist/server/lib/incremental-cache/file-system-cache.js`).default;
	await new Native(context(app)).set('isr', pageValue(version, html), pageContext);
	if (version === 'next-16-route-cache') {
		const metaPath = join(app, '.next', 'server', 'app', 'isr.meta');
		const meta = JSON.parse(await readFile(metaPath, 'utf8'));
		meta.routeCache = { key: pageKey(version), owner: { kind: 'APP_PAGE', sourceRoute: '/isr/page' }, isFallback: false };
		await writeFile(metaPath, JSON.stringify(meta));
	}
}

async function inFreshWorker(app: string, version: string, set?: string) {
	const program = `
		const { createRequire } = require('node:module');
		const { join } = require('node:path');
		const [app, plugin, key, version, html] = process.argv.slice(1);
		const appRequire = createRequire(join(app, 'package.json'));
		const { bindVersionedCache } = require(join(plugin, 'dist/versionedCache.cjs'));
		const Handler = require(join(plugin, 'dist/VersionedCacheHandler.cjs')).default;
		const ctx = { fs: appRequire('next/dist/server/lib/node-fs-methods.js').nodeFs, serverDistDir: join(app,'.next/server'), flushToDisk:true, maxMemoryCacheSize:0, revalidatedTags:[], experimental:{ppr:false}, appDir:true, pagesDir:true };
		const getCtx = { kind:'APP_PAGE', kindHint:'app', isFallback:false, isRoutePPREnabled:false };
		(async () => {
			const binding = await bindVersionedCache(app);
			const cache = new Handler(ctx);
			if (html) await cache.set(key, version === 'next-14' ? {kind:'PAGE',html,pageData:html,headers:{'x-test':html}} : {kind:'APP_PAGE',html,rscData:Buffer.from(html),headers:{'x-test':html}}, getCtx);
			const entry = await cache.get(key,getCtx);
			console.log(JSON.stringify({html:entry?.value?.html, directory:binding.cacheDirectory}));
		})().catch(error => { console.error(error);process.exitCode=1; });
	`;
	const { stdout } = await exec(process.execPath, ['-e', program, app, pluginDirectory, pageKey(version), version, set ?? ''], { timeout: 20_000 });
	return JSON.parse(stdout) as { html: string; directory: string };
}

for (const version of versions) describe(`versioned filesystem cache (${version})`, () => {
	it('pins late writes to the old build and persists the new cache across worker restarts', async (t) => {
		const { root, app } = await temporaryApp(t, version);
		const oldBinding = (await bindVersionedCache(app))!;
		const old = new Handler(context(app));
		await old.set(pageKey(version), pageValue(version, 'v1 early') as never, pageContext as never);
		await rename(app, join(root, 'aside'));
		await createApp(app, version, 'v2');
		const fresh = await inFreshWorker(app, version, 'v2');
		await old.set(pageKey(version), pageValue(version, 'v1 late') as never, pageContext as never);
		const anotherOldRequest = new Handler(context(app));
		assert.equal(await pageHTML(anotherOldRequest, pageKey(version)), 'v1 late');
		const restarted = await inFreshWorker(app, version);
		assert.equal(restarted.html, 'v2');
		assert.equal(restarted.directory, fresh.directory);
		assert.notEqual(fresh.directory, oldBinding.cacheDirectory, 'reusing BUILD_ID must not merge different artifacts');
		assert.equal(existsSync(join(app, '.next', 'server', 'route-cache')), false);
		assert.equal(existsSync(join(app, '.next', 'server', 'app', 'isr.html')), false);
		await assert.rejects(() => assertVersionedCacheBuild(oldBinding), /build changed/);
		await assert.rejects(() => bindVersionedCache(app), /restart the worker/);
		await rm(oldBinding.cacheDirectory, { recursive: true });
		await old.set(pageKey(version), pageValue(version, 'v1 recreated') as never, pageContext as never);
		assert.equal(await pageHTML(anotherOldRequest, pageKey(version)), 'v1 recreated');
		assert.equal((await inFreshWorker(app, version)).html, 'v2');
	});

	it('isolates identical cache keys for apps sharing one installed Next module with memory disabled', async (t) => {
		const { root, app } = await temporaryApp(t, version);
		const secondApp = join(root, 'components', 'second');
		await createApp(secondApp, version, 'v1');
		const firstBinding = (await bindVersionedCache(app))!;
		const secondBinding = (await bindVersionedCache(secondApp))!;
		assert.strictEqual(firstBinding.FileSystemCache, secondBinding.FileSystemCache);
		const first = new Handler(context(app));
		const second = new Handler(context(secondApp));
		await first.set(pageKey(version), pageValue(version, 'first app') as never, pageContext as never);
		await second.set(pageKey(version), pageValue(version, 'second app') as never, pageContext as never);
		assert.equal(await pageHTML(first, pageKey(version)), 'first app');
		assert.equal(await pageHTML(second, pageKey(version)), 'second app');
		assert.notEqual(firstBinding.cacheDirectory, secondBinding.cacheDirectory);
	});

	it('uses immutable build seeds on cold misses without combining partial runtime files', async (t) => {
		const { app } = await temporaryApp(t, version);
		await seed(app, version, 'seed');
		const binding = (await bindVersionedCache(app))!;
		const cache = new Handler(context(app));
		assert.equal(await pageHTML(cache, pageKey(version)), 'seed');
		const runtimePrimary = version === 'next-16-route-cache'
			? join(binding.cacheDirectory, 'server', pageKey(version) + '.html')
			: join(binding.cacheDirectory, 'server', 'app', 'isr.html');
		await mkdir(dirname(runtimePrimary), { recursive: true });
		await writeFile(runtimePrimary, 'incomplete runtime');
		assert.equal(await pageHTML(cache, pageKey(version)), 'seed');
		assert.equal(await readFile(join(app, '.next', 'server', 'app', 'isr.html'), 'utf8'), 'seed');
		await assertVersionedCacheBuild(binding);
	});

	it('keeps fetch seeds read-only and persists runtime fetches outside the component', async (t) => {
		const { app } = await temporaryApp(t, version);
		const Native = require(`${version}/dist/server/lib/incremental-cache/file-system-cache.js`).default;
		const data = { kind: 'FETCH', data: { headers: {}, body: 'seed', status: 200, url: 'https://example.com/data' }, revalidate: 3600 };
		const fetchContext = { kind: 'FETCH', kindHint: 'fetch', fetchCache: true, tags: ['seed-tag'], softTags: [] };
		await new Native(context(app)).set('fetch-key', data, fetchContext);
		const seedFile = join(app, '.next', 'cache', 'fetch-cache', 'fetch-key');
		const original = await readFile(seedFile, 'utf8');
		const binding = (await bindVersionedCache(app))!;
		const cache = new Handler(context(app));
		const result = await cache.get('fetch-key', { ...fetchContext, tags: ['another-tag'] } as never);
		assert.equal(result?.value?.kind, 'FETCH');
		assert.equal(await readFile(seedFile, 'utf8'), original);
		const disabled = new Handler({ ...context(app), flushToDisk: false });
		assert.equal(await disabled.get('fetch-key', fetchContext as never), null);
		await cache.set('fetch-key', { ...data, data: { ...data.data, body: 'runtime' } } as never, fetchContext as never);
		assert.match(await readFile(join(binding.cacheDirectory, 'cache', 'fetch-cache', 'fetch-key'), 'utf8'), /runtime/);
		await assertVersionedCacheBuild(binding);
	});

	it('leaves external builds and development on the stock filesystem when unbound', async (t) => {
		const { app } = await temporaryApp(t, version);
		const cache = new Handler(context(app));
		await cache.set(pageKey(version), pageValue(version, 'stock') as never, pageContext as never);
		assert.equal(await pageHTML(cache, pageKey(version)), 'stock');
	});

	it('persists Pages Router data and route-handler bodies in the namespace', async (t) => {
		const { app } = await temporaryApp(t, version);
		const binding = (await bindVersionedCache(app))!;
		const cache = new Handler(context(app));
		const pages = { kind: version === 'next-14' ? 'PAGE' : 'PAGES', html: 'pages', pageData: { release: 'v1' }, headers: { 'x-test': 'pages' } };
		const pagesContext = { kind: 'PAGES', kindHint: 'pages', isFallback: false };
		const pagesKey = version === 'next-16-route-cache'
			? require(`${version}/dist/server/lib/route-cache-key.js`).getRouteCacheKey('/pages', { kind: 'PAGES', sourceRoute: '/pages' })
			: 'pages';
		await cache.set(pagesKey, pages as never, pagesContext as never);
		const result = await cache.get(pagesKey, pagesContext as never);
		assert.ok(result?.value && 'pageData' in result.value);
		assert.deepEqual(result.value.pageData, { release: 'v1' });
		const route = { kind: version === 'next-14' ? 'ROUTE' : 'APP_ROUTE', body: Buffer.from('route body'), status: 201, headers: { 'x-test': 'route' } };
		const routeContext = { kind: 'APP_ROUTE', kindHint: 'app' };
		const routeKey = version === 'next-16-route-cache'
			? require(`${version}/dist/server/lib/route-cache-key.js`).getRouteCacheKey('/route', { kind: 'APP_ROUTE', sourceRoute: '/route/route' })
			: 'route';
		await cache.set(routeKey, route as never, routeContext as never);
		const body = await cache.get(routeKey, routeContext as never);
		assert.ok(body?.value && 'body' in body.value);
		assert.equal(body.value.body.toString(), 'route body');
		assert.equal(existsSync(join(app, '.next', 'server', 'pages')), false);
		assert.equal(existsSync(join(app, '.next', 'server', 'app', 'route.body')), false);
		await assertVersionedCacheBuild(binding);
	});

	it('preserves the installed Next version\'s tag expiration', async (t) => {
		const { app } = await temporaryApp(t, version);
		await bindVersionedCache(app);
		const cache = new Handler(context(app));
		const tag = app;
		const value = { ...pageValue(version, 'tagged'), headers: { 'x-next-cache-tags': tag } };
		await cache.set(pageKey(version), value as never, pageContext as never);
		assert.equal(await pageHTML(cache, pageKey(version)), 'tagged');
		await invalidateWrittenTag(cache, pageKey(version), tag);
		assert.equal(await cache.get(pageKey(version), pageContext), null);
		cache.resetRequestCache();
	});

	it('does not resurrect build seeds after runtime-only tag invalidation, even in another handler or worker', async (t) => {
		const { app } = await temporaryApp(t, version);
		await seed(app, version, 'seed');
		const binding = (await bindVersionedCache(app))!;
		const cache = new Handler(context(app));
		const tag = app;
		await cache.set(pageKey(version), { ...pageValue(version, 'runtime'), headers: { 'x-next-cache-tags': tag } } as never, pageContext as never);
		assert.equal(await pageHTML(cache, pageKey(version)), 'runtime');
		await invalidateWrittenTag(cache, pageKey(version), tag);
		assert.equal(await cache.get(pageKey(version), pageContext), null);
		assert.equal(await new Handler(context(app)).get(pageKey(version), pageContext), null);
		await rm(join(binding.cacheDirectory, 'server'), { recursive: true });
		assert.equal((await inFreshWorker(app, version)).html, undefined, 'a persisted runtime-owned key must not fall back to seeds');
		await assertVersionedCacheBuild(binding);
	});
});

describe('versioned cache startup and retention', () => {
	it('refuses unsafe production fallback while leaving development and external builds available', async (t) => {
		const { app } = await temporaryApp(t, 'next-16');
		const ctx = context(app);
		markProductionCache(ctx.serverDistDir);
		assert.throws(() => new Handler(ctx), /no production build binding/);
		assert.doesNotThrow(() => new Handler({ ...ctx, dev: true }));
		const binding = (await bindVersionedCache(app))!;
		assert.ok(Object.isFrozen(binding));
		assert.doesNotThrow(() => new Handler(ctx));
		const dev = new Handler({ ...ctx, dev: true });
		await dev.set('dev-page', pageValue('next-16', 'development') as never, pageContext as never);
		assert.ok(existsSync(join(app, '.next', 'server', 'app', 'dev-page.html')));
		assert.equal(existsSync(join(binding.cacheDirectory, 'server', 'app', 'dev-page.html')), false);
	});
	it('leaves default and unrelated custom handlers untouched', async (t) => {
		const { app } = await temporaryApp(t, 'next-16');
		const file = join(app, '.next', 'required-server-files.json');
		await writeFile(file, '{"config":{}}');
		assert.equal(await bindVersionedCache(app), undefined);
		await writeFile(file, '{"config":{"cacheHandler":"/custom/handler.cjs"}}');
		assert.equal(await bindVersionedCache(app), undefined);
	});

	it('leaves same-named custom handlers untouched without a local plugin installation', async (t) => {
		const { app } = await temporaryApp(t, 'next-16');
		await rm(join(app, 'node_modules', '@harperfast', 'nextjs'));
		const cacheHandler = join(app, 'VersionedCacheHandler.cjs');
		await writeFile(cacheHandler, 'module.exports = class CustomCache {};');
		await writeFile(join(app, '.next', 'required-server-files.json'), JSON.stringify({ config: { cacheHandler } }));
		assert.equal(await bindVersionedCache(app), undefined);
		assert.doesNotThrow(() => assertVersionedCacheConfig(app, { cacheHandler }));
	});

	it('rejects build/runtime handler mismatches before serving', async (t) => {
		const { app } = await temporaryApp(t, 'next-16');
		const config = { cacheHandler: join(app, 'node_modules', '@harperfast', 'nextjs', 'dist', 'VersionedCacheHandler.cjs') };
		const binding = (await bindVersionedCache(app))!;
		assert.doesNotThrow(() => assertVersionedCacheConfig(app, config, binding));
		assert.doesNotThrow(() => assertVersionedCacheConfig(app, {}));
		assert.throws(() => assertVersionedCacheConfig(app, config), /configuration mismatch/);
		assert.throws(() => assertVersionedCacheConfig(app, {}, binding), /configuration mismatch/);
		assert.throws(() => assertVersionedCacheConfig(app, { ...config, distDir: 'other' }, binding), /configuration mismatch/);
	});

	it('rejects a cache root inside the component and reports storage failures at startup', async (t) => {
		const { root, app } = await temporaryApp(t, 'next-16');
		await assert.rejects(() => bindVersionedCache(app, 'runtime-cache'), /outside the component/);
		const blockedRoot = join(root, 'file');
		await writeFile(blockedRoot, 'not a directory');
		await assert.rejects(() => bindVersionedCache(app, blockedRoot), /ENOTDIR/);
	});

	it('prevents unowned runtime writes and seed fallback when ownership storage is inaccessible', async (t) => {
		const version = 'next-16';
		const { app } = await temporaryApp(t, version);
		await seed(app, version, 'seed');
		const binding = (await bindVersionedCache(app))!;
		await writeFile(join(binding.cacheDirectory, 'entries'), 'blocked');
		const cache = new Handler(context(app));
		await assert.rejects(cache.set(pageKey(version), pageValue(version, 'runtime') as never, pageContext as never), /ENOTDIR/);
		assert.deepEqual(await readdir(join(binding.cacheDirectory, 'server')), []);
		await assert.rejects(cache.get(pageKey(version), pageContext), /ENOTDIR/);
		await assertVersionedCacheBuild(binding);
	});

	it('accepts a moved prebuilt artifact whose stored handler path names its build machine', async (t) => {
		const { app, root } = await temporaryApp(t, 'next-16');
		const moved = join(root, 'moved-app');
		await rename(app, moved);
		await assert.rejects(bindVersionedCache(moved), /Set cacheDirectory.*components/);
		assert.ok(await bindVersionedCache(moved, join(root, '.nextjs-cache')));
	});

	it('resolves a hoisted Next installation for both the constructor and build identity', async (t) => {
		const version = 'next-16';
		const { app } = await temporaryApp(t, version);
		await rm(join(app, 'node_modules', 'next'));
		const sharedModules = join(dirname(app), 'node_modules');
		await mkdir(sharedModules);
		await symlink(dirname(require.resolve(`${version}/package.json`)), join(sharedModules, 'next'), 'junction');
		const binding = (await bindVersionedCache(app))!;
		const cache = new Handler(context(app));
		await cache.set(pageKey(version), pageValue(version, 'hoisted') as never, pageContext as never);
		assert.equal(await pageHTML(cache, pageKey(version)), 'hoisted');
		await assertVersionedCacheBuild(binding);
	});

	it('separates builds whose only difference is prerendered seed data', async (t) => {
		const version = 'next-16-route-cache';
		const { app, root } = await temporaryApp(t, version);
		await seed(app, version, 'old seed');
		const binding = (await bindVersionedCache(app))!;
		await rename(app, join(root, 'aside'));
		await createApp(app, version, 'v1');
		await seed(app, version, 'new seed');
		const fresh = await inFreshWorker(app, version);
		assert.equal(fresh.html, 'new seed');
		assert.notEqual(fresh.directory, binding.cacheDirectory);
	});

});

it('does not import a legacy route-cache entry or promote a build seed into the component', async (t) => {
	const version = 'next-16-route-cache';
	const { app } = await temporaryApp(t, version);
	await seed(app, version, 'new seed');
	const Native = require(`${version}/dist/server/lib/incremental-cache/file-system-cache.js`).default;
	await new Native(context(app)).set(pageKey(version), pageValue(version, 'legacy old render'), pageContext);
	const binding = (await bindVersionedCache(app))!;
	const cache = new Handler(context(app));
	assert.equal(await pageHTML(cache, pageKey(version)), 'new seed');
	assert.equal(binding.seedFs.existsSync(join(app, '.next', 'server', pageKey(version) + '.html')), false);
	await assertVersionedCacheBuild(binding);
});
