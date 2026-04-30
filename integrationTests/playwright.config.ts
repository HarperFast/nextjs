import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: '**/*.pw.ts',

	// One Harper instance per test file (via the worker-scoped harper fixture).
	// Tests within a file run sequentially — safe to share state across test() blocks.
	// Files run in parallel across workers; loopback pool size limits concurrency.
	fullyParallel: false,
	workers: process.env.CI ? 2 : undefined,

	forbidOnly: !!process.env.CI,

	// Retry on CI to smooth over flakiness in Next.js startup timing
	retries: process.env.CI ? 1 : 0,

	reporter: process.env.CI ? [['list'], ['github']] : 'list',

	use: {
		// No baseURL — each test uses harper.httpURL from the fixture directly,
		// since different workers are on different loopback addresses.
		trace: 'retain-on-failure',
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
});
