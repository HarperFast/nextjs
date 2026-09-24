# @harperfast/nextjs

A [Harper Plugin](https://docs.harperdb.io/docs/reference/components/plugins) for running Next.js apps with Harper.

![NPM Version](https://img.shields.io/npm/v/%40harperfast%2Fnextjs)

> [!NOTE]
> This package currently supports **Next.js v14, v15, and v16** only.

> [!IMPORTANT]
> Requires **Harper v5** to run. **Static generation that reads Harper data at build time requires Harper v5.1 or newer** — it depends on the `HARPER_READONLY` build mode and `flushDatabases`, which do not exist in Harper v5.0.x. On Harper v5.0.x the build ignores read-only mode and fails when the build process cannot acquire the RocksDB lock held by the running instance.

## Usage

> [!NOTE]
> This guide assumes you're already familiar with [Harper Components](https://docs.harperdb.io/docs/reference/components). Please review the documentation, or check out the Harper [Next.js Example](https://github.com/HarperFast/nextjs-example) for more information.

1. Install:

```sh
npm install @harperfast/nextjs
```

2. Wrap your Next.js config with `withHarper()`. All Next.js config formats are supported:

```js
// next.config.js (CommonJS)
const { withHarper } = require('@harperfast/nextjs');

module.exports = withHarper({
	// your existing Next.js config
});
```

```js
// next.config.mjs (ESM)
import { withHarper } from '@harperfast/nextjs';

export default withHarper({
	// your existing Next.js config
});
```

```ts
// next.config.ts (TypeScript)
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

> [!WARNING]
> **Declare `rest` (and any `jsResource`) *before* this plugin.** The plugin registers an HTTP handler that claims every path, so anything declared after it is shadowed by Next.js:
>
> ```yaml
> rest: true            # must come first
>
> graphqlSchema:
>   files: 'schema.graphql'
> jsResource:
>   files: 'resources.js'
>
> '@harperfast/nextjs':  # last, so it only handles what is left
>   package: '@harperfast/nextjs'
> ```
>
> Declared after the plugin, `GET /MyTable/123` returns Next.js's 404 and `GET /MyResource/` returns its 308 trailing-slash redirect, with nothing in the logs to say why. Ordering it first costs nothing — Next.js still serves every application route.

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

`withHarper(config?: NextConfig): NextConfig`

A configuration helper that wraps your Next.js config. It automatically adds `harper` and `harper-pro` to `serverExternalPackages` so Harper's native dependencies are treated correctly by the bundler.

**Example:**

```js
// next.config.js
const { withHarper } = require('@harperfast/nextjs');

module.exports = withHarper({
	// Any valid Next.js configuration options
});
```

## Options

All plugin options are configured in `config.yaml` under the `@harperfast/nextjs` key. All options are optional.

### `bundler: 'webpack' | 'turbopack'`

Selects the bundler used for building and serving the Next.js application. The default depends on the detected Next.js version:

- **Next.js v16**: defaults to `turbopack` (matching the Next.js v16 default)
- **Next.js v15**: defaults to `webpack` (matching the Next.js v15 default)
- **Next.js v14**: always uses `webpack` (turbopack is not supported)

```yaml
'@harperfast/nextjs':
  package: '@harperfast/nextjs'
  bundler: webpack
```

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

<!--
The `files` option is now optional with plugins. This make configuration simpler in general. The plugin doesn't currently have any special file handling too. If the app changes, harper needs to be restarted. This is common behavior for applications. The default file handler mechanism in core will alert. In the future,
### `files: string`

Glob pattern specifying which files Harper should watch for changes. Example: `'/app/*'`.
-->

## Caching (Work In Progress)

`@harperfast/nextjs` includes a Harper-backed cache handler for Next.js [Incremental Static Regeneration (ISR)](https://nextjs.org/docs/app/guides/incremental-static-regeneration), the [Data Cache (`fetch()`)](https://nextjs.org/docs/app/deep-dive/caching#data-cache), and [`unstable_cache`](https://nextjs.org/docs/app/api-reference/functions/unstable_cache). Cached entries live in Harper instead of the worker's local filesystem, so a cache write on one node is visible to every node in the cluster.

> [!IMPORTANT]
> Next.js has **two** cache-handler interfaces and they are configured separately.
>
> | Next.js config | Interface | Backs |
> | --- | --- | --- |
> | `cacheHandler` | `CacheHandler` (incremental cache) | ISR, the Data Cache, `unstable_cache` |
> | `cacheHandlers` | `CacheHandler` (`use cache`) | the [`'use cache'`](https://nextjs.org/docs/app/api-reference/directives/use-cache) directive |
>
> Setting only `cacheHandler` leaves `'use cache'` entries in Next.js's built-in in-memory handler — per-worker, lost on restart, and invisible to the rest of the cluster. Apps using `cacheComponents` / `'use cache'` need [`useCache`](#use-cache) as well.

### Enabling

Set the `cacheHandler` path using the `cacheHandlerPath()` helper. This helper resolves the cache handler relative to your config file, which is required by Turbopack:

```js
// next.config.js (CommonJS)
const { withHarper, cacheHandlerPath } = require('@harperfast/nextjs');

module.exports = withHarper({
	cacheHandler: cacheHandlerPath(__dirname),
});
```

```js
// next.config.mjs (ESM)
import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

export default withHarper({
	cacheHandler: cacheHandlerPath(import.meta.dirname),
});
```

```ts
// next.config.ts (TypeScript)
import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

export default withHarper({
	cacheHandler: cacheHandlerPath(import.meta.dirname),
});
```

### Tag invalidation

[`revalidateTag()`](https://nextjs.org/docs/app/api-reference/functions/revalidateTag) is supported and propagates across the cluster automatically. A typical flow:

```js
// app/products/[id]/page.js
import { unstable_cache } from 'next/cache';

const getProduct = unstable_cache(
	async (id) => {
		const res = await fetch(`https://api.example.com/products/${id}`);
		return res.json();
	},
	['product'],
	{ tags: ['products'], revalidate: 3600 }
);

export default async function ProductPage({ params }) {
	const product = await getProduct(params.id);
	return <h1>{product.name}</h1>;
}
```

```js
// app/api/revalidate/route.js
import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

export async function POST(request) {
	const tag = new URL(request.url).searchParams.get('tag');
	revalidateTag(tag);
	return NextResponse.json({ revalidated: true });
}
```

`fetch()` calls with `next: { tags: [...] }` and the `'use cache'` directive (with `cacheTag()`) are also supported — anywhere Next.js attaches tags to a cached value, the handler will pick them up.

### `useCache`

Route `'use cache'` entries to Harper by registering `cacheHandlers`:

```js
// next.config.mjs
import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

export default withHarper(
	{
		cacheComponents: true,
		cacheHandler: cacheHandlerPath(import.meta.dirname),
	},
	{ useCache: true, configDir: import.meta.dirname }
);
```

Requires Next.js 16, which is where the interface exists. Opt-in for now — it becomes the default in the next major, because turning it on changes where existing apps' `'use cache'` entries are stored.

### Per-entry cache lives

Both handlers persist the `revalidate` and `expire` Next.js supplies for each entry.

For the `'use cache'` handler this is load-bearing, not a nicety. Cache lives travel on the entry itself, so a row stored without them reads back as `revalidate: 0`, Next.js treats it as immediately stale, and the entry is regenerated on **every single read** — a cache that stores faithfully and never serves. Measured on a two-node cluster, the same key read ten times from the non-writing node:

| Build | Regenerations per 10 reads |
| --- | --- |
| Without persisted cache lives | 10 / 10 |
| With persisted cache lives | 0 / 10 |

The legacy incremental-cache handler persists them too, but there the effect is not observable: a `FETCH` entry carries its own `revalidate` inside the cached value, and route cache lives come from the build-time prerender manifest, which ships with `.next` to every node. The columns are stored for consistency and for entry classes that carry neither, not because a measured failure demanded it.

### How invalidation works

The cache handler uses a **soft-invalidation** model:

1. `revalidateTag(tag)` writes a `{ tag, timestamp }` row to the `nextjs_cache_invalidation` table and updates an in-memory map in the calling worker.
2. Every other Harper worker subscribes to that table and updates its own map when the row is replicated — typically within milliseconds.
3. On the next `cache.get()`, an invalidated entry is reported to Next.js as *stale* rather than missing wherever Next.js supports that, so it serves the cached response and regenerates in the background. An invalidation storm should not turn into a render storm.
4. A worker that restarts rebuilds its map from the tombstone table, so an invalidation survives the process that issued it.

Entries are never hard-deleted; Next.js overwrites them on the next regeneration. The `nextjs_cache_invalidation` rows expire after 7 days so abandoned tags don't accumulate.

> [!NOTE]
> A throttled background sweep — which would mark matching entries and then drop the tombstone, so the tombstone's lifetime stops being a correctness parameter — is implemented but **off by default**, behind `HARPER_NEXTJS_EXPERIMENTAL_SWEEP=true`. No available primitive marks an entry stale without breaking something else:
>
> | Primitive | Behaviour |
> | --- | --- |
> | `invalidate()` | A no-op. Measured on Harper 5.1.23 and 5.2.0, against both a plain table and a `sourcedFrom` one: the record reads back unchanged and the source is never re-invoked. A sweep built on it drops the tombstone while leaving entries untouched, losing the invalidation outright. |
> | `delete()` | Works, but a deleted entry is a miss, and a miss is a full render — the thing this design exists to avoid. |
> | `patch()` | Bumps `lastModified` (`@updatedTime`), so the entry looks *newer* than the invalidation to Next.js's `areTagsStale`. Next.js treats it as fresh and never regenerates. |
>
> Stale-while-revalidate comes from the tags-manifest mirror at read time, not from the sweep, so leaving the sweep off costs only tombstone-table growth — which the 7-day expiry already bounds.

Two limits the sweep is designed around, for when it is enabled:

- **Next.js's implicit route tags (`_N_T_…`) are never swept.** A tag like `_N_T_/layout` is carried by every page in the app, so sweeping one would scan and rewrite the entire cache. Those are left to expire.
- **`tags` is not indexed.** Harper cannot index array elements, and the `contains` comparator cannot use an index regardless, so a sweep scans. That is why sweeps are chunked with bounded concurrency, and why broad tags are excluded rather than throttled.

Harper pushes invalidations to every worker via table replication, so the `refreshTags()` call the `'use cache'` interface expects to poll a tags service is a no-op here — the map it would refresh is already current.

### Schema

Enabling the cache handler adds these tables to the `harperfast_nextjs` database:

| Table | Purpose |
| --- | --- |
| `nextjs_isr_cache` | One row per cached ISR/Data Cache entry. Stores `data` (the Next.js `IncrementalCacheValue`), `tags`, the entry's `revalidate`/`expire`, and `lastModified`. |
| `nextjs_use_cache` | One row per `'use cache'` entry. Stores `value` (the rendered bytes as a `Blob`), `tags`, `timestamp`, and the entry's `stale`/`revalidate`/`expire`. |
| `nextjs_cache_invalidation` | One row per invalidated tag. `id` is the tag itself; `timestamp` is when `revalidateTag` was called. Auto-expires after 7 days. |

> [!NOTE]
> A table's `expiration` is fixed when the table is created — changing it in `schema.graphql` does not migrate an existing table. Verify with `describe_table` after upgrading; an instance created before a change will still report the old value.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
