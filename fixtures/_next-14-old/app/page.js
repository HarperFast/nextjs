import Image from 'next/image';

export default async function Page() {
	return (
		<div>
			<h1>Next.js v14</h1>
			<Image src="/hdb-logo.png" alt="HarperDB Logo" width={200} height={200} priority />
		</div>
	);
}
