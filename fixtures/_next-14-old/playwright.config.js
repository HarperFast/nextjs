const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 2,
	expect: {
		timeout: 30000,
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	globalSetup: require.resolve('test-utils/global-setup.js'),
	globalTeardown: require.resolve('test-utils/global-teardown.js'),
});
