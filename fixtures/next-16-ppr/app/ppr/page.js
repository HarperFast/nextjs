import { Suspense } from 'react';
import { connection } from 'next/server';

const DYNAMIC_DELAY_MS = 3000;

async function SlowDynamic() {
	await connection();
	await new Promise((resolve) => setTimeout(resolve, DYNAMIC_DELAY_MS));
	return <p data-testid="dynamic">ppr-dynamic-content:{Date.now()}</p>;
}

export default function PprPage() {
	return (
		<div>
			<h1 data-testid="shell">ppr-static-shell</h1>
			<Suspense fallback={<p data-testid="dynamic-loading">loading</p>}>
				<SlowDynamic />
			</Suspense>
		</div>
	);
}
