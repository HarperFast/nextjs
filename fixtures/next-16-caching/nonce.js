import { Resource } from 'harper';

/**
 * Returns a random nonce on every GET request.
 * The ISR page fetches this at render time so each regeneration produces a
 * distinct value — allowing tests to distinguish a fresh render from a cached one.
 */
export class Nonce extends Resource {
	static async get() {
		return { nonce: Math.random().toString(36).slice(2) };
	}
}
