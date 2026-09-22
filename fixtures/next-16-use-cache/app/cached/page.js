import { Suspense } from 'react';
import { cacheLife, cacheTag } from 'next/cache';
import { cookies } from 'next/headers';

// Keyed on `bucket`, so two requests in the same bucket must resolve to the same value. Regenerating
// produces a different nonce, so a stable value proves the entry came from cache.
async function CachedNonce({ bucket }) {
	'use cache';
	cacheLife('hours');
	cacheTag('use-cache-tag');

	return (
		<p data-testid="nonce">
			{bucket}:{Math.random().toString(36).slice(2)}
		</p>
	);
}

// Reading cookies keeps the route dynamic. Without this the whole page is prerendered at build time,
// the cached boundary is resolved during `next build` and baked into the static shell, and the cache
// handler is never called at request time — which is not the path worth testing.
async function BucketedNonce() {
	const store = await cookies();
	return <CachedNonce bucket={store.get('bucket')?.value ?? 'default'} />;
}

export default function CachedPage() {
	return (
		<div>
			<h1>Use Cache Page</h1>
			<Suspense fallback={<p data-testid="nonce-loading">loading</p>}>
				<BucketedNonce />
			</Suspense>
		</div>
	);
}
