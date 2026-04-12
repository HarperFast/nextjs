import { notFound } from 'next/navigation';

export default async function Dog({ dog }) {
	return dog ? (
		<div>
			<h1>{dog.name}</h1>
			<p>{dog.breed}</p>
			<p>Woof!</p>
		</div>
	) : (
		notFound()
	);
}
