import type { Scope, Config, FilesOption } from 'harper';

import { createRequire } from 'node:module';
import { parse as urlParse } from 'node:url';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';


import type NextModule14 from 'next-14';
import type NextBuildModule14 from 'next-14/dist/cli/next-build.d.ts';

import type NextModule15 from 'next-15';
import type NextBuildModule15 from 'next-15/dist/cli/next-build.d.ts';

import type NextModule16 from 'next-16';
import type NextBuildModule16 from 'next-16/dist/cli/next-build.d.ts';


interface NextPluginConfig extends Config {
	buildOnly: boolean;
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
	assertType('dev', options.dev, 'boolean');
	assertType('port', options.port, 'number');
	assertType('prebuilt', options.prebuilt, 'boolean');
	assertType('runFirst', options.runFirst, 'boolean');
	assertType('securePort', options.securePort, 'number');

	// TODO: Remove type casts when we have more proper plugin option validation from core
	return {
		buildOnly: options.buildOnly as boolean ?? false,
		dev: options.dev as boolean ?? false,
		// @ts-expect-error
		files: options.files,
		port: options.port as number,
		prebuilt: options.prebuilt as boolean ?? false,
		runFirst: options.runFirst as boolean ?? false,
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
		if (error.code !== 'ENOENT') {
			return null;
		}
		// Otherwise rethrow error
		throw error;
	}
}


export async function handleApplication(scope: Scope) {
	scope.logger.debug?.(`Handling Next.js Application ${scope.appName} as ${scope.directory}`);
	const config = resolveConfig(scope);

	// TODO: delegate this to the Next.js build/server functions instead.
	if (!assertNextApp(scope)) {
		return;
	}

	// Initialize the build info as stale.
	// await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, { buildId: null, status: 'stale' });

	// Figure out what to do with this with the new build info table
	// if (config.buildOnly) {
	// 	await build(scope, config);
	// 	scope.logger.info?.('buildOnly mode is enabled, exiting');
	// 	process.exit(0);
	// }

	// Need to figure this out better.
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
		await databases.harperfast_nextjs.nextjs_build_info.put(
			scope.appName, { buildId, status: buildId !== null ? 'success' : 'failure' });

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
	const buildInfo = await databases.harperfast_nextjs.nextjs_build_info.get(scope.appName);

	if (buildInfo && Date.now() - buildInfo.getUpdatedTime() < 5000) {
		// If the build info record is marked as "failure" just return immediately
		// avoids building (and failing) on every thread
		if (buildInfo.status === 'failure') {
			scope.logger.debug?.(`Failure build of ${scope.appName} detected`);
			return;
		}
		
		// If the build info record is marked as "success"
		if (buildInfo.status === 'success') {
			// then validate the BUILD_ID value
			const buildId = getBuildId(scope);
			if (buildId === buildInfo.buildId) {
				scope.logger.debug?.(`Fresh build of ${scope.appName} (id: ${buildInfo.buildId}) detected`);
				// fresh build
				return;
			}
		}
	}

	// Otherwise we have a stale build (or no build info at all) and now we can proceed with building

	scope.logger.debug?.(`Building Next.js application at ${scope.directory}`);

	try {
		switch (next.version) {
			case 14:
				await next.build({
					lint: false,
					mangling: true,
					experimentalDebugMemoryUsage: false,
					experimentalBuildMode: 'default',
				}, scope.directory);
				break;
			case 15:
				await next.build({
					lint: false,
					mangling: true,
					turbopack: false,
					experimentalDebugMemoryUsage: false,
					experimentalBuildMode: 'default',
				}, scope.directory);
				break;
			case 16:
				await next.build({
					mangling: true,
					webpack: true,
					experimentalDebugMemoryUsage: false,
					experimentalBuildMode: 'default',
				}, scope.directory);
				break;
		}

		const buildIdPath = join(scope.directory, '.next', 'BUILD_ID');
		const buildId = readFileSync(buildIdPath, 'utf-8');
		// Update the build info record
		await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, { buildId, status: 'success' });
		scope.logger.debug?.(`Successful build for ${scope.appName} (id ${buildId})`);
		return;
	} catch (error) {
		await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, { buildId: null, status: 'failure' });
		scope.logger.debug?.(`Error building ${scope.appName}`)
		throw error;
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
			app = next.server({ dir: scope.directory, dev: config.dev, turbopack: false });
			break;
		case 16:
			app = next.server({ dir: scope.directory, dev: config.dev, turbopack: false });
			break;
	}

	await app.prepare();
	
	const requestHandler = app.getRequestHandler();

	scope.server?.http?.(
		(request, next) => {
			return request._nodeResponse === undefined
				? next(request)
				// @ts-expect-error - Not sure when the IncomingMessage.url could be undefined ; need to dig into it.
				: requestHandler(request._nodeRequest, request._nodeResponse, urlParse(request._nodeRequest.url, true));
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
	throw new Error(`Unsupported Next.js version detected: ${nextPackage.version}. The \`@harperfast/nextjs\` plugin only supports Next.js versions: 14, 15, 16`);
  }
  // The default export is the `createServer` function
  const server = require('next');
  // Use the `nextBuild` method
  const build = require('next/dist/cli/next-build.js').nextBuild;
  return { server, build, version };
}
