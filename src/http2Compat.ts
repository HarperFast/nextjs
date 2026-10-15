import { Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Next.js's request handler assumes Node's HTTP/1 objects. Harper serves HTTP/2 (`http.http2: true` on a
 * secure port) through `node:http2`'s compatibility API, whose objects differ in two ways that break every
 * Next.js response:
 *
 * - `req.headers` has a null prototype, and Next.js calls `headers.hasOwnProperty()` while preparing the
 *   route, so every page renders a 500.
 * - The response has no `_implicitHeader()`. The `compression` middleware Next.js bundles calls it on
 *   the first write whenever `res._header` is unset, which on `Http2ServerResponse` is always, so the
 *   stream is reset.
 *
 * Adapts the pair in place; HTTP/1 requests are returned untouched.
 */
export function adaptHttp2ForNext(
	request: IncomingMessage | Http2ServerRequest,
	response: ServerResponse | Http2ServerResponse
): void {
	if (!(request instanceof Http2ServerRequest)) return;

	const headers = request.headers;
	if (Object.getPrototypeOf(headers) === null) Object.setPrototypeOf(headers, Object.prototype);

	const http2Response = response as Http2ServerResponse & { _implicitHeader?: () => void };
	if (typeof http2Response._implicitHeader !== 'function') {
		http2Response._implicitHeader = implicitHeader;
	}
}

function implicitHeader(this: Http2ServerResponse): void {
	if (!this.headersSent) this.writeHead(this.statusCode);
}
