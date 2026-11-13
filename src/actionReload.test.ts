import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as createHttp2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';

import { adaptHttp2ForNext } from './http2Compat.js';
import { RELOAD_GUARD_COOKIE, hasGuardCookie, reloadLocation, reloadOnMissingAction } from './actionReload.js';

const GUARD = `${RELOAD_GUARD_COOKIE}=1; Max-Age=30; Path=/; HttpOnly; SameSite=Lax`;

function fakeResponse() {
	const headers = new Map<string, unknown>();
	return {
		headers,
		setHeader(name: string, value: unknown) {
			headers.set(name.toLowerCase(), value);
			return this;
		},
		getHeader(name: string) {
			return headers.get(name.toLowerCase()) as any;
		},
		removeHeader(name: string) {
			headers.delete(name.toLowerCase());
		},
	};
}

function actionRequest(overrides: { method?: string; url?: string; headers?: Record<string, string> } = {}) {
	return {
		method: overrides.method ?? 'POST',
		url: overrides.url ?? '/page?x=1',
		headers: { 'next-action': 'abc123', ...overrides.headers },
	};
}

// What Next.js 16 does in `handleUnrecognizedFetchAction`.
function sendActionNotFound(response: { setHeader(name: string, value: string): unknown; statusCode: number; end(body: string): void }) {
	response.setHeader('x-nextjs-action-not-found', '1');
	response.setHeader('content-type', 'text/plain');
	response.statusCode = 409;
	response.end('Server action not found.');
}

describe('reloadOnMissingAction', () => {
	it('swaps the not-found marker for a redirect to the page and sets the guard cookie', () => {
		const response = fakeResponse();
		reloadOnMissingAction(actionRequest(), response, '');
		response.setHeader('x-nextjs-action-not-found', '1');
		assert.strictEqual(response.headers.get('x-nextjs-action-not-found'), undefined);
		assert.strictEqual(response.headers.get('x-action-redirect'), '/page?x=1;replace');
		assert.deepStrictEqual(response.headers.get('set-cookie'), [GUARD]);
	});

	it('matches the marker name case-insensitively and only with the value 1', () => {
		const upper = fakeResponse();
		reloadOnMissingAction(actionRequest(), upper, '');
		upper.setHeader('X-NextJS-Action-Not-Found', '1');
		assert.strictEqual(upper.headers.get('x-action-redirect'), '/page?x=1;replace');

		const other = fakeResponse();
		reloadOnMissingAction(actionRequest(), other, '');
		other.setHeader('x-nextjs-action-not-found', '0');
		assert.strictEqual(other.headers.get('x-nextjs-action-not-found'), '0');
		assert.strictEqual(other.headers.get('x-action-redirect'), undefined);
	});

	it('passes other headers through unchanged', () => {
		const response = fakeResponse();
		reloadOnMissingAction(actionRequest(), response, '');
		response.setHeader('content-type', 'text/x-component');
		assert.strictEqual(response.headers.get('content-type'), 'text/x-component');
		assert.strictEqual(response.headers.get('x-action-redirect'), undefined);
	});

	it('leaves requests that are not fetch-action POSTs alone', () => {
		for (const request of [actionRequest({ method: 'GET' }), { method: 'POST', url: '/', headers: {} }]) {
			const response = fakeResponse();
			const original = response.setHeader;
			reloadOnMissingAction(request, response, '');
			assert.strictEqual(response.setHeader, original);
		}
	});

	it('keeps Next.js’s response once the guard cookie is present', () => {
		const response = fakeResponse();
		reloadOnMissingAction(actionRequest({ headers: { cookie: `a=b; ${RELOAD_GUARD_COOKIE}=1` } }), response, '');
		response.setHeader('x-nextjs-action-not-found', '1');
		assert.strictEqual(response.headers.get('x-nextjs-action-not-found'), '1');
		assert.strictEqual(response.headers.get('x-action-redirect'), undefined);
		assert.strictEqual(response.headers.get('set-cookie'), undefined);
	});

	it('appends the guard to cookies already set', () => {
		const single = fakeResponse();
		single.setHeader('set-cookie', 'session=new');
		reloadOnMissingAction(actionRequest(), single, '');
		single.setHeader('x-nextjs-action-not-found', '1');
		assert.deepStrictEqual(single.headers.get('set-cookie'), ['session=new', GUARD]);

		const several = fakeResponse();
		several.setHeader('set-cookie', ['a=1', 'b=2']);
		reloadOnMissingAction(actionRequest(), several, '');
		several.setHeader('x-nextjs-action-not-found', '1');
		assert.deepStrictEqual(several.headers.get('set-cookie'), ['a=1', 'b=2', GUARD]);
	});

	it('scopes the guard cookie to the basePath', () => {
		const response = fakeResponse();
		reloadOnMissingAction(actionRequest({ url: '/docs/page' }), response, '/docs');
		response.setHeader('x-nextjs-action-not-found', '1');
		assert.strictEqual(response.headers.get('x-action-redirect'), '/page;replace');
		assert.deepStrictEqual(response.headers.get('set-cookie'), [GUARD.replace('Path=/', 'Path=/docs')]);
	});

	it('keeps Next.js’s response when the request target is not a safe path', () => {
		const response = fakeResponse();
		reloadOnMissingAction(actionRequest({ url: '//evil.example/page' }), response, '');
		response.setHeader('x-nextjs-action-not-found', '1');
		assert.strictEqual(response.headers.get('x-nextjs-action-not-found'), '1');
		assert.strictEqual(response.headers.get('x-action-redirect'), undefined);
	});
});

