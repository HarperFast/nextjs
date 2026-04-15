import { join } from 'node:path';
import type { NextConfig } from 'next';

export interface HarperConfig {
	experimentalHarperCache?: boolean;
}

export function withHarper(config: NextConfig, harperConfig: HarperConfig = {}): NextConfig {
	const { experimentalHarperCache = false } = harperConfig;

	return {
		...config,
		serverExternalPackages: [...(config.serverExternalPackages ?? []), 'harper', 'harper-pro'],
		...(experimentalHarperCache && { cacheHandler: join(import.meta.dirname, 'CacheHandler.js') }),
	};
}
