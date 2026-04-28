# AGENTS.md

Review the `README.md` and `CONTRIBUTING.md` for all relevant repository information.

## Development Tips
- Use `npm run build` to compile `src/withHarper.cts` and `src/CacheHandler.cts` to `dist/`. `src/plugin.ts` is not compiled — Harper loads it directly.
- Do not edit files in `dist/`; it is compiled output and gitignored.
- Do not run `npm version` or `npm publish`; these commands are for humans only.
- The `.cts` extension is intentional and load-order-sensitive. Do not change file extensions in `src/`.

## Code Style
- Use Prettier for formatting: `npm run format:fix`
- `src/plugin.ts` is ESM. `src/withHarper.cts` and `src/CacheHandler.cts` are CommonJS (required by Next.js config resolution). Keep them that way.

## Testing Tips
- Run `npm run install:fixtures` before running tests for the first time, and again after changing any fixture's `package.json`.
- Run `npm run test:integration` to run all tests, or `npm run test:integration -- integrationTests/next-15.pw.ts` for a single file.
- Test startup is slow by design — each test file starts a real Harper instance and waits for Next.js to build (up to 2 minutes). A slow start is not a failure.
- The ISR cache tests in `integrationTests/next-16.pw.ts` are intentionally skipped; `CacheHandler.cts` is a work in progress.
- CI is currently disabled (`if: false` in `.github/workflows/integration-tests.yml`). Run tests locally.
