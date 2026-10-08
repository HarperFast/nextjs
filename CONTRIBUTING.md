# Contributing

## Code Organization

The key source files are:

- `src/plugin.ts` — the Harper plugin implementation (ESM, loaded by Harper's runtime)
- `src/withHarper.cts` — the `withHarper()` Next.js config helper (CJS, loaded by Next.js config files)
- `src/CacheHandler.cts` — the Harper-backed ISR cache handler (CJS, loaded by Next.js at runtime)
- `schema.graphql` — the plugin table schemas
- `config.yaml` — Harper configuration for the plugin

Run `npm run build` to compile the `src/` directory. The `.cts` extension marks files as CommonJS, which is required because Next.js config files (`next.config.js`, `next.config.mjs`, `next.config.ts`) all use CommonJS module resolution. `plugin.ts` stays as ESM since it is only loaded by Harper's own runtime.

The published module includes `dist/`, `config.yaml`, and `schema.graphql`.

The `fixtures/` directory contains minimal Next.js applications used as integration test targets. Each subdirectory is a self-contained app with the plugin installed and configured. The three main fixtures each use a different config format to cover the full compatibility matrix:

- `fixtures/next-14/` — `next.config.js` (CommonJS `require`)
- `fixtures/next-15/` — `next.config.mjs` (ESM `import`)
- `fixtures/next-16/` — `next.config.ts` (TypeScript)

The `integrationTests/` directory contains the Playwright test files and supporting infrastructure.

## Testing

Tests are Playwright integration tests that run against real Harper instances. They live in `integrationTests/` and rely on `@harperfast/integration-testing` to manage Harper process lifecycle.

### How it works

Each test file targets one fixture — a minimal Next.js application in `fixtures/<name>/` that has the plugin installed and configured. At the start of a test run, Harper is started with that fixture as the component root and kept alive for the duration of the file. All `test()` calls in the file run sequentially against the same Harper instance, then Harper is torn down when the file finishes. Separate test files can run in parallel across Playwright workers, each with their own isolated Harper instance.

The `fixture()` helper in `integrationTests/fixture.ts` handles the wiring: it starts Harper, exposes a `harper` object (including `harper.httpURL`) to every test in the file, and tears down Harper afterward.

### Running the tests

Before running tests for the first time (and after updating fixture dependencies), install the fixture dependencies:

```sh
npm run install:fixtures
```

Run all the tests:

```sh
npm run test:integration
```

Run a specific test file:

```sh
npm run test:integration -- integrationTests/next-15.pw.ts
```

### Test parameters

Each test callback receives some combination of these parameters:

- **`harper`** — a [`HarperContext`](https://github.com/harperfast/integration-testing#types) from `@harperfast/integration-testing`
- **`page`** — Playwright's [`Page`](https://playwright.dev/docs/api/class-page) for navigating and asserting against the rendered UI
- **`request`** — Playwright's [`APIRequestContext`](https://playwright.dev/docs/api/class-apirequestcontext) for raw HTTP calls without a browser (status codes, response bodies, headers, etc.)

### Adding a new test file

1. Create a fixture app in `fixtures/<name>/` with the plugin configured.
2. Create `integrationTests/<name>.pw.ts`:

```ts
import { fixture } from './fixture.ts';

const { test, expect } = fixture('<name>');

// Browser-based assertion
test('home page renders', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.locator('h1')).toHaveText('Expected');
});

// Raw HTTP assertion (no browser)
test('health endpoint returns 200', async ({ request, harper }) => {
	const response = await request.get(`${harper.operationsAPIURL}/health`);
	expect(response.status()).toBe(200);
});
```

The `fixture()` call binds the test file to its Harper fixture and handles startup and teardown automatically.

### Future Work: Page Object Models

As the test suite grows, repeated patterns of locator queries and multi-step interactions should be extracted into [Page Object Models](https://playwright.dev/docs/pom). A POM is a class that wraps `page` and encapsulates the selectors and actions for a specific page or feature, keeping test files focused on assertions rather than DOM mechanics.

For example, testing ISR cache revalidation involves navigating to a page, reading some state, triggering revalidation, and waiting for new content — logic that would benefit from a `CachedPage` POM rather than being inlined across multiple tests. As fixture apps grow more complex and tests start sharing the same navigation and interaction patterns, that's the signal to introduce POMs.

## Commits and releases

Releases are cut by semantic-release from the commits on `main`, so what lands there decides whether a release happens at all.

**Your pull request title must be a conventional commit.** Squash is the only merge method on this repository, and for any PR with more than one commit GitHub uses the PR *title* as the subject of the commit that lands on `main`. That subject is the only thing semantic-release reads for the release type. A title with no type — `Add support for X` rather than `feat: add support for X` — produces a commit it classifies as `no release`, and the work ships silently inside whatever release comes next. This has happened twice (#41 and #65). CI lints the title for that reason; it also lints the commits within the PR, but the squash discards those subjects.

| Title | Release |
| --- | --- |
| `fix: …`, `perf: …`, `revert: …` | patch |
| `feat: …` | minor |
| `feat!: …`, or a `BREAKING CHANGE:` footer | major |
| `build: …`, `chore: …`, `ci: …`, `docs: …`, `refactor: …`, `style: …`, `test: …` | none |

`none` means the commit does not trigger a release by itself, not that it is invisible: `.releaserc.json` gives every type above its own section, so it still appears in the notes of whatever release it rides along in.

### Breaking changes

There are two ways to declare one, and squashing treats them differently. The `!` is read only from the commit *subject*; a `BREAKING CHANGE:` footer is read from the *body*. Since the PR title becomes the subject and the squashed commit messages become the body, `feat!:` counts only in the PR title — buried in a commit inside the PR it does nothing. A footer, by contrast, survives the squash even when the title has no type at all.

| Declared as | In the PR title | In a commit body |
| --- | --- | --- |
| `feat!: …` | major | none |
| `BREAKING CHANGE: …` footer | n/a | major |

Do both. The `!` in the title is what makes the release major; the footer is what the notes quote, so write it for someone upgrading rather than restating the subject.

```
feat!: drop Next.js 14 support

Next 14 has no cacheHandlers interface, so the use-cache handler cannot be registered there.

BREAKING CHANGE: Next.js 14 is no longer supported. Upgrade to 15 or 16.
```

That renders as:

```markdown
### ⚠ BREAKING CHANGES

* Next.js 14 is no longer supported. Upgrade to 15 or 16.
```

Both forms depend on the `conventionalcommits` preset that `.releaserc.json` sets on **both** `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator`, and on `conventional-changelog-conventionalcommits` staying in `release.yaml`'s `extra_plugins`. Leave the preset off the analyzer and it falls back to `angular`, which does not recognise `!`: `feat!:` then passes commitlint and yields no release at all. Keep the two in step.
