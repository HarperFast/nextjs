import { ConfigValue, Scope, type Config, type Logger } from 'harperdb';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type NextModule from 'next';
import { cwd } from 'node:process';
import { equal, notEqual, ok } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

interface NextPluginConfig extends Config {
	buildCommand?: string;
	buildOnly?: boolean;
	dev?: boolean;
	port?: number;
	prebuilt?: boolean;
	securePort?: number;
}

// Bringing this forward from extension since some validation is better than none.
// Eventually can remove when plugins have better option validation from core.
/**
 * Assert that a given option is a specific type, if it is defined.
 */
function assertType(name: string, option: unknown, expectedType: string): void {
	if (option && typeof option !== expectedType) {
		throw new Error(`${name} must be type ${expectedType}. Received: ${typeof option}`);
	}
}

/**
 * Validates and resolve plugin options with sensible defaults.
 */
function resolveConfig(scope: Scope): NextPluginConfig {
	const options = scope.options.getAll();
	// Todo; what if no options specified? Is that `null` or `undefined`? How does yaml parser handle that?
	// In theory this plugin could work with 0 config... assuming we allow that?
	// ```yaml
	// '@harperfast/next':
	//   package: '@harperfast/next'
	// ```
	if (options === null || Array.isArray(options) || typeof options !== 'object') {
		throw new Error('@harperfast/next plugin options should be a regular object');
	}

	// Environment Variables take precedence
	switch (process.env.HARPERDB_NEXTJS_MODE) {
		case 'dev':
			options.dev = true;
			break;
		case 'build':
			options.buildOnly = true;
			options.dev = false;
			options.prebuilt = false;
			break;
		case 'prod':
			options.dev = false;
			break;
		default:
			break;
	}

	assertType('buildCommand', options.buildCommand, 'string');
	assertType('buildOnly', options.buildOnly, 'boolean');
	assertType('dev', options.dev, 'boolean');
	assertType('port', options.port, 'number');
	assertType('prebuilt', options.prebuilt, 'boolean');
	assertType('securePort', options.securePort, 'number');

	// TODO: Remove type casts when we have more proper plugin option validation from core
	return {
		buildCommand: options.buildCommand as string ?? 'npx next build',
		buildOnly: options.buildOnly as boolean ?? false,
		dev: options.dev as boolean ?? false,
		port: options.port as number,
		prebuilt: options.prebuilt as boolean ?? false,
		securePort: options.securePort as number,
		setCwd: options.setCwd ?? false,
	} satisfies NextPluginConfig;
}

function assertNextApp({ appName, directory, logger }: Scope): boolean {
	logger.debug?.(`Verifying ${directory} is a Next.js application`);

	// Couple options to check if its a Next.js project
	// 1. Check for Next.js config file (next.config.{js|mjs|ts})
	//    - This file is not required for a Next.js project
	// 2. Check package.json for Next.js dependency
	//    - It could be listed in `dependencies` or `devDependencies` (and maybe even `peerDependencies` or `optionalDependencies`)
	//    - Also not required. Users can use `npx next ...`
	// 3. Check for `.next` folder
	//    - This could be a reasonable fallback if we want to support pre-built Next.js apps

	// A combination of options 1 and 2 should be sufficient for our purposes.
	// Known Edge case: app does not have a config and are using `npx` (or something similar) to execute Next.js

	// Check for Next.js Config
	const configExists = ['js', 'mjs', 'ts'].some((ext) => existsSync(join(directory, `next.config.${ext}`)));

	// Check for dependency
	let dependencyExists = false;
	const packageJSONPath = join(directory, 'package.json');
	if (existsSync(packageJSONPath)) {
		const packageJSON = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
		dependencyExists = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(dependencyList => packageJSON[dependencyList]?.['next']);
	}

	if (!configExists && !dependencyExists) {
		logger.fatal?.(
			`Failed to verify ${appName} application as a Next.js project. It is missing both a Next.js config file and the "next" dependency in package.json`
		);

		return false;
	}

	return true;
}

export async function handleApplication(scope: Scope) {
	const config = resolveConfig(scope);
	const { next, version } = await importNext(scope);

	scope.logger.debug?.('next version', version);
	scope.logger.debug?.('typeof next', typeof next);

	if (!assertNextApp(scope)) {
		return;
	}
}

function detectNextVersion(scope: Scope): number {
  const require = createRequire(join(scope.directory, 'package.json'));
  const nextPackage = require('next/package.json');
  return parseInt(nextPackage.version.split('.')[0], 10);
}

async function importNext(scope: Scope) {
  const require = createRequire(join(scope.directory, 'package.json'));
  const nextPath = pathToFileURL(require.resolve('next'));
  const nextModule = await import(nextPath.href);
  const next = nextModule.default as typeof NextModule.default;
  return { next, version: detectNextVersion(scope) };
}
