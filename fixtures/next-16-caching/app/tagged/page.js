import { unstable_cache } from 'next/cache';

const getNonce = unstable_cache(
	async () => Math.random().toString(36).slice(2),
	['tagged-nonce'],
	{ tags: ['test-tag'], revalidate: 3600 }
);

export default async function TaggedPage() {
	const nonce = await getNonce();
	return (
		<div>
			<h1>Tagged Page</h1>
			<p data-testid="nonce">{nonce}</p>
		</div>
	);
}
