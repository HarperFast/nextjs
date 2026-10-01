import { Suspense } from 'react';
import { cacheLife, cacheTag } from 'next/cache';
import { cookies } from 'next/headers';

const NODE = () => process.env.RIG_NODE ?? 'unknown';

/**
 * The new handler. The node that generated this value is baked into it, so when the page is served
 * from a different node than the one shown here, the entry crossed the cluster rather than being
 * regenerated locally — which is the whole claim.
 */
async function CachedBoundary({ bucket }) {
	'use cache';
	cacheLife('hours');
	cacheTag('rig-tag');

	return (
		<>
			<span data-testid="cached-by">{NODE()}</span>
			<span data-testid="cached-nonce">{Math.random().toString(36).slice(2, 10)}</span>
		</>
	);
}

/**
 * Reading cookies keeps the route dynamic. Without this the page is prerendered at build time, the
 * cached boundary is resolved during `next build`, and the handler is never called at request time —
 * a rig that cannot fail for the right reason.
 */
async function DynamicHole() {
	const store = await cookies();
	const bucket = store.get('bucket')?.value ?? 'default';

	return (
		<>
			<span data-testid="served-by">{NODE()}</span>
			<span data-testid="bucket">{bucket}</span>
			<CachedBoundary bucket={bucket} />
		</>
	);
}

export default function RigPage() {
	return (
		<main>
			<Suspense fallback={<span data-testid="pending">pending</span>}>
				<DynamicHole />
			</Suspense>
		</main>
	);
}
