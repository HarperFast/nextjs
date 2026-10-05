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

On Next.js 16, pick the form that matches what you want the next visitor to get:

| Call | Effect |
| --- | --- |
| `revalidateTag(tag, 'max')` (or another profile) | Stale now: the cached response is served once more while it regenerates in the background. Expires when the profile's `expire` passes. |
| `revalidateTag(tag)`, `updateTag(tag)` | Expired now: the next request blocks on a fresh render. The one-argument `revalidateTag` is deprecated by Next.js. |
| `revalidatePath(path)` | Expired now, for the route's implicit tags. |

`updateTag` reaches the handlers the same way the one-argument `revalidateTag` does.

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

- **Values are streamed.** Each entry's rendered bytes are stored as a Harper `Blob` and streamed back from storage on every read, rather than read into memory whole. A write is buffered until the render completes, so a render that fails partway is never stored.
- **Entries from earlier builds can be deleted (opt-in).** Next.js puts the build ID in every `'use cache'` key, so a deploy leaves the previous build's entries unreadable. Most of them expire with the table, 7 days later; one written under an explicit long profile such as `cacheLife('max')` keeps its own expiry and can sit there for a year. Set `HARPER_NEXTJS_SWEEP_OLD_BUILDS=true` in the Harper process's environment to clear them: five minutes after starting a build, one worker per node deletes every entry whose key names a build that is neither its own nor the latest successful build of another app in `nextjs_build_info`. The delay lets a rolling restart reach the other nodes first; deleting an entry a node on the old build is still serving would only cost it a render. Keys that cannot be attributed to a build (Next.js encodes non-JSON arguments differently) are left to expire on their own. Off by default, the entries simply expire.
- **Keys of any size work.** Next.js builds a `'use cache'` key from the component's props and puts no limit on its size, while Harper caps a primary key at 1978 bytes. A key over 1500 bytes is stored under a truncated prefix plus a hash of the full key, and the full key is kept in the row's `cacheKey` column. Shorter keys are stored as they are. Large props still make large keys, so keep a cached component's props small.

### Per-entry cache lives

Both handlers persist the `revalidate` and `expire` Next.js supplies for each entry.

For the `'use cache'` handler this is load-bearing, not a nicety. Cache lives travel on the entry itself, so a row stored without them reads back as `revalidate: 0`, Next.js treats it as immediately stale, and the entry is regenerated on **every single read** — a cache that stores faithfully and never serves. Measured on a two-node cluster, the same key read ten times from the non-writing node:

| Build | Regenerations per 10 reads |
| --- | --- |
| Without persisted cache lives | 10 / 10 |
| With persisted cache lives | 0 / 10 |

The legacy incremental-cache handler persists them too, but there the effect is not observable: a `FETCH` entry carries its own `revalidate` inside the cached value, and route cache lives come from the build-time prerender manifest, which ships with `.next` to every node. The columns are stored for consistency and for entry classes that carry neither, not because a measured failure demanded it.

### How invalidation works

Invalidation follows Next.js's own semantics. `revalidateTag(tag)` and `updateTag(tag)` expire matching entries immediately. `revalidateTag(tag, profile)` (for example `'max'`) marks them stale now, so they are served while regenerating in the background, and expires them once the profile's `expire` has passed.

1. `revalidateTag` writes one row per tag to `nextjs_cache_invalidation` (a *tombstone*, holding the tag's `stale` and `expired` times) and updates an in-memory map in the calling worker.
2. Every other Harper worker subscribes to that table and updates its own map when the row is replicated — typically within milliseconds. The map is mirrored into Next.js's own tags manifest, so Next's in-process checks agree with it.
3. On the next `cache.get()`, an entry written before the invalidation is withheld if the tag has expired. If the tag is only stale, it is handed to Next.js to serve stale while regenerating wherever Next.js supports that (Next.js 16 for pages, route handlers and `fetch`; the `'use cache'` handler always). Otherwise it is withheld.
4. A worker that restarts rebuilds its map from the tombstones, so an invalidation survives the process that issued it.

**A tombstone outlives every entry it can invalidate.** An entry whose `expire` is a definite length is written with its own Harper expiry, so it is evicted when Next.js says it stops being usable. That is independent of the tables' 7-day `expiration`, so the `weeks` and `max` profiles keep their full stale-while-revalidate window — up to one year, the `expire` of `max` and the longest any entry is kept. Each tombstone is written with an expiry of that longest life (a year, or a cache table's `expiration` if that is longer), plus an hour for renders that finish after the invalidation and for replication lag. An invalidated entry therefore expires before its tombstone does and cannot come back. The in-memory map drops a tag once its tombstone lapses, so it holds one small record per tag invalidated in the past year: fine for a few thousand distinct tags, worth sizing before invalidating a tag per product. A cache table configured with no expiration breaks that bound and is reported in the log.

