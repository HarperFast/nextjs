import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type FileSystemCache from 'next-16/dist/server/lib/incremental-cache/file-system-cache.js';
import type { CacheFs } from 'next-16/dist/shared/lib/utils.js';

export type FileSystemCacheContext = ConstructorParameters<typeof FileSystemCache>[0];

export interface CacheBinding {
	appDirectory: string;
	distDirectory: string;
	serverDistDir: string;
	cacheDirectory: string;
	identity: string;
	FileSystemCache: typeof FileSystemCache;
	seedFs: CacheFs;
}

const registryKey = Symbol.for('@harperfast/nextjs.versioned-cache.v1');
const nativeGlobal = globalThis as unknown as Record<symbol, Map<string, CacheBinding>>;
const bindings = nativeGlobal[registryKey] ??= new Map();
const fallbackConstructors = new Map<string, typeof FileSystemCache>();
const productionKey = Symbol.for('@harperfast/nextjs.production-cache-contexts');
const productionGlobal = globalThis as unknown as Record<symbol, Set<string>>;
const productionContexts = productionGlobal[productionKey] ??= new Set();

function hash(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

async function buildIdentity(appDirectory: string, distDirectory: string): Promise<string> {
	const digest = createHash('sha256');
	const buffer = Buffer.allocUnsafe(256 * 1024);
	const addFile = async (file: string) => {
		const fd = await open(file, 'r');
		try {
			digest.update(JSON.stringify([relative(appDirectory, file), (await fd.stat()).size]));
			let length: number;
			while ((length = (await fd.read(buffer, 0, buffer.length, null)).bytesRead) > 0) digest.update(buffer.subarray(0, length));
		} finally {
			await fd.close();
		}
	};
	const addDirectory = async (directory: string, skip?: string) => {
		const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const entry of entries) {
			if (entry.name === skip) continue;
			const file = join(directory, entry.name);
			if (entry.isDirectory()) await addDirectory(file);
			else if (entry.isFile()) await addFile(file);
			else throw new Error(`Versioned Next.js cache requires regular build files: ${file}`);
		}
	};

	const buildIdFile = join(distDirectory, 'BUILD_ID');
	if (!readFileSync(buildIdFile, 'utf8').trim()) throw new Error(`Missing Next.js build identity: ${buildIdFile}`);
	await addFile(buildIdFile);
	await addFile(createRequire(join(appDirectory, 'package.json')).resolve('next/package.json'));
	for (const manifest of ['required-server-files.json', 'prerender-manifest.json', 'routes-manifest.json', 'build-manifest.json', 'app-build-manifest.json']) {
		const file = join(distDirectory, manifest);
		if (existsSync(file)) await addFile(file);
	}
	await addDirectory(join(distDirectory, 'server'), 'route-cache');
	const fetchSeeds = join(distDirectory, 'cache', 'fetch-cache');
	if (existsSync(fetchSeeds)) await addDirectory(fetchSeeds);
	return digest.digest('hex');
}

function seedFileSystem(fs: CacheFs, serverDistDir: string): CacheFs {
	const legacyCache = join(serverDistDir, 'route-cache');
	const isLegacyCache = (file: unknown) => typeof file === 'string' && (file === legacyCache || file.startsWith(legacyCache + sep));
	const missing = (file: unknown) => Object.assign(new Error(`ENOENT: no build seed at '${file}'`), { code: 'ENOENT', path: file });
	const readFile = ((...args: Parameters<CacheFs['readFile']>) =>
		isLegacyCache(args[0]) ? Promise.reject(missing(args[0])) : fs.readFile(...args)) as CacheFs['readFile'];
	const readFileSync = ((...args: Parameters<CacheFs['readFileSync']>) => {
		if (isLegacyCache(args[0])) throw missing(args[0]);
		return fs.readFileSync(...args);
	}) as CacheFs['readFileSync'];
	return {
		existsSync: (file) => !isLegacyCache(file) && fs.existsSync(file),
		readFile,
		readFileSync,
		stat: (file) => isLegacyCache(file) ? Promise.reject(missing(file)) : fs.stat(file),
		writeFile: async () => {},
		mkdir: async () => {},
	};
}

