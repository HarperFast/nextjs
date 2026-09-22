import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

// `cacheComponents` turns on the `'use cache'` directive. `cacheHandler` alone would leave those
// entries in Next's in-memory default handler, so `useCache` registers the Harper-backed
// `cacheHandlers` as well — that pairing is what this fixture exists to prove.
export default withHarper(
	{
		cacheComponents: true,
		cacheHandler: cacheHandlerPath(import.meta.dirname),
	},
	{ useCache: true, configDir: import.meta.dirname }
);
