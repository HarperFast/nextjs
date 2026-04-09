import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: '**/*.pw.ts',

	// Run workers in parallel. Each worker manages its own isolated Harper instance
	// via the worker-scoped harper fixture. The loopback pool size limits true
	// concurrency — set HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT accordingly.
	fullyParallel: true,
	workers: process.env.CI ? 2 : undefined,

	forbidOnly: !!process.env.CI,

	// Retry on CI to smooth over flakiness in Next.js startup timing
	retries: process.env.CI ? 1 : 0,

	reporter: process.env.CI ? 'github' : 'list',

	use: {
		// No baseURL — each test uses harper.httpURL from the fixture directly,
		// since different workers are on different loopback addresses.
		trace: 'on-first-retry',
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
});
