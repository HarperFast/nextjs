import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
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

function buildIdentity(appDirectory: string, distDirectory: string): string {
	const digest = createHash('sha256');
	const buffer = Buffer.allocUnsafe(256 * 1024);
	const addFile = (file: string) => {
		const fd = openSync(file, 'r');
		try {
			digest.update(JSON.stringify([relative(appDirectory, file), fstatSync(fd).size]));
			let length: number;
			while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
		} finally {
			closeSync(fd);
		}
	};
	const addDirectory = (directory: string, skip?: string) => {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const entry of entries) {
			if (entry.name === skip) continue;
			const file = join(directory, entry.name);
			if (entry.isDirectory()) addDirectory(file);
			else if (entry.isFile()) addFile(file);
			else throw new Error(`Versioned Next.js cache requires regular build files: ${file}`);
		}
	};

	const buildIdFile = join(distDirectory, 'BUILD_ID');
	if (!readFileSync(buildIdFile, 'utf8').trim()) throw new Error(`Missing Next.js build identity: ${buildIdFile}`);
	addFile(buildIdFile);
	addFile(join(appDirectory, 'node_modules', 'next', 'package.json'));
	for (const manifest of ['required-server-files.json', 'prerender-manifest.json', 'routes-manifest.json', 'build-manifest.json', 'app-build-manifest.json']) {
		const file = join(distDirectory, manifest);
		if (existsSync(file)) addFile(file);
	}
	addDirectory(join(distDirectory, 'server'), 'route-cache');
	const fetchSeeds = join(distDirectory, 'cache', 'fetch-cache');
	if (existsSync(fetchSeeds)) addDirectory(fetchSeeds);
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

export function bindVersionedCache(appDirectory: string, cacheDirectory?: string): CacheBinding | undefined {
	appDirectory = resolve(appDirectory);
	const manifestFile = join(appDirectory, '.next', 'required-server-files.json');
	if (!existsSync(manifestFile)) return;
	const { config } = JSON.parse(readFileSync(manifestFile, 'utf8'));
	if (!config?.cacheHandler || basename(config.cacheHandler.replace(/\\/g, '/')) !== 'VersionedCacheHandler.cjs') return;
	const nativeRequire = createRequire(join(appDirectory, 'package.json'));
	const handler = join(appDirectory, 'node_modules', '@harperfast', 'nextjs', 'dist', 'VersionedCacheHandler.cjs');
	const packagedHandler = config.cacheHandler.replace(/\\/g, '/').endsWith('/node_modules/@harperfast/nextjs/dist/VersionedCacheHandler.cjs');
	if (!packagedHandler && nativeRequire.resolve(resolve(appDirectory, config.cacheHandler)) !== nativeRequire.resolve(handler)) return;

	const distDirectory = resolve(appDirectory, config.distDir ?? '.next');
	const serverDistDir = join(distDirectory, 'server');
	const cacheRoot = cacheDirectory ? resolve(appDirectory, cacheDirectory) : join(dirname(dirname(appDirectory)), '.nextjs-cache');
	const cacheRelative = relative(appDirectory, cacheRoot);
	if (!cacheRelative || (!isAbsolute(cacheRelative) && !cacheRelative.startsWith('..' + sep) && cacheRelative !== '..')) {
		throw new Error(`Next.js cacheDirectory must be outside the component directory: ${cacheRoot}`);
	}
	const identity = buildIdentity(appDirectory, distDirectory);
	const binding: CacheBinding = {
		appDirectory,
		distDirectory,
		serverDistDir,
		cacheDirectory: join(cacheRoot, hash(appDirectory), identity),
		identity,
		FileSystemCache: nativeRequire('next/dist/server/lib/incremental-cache/file-system-cache.js').default,
		seedFs: seedFileSystem(nativeRequire('next/dist/server/lib/node-fs-methods.js').nodeFs, serverDistDir),
	};
	const previous = bindings.get(serverDistDir);
	if (previous && (previous.identity !== identity || previous.cacheDirectory !== binding.cacheDirectory)) {
		throw new Error(`A different Next.js build is already bound in this worker: ${appDirectory}; restart the worker`);
	}
	mkdirSync(join(binding.cacheDirectory, 'server'), { recursive: true });
	bindings.set(serverDistDir, Object.freeze(binding));
	return binding;
}

export function assertVersionedCacheBuild(binding: CacheBinding): void {
	if (buildIdentity(binding.appDirectory, binding.distDirectory) !== binding.identity) {
		throw new Error(`Next.js build changed while starting ${binding.appDirectory}; restart the application`);
	}
}

export function getCacheBinding(serverDistDir: string): CacheBinding | undefined {
	return bindings.get(serverDistDir);
}

export function markProductionCache(serverDistDir: string): void {
	productionContexts.add(resolve(serverDistDir));
}

export function isProductionCache(serverDistDir: string): boolean {
	return productionContexts.has(serverDistDir);
}

export function stockCacheConstructor(serverDistDir: string): typeof FileSystemCache {
	const cached = fallbackConstructors.get(serverDistDir);
	if (cached) return cached;
	const constructor = createRequire(join(serverDistDir, 'package.json'))('next/dist/server/lib/incremental-cache/file-system-cache.js').default as typeof FileSystemCache;
	fallbackConstructors.set(serverDistDir, constructor);
	return constructor;
}

export async function sweepVersionedCache(binding: CacheBinding): Promise<number> {
	let deleted = 0;
	const appCache = dirname(binding.cacheDirectory);
	const entries = await readdir(appCache, { withFileTypes: true });
	if (buildIdentity(binding.appDirectory, binding.distDirectory) !== binding.identity) return 0;
	for (const entry of entries) {
		if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && entry.name !== binding.identity) {
			await rm(join(appCache, entry.name), { recursive: true, force: true });
			deleted++;
		}
	}
	return deleted;
}
