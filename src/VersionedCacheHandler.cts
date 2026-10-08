import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
		const fetch = args[1]?.kind === 'FETCH' || (args[1] as { kindHint?: string } | undefined)?.kindHint === 'fetch';
		// Native null also means invalidation; a runtime-owned key must not resurrect an older seed.
		try {
			await stat(this.runtimeEntryFile(args[0], fetch));
			return null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		// Falling back per file could combine a runtime HTML file with a different build seed's RSC.
		this.seed ??= new this.binding.FileSystemCache({ ...this.context, fs: this.binding.seedFs });
		return this.seed.get(...args);
	}

	async set(...args: Parameters<FileSystemCache['set']>): ReturnType<FileSystemCache['set']> {
		if (this.binding && this.context.flushToDisk) {
			const fetch = args[1]?.kind === 'FETCH' || (args[2] as { fetchCache?: boolean } | undefined)?.fetchCache === true;
			const file = this.runtimeEntryFile(args[0], fetch);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, '');
		}
		return this.runtime.set(...args);
	}

	private runtimeEntryFile(key: string, fetch: boolean): string {
		return join(this.binding!.cacheDirectory, 'entries', fetch ? 'fetch' : 'render', createHash('sha256').update(key).digest('hex'));
	}

	revalidateTag(...args: Parameters<FileSystemCache['revalidateTag']>): ReturnType<FileSystemCache['revalidateTag']> {
		return this.runtime.revalidateTag(...args);
	}

	resetRequestCache(): void {
		this.runtime.resetRequestCache();
		this.seed?.resetRequestCache();
	}
}
