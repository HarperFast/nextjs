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
- Run `npm test` for the unit suite. It is `npm run build` plus `node --test` over the emitted `dist/**/*.test.js`, so it tests compiled output, not `src/` — a stale `dist/` tests stale code.
- Run `npm run test:integration` to run all tests, or `npm run test:integration -- integrationTests/next-15.pw.ts` for a single file.
- Test startup is slow by design — each test file starts a real Harper instance and waits for Next.js to build (up to 2 minutes). A slow start is not a failure.
- The ISR cache tests in `integrationTests/next-16.pw.ts` are intentionally skipped; `CacheHandler.cts` is a work in progress.
- Integration tests need the macOS loopback alias pool (127.0.0.2+). Without it every fixture fails at startup with `LoopbackAddressValidationError` / `EADDRNOTAVAIL` before any assertion runs — that is a machine-setup gap, not a test failure. `ifconfig lo0 | grep 'inet '` shows what is configured.
- `@harperfast/integration-testing` ships the setup script; do not hand-roll `ifconfig` loops. Run `npx harper-integration-test-setup-loopback` (it prompts for sudo). `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START` (default 2) and `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT` (default 32) size the pool. Aliases do not survive a reboot; the package also ships `scripts/io.harperdb.loopback-setup.plist`, a launchd job that re-adds them at boot.
- There is no `format:fix` script in `package.json` despite the Code Style note below; match the surrounding file style (tabs, semicolons).
- `next-16-static-data` is run by two test files: `next-16-static-data.pw.ts` on the default VM module loader (where Harper's component `harper` allowlist omits `flushDatabases`, so the plugin's pre-build flush is a no-op and a read-only build child can't see unflushed writes) and `next-16-static-data-native.pw.ts` under `applications.moduleLoader: native`, where the flush does run. The pair is what pins that behavior down — keep both.
- The cluster suite (`integrationTests/cluster.pw.ts`) needs a container runtime and a **harper-pro** image (default `harperfast/harper-pro:5.3.1`, public). OSS `harper` has no replication module and rejects `add_node` as an unknown operation, so it cannot form a cluster. Docker is **not** required: the rig probes for a `docker` binary, then `podman`, and `HARPER_CONTAINER_CLI` forces one. On macOS `docker` is usually a *shell alias* for podman, which a direct `execFileSync` never sees — hence the probe. The image is pulled when missing rather than being a precondition.
- Cluster-suite environment: `HARPER_PRO_IMAGE` overrides the image, `HARPER_CONTAINER_CLI` the runtime, `HARPER_CLUSTER_KEEP=1` leaves the containers up for inspection, and `HARPER_CLUSTER_REQUIRED=1` turns "cannot run here" from a skip into a failure. CI sets the last one — without it the suite skips itself on any setup problem and the job stays green, which is how it went unexercised.
- `add_node` is retried while the replication listener comes up. `waitForNode` only proves the operations API answers; port 9933 binds later, and a too-early `add_node` fails with `connect ECONNREFUSED <ip>:9933 and connection was required to sign certificate`. Only that failure is retried — bad credentials or an OSS image surface immediately.
- `add_node` needs an explicit `authorization: "Basic <base64>"`. Passing `username`/`password` alone fails the cert-signing handshake with "No authorization provided".
- Each node needs a distinct `node.hostname` (`NODE_HOSTNAME`); it defaults to `localhost`, so two nodes otherwise collide.
- Do not `cpSync` a staged rig per node: npm links a `file:` dependency as a relative symlink and Node rewrites it to an absolute host path, which does not exist in the container. Mount one staged directory into every node instead.
- Playwright's Chromium cannot launch inside the Claude Code sandbox (`bootstrap_check_in … Permission denied`): every integration test then fails at browser launch before any assertion. Run integration tests outside the sandbox.
- Harper facts the cache handlers depend on (verified in `node_modules/harper` 5.1.23): each element of an `@indexed` array attribute is indexed, so `{attribute: 'tags', comparator: 'equals', value}` is an index lookup, while `contains` is a full scan doing a *substring* match on `String(array)`. Every write — `patch` included — resets a record's expiry to now + the table's `expiration` unless `put(id, value, { expiresAt })` overrides it, and a sourceless table returns `null` for an expired record. TTL eviction emits no subscription `delete` event. `patch` on a missing record creates a partial one. Adding `@indexed` to an existing attribute backfills in the background, and on 5.2.0 the worker threads that did not run the backfill were observed to keep throwing `IndexRebuildingError` for that attribute after "Finished indexing" was logged, until a restart — which is why the sweep falls back to an exact-match scan.
- Next.js `IncrementalCache` treats a handler-returned `lastModified: -1` as an on-demand (blocking) revalidation, not stale-while-revalidate. Next 16 serves tag-stale FETCH/APP_PAGE/APP_ROUTE entries stale from its `tagsManifest` (`{stale, expired}` per tag); Next 15's manifest holds a number per tag; Next 14 has none.
- `next-16-mounted` covers an application served under a Harper `urlPath`, which is what routing requests through `Request.withNodeAdapter()` buys. **Every `page`-based test in the suite is currently expected to fail** until harper's adapter presents a faithful Node request/response — see the blocked-on note in HarperFast/nextjs#61 and the reproducers in `~/dev/scripts/harper-node-adapter-repro`. Against today's harper, requests through the adapter 500 on `headers.hasOwnProperty` and a missing `appendHeader`/`_implicitHeader`, and any response larger than the adapter's 16 KB buffer stalls, so a browser page load never reaches `load` even though the HTML itself renders. `request`-based tests still pass because their responses are small.
- The `page`-based tests need Playwright's browser binaries (`npx playwright install chromium`); without them they fail instantly with `browserType.launch: Executable doesn't exist`. The `request`-based tests do not.
- CI runs on every pull request: `unit-tests.yml` (`npm test`, Node 22/24/26) and `integration-tests.yml` (`npm run test:integration`, Node 22/24/26), plus commitlint. The integration suite needs the machine setup described above, so it is the one to re-run locally; the unit suite is self-contained.
