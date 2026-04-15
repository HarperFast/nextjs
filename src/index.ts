import { join } from 'node:path';
import type { NextConfig } from 'next';

export function withHarper(config: NextConfig): NextConfig {
	return {
		...config,
		serverExternalPackages: [...(config.serverExternalPackages ?? []), 'harper'],
		cacheHandler: join(import.meta.dirname, 'CacheHandler.js'),
	};
}
