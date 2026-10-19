import * as plugin from '@harperfast/nextjs';

export default plugin.withHarper({
	...(process.env.HARPER_NEXTJS_CACHE_BASELINE !== '1' && {
		cacheHandler: plugin.versionedCacheHandlerPath(import.meta.dirname),
	}),
	cacheMaxMemorySize: 0,
	generateBuildId: async () => 'deliberately-reused-build-id',
});
