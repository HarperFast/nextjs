import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The BUILD_ID of the prebuilt `.next` in `directory`, which `prebuilt: true` serves. Throws, naming what is missing,
 * when there is no build to serve: a deploy that ships the app without its `.next`, such as one from a CI job that
 * did not download the build, or a build that did not finish.
 */
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
