import Link from 'next/link';

export default function NotFound() {
	return (
		<div>
			<h1>404 Woof!</h1>
			<p>Page not found.</p>
			<Link href="/">Home</Link>
		</div>
	);
}
