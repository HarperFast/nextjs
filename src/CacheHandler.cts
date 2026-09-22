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

import {
	cacheInvalidations,
	initializeInvalidationSubscription,
	isInvalidated,
	recordInvalidation,
} from './cacheInvalidation.cjs';

const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';

// Kinds for which Next re-checks its tags manifest and can classify an entry as *stale* rather than
// missing. For anything else an invalidated entry has to be withheld, because Next would otherwise
// serve it indefinitely.
const TAG_AWARE_KINDS = new Set(['APP_PAGE', 'APP_ROUTE']);

// `databases` is a Harper-provided global. Access it lazily so that loading this module from a
// non-Harper context (e.g. a turbopack build worker that resolves the cacheHandler path) does not pull
// in the harper runtime — which would register native worker hooks a second time and crash with
// "Worker creator already registered".
function getDatabases(): typeof DatabasesType | undefined {
	return (globalThis as { databases?: typeof DatabasesType }).databases;
}

function extractTags(
	data: IncrementalCacheValue | null,
	ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext
): string[] {
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
		return tagsHeader
			.split(',')
			.map((tag) => tag.trim())
			.filter(Boolean);
	}

	const dataTags = (data as { tags?: unknown }).tags;
	if (Array.isArray(dataTags)) {
		return dataTags.filter((tag): tag is string => typeof tag === 'string');
	}

	return [];
}

/**
 * True when Next will consult its own tags manifest for this entry and can therefore classify it as
 * stale. `recordInvalidation` mirrors every invalidation into that manifest, so for these kinds the
 * handler can return the entry and let Next serve it stale while regenerating, instead of forcing a
 * blocking miss.
 */
function canServeStale(data: unknown): boolean {
	const value = data as { kind?: string; headers?: Record<string, unknown> } | null;
	if (!value?.kind || !TAG_AWARE_KINDS.has(value.kind)) return false;
	return typeof value.headers?.[NEXT_CACHE_TAGS_HEADER] === 'string';
}

function isExpired(record: { lastModified?: number; expire?: number }): boolean {
	if (typeof record.expire !== 'number' || record.expire <= 0) return false;
	const lastModified = record.lastModified ?? 0;
	return lastModified + record.expire * 1000 < Date.now();
}

export default class HarperCacheHandler implements CacheHandler {
	private revalidatedTags: string[];

	constructor(ctx?: CacheHandlerContext) {
		this.revalidatedTags = ctx?.revalidatedTags ?? [];
		void initializeInvalidationSubscription();
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

		// Past its own `expire` the entry is no longer usable at all, regardless of tags.
		if (isExpired(record as { lastModified?: number; expire?: number })) return null;

		const recordTags = Array.isArray(record.tags) ? (record.tags as string[]) : [];

		const ctxTags =
			'tags' in ctx && Array.isArray(ctx.tags)
				? [...ctx.tags, ...('softTags' in ctx && Array.isArray(ctx.softTags) ? ctx.softTags : [])]
				: [];

		if (isInvalidated(recordTags, record.lastModified ?? 0, this.revalidatedTags, ctxTags)) {
			// An on-demand revalidation for this request is an explicit demand for fresh content.
			if (recordTags.some((tag) => this.revalidatedTags.includes(tag))) return null;

			// Otherwise prefer stale-while-revalidate where Next supports it: a miss here costs a full
			// blocking render, which is exactly what an invalidation storm must not produce.
			if (!canServeStale(record.data)) return null;
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

		// Next keeps cache lives in a per-process Map plus the build-time prerender manifest, neither of
		// which replicates. Persisting them alongside the entry is what lets another node compute the
		// same staleness instead of falling back to `calculateRevalidate`'s 1-second default.
		const cacheControl = 'cacheControl' in ctx ? ctx.cacheControl : undefined;
		const revalidate = typeof cacheControl?.revalidate === 'number' ? cacheControl.revalidate : undefined;
		const expire = typeof cacheControl?.expire === 'number' ? cacheControl.expire : undefined;

		await table.put(key, { data, tags, revalidate, expire });
	}

	async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
		const tagList = typeof tags === 'string' ? [tags] : tags;
		await recordInvalidation(tagList, durations);
	}

	resetRequestCache(): void {}
}
