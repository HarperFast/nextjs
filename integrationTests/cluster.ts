import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * Harper replication lives in harper-pro; the OSS `harper` distribution has no replication module and
 * rejects `add_node` as an unknown operation. These tests therefore need a Pro image.
 */
export const PRO_IMAGE = process.env.HARPER_PRO_IMAGE ?? 'harperfast/harper-pro-openshift:5.0.26';
export const NETWORK = 'harper-nextjs-clusternet';
export const CREDENTIALS = { username: 'admin', password: 'pilotpass' };

export interface ClusterNode {
	name: string;
	rigNode: string;
	httpURL: string;
	opsURL: string;
}

export const NODES: ClusterNode[] = [
	{ name: 'hnx-a', rigNode: 'nodeA', httpURL: 'http://localhost:29926', opsURL: 'http://localhost:29925' },
	{ name: 'hnx-b', rigNode: 'nodeB', httpURL: 'http://localhost:39926', opsURL: 'http://localhost:39925' },
];

function docker(args: string[], options: { allowFailure?: boolean } = {}): string {
	try {
		return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		if (options.allowFailure) return '';
		throw error;
	}
}

/** Why the cluster suite cannot run here, or null when it can. */
export function clusterUnavailable(): string | null {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
	} catch {
		return 'Docker is not available';
	}
	const images = docker(['images', '--format', '{{.Repository}}:{{.Tag}}'], { allowFailure: true });
	if (!images.split('\n').includes(PRO_IMAGE)) {
		return `${PRO_IMAGE} is not present locally (replication requires harper-pro; OSS harper has no add_node)`;
	}
	return null;
}

export function authHeader(): string {
	return `Basic ${Buffer.from(`${CREDENTIALS.username}:${CREDENTIALS.password}`).toString('base64')}`;
}

/**
 * Stage the rig once: install dependencies and run `next build` inside the Pro image, so the native
 * binaries match the container rather than the host. Cached between runs — the build is slow and the
 * inputs rarely change.
 */
export function stageRig(pluginRoot: string): string {
	const staging = join(tmpdir(), 'harper-nextjs-cluster-rig');
	const fixture = join(pluginRoot, 'fixtures', 'next-16-cluster');
	const stamp = join(staging, '.stamp');
	const inputs = ['config.yaml', 'next.config.mjs', 'package.json', 'probe.js', 'schema.graphql']
		.map((file) => readFileSync(join(fixture, file), 'utf8'))
		.join('\n');
	const pluginStamp = readFileSync(join(pluginRoot, 'dist', 'UseCacheHandler.cjs'), 'utf8');
	const want = `${inputs}\n${pluginStamp.length}`;

	if (existsSync(stamp) && readFileSync(stamp, 'utf8') === want && existsSync(join(staging, '.next'))) {
		return staging;
	}

	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	cpSync(fixture, staging, { recursive: true });

	// Vendor the plugin so the container installs the build under test rather than the published one.
	const vendored = join(staging, 'plugin');
	mkdirSync(vendored, { recursive: true });
	for (const entry of ['dist', 'config.yaml', 'schema.graphql', 'package.json']) {
		cpSync(join(pluginRoot, entry), join(vendored, entry), { recursive: true });
	}
	const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
	pkg.dependencies['@harperfast/nextjs'] = 'file:./plugin';
	writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, '\t'));

	const run = (entrypoint: string, args: string[]) =>
		docker([
			'run', '--rm', '-v', `${staging}:/app`, '-w', '/app', '-e', 'RIG_NODE=build',
			'--entrypoint', entrypoint, PRO_IMAGE, ...args,
		]);

	run('npm', ['install', '--install-links', '--no-audit', '--no-fund']);
	run('npx', ['next', 'build']);

	writeFileSync(stamp, want);
	return staging;
}

