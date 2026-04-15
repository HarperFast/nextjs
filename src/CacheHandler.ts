import type { CacheHandler, CacheHandlerValue } from 'next/dist/server/lib/incremental-cache/index.d.ts';

import type {
	IncrementalCacheValue,
	GetIncrementalFetchCacheContext,
	GetIncrementalResponseCacheContext,
	SetIncrementalFetchCacheContext,
	SetIncrementalResponseCacheContext,
} from 'next/dist/server/response-cache/index.d.ts';

import { databases } from 'harper';

/**
 * Serialize a cache value to a JSON string, handling non-serializable types.
 *
 * Next.js ISR cache values can contain:
 * - Map objects (used in segment data for RSC payloads)
 * - Buffer objects (used for rscData binary payloads)
 *
 * These are encoded with a `__type` marker so we can restore them on read.
 */
function serialize(value: IncrementalCacheValue | null): string {
	return JSON.stringify(value, (_key, val) => {
		if (val instanceof Map) {
			return { __type: 'Map', entries: Array.from(val.entries()) };
		}
		if (val instanceof Buffer || (val && val.type === 'Buffer' && Array.isArray(val.data))) {
			return { __type: 'Buffer', data: Buffer.from(val.data ?? val).toString('base64') };
		}
		return val;
	});
}

/**
 * Deserialize a JSON string back to a cache value, restoring non-serializable types.
 */
function deserialize(raw: string): IncrementalCacheValue | null {
	return JSON.parse(raw, (_key, val) => {
		if (val && typeof val === 'object') {
			if (val.__type === 'Map') {
				return new Map(val.entries);
			}
			if (val.__type === 'Buffer') {
				return Buffer.from(val.data, 'base64');
			}
		}
		return val;
	});
}

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
			const value = deserialize(record.data);
			return {
				value,
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
			data: serialize(data),
		});
	}

	async revalidateTag(_tag: string | string[]): Promise<void> {
		// TODO: implement tag-based invalidation
	}

	resetRequestCache(): void {}
}
