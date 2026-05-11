import type {
	CacheHandler,
	CacheHandlerContext,
	CacheHandlerValue,
} from 'next/dist/server/lib/incremental-cache/index.d.ts';

import type {
	IncrementalCacheValue,
	GetIncrementalFetchCacheContext,
	GetIncrementalResponseCacheContext,
	SetIncrementalFetchCacheContext,
	SetIncrementalResponseCacheContext,
} from 'next/dist/server/response-cache/index.d.ts';

import type { databases as DatabasesType } from 'harper';

const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';

// Map of tag → invalidation timestamp (ms). Hydrated from the
// nextjs_cache_invalidation table on first construction and kept fresh via a
// Harper subscription so any worker observes invalidations from any other.
const cacheInvalidations = new Map<string, number>();

let subscriptionInitialized = false;

// `databases` is a Harper-provided global. Access it lazily so that loading
// this module from a non-Harper context (e.g. a turbopack build worker that
// resolves the cacheHandler path) does not pull in the harper runtime — which
// would register native worker hooks a second time and crash with
// "Worker creator already registered".
function getDatabases(): typeof DatabasesType | undefined {
	return (globalThis as { databases?: typeof DatabasesType }).databases;
}

async function initializeSubscription(): Promise<void> {
	if (subscriptionInitialized) return;
	const databases = getDatabases();
	if (!databases) return;
	subscriptionInitialized = true;

	// Harper's TypeScript types require RequestTarget/SubscriptionRequest objects,
	// but the runtime accepts plain object literals (and search() accepts no args).
	const table = databases.harperfast_nextjs.nextjs_cache_invalidation as unknown as {
		search: () => AsyncIterable<{ id: string; timestamp: number }>;
		subscribe: (req: { omitCurrent?: boolean }) => Promise<{
			on: (event: string, listener: (e: { type: string; id: string; value?: { timestamp: number } }) => void) => void;
		}>;
	};

	try {
		for await (const row of table.search()) {
			cacheInvalidations.set(row.id, row.timestamp);
		}

		const subscription = await table.subscribe({ omitCurrent: true });

		subscription.on('data', (event) => {
			if (!event.id) return;
			if (event.type === 'delete') {
				cacheInvalidations.delete(event.id);
			} else if (event.type === 'put' && event.value) {
				cacheInvalidations.set(event.id, event.value.timestamp);
			}
		});

		subscription.on('error', (error) => {
			console.error('[CacheHandler] invalidation subscription error', error);
		});
	} catch (error) {
		// Reset so a future construction can retry — failure here means we lose
		// cross-worker visibility, but the cache still works (just falls back to
		// per-request revalidatedTags).
		subscriptionInitialized = false;
		console.error('[CacheHandler] failed to initialize invalidation subscription', error);
	}
}

function extractTags(data: IncrementalCacheValue | null, ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext): string[] {
	if (!data) return [];

	// FETCH entries carry tags via ctx.tags (set context) and data.tags.
	if ('fetchCache' in ctx && ctx.fetchCache && 'tags' in ctx && ctx.tags) {
		return ctx.tags;
	}

	// APP_PAGE / APP_ROUTE / PAGES carry tags via the NEXT_CACHE_TAGS_HEADER
	// header that Next.js writes into the cached value.
	const headers = (data as { headers?: Record<string, unknown> }).headers;
	const tagsHeader = headers?.[NEXT_CACHE_TAGS_HEADER];
	if (typeof tagsHeader === 'string' && tagsHeader.length > 0) {
		return tagsHeader.split(',').map((t) => t.trim()).filter(Boolean);
	}

	const dataTags = (data as { tags?: unknown }).tags;
	if (Array.isArray(dataTags)) {
		return dataTags.filter((t): t is string => typeof t === 'string');
	}

	return [];
}

function isInvalidated(
	recordTags: string[],
	lastModified: number,
	revalidatedTags: string[],
	ctxTags: string[]
): boolean {
	const allTags = recordTags.length > 0 ? recordTags : ctxTags;
	for (const tag of allTags) {
		if (revalidatedTags.includes(tag)) return true;
		const invalidatedAt = cacheInvalidations.get(tag);
		if (invalidatedAt !== undefined && invalidatedAt > lastModified) return true;
	}
	return false;
}

export default class HarperCacheHandler implements CacheHandler {
	private revalidatedTags: string[];

	constructor(ctx?: CacheHandlerContext) {
		this.revalidatedTags = ctx?.revalidatedTags ?? [];
		void initializeSubscription();
	}

	async get(
		key: string,
		ctx: GetIncrementalFetchCacheContext | GetIncrementalResponseCacheContext
	): Promise<CacheHandlerValue | null> {
		const databases = getDatabases();
		if (!databases) return null;

		const table = databases.harperfast_nextjs.nextjs_isr_cache;
		const record = await table.get(key);
		if (!record) return null;

		const recordTags = Array.isArray(record.tags) ? (record.tags as string[]) : [];

		const ctxTags =
			'tags' in ctx && Array.isArray(ctx.tags)
				? [...ctx.tags, ...(('softTags' in ctx && Array.isArray(ctx.softTags)) ? ctx.softTags : [])]
				: [];

		if (isInvalidated(recordTags, record.lastModified ?? 0, this.revalidatedTags, ctxTags)) {
			return null;
		}

		return {
			value: record.data as IncrementalCacheValue | null,
			lastModified: record.lastModified,
		};
	}

	async set(
		key: string,
		data: IncrementalCacheValue | null,
		ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
	): Promise<void> {
		const databases = getDatabases();
		if (!databases) return;

		const table = databases.harperfast_nextjs.nextjs_isr_cache;
		const tags = extractTags(data, ctx);
		await table.put(key, {
			data,
			tags,
		});
	}

	async revalidateTag(tags: string | string[]): Promise<void> {
		const tagList = typeof tags === 'string' ? [tags] : tags;
		if (tagList.length === 0) return;

		const databases = getDatabases();
		if (!databases) return;

		const table = databases.harperfast_nextjs.nextjs_cache_invalidation;
		const timestamp = Date.now();

		// Update the local map immediately so reads on this worker see the
		// invalidation without waiting for the subscription roundtrip.
		for (const tag of tagList) {
			cacheInvalidations.set(tag, timestamp);
		}

		await Promise.all(tagList.map((tag) => table.put(tag, { timestamp })));
	}

	resetRequestCache(): void {}
}
