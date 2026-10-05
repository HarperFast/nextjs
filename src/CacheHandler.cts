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
	entryExpiresAt,
	initializeInvalidationSubscription,
	nextServesStaleTags,
	recordInvalidation,
	tagState,
	toStoredLife,
} from './cacheInvalidation.cjs';

const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';

// Kinds for which Next 16's IncrementalCache itself checks the tags manifest and serves a tag-stale entry
// stale-while-revalidate. For any other kind, or on Next 14/15, an invalidated entry has to be withheld,
// because Next would otherwise serve it as fresh.
const TAG_AWARE_KINDS = new Set(['APP_PAGE', 'APP_ROUTE', 'FETCH']);

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

function canServeStale(data: unknown): boolean {
	const value = data as { kind?: string; headers?: Record<string, unknown> } | null;
	if (!value?.kind || !TAG_AWARE_KINDS.has(value.kind) || !nextServesStaleTags()) return false;
	// FETCH entries are tag-checked against the request's own tags; pages only through the header Next
	// wrote into the entry.
	return value.kind === 'FETCH' || typeof value.headers?.[NEXT_CACHE_TAGS_HEADER] === 'string';
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
		// A worker that has not read the tombstones back cannot tell an invalidated entry from a fresh one.
		if (!(await initializeInvalidationSubscription())) return null;

		const table = databases.harperfast_nextjs.nextjs_isr_cache;
		const record = await table.get(key);
		if (!record || record.data === undefined) return null;

		// Past its own `expire` the entry is no longer usable at all, regardless of tags.
		if (isExpired(record as { lastModified?: number; expire?: number })) return null;

		const recordTags = Array.isArray(record.tags) ? (record.tags as string[]) : [];
		const ctxTags = [
			...('tags' in ctx && Array.isArray(ctx.tags) ? ctx.tags : []),
			...('softTags' in ctx && Array.isArray(ctx.softTags) ? ctx.softTags : []),
		];
		const tags = [...recordTags, ...ctxTags];

		// An on-demand revalidation for this request is an explicit demand for fresh content.
		if (tags.some((tag) => this.revalidatedTags.includes(tag))) return null;

		const state = tagState(tags, record.lastModified ?? 0);
		if (state === 'expired') return null;
		// Where Next serves a tag-stale entry stale-while-revalidate on its own, hand it over with its real
		// age: a miss here would cost a full blocking render.
		if (state === 'stale' && !canServeStale(record.data)) return null;

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

		// Persisted so the entry's own `expire` is enforced on every node. See `toStoredLife` for why the
		// values are bounded: a rejected write here is silent — the entry simply never lands.
		const cacheControl = 'cacheControl' in ctx ? ctx.cacheControl : undefined;
		const revalidate = toStoredLife(typeof cacheControl?.revalidate === 'number' ? cacheControl.revalidate : undefined);
		const expire = toStoredLife(cacheControl?.expire);

		const now = Date.now();
		// The raw `expire`, not the stored one: see `entryExpiresAt` on why an unbounded life is left to
		// the table's own expiration rather than pinned for the year `toStoredLife` bounds it to.
		const expiresAt = entryExpiresAt(now, cacheControl?.expire, now);
		await table.put(key, { data, tags, revalidate, expire }, expiresAt === undefined ? undefined : ({ expiresAt } as never));
	}

	async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
		const tagList = typeof tags === 'string' ? [tags] : tags;
		await recordInvalidation(tagList, durations);
	}

	resetRequestCache(): void {}
}
