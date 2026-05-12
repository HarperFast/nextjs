"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withHarper = withHarper;
const node_path_1 = require("node:path");
function withHarper(config, harperConfig = {}) {
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
        ...(experimentalHarperCache && { cacheHandler: (0, node_path_1.join)(__dirname, 'CacheHandler.cjs') }),
    };
}
//# sourceMappingURL=withHarper.cjs.map