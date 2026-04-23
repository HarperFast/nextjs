import Dog from '../../components/Dog';
import { getDog } from '../../data';

export default async function SSRDog({ params }) {
	const dog = await getDog(params.id);

	return (
		<div>
			<p data-testid="when">{new Date().toISOString()}</p>
			<Dog dog={dog} />
		</div>
	);
}
