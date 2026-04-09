import type { Scope, Config, FilesOption } from 'harper';
import { createRequire } from 'node:module';
import { parse as urlParse } from 'node:url';
import { join } from 'node:path';
import type NextModule from 'next';
import type NextBuildModule from 'next-build';
import { existsSync, readFileSync } from 'node:fs';

type NextServer = typeof NextModule.default;
type NextBuild = typeof NextBuildModule.default;

interface NextPluginConfig extends Config {
	buildCommand: string;
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
	assertType('runFirst', options.runFirst, 'boolean');
	assertType('securePort', options.securePort, 'number');

	// TODO: Remove type casts when we have more proper plugin option validation from core
	return {
		buildCommand: options.buildCommand as string ?? 'npx next build',
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
	scope.logger.debug?.('appName', scope.appName);
	const config = resolveConfig(scope);

	// scope.logger.debug?.('Config: \n', JSON.stringify(config, undefined, 2))

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

	const next = await importNext(scope);

	scope.logger.debug?.('detected Next.js version', next.version);


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
			await build(scope, config, next.build);
		} catch (error) {
			// if build fails for any reason
			// mark record as failure, log error, and return
			await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, { buildId: null, status: 'failure' });
			scope.logger.error?.(`Error building Next.js application ${scope.appName}: `, error);
			return;
		}
	}

	await serve(scope, config, next.server);
}

async function build(scope: Scope, config: NextPluginConfig, nextBuild: NextBuild) {
	const buildInfo = await databases.harperfast_nextjs.nextjs_build_info.get(scope.appName);
	const now = Date.now();
	if (buildInfo) {
		scope.logger.debug?.('buildInfo', buildInfo);
		const updatedTime = buildInfo.getUpdatedTime()
		scope.logger.debug?.('buildInfo.getUpdatedTime()', updatedTime, now, now-updatedTime);
	}

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

	// Otherwise we have a stale build and now we can proceed with building

	scope.logger.info?.(`Building Next.js application at ${scope.directory}`);

	// const stdout: Buffer[] = [];
	// const stderr: Buffer[] = [];
	// const buildProcess = spawn(config.buildCommand, [], {
	// 	shell: true,
	// 	cwd: scope.directory,
	// 	stdio: ['ignore', 'pipe', 'pipe'],
	// });
	// const stdoutLogger = logger.withTag(`${scope.appName}:build:stdout`);
	// const stderrLogger = logger.withTag(`${scope.appName}:build:stderr`);
	// buildProcess.stdout.on('data', (c: Buffer) => {
	// 	stdout.push(c);
	// 	const chunk = c.toString().trim();
	// 	chunk.split('\n').forEach((line) => {
	// 		stdoutLogger.debug?.(line.trim());
	// 	});
	// });
	// buildProcess.stderr.on('data', (c: Buffer) => {
	// 	stderr.push(c);
	// 	const chunk = c.toString().trim();
	// 	chunk.split('\n').forEach((line) => {
	// 		stderrLogger.debug?.(line.trim());
	// 	});
	// });

	// const [code, signal] = await once(buildProcess, 'close');

	// If debug method isn't defined then the debug logs above didn't run (based on log level)
	// So now print out the collected stdout and stderr to info and error respectively.
	// This extension has been logging this out from the beginning so we should maintain that, but
	// we don't need to double up the same logs.
	// if (!scope.logger.debug) {
	// 	if (stdout.length > 0) {
	// 		scope.logger.info?.(Buffer.concat(stdout).toString());
	// 	}

	// 	if (stderr.length > 0) {
	// 		scope.logger.error?.(Buffer.concat(stderr).toString());
	// 	}
	// }

	// Any non 0 exit code is considered a failure
	// if (code !== 0) {
	// 	// Mark build info record as failure and return
	// 	await databases.harperfast_nextjs.nextjs_build_info.put(scope.appName, { status: 'failure' });
	// 	// And throw an error to be caught and logged in `handleApplication()`
	// 	throw new Error(`Build command \`${config.buildCommand}\` exited with code ${code} and signal ${signal}`)
	// }

	try {
		// @ts-expect-error
		await nextBuild(scope.directory);

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

async function serve(scope: Scope, config: NextPluginConfig, nextServer: NextServer) {
	scope.logger.debug?.('serving...');

	const app = nextServer({ dir: scope.directory, dev: config.dev });

	await app.prepare();
	
	const requestHandler = app.getRequestHandler();

	scope.server.http?.(
		(request, next) => {
			// @ts-expect-error
			return request._nodeResponse === undefined
				? next(request)
				// @ts-expect-error
				: requestHandler(request._nodeRequest, request._nodeResponse, urlParse(request._nodeRequest.url, true));
		},
		// @ts-expect-error
		{ runFirst: config.runFirst, port: config.port, securePort: config.securePort }
	);

	// Next.js v9 doesn't have an upgrade handler
	if (config.dev && app.getUpgradeHandler) {
		const upgradeHandler = app.getUpgradeHandler();
		// @ts-expect-error
		scope.server.upgrade(
			// @ts-expect-error
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

function detectNextVersion(scope: Scope): number {
  const require = createRequire(join(scope.directory, 'package.json'));
  const nextPackage = require('next/package.json');
  return parseInt(nextPackage.version.split('.')[0], 10);
}

async function importNext(scope: Scope): Promise<{ server: NextServer, build: NextBuild, version: number }> {
  const require = createRequire(join(scope.directory, 'package.json'));
  // The default export is the `createServer` function
  const server = require(require.resolve('next'));
  // The build module's default export is the actual `build` function
  const build = require(require.resolve('next/dist/build/index.js')).default;
  return { server, build, version: detectNextVersion(scope) };
}
