import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prebuiltBuildId } from './prebuilt.js';

describe('prebuiltBuildId', () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'nextjs-prebuilt-'));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it('throws when the app was deployed without its .next folder', () => {
		assert.throws(() => prebuiltBuildId(directory), /Prebuilt mode is enabled, but .*\.next does not exist/);
	});

	it('throws when .next holds no BUILD_ID, as after a build that did not finish', async () => {
		await mkdir(join(directory, '.next'));
		assert.throws(() => prebuiltBuildId(directory), /BUILD_ID does not exist/);
	});

	it('throws when BUILD_ID is empty', async () => {
		await mkdir(join(directory, '.next'));
		await writeFile(join(directory, '.next', 'BUILD_ID'), '\n');
		assert.throws(() => prebuiltBuildId(directory), /BUILD_ID is empty/);
	});

	it('returns the build ID of a finished build', async () => {
		await mkdir(join(directory, '.next'));
		await writeFile(join(directory, '.next', 'BUILD_ID'), 'abc123\n');
		assert.strictEqual(prebuiltBuildId(directory), 'abc123');
	});
});
