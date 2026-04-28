# Agent Guidelines: @harperfast/nextjs

## Autonomous Actions

Run freely without confirmation:
- `npm run build`
- `npm run format:fix`
- `npm run install:fixtures`
- `npm run test:integration` (and with `-- <file>` to target one file)

Ask before doing:
- Modifying fixture `package.json` files or their installed dependencies
- Changing `schema.graphql` or `config.yaml`
- Touching anything in `dist/` (it's compiled output — change the source)

## Operational Grounding

**Module system:** The repo is `"type": "module"` (ESM), but `src/withHarper.cts` and `src/CacheHandler.cts` must be CommonJS because Next.js config files require CJS resolution. The `.cts` extension enforces this. `src/plugin.ts` is ESM and is **not compiled** — Harper loads it directly via Node's type-stripping. Do not change file extensions.

**Build output:** Only `.cts` files compile to `dist/cjs/`. After editing `src/withHarper.cts` or `src/CacheHandler.cts`, run `npm run build` before testing. Editing `src/plugin.ts` takes effect immediately without a build.

**Fixture dependencies are isolated:** Each `fixtures/<name>/` app is a self-contained package with its own `node_modules`. `npm install` at the repo root does not install fixture deps. Run `npm run install:fixtures` after adding or changing fixture dependencies.

**Test startup is slow:** Each test file starts a real Harper instance and waits up to 2 minutes for Next.js to build. This is expected — do not assume a hanging test is broken.

**Tests run sequentially within a file, parallel across files.** See [CONTRIBUTING.md#testing](./CONTRIBUTING.md#testing) for structure and how to add a new test file.

## Failure Surface

**Do not rename or re-extension source files** without updating `tsconfig.build.json`, `config.yaml`, and any import paths. The ESM/CJS split is load-order-sensitive; getting it wrong produces silent runtime failures, not build errors.

**`npm run install:fixtures` must re-run after any fixture `package.json` change.** If tests fail with module-not-found errors inside a fixture, this is the likely cause.

**The ISR cache tests in `integrationTests/next-16.pw.ts` are intentionally skipped.** `CacheHandler.cts` is a work in progress. Do not remove the `.skip` without verifying the implementation is complete.

**CI is currently disabled** (`if: false` on the matrix job in `.github/workflows/integration-tests.yml`). Tests must be run locally.

**`dist/` is gitignored.** It is not committed and not published from the repo directly — it is built as part of the publish step.
