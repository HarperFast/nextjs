import type { IncomingMessage, ServerResponse } from 'node:http';
import { Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import { Writable } from 'node:stream';
import { parse as urlParse, type UrlWithParsedQuery } from 'node:url';

import { adaptHttp2ForNext, stripHttp2PseudoHeaders } from './http2Compat.js';

export type NextRequestHandler = (
	request: IncomingMessage,
	response: ServerResponse,
	parsedUrl: UrlWithParsedQuery
) => Promise<void>;

export interface HarperHttpRequest {
	url: string;
	_nodeRequest: IncomingMessage | Http2ServerRequest;
	_nodeResponse?: ServerResponse | Http2ServerResponse | null;
	withNodeAdapter(
		handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
	): Promise<unknown>;
}

interface Logger {
	warn?(...args: unknown[]): void;
}

const NODE_ADAPTER_REQUIREMENT = 'Harper 5.3.0 or later (5.3.3 or later on Node.js 26.11+)';

/**
 * Whether this Harper's `Request.withNodeAdapter()` can serve Next.js. Every 5.x Harper has the method, but
 * before 5.3.0 (harper#2528) its response was not a real Writable: Next.js 500s and responses over 16 KB hang.
 * Node.js 26.11's pipe fast path also corrupted its gzip output until 5.3.3 (harper#3108); `pipeSkipsWrite` is
 * Harper's own test for that runtime.
 */
export function nodeAdapterUsable(
	harperVersion: string | undefined,
	pipeSkipsWrite = 'writeKnownBuffer' in Writable
): boolean {
	if (harperVersion === undefined) return false;
	return pipeSkipsWrite ? versionAtLeast(harperVersion, 5, 3, 3) : versionAtLeast(harperVersion, 5, 3, 0);
}

function versionAtLeast(version: string, ...floor: [number, number, number]): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(-)?/.exec(version);
	if (!match) return false;
	for (let index = 0; index < 3; index++) {
		const part = Number(match[index + 1]);
		if (part !== floor[index]) return part > floor[index];
	}
	// A prerelease of the floor version predates it.
	return match[4] === undefined;
}

/** Mirrors Next.js's own basePath match. */
function carriesBasePath(url: string, basePath: string): boolean {
	if (basePath === '' || !url.startsWith(basePath)) return false;
	const boundary = url[basePath.length];
	return boundary === undefined || boundary === '/' || boundary === '?' || boundary === '#';
}

export function createNextHttpHandler(
	requestHandler: NextRequestHandler,
	{ basePath, harperVersion, logger }: { basePath: string; harperVersion: string | undefined; logger: Logger }
) {
	const adapterUsable = nodeAdapterUsable(harperVersion);
	let warnedAdapterUnusable = false;

	return <Request extends HarperHttpRequest>(request: Request, next: (request: Request) => unknown) => {
		// `== null`, not `=== undefined`: Harper's Bun and uWS requests carry a null `_nodeResponse`, and neither
		// implements the Node adapter used below.
		if (request._nodeResponse == null) return next(request);
		const nodeRequest = request._nodeRequest as IncomingMessage;
		const nodeResponse = request._nodeResponse as ServerResponse;
		const nodeUrl = nodeRequest.url!;
		// Harper strips a urlPath mount by proxying its `Request`; the Node request keeps the URL as it arrived.
		if (request.url !== nodeUrl && !carriesBasePath(nodeUrl, basePath)) {
			if (adapterUsable) {
				const http2 = request._nodeRequest instanceof Http2ServerRequest;
				return request.withNodeAdapter((adaptedRequest, adaptedResponse) => {
					if (http2) stripHttp2PseudoHeaders(adaptedRequest.headers);
					return requestHandler(adaptedRequest, adaptedResponse, urlParse(adaptedRequest.url!, true));
				});
			}
			if (!warnedAdapterUnusable) {
				warnedAdapterUnusable = true;
				logger.warn?.(
					`Harper ${harperVersion ?? '(version unknown)'} cannot hand Next.js the request URL relative to the ` +
						`application's urlPath mount, which needs ${NODE_ADAPTER_REQUIREMENT}. Next.js receives the URL as it ` +
						'arrived, so this mounted application will not route correctly. Upgrade Harper, serve the application at ' +
						'the root, or build it with a Next.js basePath equal to its urlPath.'
				);
			}
		}
		adaptHttp2ForNext(nodeRequest, nodeResponse);
		return requestHandler(nodeRequest, nodeResponse, urlParse(nodeUrl, true));
	};
}
