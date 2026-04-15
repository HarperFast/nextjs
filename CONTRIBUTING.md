# Contributing

## Code Organization

The key source files for the repo are:

- `plugin.ts` — the plugin implementation, compiled to `dist/` for publishing
- `schema.graphql` - the plugin table schemas
- `config.yaml` — Harper configuration for the plugin

These are what are included in the published module and what Harper relies on for the plugin to work.

The `fixtures/` directory contains minimal Next.js applications used as integration test targets. Each subdirectory is a self-contained app with the plugin installed and configured.

The `integrationTests/` directory contains the Playwright test files and supporting infrastructure.

## Testing

Tests are Playwright integration tests that run against real Harper instances. They live in `integrationTests/` and rely on `@harperfast/integration-testing` to manage Harper process lifecycle.

### How it works

Each test file targets one fixture — a minimal Next.js application in `fixtures/<name>/` that has the plugin installed and configured. At the start of a test run, Harper is started with that fixture as the component root and kept alive for the duration of the file. All `test()` calls in the file run sequentially against the same Harper instance, then Harper is torn down when the file finishes. Separate test files can run in parallel across Playwright workers, each with their own isolated Harper instance.

The `fixture()` helper in `integrationTests/fixture.ts` handles the wiring: it starts Harper, exposes a `harper` object (including `harper.httpURL`) to every test in the file, and tears down Harper afterward.

### Running the tests

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
