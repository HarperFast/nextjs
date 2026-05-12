import type { CacheHandler, CacheHandlerContext, CacheHandlerValue } from 'next/dist/server/lib/incremental-cache/index.d.ts';
import type { IncrementalCacheValue, GetIncrementalFetchCacheContext, GetIncrementalResponseCacheContext, SetIncrementalFetchCacheContext, SetIncrementalResponseCacheContext } from 'next/dist/server/response-cache/index.d.ts';
export default class HarperCacheHandler implements CacheHandler {
    private revalidatedTags;
    constructor(ctx?: CacheHandlerContext);
    get(key: string, ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext): Promise<CacheHandlerValue | null>;
    set(key: string, data: IncrementalCacheValue | null, ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext): Promise<void>;
    revalidateTag(tags: string | string[]): Promise<void>;
    resetRequestCache(): void;
}