describe('reloadLocation', () => {
	it('returns origin-relative paths with ; escaped', () => {
		assert.strictEqual(reloadLocation('/', ''), '/');
		assert.strictEqual(reloadLocation('/checkout?selection=a;b', ''), '/checkout?selection=a%3Bb');
	});

	it('strips the basePath the client adds back', () => {
		assert.strictEqual(reloadLocation('/docs', '/docs'), '/');
		assert.strictEqual(reloadLocation('/docs?x=1', '/docs'), '/?x=1');
		assert.strictEqual(reloadLocation('/docs/a/b', '/docs'), '/a/b');
		assert.strictEqual(reloadLocation('/docsearch', '/docs'), undefined);
	});

	it('rejects targets that are not origin-relative paths', () => {
		for (const url of [undefined, '', '*', 'http://evil.example/', '//evil.example/', '/\\evil.example/']) {
			assert.strictEqual(reloadLocation(url, ''), undefined, String(url));
		}
	});
});

describe('hasGuardCookie', () => {
	it('matches only the exact guard pair', () => {
		assert.strictEqual(hasGuardCookie(undefined), false);
		assert.strictEqual(hasGuardCookie(`${RELOAD_GUARD_COOKIE}=1`), true);
		assert.strictEqual(hasGuardCookie(['a=b', `x=y; ${RELOAD_GUARD_COOKIE}=1`]), true);
		assert.strictEqual(hasGuardCookie(`${RELOAD_GUARD_COOKIE}=10`), false);
		assert.strictEqual(hasGuardCookie(`x${RELOAD_GUARD_COOKIE}=1`), false);
	});
});

describe('reloadOnMissingAction on real responses', () => {
	async function http1(url: string) {
		const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
			reloadOnMissingAction(request, response, '');
			sendActionNotFound(response);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		try {
			return await new Promise<IncomingMessage>((resolve, reject) => {
				const request = httpRequest({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'next-action': 'abc' } }, (response) => {
					response.resume();
					response.on('end', () => resolve(response));
				});
				request.on('error', reject);
				request.end();
			});
		} finally {
			server.close();
		}
	}

	it('rewrites an HTTP/1 response', async () => {
		const response = await http1('/page?a=1');
		assert.strictEqual(response.statusCode, 409);
		assert.strictEqual(response.headers['x-nextjs-action-not-found'], undefined);
		assert.strictEqual(response.headers['x-action-redirect'], '/page?a=1;replace');
		assert.deepStrictEqual(response.headers['set-cookie'], [GUARD]);
	});

	it('falls back to Next.js’s response when the redirect value is not a valid header', async () => {
		const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
			request.url = '/bad\u0001path';
			reloadOnMissingAction(request, response, '');
			sendActionNotFound(response);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const raw = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'next-action': 'abc' } });
			assert.strictEqual(raw.status, 409);
			assert.strictEqual(raw.headers.get('x-nextjs-action-not-found'), '1');
			assert.strictEqual(raw.headers.get('x-action-redirect'), null);
			assert.strictEqual(raw.headers.get('set-cookie'), null);
		} finally {
			server.close();
		}
	});

	it('rewrites an HTTP/2 response', async () => {
		const server = createHttp2Server((request, response) => {
			adaptHttp2ForNext(request, response);
			reloadOnMissingAction(request, response, '');
			sendActionNotFound(response);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		const client = connect(`http://127.0.0.1:${port}`);
		try {
			const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const stream = client.request({ ':method': 'POST', ':path': '/page', 'next-action': 'abc' });
				stream.on('response', (responseHeaders) => {
					stream.resume();
					stream.on('end', () => resolve(responseHeaders));
				});
				stream.on('error', reject);
				stream.end();
			});
			assert.strictEqual(headers[':status'], 409);
			assert.strictEqual(headers['x-nextjs-action-not-found'], undefined);
			assert.strictEqual(headers['x-action-redirect'], '/page;replace');
			assert.deepStrictEqual(headers['set-cookie'], [GUARD]);
		} finally {
			client.close();
			server.close();
		}
	});
});