**An entry with no definite `expire` keeps the table's 7-day `expiration`.** Next.js's `default` profile — every `'use cache'` boundary with no `cacheLife()` — sets `expire` to `INFINITE_CACHE` (0xfffffffe). That is stored as one year, because it does not fit the 32-bit `Int` column and Harper would otherwise refuse the write and never cache the entry at all, but the row itself is left to the table's expiration rather than pinned for the year. Pinning it would override the table TTL for the common case, and because Next.js puts the build ID in every `'use cache'` key, every deploy would leave a full generation of unreadable entries behind for a year. Ask for a long life explicitly — `cacheLife('max')` — and it is honoured.

An immediate expiry is also **swept**: entries carrying the tag are looked up through the indexed `tags` column (an exact-match index lookup, not a scan) and deleted in throttled chunks, so they stop taking up space before their own expiry. This includes Next.js's implicit route tags, so `revalidatePath` is swept too. While Harper reports the index as still being built, the sweep scans with the same exact match instead. The sweep only reclaims space, and reads never depend on it: a sweep that fails or is interrupted leaves the entries to expire on their own. A stale-then-expire invalidation is not swept, because those entries must stay servable while they regenerate.

`'use cache'` entries do not carry the implicit route tags `revalidatePath` targets. Next.js checks those through `getExpiration`, which reports only expirations that have already passed.

Harper pushes invalidations to every worker via table replication, so the `refreshTags()` call the `'use cache'` interface expects to poll a tags service is a no-op here — the map it would refresh is already current.

### Schema

Enabling the cache handler adds these tables to the `harperfast_nextjs` database:

| Table | Purpose |
| --- | --- |
| `nextjs_isr_cache` | One row per cached ISR/Data Cache entry. Stores `data` (the Next.js `IncrementalCacheValue`), `tags` (indexed), the entry's `revalidate`/`expire`, and `lastModified`. |
| `nextjs_use_cache` | One row per `'use cache'` entry. Stores `value` (the rendered bytes as a `Blob`), `tags` (indexed), `timestamp`, and the entry's `stale`/`revalidate`/`expire`. |
| `nextjs_cache_invalidation` | One row per invalidated tag. `id` is the tag itself; `timestamp` is when `revalidateTag` was called; `stale`/`expired` are the tag's invalidation in Next.js's terms; `lapsesAt` is when the row expires, which is later than any entry it invalidates. |

> [!NOTE]
> A table's `expiration` is fixed when the table is created — changing it in `schema.graphql` does not migrate an existing table. Verify with `describe_table` after upgrading; an instance created before a change will still report the old value. Tombstone lifetimes take a cache table's actual expiration into account when it is longer than a year, so they stay correct either way.

### Upgrading

No manual migration is needed; existing tables, entries and tombstones keep working.

- **Existing entries are kept** and served without regenerating.
- **`tags` becomes indexed on both cache tables.** Harper builds the index for existing rows in the background on first start; nothing is unavailable meanwhile. On Harper 5.2.0 some worker threads were seen to keep reporting that index as unfinished until the next restart; the sweep falls back to a scan in that case, and reads are unaffected.
- **Entries written by earlier versions** keep the Harper expiry they were written with: at most the table's 7 days.
- **Tombstones written by earlier versions** (a bare `timestamp`) are read as an immediate expiry at that time. Pre-release builds of `'use cache'` support stored `revalidateTag(tag, profile)` as a timestamp up to a year ahead; those rows no longer block later invalidations of the same tag, and they expire on the table's own 7-day schedule.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
