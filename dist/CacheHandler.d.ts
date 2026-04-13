import type { CacheHandler, CacheHandlerValue } from 'next/dist/server/lib/incremental-cache/index.d.ts';
import type { IncrementalCacheValue, GetIncrementalFetchCacheContext, GetIncrementalResponseCacheContext, SetIncrementalFetchCacheContext, SetIncrementalResponseCacheContext } from 'next/dist/server/response-cache/index.d.ts';
export default class HarperCacheHandler implements CacheHandler {
    constructor();
    get(key: string, _ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext): Promise<CacheHandlerValue | null>;
    set(key: string, data: IncrementalCacheValue | null, _ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext): Promise<void>;
    revalidateTag(_tag: string | string[]): Promise<void>;
    resetRequestCache(): void;
}
