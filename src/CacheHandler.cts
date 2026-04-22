import type { CacheHandler, CacheHandlerValue } from 'next/dist/server/lib/incremental-cache/index.d.ts';

import type {
	IncrementalCacheValue,
	GetIncrementalFetchCacheContext,
	GetIncrementalResponseCacheContext,
	SetIncrementalFetchCacheContext,
	SetIncrementalResponseCacheContext,
} from 'next/dist/server/response-cache/index.d.ts';

import { databases } from 'harper';

export default class HarperCacheHandler implements CacheHandler {
	constructor() {}

	async get(
		key: string,
		_ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext
	): Promise<CacheHandlerValue | null> {
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
