// Namespace import, not `import { flushDatabases }`. Harper loads components through a sandboxed VM
// loader where `harper` is a SyntheticModule built from a hardcoded allowlist (getHarperExports in
// harper's security/jsLoader.ts). `flushDatabases` is a documented package export but is not on that
// allowlist, so a named import fails at *link* time with "does not provide an export named
// 'flushDatabases'" — fatal, taking the whole plugin down. A namespace import always links; the
// property is simply undefined where it isn't exposed, which runNextBuild handles.
//
// It *is* defined under `applications.moduleLoader: native`, which bypasses the VM loader and resolves
// the real package. So this has to work both ways, not just on the default loader.
import * as harper from 'harper';
import type { Scope, Config, FilesOption } from 'harper';

import { createRequire } from 'node:module';
import { parse as urlParse } from 'node:url';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { withBuildLock } from './buildLock.js';

import type NextModule14 from 'next-14';
import type NextBuildModule14 from 'next-14/dist/cli/next-build.d.ts';

import type NextModule15 from 'next-15';
import type NextBuildModule15 from 'next-15/dist/cli/next-build.d.ts';

import type NextModule16 from 'next-16';
import type NextBuildModule16 from 'next-16/dist/cli/next-build.d.ts';

type Bundler = 'webpack' | 'turbopack';

interface NextPluginConfig extends Config {
	buildOnly: boolean;
	bundler: Bundler;
	dev: boolean;
	// @ts-expect-error
	files?: FilesOption;
	port?: number;
	prebuilt: boolean;
	runFirst: boolean;
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
	if (options === null || Array.isArray(options) || typeof options !== 'object') {
		throw new Error('@harperfast/nextjs plugin options should be a regular object');
	}

	// Environment Variables take precedence
	switch (process.env.HARPER_NEXTJS_MODE) {
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

	assertType('buildOnly', options.buildOnly, 'boolean');
	assertType('bundler', options.bundler, 'string');
	assertType('dev', options.dev, 'boolean');
	assertType('port', options.port, 'number');
	assertType('prebuilt', options.prebuilt, 'boolean');
	assertType('runFirst', options.runFirst, 'boolean');
	assertType('securePort', options.securePort, 'number');

	if (options.bundler && options.bundler !== 'webpack' && options.bundler !== 'turbopack') {
		throw new Error(`bundler must be "webpack" or "turbopack". Received: "${options.bundler}"`);
	}

	// TODO: Remove type casts when we have more proper plugin option validation from core
	return {
		buildOnly: (options.buildOnly as boolean) ?? false,
		// bundler default is set later in handleApplication() based on the detected Next.js version
		bundler: options.bundler as Bundler,
		dev: (options.dev as boolean) ?? false,
		// @ts-expect-error
		files: options.files,
		port: options.port as number,
		prebuilt: (options.prebuilt as boolean) ?? false,
		runFirst: (options.runFirst as boolean) ?? false,
		securePort: options.securePort as number,
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
		dependencyExists = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
			(dependencyList) => packageJSON[dependencyList]?.['next']
		);
	}

	if (!configExists && !dependencyExists) {
		logger.fatal?.(
			`Failed to verify ${appName} application as a Next.js project. It is missing both a Next.js config file and the "next" dependency in package.json`
		);

		return false;
	}

	return true;
}

/**
 * Safely attempts to read the `.next/BUILD_ID`.
 *
 * Returns `null` if it does not exist (empty BUILD_ID file or file does not exist)
 */
function getBuildId(scope: Scope) {
	const buildIdPath = join(scope.directory, '.next', 'BUILD_ID');
	try {
		const buildId = readFileSync(buildIdPath, 'utf-8').trim();
		return buildId || null;
	} catch (error) {
		// Ignore ENOENT errors (.next/BUILD_ID does not exist)
		// @ts-expect-error
		if (error.code === 'ENOENT') {
			return null;
		}
		// Otherwise rethrow error
		throw error;
	}
}

