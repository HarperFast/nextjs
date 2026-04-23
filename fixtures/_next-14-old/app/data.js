import('harperdb');

export function getDog(id) {
	return tables.Dog.get(id);
}

export function listDogs() {
	return tables.Dog.search().map((dog) => ({ id: dog.id }));
}
