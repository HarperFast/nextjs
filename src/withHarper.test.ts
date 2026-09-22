import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const { withHarper, cacheHandlerPath, useCacheHandlerPath } = createRequire(import.meta.url)('./withHarper.cjs') as {
	withHarper(config?: Record<string, unknown>, options?: { useCache?: boolean; configDir?: string }): Record<string, unknown>;
	cacheHandlerPath(configDir: string): string;
	useCacheHandlerPath(configDir: string): string;
};

describe('handler paths', () => {
	it('resolves the two handlers to different modules', () => {
		// The ISR handler and the "use cache" handler implement different Next.js interfaces; pointing
		// `cacheHandlers` at the ISR one would silently do nothing.
		assert.notEqual(cacheHandlerPath('/app'), useCacheHandlerPath('/app'));
		assert.match(cacheHandlerPath('/app'), /CacheHandler\.cjs$/);
		assert.match(useCacheHandlerPath('/app'), /UseCacheHandler\.cjs$/);
	});
});

describe('withHarper use-cache registration', () => {
	it('does not register cacheHandlers by default', () => {
		const config = withHarper({});
		assert.equal(config.cacheHandlers, undefined, 'enabling this silently would change existing apps');
	});

	it('registers both handler kinds when opted in', () => {
		const config = withHarper({}, { useCache: true, configDir: '/app' }) as {
			cacheHandlers: Record<string, string>;
		};

		assert.match(config.cacheHandlers.default, /UseCacheHandler\.cjs$/);
		assert.match(config.cacheHandlers.remote, /UseCacheHandler\.cjs$/);
	});

	it('requires configDir when opted in, rather than producing an unresolvable path', () => {
		assert.throws(() => withHarper({}, { useCache: true }), /configDir/);
	});

	it('lets a user-supplied cacheHandlers entry win', () => {
		const config = withHarper({ cacheHandlers: { default: '/custom.js' } }, { useCache: true, configDir: '/app' }) as {
			cacheHandlers: Record<string, string>;
		};

		assert.equal(config.cacheHandlers.default, '/custom.js');
		assert.match(config.cacheHandlers.remote, /UseCacheHandler\.cjs$/);
	});

	it('preserves an existing cacheHandlers config when not opted in', () => {
		const config = withHarper({ cacheHandlers: { default: '/custom.js' } }) as {
			cacheHandlers: Record<string, string>;
		};

		assert.equal(config.cacheHandlers.default, '/custom.js');
	});

	it('still applies the Harper externals', () => {
		const config = withHarper({}, { useCache: true, configDir: '/app' }) as {
			serverExternalPackages: string[];
		};

		assert.ok(config.serverExternalPackages.includes('harper'));
	});
});
