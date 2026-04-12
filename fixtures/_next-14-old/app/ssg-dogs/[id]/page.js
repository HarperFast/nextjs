import Dog from '../../components/Dog';
import { getDog, listDogs } from '../../data';

export default async function SSGDog({ params }) {
	const dog = getDog(params.id);

	return (
		<div>
			<p data-testid="when">{new Date().toISOString()}</p>
			<Dog dog={dog} />
		</div>
	);
}

export function generateStaticParams() {
	return listDogs();
}
