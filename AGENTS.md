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
- One test in `integrationTests/next-16-static-data.pw.ts` is `test.fixme`'d: a read-only build child can't see rows the parent committed but hasn't flushed, and the `flushDatabases()` call that would fix it is a no-op until Harper exposes that export to components. Un-skip when it does.
- CI is currently disabled (`if: false` in `.github/workflows/integration-tests.yml`). Run tests locally.
