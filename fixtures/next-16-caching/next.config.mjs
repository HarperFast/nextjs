import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';

export default withHarper({
	cacheHandler: cacheHandlerPath(import.meta.dirname),
});
