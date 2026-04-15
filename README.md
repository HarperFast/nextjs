# @harperfast/nextjs

A [Harper Plugin](https://docs.harperdb.io/docs/reference/components/plugins) for running Next.js apps with Harper.

![NPM Version](https://img.shields.io/npm/v/%40harperfast%2Fnextjs)

> [!NOTE]
> This package currently supports **Next.js v14, v15, and v16** only.

## Usage

> [!NOTE]
> This guide assumes you're already familiar with [Harper Components](https://docs.harperdb.io/docs/reference/components). Please review the documentation, or check out the Harper [Next.js Example](https://github.com/HarperFast/nextjs-example) for more information.

1. Install:

```sh
npm install @harperfast/nextjs
```

2. Wrap your Next.js config with `withHarper()` in `next.config.js`:

```js
import { withHarper } from '@harperfast/nextjs';

export default withHarper({
	// your existing Next.js config
});
```

3. Add to `config.yaml`:

```yaml
'@harperfast/nextjs':
  package: '@harperfast/nextjs'
```

4. Run your app with Harper v5:

```sh
harper run nextjs-app
```

5. Within any server-side code paths, you can use [Harper Globals](https://docs.harperdb.io/docs/reference/globals) after importing the `harper` package:

> Just make sure you are using `withHarper()` or that you've added the `harper` (or `harper-pro`) package to the `serverExternalPackages` list in the Next.js config.

```js
// app/actions.js
'use server';

import 'harper';

export async function listDogs() {
	const dogs = [];
	for await (const dog of tables.Dog.search()) {
		dogs.push({ id: dog.id, name: dog.name });
	}
	return dogs;
}
```

```js
// app/dogs/[id]/page.jsx
import { getDog, listDogs } from '@/app/actions';

export async function generateStaticParams() {
	const dogs = await listDogs();
	return dogs;
}

export default async function Dog({ params }) {
	const dog = await getDog(params.id);

	return (
		<section>
			<h1>{dog.name}</h1>
			<p>Breed: {dog.get('breed')}</p>
			<p>Woof!</p>
		</section>
	);
}
```

## `withHarper()`

`withHarper(config: NextConfig, harperConfig?: HarperConfig): NextConfig`

A configuration helper that wraps your Next.js config. It automatically adds `harper` and `harper-pro` to `serverExternalPackages` so Harper's native dependencies are treated correctly by the bundler.

**Example:**

```js
// next.config.js
import { withHarper } from '@harperfast/nextjs';

export default withHarper({
	// Any valid Next.js configuration options
});
```

### `experimentalHarperCache: boolean`

Enables the built-in Harper [cache handler](#caching-work-in-progress). Defaults to `false`.

```js
export default withHarper(
	{
		/* Next.js config */
	},
	{ experimentalHarperCache: true }
);
```

## Options

All plugin options are configured in `config.yaml` under the `@harperfast/nextjs` key. All options are optional.

### `dev: boolean`

Enables Next.js development mode with hot module replacement (HMR). Defaults to `false`.

> [!NOTE]
> Dev mode for Next.js relies on WebSockets. If you encounter an `Invalid WebSocket frame:` error, disable any other WebSocket services running on the same port.

### `prebuilt: boolean`

When enabled, the plugin will look for an existing `.next` directory and skip the build step. Defaults to `false`.

### `buildOnly: boolean`

Build the Next.js application and then exit (including shutting down Harper). Defaults to `false`.

### `port: number`

Specify a custom HTTP port for the Next.js server. Defaults to the Harper default port (`9926`).

### `securePort: number`

Specify a custom HTTPS port for the Next.js server. Defaults to the Harper default secure port.

### `runFirst: boolean`

When enabled, the Next.js request handler runs before any other Harper HTTP middleware. Useful for scenarios where Next.js handles authentication directly. Note that enabling this will conflict with Harper's REST API on the same port — consider using a dedicated `port` to avoid conflicts. Defaults to `false`.

### `files: string`

Glob pattern specifying which files Harper should watch for changes. Example: `'/app/*'`.

## Caching (Work In Progress)

> This custom caching handler is currently a WIP and is actively being developed.

`@harperfast/nextjs` includes a built-in cache handler for Next.js [Incremental Static Regeneration (ISR)](https://nextjs.org/docs/app/guides/incremental-static-regeneration). Instead of storing cached pages on the file system, cached data is stored in Harper's database, making it available across all nodes in your Harper cluster.

Enable it via the `experimentalHarperCache` option in [`withHarper()`](#withharper):

```js
export default withHarper(
	{
		/* Next.js config */
	},
	{ experimentalHarperCache: true }
);
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