function usesVersionedCache(appDirectory: string, cacheHandler?: string): boolean {
	if (!cacheHandler || basename(cacheHandler.replace(/\\/g, '/')) !== 'VersionedCacheHandler.cjs') return false;
	const nativeRequire = createRequire(join(appDirectory, 'package.json'));
	const handler = join(appDirectory, 'node_modules', '@harperfast', 'nextjs', 'dist', 'VersionedCacheHandler.cjs');
	const packagedHandler = cacheHandler.replace(/\\/g, '/').endsWith('/node_modules/@harperfast/nextjs/dist/VersionedCacheHandler.cjs');
	return packagedHandler || nativeRequire.resolve(resolve(appDirectory, cacheHandler)) === nativeRequire.resolve(handler);
}

export async function bindVersionedCache(appDirectory: string, cacheDirectory?: string): Promise<CacheBinding | undefined> {
	appDirectory = resolve(appDirectory);
	const manifestFile = join(appDirectory, '.next', 'required-server-files.json');
	if (!existsSync(manifestFile)) return;
	const { config } = JSON.parse(readFileSync(manifestFile, 'utf8'));
	if (!usesVersionedCache(appDirectory, config?.cacheHandler)) return;
	const nativeRequire = createRequire(join(appDirectory, 'package.json'));

	const distDirectory = resolve(appDirectory, config.distDir ?? '.next');
	const serverDistDir = join(distDirectory, 'server');
	const cacheRoot = cacheDirectory ? resolve(appDirectory, cacheDirectory) : join(dirname(dirname(appDirectory)), '.nextjs-cache');
	const cacheRelative = relative(appDirectory, cacheRoot);
	if (!cacheRelative || (!isAbsolute(cacheRelative) && !cacheRelative.startsWith('..' + sep) && cacheRelative !== '..')) {
		throw new Error(`Next.js cacheDirectory must be outside the component directory: ${cacheRoot}`);
	}
	const FileSystemCache = nativeRequire('next/dist/server/lib/incremental-cache/file-system-cache.js').default;
	const seedFs = seedFileSystem(nativeRequire('next/dist/server/lib/node-fs-methods.js').nodeFs, serverDistDir);
	const identity = await buildIdentity(appDirectory, distDirectory);
	const binding: CacheBinding = {
		appDirectory,
		distDirectory,
		serverDistDir,
		cacheDirectory: join(cacheRoot, hash(appDirectory), identity),
		identity,
		FileSystemCache,
		seedFs,
	};
	const previous = bindings.get(serverDistDir);
	if (previous && (previous.identity !== identity || previous.cacheDirectory !== binding.cacheDirectory)) {
		throw new Error(`A different Next.js build is already bound in this worker: ${appDirectory}; restart the worker`);
	}
	mkdirSync(join(binding.cacheDirectory, 'server'), { recursive: true });
	bindings.set(serverDistDir, Object.freeze(binding));
	return binding;
}

export async function assertVersionedCacheBuild(binding: CacheBinding): Promise<void> {
	if (await buildIdentity(binding.appDirectory, binding.distDirectory) !== binding.identity) {
		throw new Error(`Next.js build changed while starting ${binding.appDirectory}; restart the application`);
	}
}

export function assertVersionedCacheConfig(appDirectory: string, config: { cacheHandler?: string; distDir?: string }, binding?: CacheBinding): void {
	const optedIn = usesVersionedCache(appDirectory, config.cacheHandler);
	if (optedIn !== Boolean(binding) || (binding && binding.serverDistDir !== join(resolve(appDirectory, config.distDir ?? '.next'), 'server'))) {
		throw new Error('Versioned Next.js cache build/runtime configuration mismatch; rebuild the application before serving');
	}
	if (optedIn) createRequire(join(appDirectory, 'package.json')).resolve(resolve(appDirectory, config.cacheHandler!));
}

export function getCacheBinding(serverDistDir: string): CacheBinding | undefined {
	return bindings.get(resolve(serverDistDir));
}

export function markProductionCache(serverDistDir: string): void {
	productionContexts.add(resolve(serverDistDir));
}

export function isProductionCache(serverDistDir: string): boolean {
	return productionContexts.has(resolve(serverDistDir));
}

export function stockCacheConstructor(serverDistDir: string): typeof FileSystemCache {
	const cached = fallbackConstructors.get(serverDistDir);
	if (cached) return cached;
	const constructor = createRequire(join(serverDistDir, 'package.json'))('next/dist/server/lib/incremental-cache/file-system-cache.js').default as typeof FileSystemCache;
	fallbackConstructors.set(serverDistDir, constructor);
	return constructor;
}
