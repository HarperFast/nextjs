import { test as base, expect } from '@playwright/test';
import { join } from 'node:path';

import {
	NODES,
	authHeader,
	clusterUnavailable,
	operation,
	readRig,
	restartNode,
	startCluster,
	stopCluster,
	useCacheRows,
} from './cluster.ts';

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const [nodeA, nodeB] = NODES;

const unavailable = clusterUnavailable();

const test = base.extend({});
test.describe.configure({ mode: 'serial' });
// Staging installs dependencies and runs `next build` inside the image on first use.
test.setTimeout(900_000);

test.beforeAll(async () => {
	// Hooks carry their own timeout, which the describe-level one does not extend.
	test.setTimeout(900_000);
	test.skip(unavailable !== null, unavailable ?? '');
	await startCluster(PLUGIN_ROOT);
});

test.afterAll(async () => {
	test.setTimeout(120_000);
	// HARPER_CLUSTER_KEEP leaves the containers up so a failing run can be inspected by hand.
	if (!unavailable && process.env.HARPER_CLUSTER_KEEP !== '1') await stopCluster();
});

function bucket(prefix: string) {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

test('the cluster is actually replicating', async () => {
	const status = (await operation(nodeA, { operation: 'cluster_status' })) as {
		node_name: string;
		connections: Array<{ name: string }>;
	};
	expect(status.node_name).toBe(nodeA.name);
	expect(status.connections.map((connection) => connection.name)).toContain(nodeB.name);

	// A plain replicated table, so a later cache failure can be told apart from replication being down.
	await fetch(`${nodeA.httpURL}/RigMarker/replication-probe`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
		body: JSON.stringify({ node: nodeA.rigNode, at: Date.now() }),
	});
	await expect(async () => {
		const response = await fetch(`${nodeB.httpURL}/RigMarker/replication-probe`, {
			headers: { Authorization: authHeader() },
		});
		expect(response.status).toBe(200);
	}).toPass({ timeout: 20_000 });
});

test('the handlers run at request time rather than being prerendered', async () => {
	// The trap this rig exists to avoid: a fully prerendered page resolves its cached boundary during
	// `next build`, so the handler is never called and the cache assertions below pass for free.
	const response = await fetch(`${nodeA.httpURL}/rig`, { headers: { Cookie: 'bucket=prerender-check' } });
	expect(response.headers.get('x-nextjs-prerender')).toBeNull();

	const before = (await useCacheRows(nodeA)).length;
	await readRig(nodeA, bucket('invoked'));
	await expect(async () => {
		expect((await useCacheRows(nodeA)).length).toBeGreaterThan(before);
	}).toPass({ timeout: 15_000 });
});

test('a "use cache" entry written on A is served from B without regeneration', async () => {
	const key = bucket('cross-node');

	const onA = await readRig(nodeA, key);
	expect(onA['served-by']).toBe('nodeA');
	expect(onA['cached-by']).toBe('nodeA');

	let onB: Record<string, string> = {};
	await expect(async () => {
		onB = await readRig(nodeB, key);
		expect(onB['cached-nonce']).toBe(onA['cached-nonce']);
	}).toPass({ timeout: 20_000 });

	expect(onB['served-by'], 'B must have served the request').toBe('nodeB');
	expect(onB['cached-by'], "the value must carry A's identity, proving it crossed the cluster").toBe('nodeA');
});

test('per-entry cache lives replicate, so the non-writing node does not regenerate every read', async () => {
	const key = bucket('lives');
	await readRig(nodeA, key);

	await expect(async () => {
		const rows = await useCacheRows(nodeB);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => typeof row.revalidate === 'number' && typeof row.expire === 'number')).toBe(true);
	}).toPass({ timeout: 20_000 });

	// Without persisted cache lives the handler reads back revalidate=0, Next treats the entry as
	// immediately stale, and node B regenerates on every single read (measured 10/10).
	const first = await readRig(nodeB, key);
	const nonces = new Set<string>([first['cached-nonce']]);
	for (let i = 0; i < 8; i++) nonces.add((await readRig(nodeB, key))['cached-nonce']);
	expect([...nonces], 'B regenerated instead of serving the replicated entry').toHaveLength(1);
});

test('the Blob value survives replication intact', async () => {
	await readRig(nodeA, bucket('blob'));
	await expect(async () => {
		const [onA, onB] = [await useCacheRows(nodeA), await useCacheRows(nodeB)];
		const bytesA = Math.max(...onA.map((row) => Number(row.valueBytes)));
		const bytesB = Math.max(...onB.map((row) => Number(row.valueBytes)));
		expect(bytesA).toBeGreaterThan(0);
		expect(bytesB).toBe(bytesA);
	}).toPass({ timeout: 20_000 });
});

test('revalidateTag on A invalidates on B', async () => {
	const key = bucket('fanout');
	await readRig(nodeA, key);

	let before = '';
	await expect(async () => {
		before = (await readRig(nodeB, key))['cached-nonce'];
		expect(before).toBeTruthy();
	}).toPass({ timeout: 20_000 });

	const started = Date.now();
	await fetch(`${nodeA.httpURL}/api/revalidate?tag=rig-tag`, { method: 'POST' });

	await expect(async () => {
		expect((await readRig(nodeB, key))['cached-nonce']).not.toBe(before);
	}).toPass({ timeout: 30_000 });

	console.log(`  invalidation fan-out A -> B observed in ~${Date.now() - started}ms`);
});

test('cached entries and tombstones survive a node restart', async () => {
	const key = bucket('restart');
	const before = (await readRig(nodeA, key))['cached-nonce'];

	await fetch(`${nodeA.httpURL}/api/revalidate?tag=restart-tag`, { method: 'POST' });

	await restartNode(nodeA);

	expect((await readRig(nodeA, key))['cached-nonce'], 'the entry did not survive the restart').toBe(before);

	// The in-memory invalidation map dies with the worker; the tombstone is what a restarted worker
	// rehydrates from, so without it the stale entry would come back looking fresh.
	const rows = (await operation(nodeA, {
		operation: 'search_by_value',
		database: 'harperfast_nextjs',
		table: 'nextjs_cache_invalidation',
		search_attribute: 'id',
		search_value: 'restart-tag',
		get_attributes: ['id', 'timestamp'],
	})) as unknown[];
	expect(rows.length).toBeGreaterThan(0);
});

test('Harper REST resources are reachable alongside Next', async () => {
	// Only because `rest` is declared before the plugin in config.yaml. Declared after, the plugin's
	// catch-all handler answers these paths with Next's 404/308 instead.
	const probe = await fetch(`${nodeA.httpURL}/RigProbe/`, { headers: { Authorization: authHeader() } });
	expect(probe.status).toBe(200);

	const page = await fetch(`${nodeA.httpURL}/rig`, { headers: { Cookie: 'bucket=coexist' } });
	expect(page.status).toBe(200);
});
