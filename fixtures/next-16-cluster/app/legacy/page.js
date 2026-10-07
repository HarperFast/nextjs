import { Suspense } from 'react';
import { unstable_cache } from 'next/cache';
import { cookies } from 'next/headers';

// The legacy incremental-cache handler. Route-segment `revalidate` is rejected under
// `cacheComponents`, so the legacy path is reached through `unstable_cache` instead — its entries are
// FETCH-kind rows in nextjs_isr_cache.
const cachedNonce = unstable_cache(
	async () => ({ node: process.env.RIG_NODE ?? 'unknown', nonce: Math.random().toString(36).slice(2, 10) }),
	['rig-legacy'],
	{ tags: ['legacy-tag'], revalidate: 3600 }
);

async function DynamicHole() {
	await cookies();
	const { node, nonce } = await cachedNonce();
	return (
		<>
			<span data-testid="legacy-cached-by">{node}</span>
			<span data-testid="legacy-nonce">{nonce}</span>
			<span data-testid="legacy-served-by">{process.env.RIG_NODE ?? 'unknown'}</span>
		</>
	);
}

export default function LegacyPage() {
	return (
		<main>
			<Suspense fallback={<span data-testid="pending">pending</span>}>
				<DynamicHole />
			</Suspense>
		</main>
	);
}
