import { Resource, databases } from 'harper';

/**
 * Cluster-visible state, so a test can ask a specific node what it holds without going through Next.
 * Declared before the Next.js plugin in config.yaml — after it, the plugin's catch-all handler answers
 * this path with Next's 404 instead.
 */
export class RigProbe extends Resource {
	static async get() {
		const node = process.env.RIG_NODE ?? 'unknown';
		const database = databases.harperfast_nextjs;

		// The cache tables only exist once the plugin has registered its schema, so a probe on a
		// freshly started node must report an empty view rather than failing the request.
		if (!database) return { node, counts: {}, useCacheEntries: [], ready: false };

		const counts = {};
		for (const table of ['nextjs_isr_cache', 'nextjs_use_cache', 'nextjs_cache_invalidation']) {
			let count = 0;
			if (database[table]) {
				for await (const _row of database[table].search({ conditions: [] })) count++;
			}
			counts[table] = count;
		}

		const useCacheEntries = [];
		if (database.nextjs_use_cache) {
			for await (const row of database.nextjs_use_cache.search({ conditions: [] })) {
				useCacheEntries.push({
					id: String(row.id).slice(0, 60),
					timestamp: row.timestamp,
					revalidate: row.revalidate,
					expire: row.expire,
					tags: row.tags,
					valueBytes: row.value ? (await row.value.arrayBuffer()).byteLength : 0,
				});
			}
		}

		return { node, counts, useCacheEntries, ready: true };
	}
}
