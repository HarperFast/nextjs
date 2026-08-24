# AGENTS.md

Review the `README.md` and `CONTRIBUTING.md` for all relevant repository information.

## Development Tips

- Use `npm install` to install dependencies
- Use `npm run build` to build the project files
- Do not edit files in `dist/`; it is compiled output and gitignored.
- Do not run `npm version` or `npm publish`; these commands are for humans only.
- The `.cts` extension is intentional and load-order-sensitive. Do not change file extensions in `src/`.

## Code Style

- Use Prettier for formatting: `npm run format:fix`
- `src/plugin.ts` is ESM. `src/withHarper.cts` and `src/CacheHandler.cts` are CommonJS (required by Next.js config resolution). Keep them that way.

## Testing Tips

- Use `npm link` in this directory and `npm link @harperfast/nextjs` in other project directories to test out changes locally
- Run `npm run install:fixtures` before running tests for the first time, and again after changing any fixture's `package.json` **or any plugin source under `src/`**. Fixtures install the plugin with `--install-links`, so each one holds a *copy* of `dist/`, not a symlink — `npm run build` alone does not reach them.
- Run `npm run test:integration` to run all tests, or `npm run test:integration -- integrationTests/next-15.pw.ts` for a single file.
- Test startup is slow by design — each test file starts a real Harper instance and waits for Next.js to build (up to 2 minutes). A slow start is not a failure.
- The ISR cache tests in `integrationTests/next-16.pw.ts` are intentionally skipped; `CacheHandler.cts` is a work in progress.
- `next-16-static-data` is run by two test files: `next-16-static-data.pw.ts` on the default VM module loader (where Harper's component `harper` allowlist omits `flushDatabases`, so the plugin's pre-build flush is a no-op and a read-only build child can't see unflushed writes) and `next-16-static-data-native.pw.ts` under `applications.moduleLoader: native`, where the flush does run. The pair is what pins that behavior down — keep both.
- `next-16-mounted` covers an application served under a Harper `urlPath`, which is what routing requests through `Request.withNodeAdapter()` buys. **Every `page`-based test in the suite is currently expected to fail** until harper's adapter presents a faithful Node request/response — see the blocked-on note in HarperFast/nextjs#61 and the reproducers in `~/dev/scripts/harper-node-adapter-repro`. Against today's harper, requests through the adapter 500 on `headers.hasOwnProperty` and a missing `appendHeader`/`_implicitHeader`, and any response larger than the adapter's 16 KB buffer stalls, so a browser page load never reaches `load` even though the HTML itself renders. `request`-based tests still pass because their responses are small.
- CI is currently disabled (`if: false` in `.github/workflows/integration-tests.yml`). Run tests locally.
- The `page`-based tests need Playwright's browser binaries (`npx playwright install chromium`); without them they fail instantly with `browserType.launch: Executable doesn't exist`. The `request`-based tests do not.
