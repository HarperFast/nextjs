import { Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

/**
 * Next.js's request handler assumes Node's HTTP/1 objects; Harper's HTTP/2 port hands it `node:http2`
 * compatibility objects instead. Next.js calls `headers.hasOwnProperty()` (absent on HTTP/2's
 * null-prototype headers), passes every header name to `Headers.append()` (which rejects HTTP/2's
 * `:path`-style pseudo-headers), reads `host` (HTTP/2 sends `:authority`), and its bundled `compression`
 * calls `res._implicitHeader()` (absent on `Http2ServerResponse`). HTTP/1 requests are left untouched.
 */
export function adaptHttp2ForNext(
	request: IncomingMessage | Http2ServerRequest,
	response: ServerResponse | Http2ServerResponse
): void {
	if (!(request instanceof Http2ServerRequest)) return;

	// `url` and `method` are getters over the stream's headers object, so the pseudo-headers stay there
	// and Next.js is given an HTTP/1-shaped copy instead.
	const http2Headers = request.headers;
	const headers: IncomingHttpHeaders = {};
	for (const name in http2Headers) {
		if (name[0] !== ':') headers[name] = http2Headers[name];
	}
	headers.host ??= http2Headers[':authority'];
	Object.defineProperty(request, 'headers', { value: headers, configurable: true, enumerable: true, writable: true });

	const http2Response = response as Http2ServerResponse & { _implicitHeader?: () => void };
	if (typeof http2Response._implicitHeader !== 'function') {
		http2Response._implicitHeader = implicitHeader;
	}
}

// `compression` calls this on every write because `Http2ServerResponse` never sets `_header`.
function implicitHeader(this: Http2ServerResponse): void {
	if (!this.headersSent) this.writeHead(this.statusCode);
}
