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
export const PRO_IMAGE = process.env.HARPER_PRO_IMAGE ?? 'harperfast/harper-pro:5.3.1';
export const NETWORK = 'harper-nextjs-clusternet';
export const CREDENTIALS = { username: 'admin', password: 'pilotpass' };

/**
 * Docker or Podman, whichever this machine has. Podman is a drop-in for every subcommand the rig uses,
 * and it is what the macOS workstations run — but `docker` there is usually a *shell alias*, which a
 * direct spawn never sees, so the binary has to be probed rather than assumed. `HARPER_CONTAINER_CLI`
 * forces one.
 */
function detectContainerCli(): string | null {
	const forced = process.env.HARPER_CONTAINER_CLI;
	for (const candidate of forced ? [forced] : ['docker', 'podman']) {
		try {
			execFileSync(candidate, ['version'], { stdio: 'ignore' });
			return candidate;
		} catch {
			// Not installed, or not on PATH as a real executable.
		}
	}
	return null;
}

export const CONTAINER_CLI = detectContainerCli();

/**
 * Set this where the cluster suite is expected to run — CI above all. Without it a suite that cannot
 * start silently skips, which is how it came to be green everywhere and exercised nowhere. With it, a
 * missing runtime or an unpullable image fails the run instead.
 */
export const CLUSTER_REQUIRED = process.env.HARPER_CLUSTER_REQUIRED === '1';

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
	if (!CONTAINER_CLI) throw new Error('no container CLI: install Docker or Podman, or set HARPER_CONTAINER_CLI');
	try {
		return execFileSync(CONTAINER_CLI, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		if (options.allowFailure) return '';
		throw error;
	}
}

/**
 * Why the cluster suite cannot run here, or null when it can. Only the container runtime is checked:
 * a missing image is not a blocker, because `ensureImage` pulls it.
 */
export function clusterUnavailable(): string | null {
	if (!CONTAINER_CLI) return 'neither docker nor podman is available (set HARPER_CONTAINER_CLI to force one)';
	try {
		execFileSync(CONTAINER_CLI, ['info'], { stdio: 'ignore' });
	} catch {
		return `${CONTAINER_CLI} is installed but its daemon/machine is not running`;
	}
	return null;
}

function imagePresent(): boolean {
	// Podman prints repositories fully qualified (docker.io/harperfast/...), so match on the suffix too.
	return docker(['images', '--format', '{{.Repository}}:{{.Tag}}'], { allowFailure: true })
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.some((image) => image === PRO_IMAGE || image.endsWith(`/${PRO_IMAGE}`));
}

/**
 * Pull the Pro image if this machine does not already have it. Replication lives in harper-pro, so
 * there is no OSS fallback — `add_node` is simply not an operation there.
 */
export function ensureImage(): void {
	if (imagePresent()) return;
	try {
		docker(['pull', PRO_IMAGE]);
	} catch (error) {
		throw new Error(
			`could not pull ${PRO_IMAGE} (replication requires harper-pro; OSS harper has no add_node). ` +
				`If it is private here, log in to the registry first or set HARPER_PRO_IMAGE to one you can pull. ` +
				`Cause: ${(error as Error).message}`
		);
	}
	if (!imagePresent()) throw new Error(`${PRO_IMAGE} still not present after a pull that reported success`);
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
	ensureImage();
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
	//
	// Retried because `waitForNode` only proves the operations API is up. The replication listener on
	// 9933 binds later, and `add_node` against a node that has not got there yet fails with
	// "connect ECONNREFUSED <ip>:9933 and connection was required to sign certificate".
	await addNodeWhenReplicationIsUp();

	// Both nodes must be serving Next.js, not just answering the operations API, before the first test
	// fetches a page. The settle afterwards is for replication itself, which has no readiness signal.
	for (const node of NODES) await waitForApp(node);
	await new Promise((resolve) => setTimeout(resolve, 5000));
}

/**
 * Join B to A, retrying while the replication socket is still coming up. Only the connect-refused
 * handshake failure is retried; anything else (bad credentials, an OSS image with no `add_node`) is
 * raised at once rather than hidden behind a timeout.
 */
async function addNodeWhenReplicationIsUp(timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await operation(NODES[0], {
				operation: 'add_node',
				hostname: NODES[1].name,
				authorization: authHeader(),
				verify_tls: false,
			});
			return;
		} catch (error) {
			const message = (error as Error).message;
			const starting = message.includes('ECONNREFUSED') || message.includes('required to sign certificate');
			if (!starting || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}
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
	if (!response.ok) {
		// Harper puts the reason in the body; without it a failed handshake is just a bare 500.
		const detail = await response.text().catch(() => '');
		throw new Error(`${body.operation} failed: ${response.status} ${detail.slice(0, 500)}`);
	}
	return response.json();
}

/**
 * Wait until the node is serving the Next.js app, not merely answering the operations API. Harper
 * binds 9925 well before the plugin has Next.js up on 9926, so a request sent in between is reset
 * mid-flight (`fetch failed` / `ECONNRESET`) rather than refused outright. A fixed sleep covered this
 * only while the machine was idle; it is the restart path's counterpart to the `add_node` retry.
 */
export async function waitForApp(node: ClusterNode, timeoutMs = 180_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const response = await fetch(`${node.httpURL}/rig`, { headers: { Cookie: 'bucket=readiness' } });
			// Any complete HTTP response means the app is listening; the status itself is the tests' business.
			if (response.ok) {
				await response.arrayBuffer();
				return;
			}
		} catch {
			// Not up yet: connection refused, or reset part-way through the response.
		}
		if (Date.now() >= deadline) throw new Error(`${node.name} did not serve the app within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

export async function restartNode(node: ClusterNode): Promise<void> {
	docker(['restart', node.name]);
	await waitForNode(node);
	await waitForApp(node);
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
