import { join } from 'node:path';
import type { NextConfig } from 'next';

/**
 * Returns the path to the Harper cache handler module, resolved relative to the
 * caller's directory. Pass `import.meta.dirname` (ESM) or `__dirname` (CJS).
 *
 * This avoids `require.resolve`, which dereferences symlinks and produces paths
 * outside Turbopack's filesystem root when the package is linked.
 */
export function cacheHandlerPath(configDir: string): string {
	return join(configDir, 'node_modules', '@harperfast', 'nextjs', 'dist', 'CacheHandler.cjs');
}

/**
 * Returns the path to the Harper "use cache" handler, resolved the same way as `cacheHandlerPath`.
 *
 * This is a different Next.js interface from `cacheHandler`: `cacheHandler` backs ISR, the Data Cache
 * and `unstable_cache`, while `cacheHandlers` backs the `'use cache'` directive. Setting only the former
 * leaves `'use cache'` entries in Next's in-memory default handler — per-worker, lost on restart, and
 * invisible to the rest of the cluster.
 */
export function useCacheHandlerPath(configDir: string): string {
	return join(configDir, 'node_modules', '@harperfast', 'nextjs', 'dist', 'UseCacheHandler.cjs');
}

export interface WithHarperOptions {
	/**
	 * Route `'use cache'` entries to Harper by registering `cacheHandlers`. Requires Next.js 16, which is
	 * where that interface exists. Opt-in while the handler settles; it becomes the default in the next
	 * major, because enabling it silently changes caching behaviour for existing apps.
	 */
	useCache?: boolean;
	/** Directory to resolve the handler path against. Required when `useCache` is enabled. */
	configDir?: string;
}

export function withHarper(config: NextConfig = {}, options: WithHarperOptions = {}): NextConfig {
	// TODO: Do things like `serverExternalPackage` work with Next.js v14? If not, how can we
	// detect version reliably and apply? What if we added properties specific to v14? Would
	// they be okay with v15 and v16 or do this all need to be guarded?
	// Potential solution: To avoid version detection (if thats complicated), add a `version`
	// option or provide separate exports for each unique Next.js major. Something like:
	// `withHarperNext14()` or `withHarper({}, 14)`

	// TODO: We should inspect the Next.js config for properties such as `turbo` and then apply
	// specific options when present. I think things like `serverExternalPackages` used to be
	// `webpack` and thus maybe theres separate configuration based on the selected bundler.
	// But also this means resolving turbopack support in the plugin which is currently proving
	// difficult.

	if (options.useCache && !options.configDir) {
		throw new Error('withHarper(): `configDir` is required when `useCache` is enabled — pass `__dirname` or `import.meta.dirname`.');
	}

	const cacheHandlers = options.useCache
		? {
				// Both kinds resolve to the same handler: Harper is the durable store for either, and the
				// "remote" alias falling back to the in-memory default would reintroduce the per-worker
				// caching this exists to remove.
				default: useCacheHandlerPath(options.configDir as string),
				remote: useCacheHandlerPath(options.configDir as string),
				...(config as { cacheHandlers?: Record<string, string> }).cacheHandlers,
			}
		: (config as { cacheHandlers?: Record<string, string> }).cacheHandlers;

	return {
		...config,
		...(cacheHandlers ? { cacheHandlers } : {}),
		webpack: (config) => {
			config.externals.push({
				'harperdb': 'commonjs harperdb',
				'harper': 'commonjs harper',
				'harper-pro': 'commonjs harper-pro',
			});

			return config;
		},
		turbopack: {
			...config.turbopack,
		},
		serverExternalPackages: [...(config.serverExternalPackages ?? []), 'harperdb', 'harper', 'harper-pro'],
	};
}
