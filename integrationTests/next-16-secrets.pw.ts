import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-secrets');

test('startup secrets are injected before Next.js boots', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	await expect(page.getByTestId('api-key')).toHaveText('harper-secret-abc123');
});
