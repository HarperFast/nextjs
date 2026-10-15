import { Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Next.js's request handler assumes Node's HTTP/1 objects; Harper's HTTP/2 port hands it `node:http2`
 * compatibility objects instead. Next.js calls `headers.hasOwnProperty()` (absent on HTTP/2's
 * null-prototype headers), reads `host` (HTTP/2 sends `:authority`), and its bundled `compression`
 * calls `res._implicitHeader()` (absent on `Http2ServerResponse`). HTTP/1 requests are left untouched.
 */
export function adaptHttp2ForNext(
	request: IncomingMessage | Http2ServerRequest,
	response: ServerResponse | Http2ServerResponse
): void {
	if (!(request instanceof Http2ServerRequest)) return;

	const headers = request.headers;
	if (Object.getPrototypeOf(headers) === null) Object.setPrototypeOf(headers, Object.prototype);
	headers.host ??= headers[':authority'];

	const http2Response = response as Http2ServerResponse & { _implicitHeader?: () => void };
	if (typeof http2Response._implicitHeader !== 'function') {
		http2Response._implicitHeader = implicitHeader;
	}
}

// `compression` calls this on every write because `Http2ServerResponse` never sets `_header`.
function implicitHeader(this: Http2ServerResponse): void {
	if (!this.headersSent) this.writeHead(this.statusCode);
}
