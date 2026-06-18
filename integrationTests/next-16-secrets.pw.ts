import { fixture } from './fixture.ts';

const { test, expect } = fixture('next-16-secrets');

test('startup secrets are injected before Next.js boots', async ({ page, harper }) => {
	await page.goto(harper.httpURL);
	const apiKey = await page.getByTestId('api-key').innerText();
	expect(apiKey).toBe('harper-secret-abc123');
});
