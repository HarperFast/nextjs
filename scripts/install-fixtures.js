#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
	.map((entry) => entry.name);

for (const fixture of fixtures) {
	console.log(`Installing ${fixture} dependencies...`);
	spawnSync('npm', ['install', '--install-links'], {
		cwd: join(fixturesDir, fixture),
		stdio: 'inherit',
	});
	console.log('\n');
}
