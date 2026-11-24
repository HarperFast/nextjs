import { resolve, sep } from 'node:path';

/**
 * Next.js keys an incremental-cache entry by its source route or a digest of the call, never by the app, so two
 * applications on one Harper instance would otherwise share `nextjs_isr_cache` rows.
 *
 * The registry lives on a `Symbol.for` global: Next.js `require`s the handler natively, while Harper loads the plugin
 * through its own loader, so the two can hold separate copies of this module.
 */
interface Registry {
	prefixes: Map<string, string>;
	/** A handler's `serverDistDir` to its prefix, or null when it matches no app; Next.js builds a handler per request. */
	lookups: Map<string, string | null>;
}
const registryKey = Symbol.for('@harperfast/nextjs.cache-namespaces.v1');
const nativeGlobal = globalThis as unknown as Record<symbol, Registry>;
const registry = (nativeGlobal[registryKey] ??= { prefixes: new Map(), lookups: new Map() });

export function registerCacheNamespace(appDirectory: string, applicationName: string): void {
	registry.prefixes.set(resolve(appDirectory) + sep, `${applicationName}:`);
	registry.lookups.clear();
}

export function unregisterCacheNamespace(appDirectory: string): void {
	if (registry.prefixes.delete(resolve(appDirectory) + sep)) registry.lookups.clear();
}

/**
 * Without `serverDistDir` (Next.js's middleware adapter passes none), the worker's only application, as in an isolated
 * application's worker. Undefined when it cannot be told: a key without a prefix would be every application's.
 */
export function cacheKeyPrefixFor(serverDistDir: string | undefined): string | undefined {
	const lookup = serverDistDir ?? '';
	let prefix = registry.lookups.get(lookup);
	if (prefix === undefined) {
		prefix = serverDistDir === undefined ? onlyPrefix() : longestMatch(resolve(serverDistDir));
		registry.lookups.set(lookup, prefix);
		if (prefix === null && serverDistDir !== undefined) {
			getLogger().warn?.(
				`[@harperfast/nextjs] ${serverDistDir} belongs to no application this worker serves, so its ISR and Data Cache are off`
			);
		}
	}
	return prefix ?? undefined;
}

function getLogger(): { warn?(...args: unknown[]): void } {
	return (globalThis as { logger?: { warn?(...args: unknown[]): void } }).logger ?? console;
}

function onlyPrefix(): string | null {
	const prefixes = new Set(registry.prefixes.values());
	return prefixes.size === 1 ? prefixes.values().next().value! : null;
}

function longestMatch(serverDistDir: string): string | null {
	let match: string | null = null;
	let matchLength = -1;
	for (const [directory, prefix] of registry.prefixes) {
		if (directory.length > matchLength && serverDistDir.startsWith(directory)) {
			match = prefix;
			matchLength = directory.length;
		}
	}
	return match;
}

export function resetCacheNamespacesForTesting(): void {
	registry.prefixes.clear();
	registry.lookups.clear();
}
