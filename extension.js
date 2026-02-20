/* eslint-env node */
/* global logger */

import { existsSync, statSync, readFileSync, openSync, writeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as urlParse } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

class HarperDBNextJSExtensionError extends Error {}

/**
 * @typedef {Object} ExtensionOptions - The configuration options for the extension. These are all configurable via `config.yaml`.
 * @property {string=} buildCommand - A custom build command. Default to `next build`.
 * @property {string=} buildOnly - Build the Next.js app and exit. Defaults to `false`.
 * @property {boolean=} dev - Enable dev mode. Defaults to `false`.
 * @property {number=} port - A port for the Next.js server. Defaults to the HarperDB HTTP Port.
 * @property {boolean=} prebuilt - Instruct the extension to skip executing the `buildCommand`. Defaults to `false`.
 * @property {number=} securePort - A (secure) port for the https Next.js server. Defaults to the HarperDB HTTP Secure Port.
 */

/**
 * Assert that a given option is a specific type, if it is defined.
 *
 * @param {string} name The name of the option
 * @param {any=} option The option value
 * @param {string} expectedType The expected type (i.e. `'string'`, `'number'`, `'boolean'`, etc.)
 */
function assertType(name, option, expectedType) {
	if (option && typeof option !== expectedType) {
		throw new HarperDBNextJSExtensionError(`${name} must be type ${expectedType}. Received: ${typeof option}`);
	}
}

// loggerWithTag is kinda weird as it will set log methods like `.debug()` to `null`
// based on the configuerd log level. So now all calls to these log methods need to use `?.()`
// like `extensionLogger.debug?.('whoops!');`.
// This should be fixed when we migrate to plugin api.
const extensionLogger = logger.loggerWithTag('@harperdb/nextjs', true);

/**
 * Resolves the incoming extension options into a config for use throughout the extension.
 *
 * @param {ExtensionOptions} options - The options object to be resolved into a configuration
 * @returns {Required<ExtensionOptions>}
 */
function resolveConfig(options) {
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

	extensionLogger.debug?.('configuration:\n' + JSON.stringify(config, undefined, 2));

	return config;
}

/**
 * This function verifies if the input is a Next.js app through a couple of
 * verification methods. See the implementation for details.
 *
 * @param {string} componentPath
 * @returns {string} The path to the Next.js main file
 */
function assertNextJSApp(componentPath) {
	extensionLogger.debug?.(`Verifying ${componentPath} is a Next.js application`);

	try {
		if (!existsSync(componentPath)) {
			throw new HarperDBNextJSExtensionError(`The folder ${componentPath} does not exist`);
		}

		if (!statSync(componentPath).isDirectory) {
			throw new HarperDBNextJSExtensionError(`The path ${componentPath} is not a folder`);
		}

		// Couple options to check if its a Next.js project
		// 1. Check for Next.js config file (next.config.{js|mjs|ts})
		//    - This file is not required for a Next.js project
		// 2. Check package.json for Next.js dependency
		//    - It could be listed in `dependencies` or `devDependencies` (and maybe even `peerDependencies` or `optionalDependencies`)
		//    - Also not required. Users can use `npx next ...`
		// 3. Check for `.next` folder
		//    - This could be a reasonable fallback if we want to support pre-built Next.js apps

		// A combination of options 1 and 2 should be sufficient for our purposes.
		// Edge case: app does not have a config and are using `npx` (or something similar) to execute Next.js

		// Check for Next.js Config
		const configExists = ['js', 'mjs', 'ts'].some((ext) => existsSync(join(componentPath, `next.config.${ext}`)));

		// Check for dependency
		let dependencyExists = false;
		const packageJSONPath = join(componentPath, 'package.json');
		if (existsSync(packageJSONPath)) {
			const packageJSON = JSON.parse(readFileSync(packageJSONPath));
			for (let dependencyList of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
				if (packageJSON[dependencyList]?.['next']) {
					dependencyExists = true;
				}
			}
		}

		if (!configExists && !dependencyExists) {
			throw new HarperDBNextJSExtensionError(
				`Could not determine if ${componentPath} is a Next.js project. It is missing both a Next.js config file and the "next" dependency in package.json`
			);
		}
	} catch (error) {
		if (error instanceof HarperDBNextJSExtensionError) {
			extensionLogger.fatal?.(`Component path is not a Next.js application: ` + error.message);
		} else {
			extensionLogger.fatal?.(`Unexpected Error thrown during Next.js Verification: ` + error.toString());
		}

		throw error;
	}
}

/**
 *
 * @param {ExtensionOptions} options
 * @returns
 */
export function startOnMainThread(options = {}) {
	const config = resolveConfig(options);

	return {
		async setupDirectory(_, componentPath) {
			assertNextJSApp(componentPath);

			if (config.setCwd) {
				// Some Next.js apps will include cwd relative operations throughout the application (generally in places like `next.config.js`).
				// So set the cwd to the component path by default.
				process.chdir(componentPath);
			}

			if (config.buildOnly) {
				await build(config, componentPath, options.server);
				extensionLogger.info?.('build only mode is enabled, exiting');
				process.exit(0);
			}

			return true;
		},
	};
}

/**
 * This method is executed on each worker thread, and is responsible for
 * returning a Resource Extension that will subsequently be executed on each
 * worker thread.
 *
 * The Resource Extension is responsible for creating the Next.js server, and
 * hooking into the global HarperDB server.
 *
 * @param {ExtensionOptions} options
 * @returns
 */
