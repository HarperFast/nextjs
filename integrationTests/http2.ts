import { connect } from 'node:http2';
import { gunzipSync } from 'node:zlib';

export const SECURE_PORT = 9927;

export async function getHttp2(origin: string, path: string, headers: Record<string, string> = {}) {
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

export function decode(response: { headers: Record<string, any>; body: Buffer }): string {
	return (response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body).toString();
}
