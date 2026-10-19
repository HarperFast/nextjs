import { describe, it, after, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, constants, createServer as createHttp2Server, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

import { adaptHttp2ForNext } from './http2Compat.js';

const require = createRequire(import.meta.url);
const compression = require('next-16/dist/compiled/compression');
const { fromNodeOutgoingHttpHeaders } = require('next-16/dist/server/web/utils.js');

function nextHeadersConversion(headers: unknown): string {
	try {
		fromNodeOutgoingHttpHeaders(headers);
		return 'ok';
	} catch (error) {
		return (error as Error).message;
	}
}

const BODY = 'x'.repeat(4096);

type Handler = (request: any, response: any) => void;

async function listenHttp2(handler: Handler): Promise<{ server: Http2Server; url: string }> {
	const server = createHttp2Server(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function getHttp2(url: string, headers: Record<string, string> = {}) {
	const client = connect(url);
	try {
		return await new Promise<{ status: number; headers: Record<string, any>; body: Buffer }>((resolve, reject) => {
			client.on('error', reject);
			const stream = client.request({ ':path': '/', ...headers });
			const chunks: Buffer[] = [];
			let responseHeaders: Record<string, any> = {};
			stream.on('response', (received) => (responseHeaders = received));
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('end', () =>
				resolve({ status: responseHeaders[':status'], headers: responseHeaders, body: Buffer.concat(chunks) })
			);
			stream.on('error', reject);
			stream.end();
		});
	} finally {
		client.close();
	}
}

function compressedHandler(adapt: boolean, onError?: (error: Error) => void): Handler {
	const compress = compression();
	return (request, response) => {
		if (adapt) adaptHttp2ForNext(request, response);
		compress(request, response, () => {
			response.setHeader('content-type', 'text/html');
			try {
				response.write(BODY.slice(0, 2048));
				response.end(BODY.slice(2048));
			} catch (error) {
				onError?.(error as Error);
				response.stream.close();
			}
		});
	};
}

describe('adaptHttp2ForNext', () => {
	describe('over HTTP/2', () => {
		let observed:
			| { hasOwnProperty: string; pseudoHeaders: string[]; host: string; authority: string; url: string; method: string; conversion: string }
			| undefined;
		let unadaptedHasOwnProperty: string | undefined;
		let unadaptedHost: string | undefined;
		let unadaptedConversion: string | undefined;
		let unadaptedError: Error | undefined;
		const servers: Http2Server[] = [];
		let headersURL: string;
		let adaptedURL: string;
		let unadaptedURL: string;

		before(async () => {
			const headers = await listenHttp2((request, response) => {
				adaptHttp2ForNext(request, response);
				observed = {
					hasOwnProperty: typeof request.headers.hasOwnProperty,
					pseudoHeaders: Object.keys(request.headers).filter((name) => name.startsWith(':')),
					host: request.headers.host,
					authority: request.authority,
					url: request.url,
					method: request.method,
					conversion: nextHeadersConversion(request.headers),
				};
				response.end();
			});
			const adapted = await listenHttp2(compressedHandler(true));
			const unadapted = await listenHttp2((request, response) => {
				unadaptedHasOwnProperty = typeof request.headers.hasOwnProperty;
				unadaptedHost = request.headers.host;
				unadaptedConversion = nextHeadersConversion(request.headers);
				compressedHandler(false, (error) => (unadaptedError = error))(request, response);
			});
			servers.push(headers.server, adapted.server, unadapted.server);
			headersURL = headers.url;
			adaptedURL = adapted.url;
			unadaptedURL = unadapted.url;
		});

		after(() => {
			for (const server of servers) server.close();
		});

		it('gives request headers the Object prototype Next.js calls hasOwnProperty on', async () => {
			const response = await getHttp2(headersURL);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(observed?.hasOwnProperty, 'function');
		});

		it("drops the pseudo-headers Next.js's Headers conversion rejects, keeping url and method", async () => {
			await getHttp2(headersURL, { ':path': '/api/echo?q=1', ':method': 'GET' });
			assert.deepStrictEqual(observed?.pseudoHeaders, []);
			assert.strictEqual(observed?.conversion, 'ok');
			assert.strictEqual(observed?.url, '/api/echo?q=1');
			assert.strictEqual(observed?.method, 'GET');
		});

		it('fills host from :authority, which HTTP/2 sends in its place', async () => {
			await getHttp2(headersURL);
			assert.ok(observed?.authority);
			assert.strictEqual(observed?.host, observed?.authority);
		});

		it('keeps a host header the client sent', async () => {
			await getHttp2(headersURL, { host: 'example.test' });
			assert.strictEqual(observed?.host, 'example.test');
		});

		it("lets Next.js's compression middleware write a gzipped response", async () => {
			const response = await getHttp2(adaptedURL, { 'accept-encoding': 'gzip' });
			assert.strictEqual(response.status, 200);
			assert.strictEqual(response.headers['content-encoding'], 'gzip');
			assert.strictEqual(gunzipSync(response.body).toString(), BODY);
		});

		it('lets the compression middleware write an uncompressed response', async () => {
			const response = await getHttp2(adaptedURL);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(response.headers['content-encoding'], undefined);
			assert.strictEqual(response.body.toString(), BODY);
		});

		it('is needed: unadapted, headers lack hasOwnProperty and host, Next.js rejects them, and the compression middleware throws', async () => {
			await getHttp2(unadaptedURL, { 'accept-encoding': 'gzip' });
			assert.strictEqual(unadaptedHasOwnProperty, 'undefined');
			assert.strictEqual(unadaptedHost, undefined);
			assert.match(unadaptedConversion ?? '', /is an invalid header name/);
			assert.match(unadaptedError?.message ?? '', /_implicitHeader is not a function/);
		});

		it('does not throw when the client has already reset the stream', async () => {
			let outcome: string | undefined;
			const { server, url } = await listenHttp2((request, response) => {
				adaptHttp2ForNext(request, response);
				request.stream.on('close', () => {
					try {
						response._implicitHeader();
						outcome = 'ok';
					} catch (error) {
						outcome = (error as NodeJS.ErrnoException).code;
					}
				});
			});
			try {
				const client = connect(url);
				const stream = client.request({ ':path': '/' });
				stream.on('error', () => {});
				await new Promise<void>((resolve) => {
					stream.on('close', resolve);
					setTimeout(() => stream.close(constants.NGHTTP2_CANCEL), 20);
				});
				client.close();
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.strictEqual(outcome, 'ok');
			} finally {
				server.close();
			}
		});
	});

	it('leaves HTTP/1 requests untouched', async () => {
		let observed: { headersProto: object | null; implicitHeader: unknown } | undefined;
		const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
			const ownBefore = Object.hasOwn(response, '_implicitHeader');
			adaptHttp2ForNext(request, response);
			observed = {
				headersProto: Object.getPrototypeOf(request.headers),
				implicitHeader: Object.hasOwn(response, '_implicitHeader') !== ownBefore,
			};
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const { port } = server.address() as AddressInfo;
			await new Promise<void>((resolve, reject) =>
				httpRequest({ host: '127.0.0.1', port }, (response) => response.resume().on('end', resolve))
					.on('error', reject)
					.end()
			);
			assert.deepStrictEqual(observed, { headersProto: Object.prototype, implicitHeader: false });
		} finally {
			server.close();
		}
	});
});
