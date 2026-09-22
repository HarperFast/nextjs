import { Suspense } from 'react';
import { cacheLife, cacheTag } from 'next/cache';

async function CachedNonce() {
	'use cache';
	cacheLife('hours');
	cacheTag('use-cache-tag');

	// Regenerating produces a different value, so a stable value across reads proves the entry was
	// served from cache rather than re-rendered.
	return <p data-testid="nonce">{Math.random().toString(36).slice(2)}</p>;
}

export default function CachedPage() {
	return (
		<div>
			<h1>Use Cache Page</h1>
			<Suspense fallback={<p data-testid="nonce">loading</p>}>
				<CachedNonce />
			</Suspense>
		</div>
	);
}
