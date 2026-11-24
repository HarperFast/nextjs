import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UrlWithParsedQuery } from 'node:url';

import { createNextHttpHandler, nodeAdapterUsable, type HarperHttpRequest } from './requestHandoff.js';

describe('nodeAdapterUsable', () => {
	it('requires Harper 5.3.0', () => {
		assert.strictEqual(nodeAdapterUsable('5.2.15', false), false);
		assert.strictEqual(nodeAdapterUsable('5.3.0-beta.4', false), false);
		assert.strictEqual(nodeAdapterUsable('5.3.0', false), true);
		assert.strictEqual(nodeAdapterUsable('5.4.0-alpha.1', false), true);
		assert.strictEqual(nodeAdapterUsable('6.0.0', false), true);
	});

	it('requires Harper 5.3.3 where the pipe fast path skips write() overrides', () => {
		assert.strictEqual(nodeAdapterUsable('5.3.2', true), false);
		assert.strictEqual(nodeAdapterUsable('5.3.3', true), true);
		assert.strictEqual(nodeAdapterUsable('5.4.0', true), true);
	});

	it('rejects an unknown or unparseable version', () => {
		assert.strictEqual(nodeAdapterUsable(undefined, false), false);
		assert.strictEqual(nodeAdapterUsable('latest', false), false);
	});
});

describe('createNextHttpHandler', () => {
	function harness(options: { basePath?: string; harperVersion?: string | undefined } = {}) {
		const { basePath = '' } = options;
		const harperVersion = 'harperVersion' in options ? options.harperVersion : '5.3.4';
		const handled: { url: string; pathname: string | null; search: string | null; adapted: boolean }[] = [];
		const warnings: unknown[][] = [];
		const handler = createNextHttpHandler(
			async (request: IncomingMessage, _response: ServerResponse, parsedUrl: UrlWithParsedQuery) => {
				handled.push({
					url: request.url!,
					pathname: parsedUrl.pathname,
					search: parsedUrl.search,
					adapted: (request as { adapted?: boolean }).adapted === true,
				});
			},
			{ basePath, harperVersion, logger: { warn: (...args: unknown[]) => warnings.push(args) } }
		);
		let adapterCalls = 0;
		const send = (url: string, nodeUrl = url) => {
			const request: HarperHttpRequest = {
				url,
				_nodeRequest: { url: nodeUrl, headers: {} } as IncomingMessage,
				_nodeResponse: {} as ServerResponse,
				async withNodeAdapter(adapted) {
					adapterCalls++;
					await adapted({ url, adapted: true } as unknown as IncomingMessage, {} as ServerResponse);
					return { status: 200 };
				},
			};
			return handler(request, () => 'next layer');
		};
		return { send, handled, warnings, adapterCalls: () => adapterCalls };
	}

	it('hands an unmounted request straight to Next.js', async () => {
		const { send, handled, adapterCalls } = harness();
		await send('/about?q=1');
		assert.deepStrictEqual(handled, [{ url: '/about?q=1', pathname: '/about', search: '?q=1', adapted: false }]);
		assert.strictEqual(adapterCalls(), 0);
	});

	it('passes a request with no Node response to the next layer', () => {
		let handled = false;
		const handler = createNextHttpHandler(
			async () => {
				handled = true;
			},
			{ basePath: '', harperVersion: '5.3.4', logger: {} }
		);
		const request = { url: '/x', _nodeRequest: { url: '/x' }, _nodeResponse: null } as unknown as HarperHttpRequest;
		assert.strictEqual(handler(request, () => 'next layer'), 'next layer');
		assert.strictEqual(handled, false);
	});

	it('presents the mount-relative URL through the adapter on a capable Harper', async () => {
		const { send, handled, warnings, adapterCalls } = harness();
		await send('/about?q=1', '/mounted/about?q=1');
		assert.deepStrictEqual(handled, [{ url: '/about?q=1', pathname: '/about', search: '?q=1', adapted: true }]);
		assert.strictEqual(adapterCalls(), 1);
		assert.deepStrictEqual(warnings, []);
	});

	it('keeps the direct hand-off and warns once on a Harper below the adapter floor', async () => {
		const { send, handled, warnings, adapterCalls } = harness({ harperVersion: '5.2.15' });
		await send('/about?token=secret', '/mounted/about?token=secret');
		await send('/', '/mounted');
		assert.strictEqual(adapterCalls(), 0);
		assert.deepStrictEqual(
			handled.map(({ url, adapted }) => ({ url, adapted })),
			[
				{ url: '/mounted/about?token=secret', adapted: false },
				{ url: '/mounted', adapted: false },
			]
		);
		assert.strictEqual(warnings.length, 1);
		const warning = String(warnings[0][0]);
		assert.match(warning, /Harper 5\.2\.15/);
		assert.doesNotMatch(warning, /about|secret/);
	});

	it('treats an unknown Harper version as below the floor', async () => {
		const { send, warnings, adapterCalls } = harness({ harperVersion: undefined });
		await send('/about', '/mounted/about');
		assert.strictEqual(adapterCalls(), 0);
		assert.match(String(warnings[0][0]), /version unknown/);
	});

	it('keeps the direct hand-off when the arriving URL already carries the basePath', async () => {
		const { send, handled, warnings, adapterCalls } = harness({ basePath: '/mounted', harperVersion: '5.2.15' });
		await send('/about', '/mounted/about');
		await send('/', '/mounted');
		await send('/?q=1', '/mounted?q=1');
		assert.strictEqual(adapterCalls(), 0);
		assert.deepStrictEqual(
			handled.map(({ url }) => url),
			['/mounted/about', '/mounted', '/mounted?q=1']
		);
		assert.deepStrictEqual(warnings, []);
	});

	it('matches the basePath only at a path segment boundary', async () => {
		const { send, handled, adapterCalls } = harness({ basePath: '/app' });
		await send('/x', '/apps/x');
		assert.strictEqual(adapterCalls(), 1);
		assert.strictEqual(handled[0].url, '/x');
	});

	it('uses the adapter when the basePath sits below the mount', async () => {
		const { send, handled, adapterCalls } = harness({ basePath: '/next' });
		await send('/next/about', '/mounted/next/about');
		assert.strictEqual(adapterCalls(), 1);
		assert.strictEqual(handled[0].url, '/next/about');
	});
});