export function start(options = {}) {
	const config = resolveConfig(options);
	return {
		async handleDirectory(_, componentPath) {
			// Assert the component path is a Next.js app. This will throw if it is not.
			assertNextJSApp(componentPath);

			// Setup (build) the component.

			// Prebuilt mode requires validating the `.next` directory exists
			if (config.prebuilt && !existsSync(join(componentPath, '.next'))) {
				throw new HarperDBNextJSExtensionError('Prebuilt mode is enabled, but the .next folder does not exist');
			}

			// In non prebuilt or dev modes, build the Next.js app.
			// This only needs to happen once, on a single thread.
			// All threads need to wait for this to complete.
			if (!config.prebuilt && !config.dev) {
				await build(config, componentPath, options.server);
			}

			// Start the Next.js server
			await serve(config, componentPath, options.server);

			return true;
		},
	};
}

/**
 * Build the Next.js application located at `componentPath`.
 * Uses a lock file to ensure only one thread builds the application.
 *
 * @param {Required<ExtensionOptions>} config
 * @param {string} componentPath
 * @param {unknown} server
 */
async function build(config, componentPath, server) {
	// Theoretically, all threads should have roughly the same start time
	const startTime = Date.now();
	const buildLockPath = join(tmpdir(), '.harperdb-nextjs-build.lock');

	while (true) {
		try {
			// Open lock
			const buildLockFD = openSync(buildLockPath, 'wx');
			writeSync(buildLockFD, process.pid.toString());
		} catch (error) {
			if (error.code === 'EEXIST') {
				try {
					// Check if the lock is stale
					if (statSync(buildLockPath).mtimeMs < startTime - 100) {
						// The lock was created before (with a 100ms tolerance) any of the threads started building.
						// Safe to consider it stale and remove it.
						unlinkSync(buildLockPath);
					}
				} catch (error) {
					if (error.code === 'ENOENT') {
						// The lock was removed by another thread.
						continue;
					}

					throw error;
				}

				// Wait for a second and try again
				await setTimeout(1000);
				continue;
			}

			throw error;
		}

		try {
			// Check if the .next/BUILD_ID file is fresh
			if (statSync(join(componentPath, '.next', 'BUILD_ID')).mtimeMs > startTime) {
				unlinkSync(buildLockPath);
				break;
			}
		} catch (error) {
			// If the build id file does not exist, continue to building
			if (error.code !== 'ENOENT') {
				// All other errors should be thrown
				throw error;
			}
		}

		// Build
		try {
			extensionLogger.info?.(`Building Next.js application at ${componentPath}`);

			const timerStart = performance.now();

			const stdout = [];
			const stderr = [];

			const buildProcess = spawn(config.buildCommand, [], {
				shell: true,
				cwd: componentPath,
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			const stdoutLogger = logger.loggerWithTag('@harperdb/nextjs:build:stdout', true);
			const stderrLogger = logger.loggerWithTag('@harperdb/nextjs:build:stderr', true);

			buildProcess.stdout.on('data', (c) => {
				stdout.push(c);
				const chunk = c.toString().trim();
				chunk.split('\n').forEach((line) => {
					stdoutLogger.debug?.(line.trim());
				});
			});
			buildProcess.stderr.on('data', (c) => {
				stderr.push(c);
				const chunk = c.toString().trim();
				chunk.split('\n').forEach((line) => {
					stderrLogger.debug?.(line.trim());
				});
			});

			const [code, signal] = await once(buildProcess, 'close');

			const duration = performance.now() - timerStart;

			if (code !== 0) {
				logger.warn(`Build command \`${config.buildCommand}\` exited with code ${code} and signal ${signal}`);
			}

			// If debug method isn't defined then the debug logs above didn't run (based on log level)
			// So now print out the collected stdout and stderr to info and error respectively.
			// This extension has been logging this out from the beginning so we should maintain that, but
			// we don't need to double up the same logs.
			if (!extensionLogger.debug) {
				if (stdout.length > 0) {
					extensionLogger.info?.(Buffer.concat(stdout).toString());
				}

				if (stderr.length > 0) {
					extensionLogger.error?.(Buffer.concat(stderr).toString());
				}
			}

			extensionLogger.info?.(`The Next.js build took ${((duration % 60000) / 1000).toFixed(2)} seconds`);
			server.recordAnalytics(
				duration,
				'nextjs_build_time_in_milliseconds',
				componentPath.toString().slice(0, -1).split('/').pop()
			);
		} catch (error) {
			extensionLogger.error?.(error);
		}

		// Release lock and exit
		unlinkSync(buildLockPath);
		break;
	}
}

/**
 * Serve the Next.js application located at `componentPath`.
 * The app must be built before calling this function.
 *
 * @param {Required<ExtensionOptions>} config
 * @param {string} componentPath
 */
async function serve(config, componentPath, server) {
	const componentRequire = createRequire(join(componentPath, 'package.json'));

	const next = (await import(pathToFileURL(componentRequire.resolve('next')))).default;

	const app = next({ dir: componentPath, dev: config.dev });

	await app.prepare();

	const requestHandler = app.getRequestHandler();

	server.http(
		(request, next) => {
			return request._nodeResponse === undefined
				? next(request)
				: requestHandler(request._nodeRequest, request._nodeResponse, urlParse(request._nodeRequest.url, true));
		},
		{ port: config.port, securePort: config.securePort }
	);

	// Next.js v9 doesn't have an upgrade handler
	if (config.dev && app.getUpgradeHandler) {
		const upgradeHandler = app.getUpgradeHandler();
		server.upgrade(
			(request, socket, head, next) => {
				if (request.url === '/_next/webpack-hmr') {
					// Next.js v13 - v15 upgradeHandler implementations return promises
					return upgradeHandler(request, socket, head).then(() => {
						request.__harperdbRequestUpgraded = true;

						return next(request, socket, head);
					});
				}

				return next(request, socket, head);
			},
			{ runFirst: true, port: config.port, securePort: config.securePort }
		);
	}
}
