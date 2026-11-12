import { get } from 'node:http';
import { connect } from 'node:http2';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-ppr', { http: { http2: true, mtls: false } });

const SECURE_PORT = 9927;
// Matches DYNAMIC_DELAY_MS in fixtures/next-16-ppr/app/ppr/page.js.
const DYNAMIC_DELAY_MS = 3000;
const SHELL_MARKER = 'ppr-static-shell';
const DYNAMIC_MARKER = 'ppr-dynamic-content:';

interface StreamTimeline {
	status: number;
	headers: Record<string, unknown>;
	shellAtMs?: number;
	dynamicAtMs?: number;
}

function timeMarkers(
	status: number,
	headers: Record<string, unknown>,
	body: Readable,
	startedAt: number
): Promise<StreamTimeline> {
	const timeline: StreamTimeline = { status, headers };
	const decoded = headers['content-encoding'] === 'gzip' ? body.pipe(createGunzip()) : body;
	let text = '';
	return new Promise((resolve, reject) => {
		decoded.on('data', (chunk: Buffer) => {
			text += chunk.toString();
			const elapsedMs = Date.now() - startedAt;
			if (timeline.shellAtMs === undefined && text.includes(SHELL_MARKER)) timeline.shellAtMs = elapsedMs;
			if (timeline.dynamicAtMs === undefined && text.includes(DYNAMIC_MARKER)) timeline.dynamicAtMs = elapsedMs;
		});
		decoded.on('end', () => resolve(timeline));
		decoded.on('error', reject);
		body.on('error', reject);
	});
}

function getHttp1(url: string, headers: Record<string, string>): Promise<StreamTimeline> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		get(url, { headers }, (response) => {
			timeMarkers(response.statusCode!, response.headers, response, startedAt).then(resolve, reject);
		}).on('error', reject);
	});
}

async function getHttp2(origin: string, path: string, headers: Record<string, string>): Promise<StreamTimeline> {
	const client = connect(origin, { rejectUnauthorized: false });
	try {
		const startedAt = Date.now();
		return await new Promise((resolve, reject) => {
			client.on('error', reject);
			const stream = client.request({ ':path': path, ...headers });
			stream.on('response', (received) => {
				timeMarkers(received[':status'] as number, received, stream, startedAt).then(resolve, reject);
			});
			stream.on('error', reject);
			stream.end();
		});
	} finally {
		client.close();
	}
}

const cases = [
	{ name: 'HTTP/1.1', encoding: 'identity' },
	{ name: 'HTTP/1.1', encoding: 'gzip' },
	{ name: 'HTTP/2', encoding: 'identity' },
	{ name: 'HTTP/2', encoding: 'gzip' },
];

for (const { name, encoding } of cases) {
	test(`streams the PPR static shell before the dynamic content over ${name} (${encoding})`, async ({ harper }) => {
		const headers = { accept: 'text/html', 'accept-encoding': encoding };
		const timeline =
			name === 'HTTP/2'
				? await getHttp2(`https://${harper.hostname}:${SECURE_PORT}`, '/ppr', headers)
				: await getHttp1(`${harper.httpURL}/ppr`, headers);

		expect(timeline.status).toBe(200);
		expect(timeline.headers['content-encoding']).toBe(encoding === 'gzip' ? 'gzip' : undefined);
		expect(timeline.headers['x-nextjs-postponed']).toBe('1');
		expect(timeline.shellAtMs).toBeDefined();
		expect(timeline.dynamicAtMs).toBeDefined();
		// A gap, not an absolute bound on the shell: the first request can be slow to start, but a
		// buffered response would deliver both markers together.
		expect(timeline.dynamicAtMs! - timeline.shellAtMs!).toBeGreaterThanOrEqual(DYNAMIC_DELAY_MS / 2);
	});
}

test('client navigation to a PPR route renders its dynamic content', async ({ page, harper }) => {
	const failures: string[] = [];
	page.on('response', (response) => {
		if (response.url().includes('/ppr') && response.status() >= 500) {
			failures.push(`${response.status()} ${response.url()}`);
		}
	});

	await page.goto(harper.httpURL);
	await page.getByRole('link', { name: 'PPR page' }).click();

	await expect(page.getByTestId('shell')).toHaveText(SHELL_MARKER);
	await expect(page.getByTestId('dynamic')).toContainText(DYNAMIC_MARKER, { timeout: DYNAMIC_DELAY_MS * 3 });
	expect(failures).toEqual([]);
});
