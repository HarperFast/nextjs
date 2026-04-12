import Dog from '../../components/Dog';
import { listDogs, getDog } from '../../data';

export const revalidate = 1;

export default async function ISRDog({ params }) {
	const dog = await getDog(params.id);

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
