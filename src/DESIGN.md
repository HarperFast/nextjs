# Versioned filesystem cache

`versionedCache.cts` binds the logical `serverDistDir`, installed Next filesystem-cache constructor and immutable artifact namespace before `plugin.ts` prepares the production server. Rebinding a different artifact in one worker and changing a build during prepare both fail startup. No request re-resolves a build identity or constructor from the replaceable app path. The native CJS registry bridges Harper's VM plugin and Next's native CJS handler, including separate package copies.

`VersionedCacheHandler.cts` writes through the captured runtime delegate. A whole-entry miss can use a second delegate whose filesystem cannot write or read legacy `server/route-cache`. Per-file fallback could mix runtime HTML with seed RSC. Seed reads still use the component pathname; this is cache-write isolation, not arbitrary application-file read isolation.

A native cache null can mean tag invalidation, not only missing files. Before any disk-backed runtime write, the handler persists key ownership under `entries/{fetch,render}/<key-hash>` in its namespace. A null for an owned key stays null, including after worker restart or a partial/failed write; it never revives an older seed whose tags differ. Marker failure prevents the runtime write. Separate fetch/render key spaces avoid collisions between Next's data-cache hashes and route names. Memory-only writes do not create disk markers, and seed delegates preserve the caller's flush setting.

The artifact digest includes build seeds, manifests, compiled server files and Next package metadata; it excludes the legacy route-cache directory. These build files stay immutable when this handler owns runtime writes, so restart identity is stable. This also handles a reused BUILD_ID; Next15/16 preview IDs alone would not, because they can be cached across builds. On 14/15, outgoing stock workers can still mutate seeds during the initial migration.

Artifact hashing reads bounded chunks asynchronously before serving and after prepare; it yields between file operations and never runs from a request or cleanup timer. The installed Next constructor is captured before hashing; package metadata uses Node resolution to support a hoisted Next installation.

Namespaces and ownership markers are retained for operator-managed cleanup after their workers stop. No automatic cache sweep is added: a pre-delete liveness check cannot exclude a concurrent activation, and removing ownership markers while a worker serves can revive older seeds after invalidation.

`VersionedCacheHandler.test.ts` exercises installed Next14/15/16 caches against real files and fresh processes. `integrationTests/next-16-versioned-cache.pw.ts` holds a real regeneration across the swap and verifies the new build and persistence after restarts.