export async function handleApplication(scope: Scope) {
	scope.logger.debug?.(`Handling Next.js Application ${scope.appName} as ${scope.directory}`);
	const config = resolveConfig(scope);

	// TODO: delegate asserting the app to the Next.js build/server functions instead.
	if (!assertNextApp(scope)) {
		return;
	}

	// The original idea here was to use the file change detection mechanism to make rebuilds smarter.
	// Specifically, if the plugin detects application file changes, then it should rebuild immediately
	// and _then_ restart the threads. This would then let the user skip building after threads restart.
	// Unfortunately, with the time based mechanism below I don't think this is as deterministic and must
	// be thought through again. Additionally this was not as simple as originally thought. Unless the user
	// knows to finely tune the `files` option, what exactly should Harper watch automatically? Surely not
	// _everything_ in an application directory. Including things like `node_modules` would be impossible too.
	// So just leave this artifact here for a future feature improvement.

	// // If files for the next.js app change, we want to mark the build as stale and request a restart
	// // this way when the threads restart, and see the existing `.next/BUILD_ID` file, they will still rebuild the app.
	// async function entryHandler (entry: FileEntryEvent | DirectoryEntryEvent) {
	// 	scope.logger.debug?.(`Entry Handler called`, entry)
	// 	await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, { buildId: null, status: 'stale' });
	// 	scope.requestRestart();
	// }

	// if (config.files) {
	// 	// If the user specified files then use the default handler
	// 	scope.handleEntry(entryHandler);
	// } else {
	// 	// Otherwise define our own.
	// 	scope.handleEntry({
	// 		source: '**/*',
	// 		ignore: ['.next/**/*', 'node_modules/**/*']
	// 	}, entryHandler);
	// }

	const next = importNext(scope);

	// Set the bundler default based on the detected Next.js version if not explicitly configured.
	// Next.js v16 defaults to turbopack; v14 and v15 default to webpack.
	if (!config.bundler) {
		config.bundler = next.version >= 16 ? 'turbopack' : 'webpack';
	}

	if (config.bundler === 'turbopack' && next.version === 14) {
		scope.logger.error?.('Turbopack is not supported for Next.js v14. Falling back to webpack.');
		config.bundler = 'webpack';
	}

	scope.logger.debug?.(`Detected Next.js version: ${next.version}`);

	if (config.prebuilt) {
		// TODO: implement record check to skip-over following checks
		// get record by appName
		// - if it exists && within 500ms(?)
		//   - if success goto serve
		//   - if failure log and return early
		//   - if stale ??? (how do we get here?) (maybe with time-based we don't have stale anymore?)
		// - else continue with below logic
		//   - if valid, write success record and goto serve
		//   - if invalid, write failure record and log and return

		const nextDir = join(scope.directory, '.next');
		if (!existsSync(nextDir)) {
			scope.logger.error?.('Prebuilt mode is enabled, but the .next folder does not exist');
			return;
		}

		if (!existsSync(join(nextDir, 'BUILD_ID'))) {
			scope.logger.error?.('Prebuilt mode is enabled, but the .next/BUILD_ID file does not exist');
			return;
		}

		// In prebuilt mode, we still want to ensure the build is valid by checking for a `buildId`.
		// We shouldn't try serving (and failing) if we can detect a potentially bad build.
		// This is based on the assumption that a BUILD_ID file only exists for valid builds; not sure
		// if that is 100% true or if Next.js provides any other guarantees or validation mechanisms.
		const buildId = getBuildId(scope);
		// Immediately set the build info record appropriately
		await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, {
			buildId,
			status: buildId !== null ? 'success' : 'failure',
		});

		if (buildId === null) {
			return;
		}
	} else if (!config.dev) {
		// If not prebuilt mode and not dev mode, then proceed to building
		try {
			await build(scope, config, next);

			// In build only we can exit and return early here.
			if (config.buildOnly) {
				scope.logger.info?.('buildOnly mode is enabled, exiting');
				// TODO: should harper expose a like `scope.shutdown()` method or something that "safely" exits?
				process.exit(0);
			}
		} catch (error) {
			// if build fails for any reason
			// mark record as failure, log error, and return
			await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, { buildId: null, status: 'failure' });
			scope.logger.error?.(`Error building Next.js application ${scope.appName}: `, error);
			return;
		}
	}

	// Finally, serve the application
	await serve(scope, config, next);
}

