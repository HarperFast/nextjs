import { join } from 'node:path';
import { getCacheBinding, isProductionCache, stockCacheConstructor, type FileSystemCacheContext } from './versionedCache.cjs';
import type FileSystemCache from 'next-16/dist/server/lib/incremental-cache/file-system-cache.js';

export default class VersionedCacheHandler {
	private runtime: FileSystemCache;
	private seed?: FileSystemCache;
	private context: FileSystemCacheContext;
	private binding: ReturnType<typeof getCacheBinding>;

	constructor(context: FileSystemCacheContext) {
		this.context = context;
		this.binding = context.dev ? undefined : getCacheBinding(context.serverDistDir);
		if (!this.binding && !context.dev && isProductionCache(context.serverDistDir)) {
			throw new Error('VersionedCacheHandler has no production build binding; check .next/required-server-files.json and restart the application');
		}
		const constructor = this.binding?.FileSystemCache ?? stockCacheConstructor(context.serverDistDir);
		this.runtime = new constructor({
			...context,
			serverDistDir: this.binding ? join(this.binding.cacheDirectory, 'server') : context.serverDistDir,
		});
	}

	async get(...args: Parameters<FileSystemCache['get']>): ReturnType<FileSystemCache['get']> {
		const entry = await this.runtime.get(...args);
		if (entry !== null || !this.binding) return entry;
		// Falling back per file could combine a runtime HTML file with a different build seed's RSC.
		this.seed ??= new this.binding.FileSystemCache({ ...this.context, fs: this.binding.seedFs, flushToDisk: true });
		return this.seed.get(...args);
	}

	set(...args: Parameters<FileSystemCache['set']>): ReturnType<FileSystemCache['set']> {
		return this.runtime.set(...args);
	}

	revalidateTag(...args: Parameters<FileSystemCache['revalidateTag']>): ReturnType<FileSystemCache['revalidateTag']> {
		return this.runtime.revalidateTag(...args);
	}

	resetRequestCache(): void {
		this.runtime.resetRequestCache();
		this.seed?.resetRequestCache();
	}
}
