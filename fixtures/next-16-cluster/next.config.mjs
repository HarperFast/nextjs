import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

export default withHarper(
	{
		cacheComponents: true,
		cacheHandler: cacheHandlerPath(import.meta.dirname),
	},
	{ useCache: true, configDir: import.meta.dirname }
);