async function build(scope: Scope, config: NextPluginConfig, next: NextPackage) {
	// Serialize builds across Harper worker threads (see buildLock.ts). `withBuildLock` decides whether
	// this worker builds, reuses a fresh build, or waits for a sibling; it only invokes `runBuild` (and
	// only on the one worker that wins the claim) when a build is actually needed.
	await withBuildLock(scope, {
		getBuildId: () => getBuildId(scope),
		runBuild: () => runNextBuild(scope, config, next),
	});
}

/** Runs `next build` for the detected Next.js version and returns the resulting BUILD_ID. */
async function runNextBuild(scope: Scope, config: NextPluginConfig, next: NextPackage): Promise<string> {
	// Next.js generates static pages using child processes and only a single process can open the
	// RocksDB databases, so force child processes to start Harper in read-only mode. Flush first
	// so child processes can see all committed data. Unset after the build so the server process
	// itself is not permanently locked into read-only mode.
	//
	// The flush is best-effort in both directions: it isn't reachable on every Harper build (see the
	// import comment), and it can fail on a transient storage error. Read-only children still open the
	// databases and replay the on-disk WAL, so a missing flush only risks them not seeing the most
	// recent writes — worth a warning, not worth failing the build. Nothing here may throw: this runs
	// before the try/finally below, so an escaping error would leave HARPER_READONLY set on a thread
	// that goes on serving requests.
	const prevHarperReadonly = process.env.HARPER_READONLY;
	process.env.HARPER_READONLY = 'true';
	if (harper.flushDatabases) {
		try {
			await harper.flushDatabases();
		} catch (error) {
			scope.logger.warn?.('Failed to flush databases before build; static pages may not see the most recent writes: ', error);
		}
	} else {
		scope.logger.warn?.(
			'harper.flushDatabases is unavailable, so the pre-build flush was skipped and statically generated pages ' +
				'may not see recently written data. Harper only exposes it to components under the native module ' +
				'loader; set `applications.moduleLoader: native` in harperdb-config.yaml to enable the flush, at the ' +
				'cost of per-application tagged logging and config.'
		);
	}

	// --expose-internals is set in Harper's worker execArgv but is not allowed in NODE_OPTIONS.
	// Next.js reads process.execArgv to forward flags to its own child workers via NODE_OPTIONS,
	// which causes Node to reject the build worker. Strip it before building and restore after.
	const exposeInternalsIdx = process.execArgv.indexOf('--expose-internals');
	if (exposeInternalsIdx !== -1) process.execArgv.splice(exposeInternalsIdx, 1);

	try {
		switch (next.version) {
			case 14:
				await next.build(
					{
						lint: false,
						mangling: true,
						experimentalDebugMemoryUsage: false,
						experimentalBuildMode: 'default',
					},
					scope.directory
				);
				break;
			case 15:
				await next.build(
					{
						lint: false,
						mangling: true,
						...(config.bundler === 'turbopack' && { turbopack: true }),
						experimentalDebugMemoryUsage: false,
						experimentalBuildMode: 'default',
					},
					scope.directory
				);
				break;
			case 16:
				await next.build(
					{
						mangling: true,
						...(config.bundler === 'webpack' && { webpack: true }),
						experimentalDebugMemoryUsage: false,
						experimentalBuildMode: 'default',
					},
					scope.directory
				);
				break;
		}

		// Read BUILD_ID directly (not via getBuildId) so a build that completed without one throws and is
		// recorded as a failure. Trim it so it matches getBuildId() in the lock's fresh-build check.
		const buildIdPath = join(scope.directory, '.next', 'BUILD_ID');
		return readFileSync(buildIdPath, 'utf-8').trim();
	} finally {
		if (prevHarperReadonly === undefined) {
			delete process.env.HARPER_READONLY;
		} else {
			process.env.HARPER_READONLY = prevHarperReadonly;
		}
		if (exposeInternalsIdx !== -1) process.execArgv.splice(exposeInternalsIdx, 0, '--expose-internals');
	}
}