export async function startCluster(pluginRoot: string): Promise<void> {
	const staging = stageRig(pluginRoot);

	docker(['network', 'create', NETWORK], { allowFailure: true });
	for (const node of NODES) docker(['rm', '-f', node.name], { allowFailure: true });

	for (const node of NODES) {
		// Both nodes mount the same staged directory. `prebuilt: true` means neither builds, and Harper
		// writes to ROOTPATH rather than the component, so there is nothing for them to race on. Copying
		// per node is also actively wrong here: npm links the vendored plugin as a relative symlink and
		// Node's cpSync rewrites it to an absolute host path, which does not exist inside the container.
		const dir = staging;

		const opsPort = new URL(node.opsURL).port;
		const httpPort = new URL(node.httpURL).port;
		docker([
			'run', '-d', '--name', node.name, '--network', NETWORK, '--hostname', node.name,
			'-e', 'TC_AGREEMENT=yes', '-e', 'ROOTPATH=/tmp/hdb', '-e', 'DEFAULTS_MODE=dev',
			'-e', `HDB_ADMIN_USERNAME=${CREDENTIALS.username}`, '-e', `HDB_ADMIN_PASSWORD=${CREDENTIALS.password}`,
			'-e', 'OPERATIONSAPI_NETWORK_PORT=9925', '-e', 'HTTP_PORT=9926', '-e', 'HTTP_NETWORK_PORT=9926',
			'-e', 'LOGGING_STDSTREAMS=true', '-e', `REPLICATION_HOSTNAME=${node.name}`,
			'-e', `NODE_HOSTNAME=${node.name}`, '-e', `RIG_NODE=${node.rigNode}`,
			'-p', `${opsPort}:9925`, '-p', `${httpPort}:9926`,
			'-v', `${dir}:/component`, PRO_IMAGE, 'run', '/component',
		]);
	}

	for (const node of NODES) await waitForNode(node);

	// `username`/`password` alone are rejected by the replication socket with "No authorization
	// provided"; the cert-signing handshake needs an explicit Authorization header.
	await operation(NODES[0], {
		operation: 'add_node',
		hostname: NODES[1].name,
		authorization: authHeader(),
		verify_tls: false,
	});

	await new Promise((resolve) => setTimeout(resolve, 5000));
}

export async function waitForNode(node: ClusterNode, timeoutMs = 180_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await operation(node, { operation: 'describe_all' });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
	throw new Error(`${node.name} did not become ready within ${timeoutMs}ms`);
}

export async function operation(node: ClusterNode, body: Record<string, unknown>): Promise<unknown> {
	const response = await fetch(`${node.opsURL}/`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${body.operation} failed: ${response.status}`);
	return response.json();
}

export async function restartNode(node: ClusterNode): Promise<void> {
	docker(['restart', node.name]);
	await waitForNode(node);
	await new Promise((resolve) => setTimeout(resolve, 5000));
}

export async function stopCluster(): Promise<void> {
	for (const node of NODES) docker(['rm', '-f', node.name], { allowFailure: true });
	docker(['network', 'rm', NETWORK], { allowFailure: true });
}

/** Fetch the rig page and pull the marker spans out of the streamed HTML. */
export async function readRig(node: ClusterNode, bucket: string, path = 'rig'): Promise<Record<string, string>> {
	const response = await fetch(`${node.httpURL}/${path}`, { headers: { Cookie: `bucket=${bucket}` } });
	const html = await response.text();
	const markers: Record<string, string> = {};
	for (const [, id, value] of html.matchAll(/data-testid="([^"]+)">([^<]*)/g)) {
		if (!(id in markers)) markers[id] = value;
	}
	return markers;
}

export async function useCacheRows(node: ClusterNode): Promise<Array<Record<string, unknown>>> {
	const response = await fetch(`${node.httpURL}/RigProbe/`, { headers: { Authorization: authHeader() } });
	const text = await response.text();
	let body: { useCacheEntries?: Array<Record<string, unknown>> };
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`RigProbe on ${node.name} returned ${response.status}: ${text.slice(0, 200)}`);
	}
	if (!Array.isArray(body.useCacheEntries)) {
		throw new Error(`RigProbe on ${node.name} returned ${response.status}: ${text.slice(0, 200)}`);
	}
	return body.useCacheEntries;
}

export { execFileAsync, dirname };
