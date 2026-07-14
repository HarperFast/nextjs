// force-dynamic so the injected secret is read at request time, proving
// loadEnv ran before Next.js rather than being baked in at build.
export const dynamic = 'force-dynamic';

export default async function Page() {
	const apiKey = process.env.MOCK_API_KEY ?? 'not-set';
	return (
		<div>
			<h1>Next.js v16</h1>
			<p data-testid="api-key">{apiKey}</p>
		</div>
	);
}
