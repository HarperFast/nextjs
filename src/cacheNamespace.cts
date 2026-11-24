import { sep } from 'node:path';

/**
 * Which Harper application each Next.js app directory belongs to, so the Harper-backed cache handler can keep each
 * application's entries apart.
 *
 * Next.js keys an incremental-cache entry by the route (`/route-cache/<kind>/<sha256 of the source route>/$<path>`)
 * or by a digest of a `fetch()` or `unstable_cache()` call, never by the app. Two applications on one Harper
 * instance that both serve `/` would otherwise read and write the same row of `nextjs_isr_cache`: a pull request
 * preview running on the cluster's shared data, for example, renders its page into the row production serves.
 *
 * The plugin registers each app before Next.js constructs its handler, which then finds its application by the
 * `serverDistDir` Next.js passes it. The map lives on a `Symbol.for` global because Next.js `require`s the handler
 * natively while Harper loads the plugin through its own loader, so the two can hold separate copies of this module.
 */
const registryKey = Symbol.for('@harperfast/nextjs.cache-namespaces.v1');
const nativeGlobal = globalThis as unknown as Record<symbol, Map<string, string>>;
const namespaces = (nativeGlobal[registryKey] ??= new Map());

/** Record that the Next.js app in `appDirectory` is served as Harper application `applicationName`. */
export function registerCacheNamespace(appDirectory: string, applicationName: string): void {
	namespaces.set(appDirectory, applicationName);
}

/**
 * The application whose app directory holds `serverDistDir` (any `distDir` works). Without one, as when Next.js's
 * middleware adapter constructs the handler, the worker's only registered application, which is always the case in an
 * isolated application's own worker. Undefined when that cannot be told, and the handler then uses Next.js's key as is.
 */
export function cacheNamespaceFor(serverDistDir: string | undefined): string | undefined {
	if (serverDistDir === undefined) {
		const names = new Set(namespaces.values());
		return names.size === 1 ? names.values().next().value : undefined;
	}
	let match: string | undefined;
	let matchLength = -1;
	for (const [appDirectory, applicationName] of namespaces) {
		if (appDirectory.length > matchLength && serverDistDir.startsWith(appDirectory + sep)) {
			match = applicationName;
			matchLength = appDirectory.length;
		}
	}
	return match;
}

/**
 * The storage key for Next.js's `key` in `namespace`. A Next.js key starts with `/` or is a hex digest, and a deployed
 * Harper application's name is letters, digits, `-` and `_`, so a namespaced key can never equal another
 * application's or an un-namespaced one.
 */
export function namespacedCacheKey(namespace: string | undefined, key: string): string {
	return namespace === undefined ? key : `${namespace}:${key}`;
}

export function resetCacheNamespacesForTesting(): void {
	namespaces.clear();
}
