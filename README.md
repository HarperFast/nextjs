# @harperdb/nextjs

A [HarperDB Component](https://docs.harperdb.io/docs/developers/components) for running and developing Next.js apps.

![NPM Version](https://img.shields.io/npm/v/%40harperdb%2Fnextjs)

Most Next.js features are supported as we rely on the Next.js Server provided by Next.js to run your application.

> [!TIP]
> Watch a walkthrough of this component in action here: [Next.js on HarperDB | Step-by-Step Guide for Next Level Next.js Performance](https://youtu.be/GqLEwteFJYY)

## Usage

> [!NOTE]
> This guide assumes you're already familiar with [HarperDb Components](https://docs.harperdb.io/docs/developers/components). Please review the documentation, or check out the HarperDB [Next.js Example](https://github.com/HarperDB/nextjs-example) for more information.

1. Install:

```sh
npm install @harperdb/nextjs
```

2. Add to `config.yaml`:

```yaml
'@harperdb/nextjs':
  package: '@harperdb/nextjs'
  files: '/*'
```

3. Run your app with HarperDB:

```sh
harperdb run nextjs-app
```

Alternatively, you can use the included `harperdb-nextjs` CLI:

```sh
harperdb-nextjs build | dev | start
```

4. Within any server side code paths, you can use [HarperDB Globals](https://docs.harperdb.io/docs/technical-details/reference/globals) after importing the HarperDB package:

```js
// app/actions.js
'use server';

import('harperdb');

export async function listDogs() {
	const dogs = [];
	for await (const dog of tables.Dog.search()) {
		dogs.push({ id: dog.id, name: dog.name });
	}
	return dogs;
}

export async function getDog(id) {
	return tables.Dog.get(id);
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

HarperDB relies on native dependencies and must be configured as an external package. In Next.js v14, update the next.config.js `webpack` option with:

```js
	webpack: (config) => {
		config.externals.push({
			harperdb: 'commonjs harperdb',
		});

		return config;
	},
```

## Options

> All configuration options are optional

### `buildCommand: string`

Specify a custom build command. Defaults to `next build`.

> Note: the extension will skip building if the `prebuilt` option is set to `true`

### `buildOnly: boolean`

Build the Next.js application and then exit (including shutting down HarperDB). Defaults to `false`.

### `dev: boolean`

Enables Next.js dev mode. Defaults to `false`.

### `port: number`

Specify a port for the Next.js server. Defaults to the HarperDB default port (generally `9926`).

### `prebuilt: boolean`

When enabled, the extension will look for a `.next` directory in the root of the component and skip executing the `buildCommand`. Defaults to `false`.

### `runFirst: boolean`

Configure the Next.js request handler to run first in the Harper HTTP middleware. When enabled, the Next.js request handler is executed before any other Harper HTTP middleware handlers. This is useful for things such as handling authentication directly with the Next.js app instead of delegating that to Harper. Enabling this option will conflict with other Harper HTTP things such as the REST API. Consider specifying the `port` (or `securePort`) option as well and separating the Next.js app HTTP server from the rest of Harper so there is less conflicts. Defaults to `false`.

### `securePort: number`

Specify a secure port for the Next.js server. Defaults to the HarperDB default secure port.

### `setCwd: boolean`

Harper will set the current working directory to the root of the Next.js app. Necessary for some Next.js and React libraries. Can cause other issues with Harper Components. Use with caution. Defaults to `false`.

## CLI

This package includes a CLI (`harperdb-nextjs`) that is meant to replace certain functions of the Next.js CLI. It will launch HarperDB and set sensible configuration values.

Available commands include:

### `dev`

Launches the application in Next.js development mode, and enables HMR for instantaneous updates when modifying application code.

> [!NOTE]
> Dev mode for Next.js v13+ relies on WebSockets. If you encounter an `Invalid WebSocket frame:` error, disable any other WebSocket services on the Next.js port. This commonly can be the HarperDB MQTT WebSocket service, which can be configured under the `mqtt` option within `harperdb-config.yaml`.

### `build`

Builds the application and then exits the process.

### `start`

Launches the application in Next.js production mode.

### `help`

Lists available CLI commands.
