import { join } from 'path';

export default {
	// turbopack: {
	// 	root: '../../../../',
	// },
	serverExternalPackages: ['harper', '@harperfast/nextjs'],
	cacheHandler: join(import.meta.dirname, 'node_modules', '@harperfast', 'nextjs', 'dist', 'CacheHandler.js'),

}
