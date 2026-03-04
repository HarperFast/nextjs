import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
// Bringing this forward from extension since some validation is better than none.
// Eventually can remove when plugins have better option validation from core.
function assertType(name, option, expectedType) {
    if (option && typeof option !== expectedType) {
        throw new Error(`${name} must be type ${expectedType}. Received: ${typeof option}`);
    }
}
function resolveConfig(options, logger) {
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
    const config = {
        buildCommand: options.buildCommand ?? 'npx next build',
        buildOnly: options.buildOnly ?? false,
        dev: options.dev ?? false,
        port: options.port,
        prebuilt: options.prebuilt ?? false,
        securePort: options.securePort,
        setCwd: options.setCwd ?? false,
    };
    return config;
}
export async function handleApplication(scope) {
    const options = scope.options.getAll();
    const config = resolveConfig(options, scope.logger);
    const { next, version } = await importNext(scope.directory);
    scope.logger.debug('next version', version);
    scope.logger.debug('typeof next', typeof next);
}
function detectNextVersion(componentPath) {
    const require = createRequire(join(componentPath, 'package.json'));
    const nextPackage = require('next/package.json');
    return parseInt(nextPackage.version.split('.')[0], 10);
}
async function importNext(componentPath) {
    const require = createRequire(join(componentPath, 'package.json'));
    const nextPath = pathToFileURL(require.resolve('next'));
    const nextModule = await import(nextPath.href);
    const next = nextModule.default;
    return { next, version: detectNextVersion(componentPath) };
}
