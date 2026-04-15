// revalidate every 2 seconds so tests can observe stale-while-revalidate behavior
// without waiting too long
export const revalidate = 2;

export default async function ISRPage() {
	return (
		<div>
			<h1>ISR Page</h1>
			<p data-testid="timestamp">{new Date().toISOString()}</p>
		</div>
	);
}
