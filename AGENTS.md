# Agent Guidelines: @harperfast/nextjs

This is the `@harperfast/nextjs` package — a [Harper Plugin](https://docs.harperdb.io/docs/reference/components/plugins) for running Next.js applications (v14, v15, v16) within the Harper distributed runtime. It wraps Next.js config, manages the application lifecycle within Harper, and optionally provides ISR caching backed by Harper's database.

## Repository Structure

```
src/
  plugin.ts          # Harper plugin entry point (ESM, loaded by Harper runtime)
  withHarper.cts     # withHarper() Next.js config helper (CJS, loaded by Next.js)
  CacheHandler.cts   # Harper-backed ISR cache handler (CJS, loaded by Next.js at runtime)
schema.graphql       # Harper table definitions (NextBuildInfo, NextISRCache)
config.yaml          # Harper plugin configuration (pluginModule, graphqlSchema)
fixtures/            # Minimal Next.js apps used as integration test targets
  next-14/           # next.config.js (CommonJS require)
  next-15/           # next.config.mjs (ESM import)
  next-16/           # next.config.ts (TypeScript)
  next-16-caching/   # Experimental ISR caching fixture
integrationTests/    # Playwright integration test suite
  fixture.ts         # Harper lifecycle wiring for Playwright
  next-14.pw.ts      # Tests for next-14 fixture
  next-15.pw.ts      # Tests for next-15 fixture
  next-16.pw.ts      # Tests for next-16 fixture
  playwright.config.ts
scripts/
  install-fixtures.js  # Installs dependencies for all fixture apps
dist/                  # Compiled output (do not edit)
```

## Development

**Build** (compiles `.cts` files to `dist/cjs/`):
```sh
npm run build
```

`src/plugin.ts` is **not** compiled — Harper loads it directly via Node's type-stripping. Only `src/withHarper.cts` and `src/CacheHandler.cts` are compiled.

**Format:**
```sh
npm run format:check   # check
npm run format:fix     # fix
```

**Requirements:** Node.js ≥ 20, npm.

## Module System Notes

`.cts` marks a file as CommonJS. This is required for `withHarper.cts` and `CacheHandler.cts` because Next.js config files use CommonJS resolution. `plugin.ts` stays ESM since it is loaded only by Harper's runtime. Do not change file extensions without understanding this distinction.

## Testing

See [CONTRIBUTING.md#testing](./CONTRIBUTING.md#testing) for the full testing guide. Tests are Playwright integration tests that run against real Harper instances using `@harperfast/integration-testing` for lifecycle management.

**Setup (once, and after updating fixture deps):**
```sh
npm run install:fixtures
```

**Run all tests:**
```sh
npm run test:integration
```

**Run a specific test file:**
```sh
npm run test:integration -- integrationTests/next-15.pw.ts
```

### How Tests Are Structured

Each test file maps to one fixture. The `fixture()` helper in `integrationTests/fixture.ts` starts Harper with the named fixture, exposes `harper`, `page`, and `request` to every test, then tears down Harper when the file finishes. Tests within a file run **sequentially**; separate test files run **in parallel** across Playwright workers.

Each test callback may receive:
- **`harper`** — `HarperContext` from `@harperfast/integration-testing` (includes `harper.httpURL`, `harper.operationsAPIURL`)
- **`page`** — Playwright `Page` for browser-based assertions
- **`request`** — Playwright `APIRequestContext` for raw HTTP calls

### Adding a New Test File

1. Create a fixture app in `fixtures/<name>/` with the plugin installed and configured (see existing fixtures for reference).
2. Run `npm run install:fixtures` to install its dependencies.
3. Create `integrationTests/<name>.pw.ts`:

```ts
import { fixture } from './fixture.ts';

const { test, expect } = fixture('<name>');

test('home page renders', async ({ page, harper }) => {
  await page.goto(harper.httpURL);
  await expect(page.locator('h1')).toHaveText('Expected heading');
});

test('health endpoint returns 200', async ({ request, harper }) => {
  const response = await request.get(`${harper.operationsAPIURL}/health`);
  expect(response.status()).toBe(200);
});
```

## Key Source Files

**`src/plugin.ts`** — Harper plugin implementation. Handles the full Next.js application lifecycle: config resolution, build (version-specific for v14/15/16), serving via Harper's HTTP middleware, dev mode with HMR, and build info tracking to avoid redundant rebuilds across threads. Reads `HARPER_NEXTJS_MODE` env var (`dev` / `build` / `prod`).

**`src/withHarper.cts`** — Wraps user's Next.js config. Adds `harper`, `harper-pro`, and `harperdb` to `serverExternalPackages` so Harper's native dependencies are excluded from bundling. Optionally enables ISR caching via `experimentalHarperCache: true`.

**`src/CacheHandler.cts`** — Implements Next.js `CacheHandler` interface. Stores ISR cached page data in Harper's `harperfast_nextjs.nextjs_isr_cache` table instead of the filesystem, making cached pages available across all nodes in a Harper cluster.

## Database Schema

Defined in `schema.graphql`, used by `harperfast_nextjs` database:

- **`NextBuildInfo`** — tracks build state per app (`appName` PK, `buildId`, `status`)
- **`NextISRCache`** — stores ISR cache entries (`id` PK, `data`, `lastModified` auto-updated)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HARPER_NEXTJS_MODE` | Plugin mode: `dev` (HMR), `build` (build-only, then exit), `prod` (default) |
| `HARPER_INTEGRATION_TEST_LOG_DIR` | If set, Harper test logs are written here (used in CI) |

## CI

The GitHub Actions workflow (`.github/workflows/integration-tests.yml`) runs integration tests on push to `main` and on pull requests. It installs dependencies, builds, installs fixture dependencies, installs Playwright browsers, and runs the full test suite. Playwright traces and Harper logs are uploaded as artifacts on failure.

> Note: CI jobs are currently disabled (`if: false`). When re-enabling, set the matrix job condition back to `true`.
