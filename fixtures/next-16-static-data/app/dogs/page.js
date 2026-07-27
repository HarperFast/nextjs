// A statically generated page that reads a Harper table at build time. No `force-dynamic`, no
// dynamic APIs, so Next.js prerenders it during `next build` — and Next.js runs static generation in
// a *child process*. Loading Harper there opens the same RocksDB databases the parent Harper process
// already has open, which without `HARPER_READONLY` fails with:
//
//   Error: IO error: While lock file: <root>/database/data/LOCK: Resource temporarily unavailable
//
// Real apps declare `harper` as a dependency and use the bare `import('harper')` specifier (see
// HarperFast/nextjs-example). Fixtures can't: the harness deep-copies the fixture directory into the
// Harper root and `harper` installs to ~577MB. So the test passes harper's already-resolved entry
// path in via `HARPER_FIXTURE_HARPER_ENTRY`. The mechanism under test is unchanged — a build child
// process loading Harper's storage layer against a database the parent holds locked.
const harperEntry = process.env.HARPER_FIXTURE_HARPER_ENTRY;

async function listDogs() {
	// Served from a Harper worker thread, the `tables` global is already there. In the build child it
	// is not, and loading Harper is what installs it (and opens the databases).
	//
	// The ignore comments are required: both bundlers otherwise try to resolve this specifier at build
	// time and fail with "Cannot find module as expression is too dynamic". They tell the bundler to
	// leave the import alone and let Node resolve the absolute path at runtime.
	if (typeof globalThis.tables === 'undefined') {
		if (!harperEntry) {
			throw new Error(
				'HARPER_FIXTURE_HARPER_ENTRY is not set, so this fixture cannot load Harper outside a Harper thread. ' +
					'It is passed in by integrationTests/next-16-static-data.pw.ts.'
			);
		}
		await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ harperEntry);
	}

	// No fallback if `tables.Dog` is missing, deliberately. An empty list is a *meaningful* result here
	// — it is what a read-only child renders when it can't see the parent's unflushed writes — so
	// swallowing a failure to load Harper as `[]` would make this test pass for the wrong reason.
	const dogs = [];
	for await (const dog of globalThis.tables.Dog.search()) {
		dogs.push({ id: dog.id, name: dog.name });
	}
	return dogs;
}

export default async function Page() {
	const dogs = await listDogs();

	return (
		<ul data-testid="dogs">
			{dogs.map((dog) => (
				<li key={dog.id} data-testid={`dog-${dog.id}`}>
					{dog.name}
				</li>
			))}
		</ul>
	);
}
