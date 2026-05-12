import type { CacheHandler, CacheHandlerValue } from 'next/dist/server/lib/incremental-cache/index.d.ts';

import type {
	IncrementalCacheValue,
	GetIncrementalFetchCacheContext,
	GetIncrementalResponseCacheContext,
	SetIncrementalFetchCacheContext,
	SetIncrementalResponseCacheContext,
} from 'next/dist/server/response-cache/index.d.ts';

// Type-only import: erased at compile time so `harper` is never resolved when this
// module is loaded from a non-Harper context (e.g. Next.js's build worker, which
// requires the cacheHandler path directly via Node's `require`, bypassing webpack
// externals and serverExternalPackages).
import type { databases as DatabasesType } from 'harper';

// `databases` is a Harper-provided global registered when the plugin is loaded
// in-process by Harper. Resolve it lazily so loading this file in a build worker
// does not pull in the harper runtime — which would otherwise try to register
// native worker hooks a second time and crash with "Worker creator already
// registered", restarting the HTTP worker until Harper gives up.
function getDatabases(): typeof DatabasesType | undefined {
	return (globalThis as { databases?: typeof DatabasesType }).databases;
}

export default class HarperCacheHandler implements CacheHandler {
	constructor() {}

	async get(
		key: string,
		_ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext
	): Promise<CacheHandlerValue | null> {
		const databases = getDatabases();
		if (!databases) return null;

		const table = databases.harperfast_nextjs.nextjs_isr_cache;
		const record = await table.get(key);
		if (!record) return null;

		try {
			return {
				value: record.data,
				lastModified: record.lastModified,
			};
		} catch {
			return null;
		}
	}

	async set(
		key: string,
		data: IncrementalCacheValue | null,
		_ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
	): Promise<void> {
		const databases = getDatabases();
		if (!databases) return;

		const table = databases.harperfast_nextjs.nextjs_isr_cache;
		await table.put(key, {
			data,
		});
	}

	async revalidateTag(_tag: string | string[]): Promise<void> {
		// TODO: implement tag-based invalidation
	}

	resetRequestCache(): void {}
}