async function serve(scope: Scope, config: NextPluginConfig, next: NextPackage) {
	scope.logger.debug?.(`Serving Next.js application at ${scope.directory}`);

	let app;
	switch (next.version) {
		case 14:
			app = next.server({ dir: scope.directory, dev: config.dev });
			break;
		case 15:
			app = next.server({ dir: scope.directory, dev: config.dev, ...(config.bundler === 'turbopack' && { turbopack: true }) });
			break;
		case 16:
			app = next.server({ dir: scope.directory, dev: config.dev, ...(config.bundler === 'webpack' && { webpack: true }) });
			break;
	}

	await app.prepare();

	const requestHandler = app.getRequestHandler();

	scope.server?.http?.(
		(request, next) => {
			// `== null`, not `=== undefined`: Harper's Bun and uWS requests carry a null `_nodeResponse`,
			// and neither implements the Node adapter used below.
			if (request._nodeResponse == null) return next(request);
			// Harper's router strips an application's urlPath mount by proxying the Harper `Request`, so the
			// Node request underneath it still carries the un-stripped URL. Only a request some middleware
			// rewrote needs the adapter, which presents the Request's own method/url/headers over that Node
			// request; anything else keeps the direct hand-off.
			if (request.url === request._nodeRequest.url) {
				// @ts-expect-error - Not sure when the IncomingMessage.url could be undefined ; need to dig into it.
				return requestHandler(request._nodeRequest, request._nodeResponse, urlParse(request._nodeRequest.url, true));
			}
			return request
				.withNodeAdapter((nodeRequest, nodeResponse) =>
					// @ts-expect-error - Not sure when the IncomingMessage.url could be undefined ; need to dig into it.
					requestHandler(nodeRequest, nodeResponse, urlParse(nodeRequest.url, true))
				)
				.then((response) => {
					// Required by withNodeAdapter: a connection reset after the headers are sent destroys this
					// stream with an error, which Node throws as an uncaught exception without a listener.
					response.body.on('error', (error) =>
						scope.logger.debug?.(`Next.js response stream error for ${request.pathname}: `, error)
					);
					return response;
				});
		},
		{ runFirst: config.runFirst, port: config.port, securePort: config.securePort }
	);

	// Early Next.js versions don't have an upgrade handler
	if (config.dev && app.getUpgradeHandler) {
		const upgradeHandler = app.getUpgradeHandler();
		scope.server?.upgrade?.(
			async (request, socket, head, next) => {
				if (request.url === '/_next/webpack-hmr') {
					// Next.js v13+ upgradeHandler implementations return promises
					await upgradeHandler(request._nodeRequest, socket, head);
					request.__harperRequestUpgraded = true;
					return await next(request, socket, head);
				}

				return next(request, socket, head);
			},
			// Okay to set `runFirst: true` here since this has a strict match on `/_next/webpack-hmr`
			{ runFirst: true, port: config.port, securePort: config.securePort }
		);
	}
}

interface Next14 {
	version: 14;
	server: typeof NextModule14.default;
	build: typeof NextBuildModule14.nextBuild;
}

interface Next15 {
	version: 15;
	server: typeof NextModule15.default;
	build: typeof NextBuildModule15.nextBuild;
}

interface Next16 {
	version: 16;
	server: typeof NextModule16.default;
	build: typeof NextBuildModule16.nextBuild;
}

type NextPackage = Next14 | Next15 | Next16;

// This function imports the Next.js version specified by the application
function importNext(scope: Scope): NextPackage {
	const require = createRequire(join(scope.directory, 'package.json'));
	const nextPackage = require('next/package.json');
	const version = parseInt(nextPackage.version.split('.')[0], 10);
	if (version !== 14 && version !== 15 && version !== 16) {
		throw new Error(
			`Unsupported Next.js version detected: ${nextPackage.version}. The \`@harperfast/nextjs\` plugin only supports Next.js versions: 14, 15, 16`
		);
	}
	// The default export is the `createServer` function
	const server = require('next');
	// Use the `nextBuild` method
	const build = require('next/dist/cli/next-build.js').nextBuild;
	return { server, build, version };
}
