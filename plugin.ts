import { ConfigValue, Scope, type Config } from 'harperdb';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type NextModule from 'next';
import { cwd } from 'node:process';
import { equal, notEqual, ok } from 'node:assert/strict';

interface NextPluginOptions extends Config {
	buildCommand?: string;
	buildOnly?: boolean;
	dev?: boolean;
	port?: number;
	prebuilt?: boolean;
	securePort?: number; 
}

function assertType<E extends 'string' | 'number' | 'boolean', R = E extends 'string' ? string : E extends 'number' ? number : boolean>(name: string, option: unknown, expectedType: E): asserts option is R {
	equal(typeof option, expectedType);
}

function assertObject(variable: unknown): asserts variable is object {
	equal(typeof variable, 'object');
}

function resolveConfig(options: ConfigValue, logger: any) {
	// Todo; what if no options specified? Is that `null` or `undefined`? How does yaml parser handle that.
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

	const config = {
		buildCommand: options.buildCommand ?? 'npx next build',
		buildOnly: options.buildOnly ?? false,
		dev: options.dev ?? false,
		port: options.port,
		prebuilt: options.prebuilt ?? false,
		securePort: options.securePort,
		setCwd: options.setCwd ?? false,
	};

	logger.debug('@harperdb/nextjs extension configuration:\n' + JSON.stringify(config, undefined, 2));

	return config;
}

export async function handleApplication(scope: Scope) {
	const options = scope.options.getAll();
	const config = resolveConfig(options, scope.logger);
	const { next, version } = await importNext(scope.directory);

	console.log(version);
	console.log(typeof next);
}

function detectNextVersion(componentPath: string): number {
  const require = createRequire(join(componentPath, 'package.json'));
  const nextPackage = require('next/package.json');
  return parseInt(nextPackage.version.split('.')[0], 10);
}

async function importNext(componentPath: string) {
  const require = createRequire(join(componentPath, 'package.json'));
  const nextPath = pathToFileURL(require.resolve('next'));
  const nextModule = await import(nextPath.href);
  const next = nextModule.default as typeof NextModule.default;
  return { next, version: detectNextVersion(componentPath) };
}

function serve () {

}

// @ts-expect-error
handleApplication({ directory: cwd() });