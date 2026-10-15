import { describe, it, after, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as createHttp2Server, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

import { adaptHttp2ForNext } from './http2Compat.js';

// The middleware Next.js wraps every response in (`compress: true`, its default). Driving the real one
// is what proves the response half of the fix.
const compression = createRequire(import.meta.url)('next-16/dist/compiled/compression');

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
		let observed: { hasOwnProperty: string; host: boolean } | undefined;
		let unadaptedHasOwnProperty: string | undefined;
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
					host: request.headers.hasOwnProperty(':authority'),
				};
				response.end();
			});
			const adapted = await listenHttp2(compressedHandler(true));
			const unadapted = await listenHttp2((request, response) => {
				unadaptedHasOwnProperty = typeof request.headers.hasOwnProperty;
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
			assert.deepStrictEqual(observed, { hasOwnProperty: 'function', host: true });
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

		it('is needed: unadapted, headers lack hasOwnProperty and the compression middleware throws', async () => {
			await getHttp2(unadaptedURL, { 'accept-encoding': 'gzip' });
			assert.strictEqual(unadaptedHasOwnProperty, 'undefined');
			assert.match(unadaptedError?.message ?? '', /_implicitHeader is not a function/);
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
