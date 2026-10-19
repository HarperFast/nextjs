import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { release } from '../release.mjs';

export const revalidate = 3600;

export default async function Page() {
	const gate = process.env.HARPER_NEXTJS_CACHE_GATE;
	if (gate && existsSync(join(gate, 'hold'))) {
		await writeFile(join(gate, 'entered'), release);
		while (!existsSync(join(gate, 'release'))) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return <main><h1 data-release>{release}</h1><p data-nonce>{randomUUID()}</p></main>;
}
