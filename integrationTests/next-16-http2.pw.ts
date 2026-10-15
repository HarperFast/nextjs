import { connect } from 'node:http2';
import { gunzipSync } from 'node:zlib';
import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16', { http: { http2: true, mtls: false } });

const SECURE_PORT = 9927;

async function getHttp2(origin: string, path: string, headers: Record<string, string> = {}) {
	const client = connect(origin, { rejectUnauthorized: false });
	try {
		return await new Promise<{ status: number; headers: Record<string, any>; body: Buffer }>((resolve, reject) => {
			client.on('error', reject);
			const stream = client.request({ ':path': path, ...headers });
			const chunks: Buffer[] = [];
			let responseHeaders: Record<string, any> = {};
			stream.on('response', (received) => (responseHeaders = received));
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('end', () =>
				resolve({ status: responseHeaders[':status'], headers: responseHeaders, body: Buffer.concat(chunks) })
			);
			stream.on('error', reject);
			stream.end();
		});
	} finally {
		client.close();
	}
}

function decode(response: { headers: Record<string, any>; body: Buffer }): string {
	return (response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body).toString();
}

test('home page renders over HTTP/2', async ({ harper }) => {
	const response = await getHttp2(`https://${harper.hostname}:${SECURE_PORT}`, '/', {
		accept: 'text/html',
		'accept-encoding': 'gzip',
	});
	expect(response.status).toBe(200);
	expect(response.headers['content-encoding']).toBe('gzip');
	expect(decode(response)).toContain('Next.js v16');
});

test('static assets are served over HTTP/2', async ({ harper }) => {
	const origin = `https://${harper.hostname}:${SECURE_PORT}`;
	const page = decode(await getHttp2(origin, '/', { accept: 'text/html' }));
	const asset = page.match(/\/_next\/static\/[^"]+\.js/)?.[0];
	expect(asset).toBeTruthy();

	const response = await getHttp2(origin, asset!, { 'accept-encoding': 'gzip' });
	expect(response.status).toBe(200);
	expect(decode(response).length).toBeGreaterThan(0);
});

test('HTTP/1.1 on the same secure port is unaffected', async ({ request, harper }) => {
	const response = await request.get(`https://${harper.hostname}:${SECURE_PORT}/`, { ignoreHTTPSErrors: true });
	expect(response.status()).toBe(200);
	expect(await response.text()).toContain('Next.js v16');
});
