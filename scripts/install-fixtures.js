#!/usr/bin/env node

import { readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
	.map((entry) => entry.name);

for (const fixture of fixtures) {
	console.log(`Installing ${fixture} dependencies...`);
	const fixtureDir = join(fixturesDir, fixture);

	// `--install-links` copies `file:../..` instead of symlinking it, so the fixture holds a snapshot
	// of the plugin rather than a live view. npm considers that snapshot to satisfy the tree and
	// restores it from its cache on reinstall, so a rebuilt `dist/` never reaches the fixture and
	// tests silently run stale plugin code. Dropping the copy *and* npm's hidden lockfile forces a
	// fresh one — without removing `.package-lock.json` npm just re-extracts the cached version.
	rmSync(join(fixtureDir, 'node_modules', '@harperfast'), { recursive: true, force: true });
	rmSync(join(fixtureDir, 'node_modules', '.package-lock.json'), { force: true });

	spawnSync('npm', ['install', '--install-links'], {
		cwd: fixtureDir,
		stdio: 'inherit',
	});
	console.log('\n');
}
