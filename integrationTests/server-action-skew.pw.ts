import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { startFixture } from './fixture.ts';

// These tests pin down the current, broken behavior so a fix has to flip them. A fixed
// NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, or a build that keeps `.next/cache/.rscinfo`, keeps the IDs stable.
const FIXTURE = 'next-16-server-actions';
const ACTION_NOT_FOUND = 'was not found on the server';

interface CapturedAction {
	id: string;
	headers: Record<string, string>;
	body: string;
}

function componentDir(dataRootDir: string) {
	return join(dataRootDir, 'components', FIXTURE);
}

function buildId(dataRootDir: string) {
	return readFileSync(join(componentDir(dataRootDir), '.next', 'BUILD_ID'), 'utf8').trim();
}

async function clickPing(page: Page): Promise<CapturedAction> {
	const request = page.waitForRequest((candidate) => candidate.method() === 'POST' && !!candidate.headers()['next-action']);
	await page.getByRole('button', { name: 'Ping' }).click();
	const sent = await request;
	const headers = sent.headers();
	return { id: headers['next-action'], headers, body: sent.postData() ?? '' };
}

async function replay(origin: string, action: CapturedAction) {
	const response = await fetch(`${origin}/`, {
		method: 'POST',
		headers: {
			accept: 'text/x-component',
			'content-type': action.headers['content-type'],
			'next-action': action.id,
			'next-router-state-tree': action.headers['next-router-state-tree'],
		},
		body: action.body,
	});
	await response.arrayBuffer();
	return { status: response.status, actionNotFound: response.headers.get('x-nextjs-action-not-found') };
}

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test('a rebuild of unchanged source breaks server actions in pages that are already open', async ({ page }) => {
	const node = await startFixture(FIXTURE);
	try {
		const before = buildId(node.harper.dataRootDir);
		await page.goto(node.harper.httpURL);
		const original = await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');

		// What a deploy hands the plugin: the same source in a fresh tree, with no `.next` from the last build.
		rmSync(join(componentDir(node.harper.dataRootDir), '.next'), { recursive: true, force: true });
		await node.restart();
		const after = buildId(node.harper.dataRootDir);

		const replayed = await replay(node.harper.httpURL, original);
		await clickPing(page);
		await expect(page.getByTestId('result')).not.toHaveText('pong');
		const shown = await page.getByTestId('result').innerText();

		const fresh = await page.context().newPage();
		await fresh.goto(node.harper.httpURL);
		const rebuilt = await clickPing(fresh);
		await expect(fresh.getByTestId('result')).toHaveText('pong');

		expect(after).not.toBe(before);
		expect(rebuilt.id).not.toBe(original.id);
		expect(replayed).toEqual({ status: 409, actionNotFound: '1' });
		expect(shown).toContain(ACTION_NOT_FOUND);
	} finally {
		await node.stop();
	}
});

test('two nodes built from the same source disagree on server action IDs', async ({ page }) => {
	const [nodeA, nodeB] = await Promise.all([startFixture(FIXTURE), startFixture(FIXTURE)]);
	try {
		const a = nodeA.harper.httpURL;
		const b = nodeB.harper.httpURL;
		// A load balancer that sends the page request to one node and the action POST to the other.
		await page.route(`${a}/**`, async (route) => {
			const request = route.request();
			if (request.method() !== 'POST' || !request.headers()['next-action']) return route.continue();
			const response = await route.fetch({ url: request.url().replace(a, b) });
			return route.fulfill({ response });
		});

		await page.goto(a);
		const fromA = await clickPing(page);
		await expect(page.getByTestId('result')).not.toHaveText('idle');
		const shown = await page.getByTestId('result').innerText();

		const replayed = await replay(b, fromA);
		expect(buildId(nodeB.harper.dataRootDir)).not.toBe(buildId(nodeA.harper.dataRootDir));
		expect(replayed).toEqual({ status: 409, actionNotFound: '1' });
		expect(shown).toContain(ACTION_NOT_FOUND);
	} finally {
		await Promise.all([nodeA.stop(), nodeB.stop()]);
	}
});
