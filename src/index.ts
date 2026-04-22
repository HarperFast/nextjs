import { join } from 'node:path';
import type { NextConfig } from 'next';

export interface HarperConfig {
	experimentalHarperCache?: boolean;
}

export function withHarper(config: NextConfig, harperConfig: HarperConfig = {}): NextConfig {
	const { experimentalHarperCache = false } = harperConfig;

	// TODO: Do things like `serverExternalPackage` work with Next.js v14? If not, how can we
	// detect version reliably and apply? What if we added properties specific to v14? Would
	// they be okay with v15 and v16 or do this all need to be guarded?
	// Potential solution: To avoid version detection (if thats complicated), add a `version`
	// option or provide separate exports for each unique Next.js major. Something like:
	// `withHarperNext14()` or `withHarper({}, {}, 14)`

	// TODO: We should inspect the Next.js config for properties such as `turbo` and then apply
	// specific options when present. I think things like `serverExternalPackages` used to be
	// `webpack` and thus maybe theres separate configuration based on the selected bundler.
	// But also this means resolving turbopack support in the plugin which is currently proving
	// difficult.

	return {
		...config,
		// TODO: Along with the version detection above, we may need to also support `harperdb` in
		// in this list too if we maintain backwards compatibility with v4
		serverExternalPackages: [...(config.serverExternalPackages ?? []), 'harper', 'harper-pro'],
		...(experimentalHarperCache && { cacheHandler: join(import.meta.dirname, 'CacheHandler.js') }),
	};
}
