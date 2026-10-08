# Versioned filesystem cache

`versionedCache.cts` binds the logical `serverDistDir`, installed Next filesystem-cache constructor and immutable artifact namespace before `plugin.ts` prepares the production server. Rebinding a different artifact in one worker and changing a build during prepare both fail startup. No request re-resolves a build identity or constructor from the replaceable app path. The native CJS registry bridges Harper's VM plugin and Next's native CJS handler, including separate package copies.

`VersionedCacheHandler.cts` writes through the captured runtime delegate. A whole-entry miss can use a second delegate whose filesystem cannot write or read legacy `server/route-cache`. Per-file fallback could mix runtime HTML with seed RSC. Seed reads still use the component pathname; this is cache-write isolation, not arbitrary application-file read isolation.

The artifact digest includes build seeds, manifests, compiled server files and Next package metadata; it excludes the legacy route-cache directory. These build files stay immutable when this handler owns runtime writes, so restart identity is stable. This also handles a reused BUILD_ID; Next15/16 preview IDs alone would not, because they can be cached across builds. On 14/15, outgoing stock workers can still mutate seeds during the initial migration.

The optional sweep deletes disposable cache namespaces, never app artifacts. Outgoing workers skip the sweep after their build leaves the live path. Deletion may cost an older worker a render; its captured runtime root is recreated on writes. The default retains namespaces for operator-managed cleanup.

`VersionedCacheHandler.test.ts` exercises installed Next14/15/16 caches against real files and fresh processes. `integrationTests/next-16-versioned-cache.pw.ts` holds a real regeneration across the swap and verifies the new build and persistence after restarts.
