export const dynamic = 'force-dynamic';

export default function Page() {
	const apiKey = process.env.MOCK_API_KEY ?? 'not-set';
	return (
		<div>
			<h1>Secrets Test</h1>
			<p data-testid="api-key">{apiKey}</p>
		</div>
	);
}
