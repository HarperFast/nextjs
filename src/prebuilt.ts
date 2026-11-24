import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function prebuiltBuildId(directory: string): string {
	const nextDir = join(directory, '.next');
	if (!existsSync(nextDir)) {
		throw new Error(
			`Prebuilt mode is enabled, but ${nextDir} does not exist. Run \`next build\` before deploying, and deploy its .next folder with the app`
		);
	}
	const buildIdPath = join(nextDir, 'BUILD_ID');
	let buildId: string;
	try {
		buildId = readFileSync(buildIdPath, 'utf-8').trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		throw new Error(`Prebuilt mode is enabled, but ${buildIdPath} does not exist, so the .next folder holds no finished build`);
	}
	if (!buildId) throw new Error(`Prebuilt mode is enabled, but ${buildIdPath} is empty, so the .next folder holds no finished build`);
	return buildId;
}
