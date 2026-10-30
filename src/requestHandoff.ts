import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { parse as urlParse, type UrlWithParsedQuery } from 'node:url';

import { adaptHttp2ForNext } from './http2Compat.js';

export type NextRequestHandler = (
	request: IncomingMessage,
	response: ServerResponse,
	parsedUrl: UrlWithParsedQuery
) => Promise<void>;

/** The parts of Harper's `Request` the hand-off reads. */
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

/**
 * The `basePath` the Next.js app was built with, or `''`. Next.js 16 writes its dev-server manifest under
 * `.next/dev`; Next.js 14's dev server writes none, so a dev-mode Next.js 14 app reads as having no basePath.
 */
export function readBasePath(directory: string, dev: boolean): string {
	const manifests = [join(directory, '.next', 'routes-manifest.json')];
	if (dev) manifests.unshift(join(directory, '.next', 'dev', 'routes-manifest.json'));
	for (const manifest of manifests) {
		try {
			return JSON.parse(readFileSync(manifest, 'utf8')).basePath ?? '';
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	return '';
}

/** Mirrors Next.js's own basePath match: the prefix must end at a path segment boundary. */
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
		// Harper's router strips an application's urlPath mount by proxying the Harper `Request`, so the Node
		// request underneath still carries the un-stripped URL. The adapter presents the stripped one to Next.js,
		// unless that URL still begins with the app's basePath: Next.js strips its own basePath, and would 404 a
		// stripped URL that no longer carries it.
		if (request.url !== nodeUrl && !carriesBasePath(nodeUrl, basePath)) {
			if (adapterUsable) {
				return request.withNodeAdapter((adaptedRequest, adaptedResponse) =>
					requestHandler(adaptedRequest, adaptedResponse, urlParse(adaptedRequest.url!, true))
				);
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
