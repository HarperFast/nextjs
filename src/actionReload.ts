import type { IncomingHttpHeaders, OutgoingHttpHeader } from 'node:http';

export const RELOAD_GUARD_COOKIE = '__harper_nextjs_action_reload';
export const RELOAD_GUARD_SECONDS = 30;

const ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found';
const ACTION_REDIRECT_HEADER = 'x-action-redirect';

interface ActionRequest {
	method?: string;
	url?: string;
	headers: IncomingHttpHeaders;
}

interface ActionResponse {
	setHeader(name: string, value: OutgoingHttpHeader): unknown;
	getHeader(name: string): OutgoingHttpHeader | undefined;
	removeHeader(name: string): void;
}

/**
 * Next.js 16 marks a server action the current build doesn't have with `x-nextjs-action-not-found`, and
 * its client throws. Swapping that marker for `x-action-redirect` to the current page makes the client do
 * a full page load into the current build instead; the action never ran, so nothing is lost but local
 * state. Next.js 15's client resolves the action before that load, so callers must not enable this there.
 *
 * A guard cookie allows one reload per browser per {@link RELOAD_GUARD_SECONDS}, so an action that keeps
 * missing (for example one called on mount) surfaces Next.js's error instead of reloading forever.
 */
export function reloadOnMissingAction(request: ActionRequest, response: ActionResponse, basePath: string): void {
	if (request.method !== 'POST' || request.headers['next-action'] === undefined) return;
	const setHeader = response.setHeader;
	response.setHeader = function (this: ActionResponse, name: string, value: OutgoingHttpHeader) {
		if (typeof name === 'string' && name.toLowerCase() === ACTION_NOT_FOUND_HEADER && String(value) === '1') {
			const location = hasGuardCookie(request.headers.cookie) ? undefined : reloadLocation(request.url, basePath);
			if (location !== undefined) {
				try {
					const cookies = appendCookie(this.getHeader('set-cookie'), guardCookie(basePath));
					const result = setHeader.call(this, ACTION_REDIRECT_HEADER, `${location};replace`);
					try {
						setHeader.call(this, 'set-cookie', cookies);
					} catch (error) {
						this.removeHeader(ACTION_REDIRECT_HEADER);
						throw error;
					}
					return result;
				} catch {
					// Fall through: Next.js's own not-found response is still correct, only less helpful.
				}
			}
		}
		return setHeader.call(this, name, value);
	};
}

/**
 * The page to reload, relative to `basePath` because the client adds it back. `undefined` when the request
 * target isn't an origin-relative path. The client splits the header on `;`, so `;` is escaped.
 */
export function reloadLocation(url: string | undefined, basePath: string): string | undefined {
	if (url === undefined || url[0] !== '/' || url[1] === '/' || url[1] === '\\') return undefined;
	let path = url;
	if (basePath) {
		if (path !== basePath && !path.startsWith(`${basePath}/`) && !path.startsWith(`${basePath}?`)) return undefined;
		path = path.slice(basePath.length);
		if (path === '' || path[0] === '?') path = `/${path}`;
	}
	return path.replaceAll(';', '%3B');
}

export function hasGuardCookie(header: string | string[] | undefined): boolean {
	if (header === undefined) return false;
	const values = Array.isArray(header) ? header : [header];
	return values.some((value) => value.split(';').some((pair) => pair.trim() === `${RELOAD_GUARD_COOKIE}=1`));
}

function guardCookie(basePath: string): string {
	return `${RELOAD_GUARD_COOKIE}=1; Max-Age=${RELOAD_GUARD_SECONDS}; Path=${basePath || '/'}; HttpOnly; SameSite=Lax`;
}

function appendCookie(existing: OutgoingHttpHeader | undefined, cookie: string): string[] {
	if (existing === undefined) return [cookie];
	if (Array.isArray(existing)) return [...existing, cookie];
	return [String(existing), cookie];
}
