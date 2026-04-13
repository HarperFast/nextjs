import { join } from 'node:path';
export function withHarper(config) {
    return {
        ...config,
        serverExternalPackages: [...(config.serverExternalPackages ?? []), 'harper'],
        cacheHandler: join(import.meta.dirname, 'CacheHandler.js'),
    };
}
//# sourceMappingURL=index.js.map