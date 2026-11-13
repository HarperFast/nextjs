import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { startFixture, type FixtureInstance } from './fixture.ts';

const FIXTURE = 'next-16-server-actions';
const ACTION_NOT_FOUND = 'was not found on the server';
const GUARD_COOKIE = '__harper_nextjs_action_reload';
const FIXED_KEY = Buffer.alloc(32, 7).toString('base64');

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

function removeBuild(node: FixtureInstance) {
	return () => rmSync(join(componentDir(node.harper.dataRootDir), '.next'), { recursive: true, force: true });
}

async function clickPing(page: Page): Promise<CapturedAction> {
	const request = page.waitForRequest((candidate) => candidate.method() === 'POST' && !!candidate.headers()['next-action']);
	await page.getByRole('button', { name: 'Ping' }).click();
	const sent = await request;
	const headers = sent.headers();
	return { id: headers['next-action'], headers, body: sent.postData() ?? '' };
}

async function markDocument(page: Page) {
	await page.evaluate(() => {
		(window as any).__beforeDeploy = true;
	});
}

function isSameDocument(page: Page) {
	return page.evaluate(() => (window as any).__beforeDeploy === true);
}

async function replay(origin: string, action: CapturedAction, cookie?: string) {
	const response = await fetch(`${origin}/`, {
		method: 'POST',
		headers: {
			accept: 'text/x-component',
			'content-type': action.headers['content-type'],
			'next-action': action.id,
			'next-router-state-tree': action.headers['next-router-state-tree'],
			...(cookie && { cookie }),
		},
		body: action.body,
	});
	await response.arrayBuffer();
	return {
		actionNotFound: response.headers.get('x-nextjs-action-not-found'),
		redirect: response.headers.get('x-action-redirect'),
		guardSet: response.headers.getSetCookie().some((value) => value.startsWith(`${GUARD_COOKIE}=1;`)),
	};
}

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test('a page open across a rebuild reloads once when its action is missing, then works', async ({ page }) => {
	const node = await startFixture(FIXTURE);
	try {
		const before = buildId(node.harper.dataRootDir);
		await page.goto(node.harper.httpURL);
		const original = await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');
		await markDocument(page);

		// What a deploy hands the plugin: the same source in a fresh tree, with no `.next` from the last build.
		await node.restart(removeBuild(node));
		expect(buildId(node.harper.dataRootDir)).not.toBe(before);

		await clickPing(page);
		await expect.poll(() => isSameDocument(page)).toBe(false);
		await expect(page.getByTestId('result')).toHaveText('idle');
		expect((await page.context().cookies()).map((cookie) => cookie.name)).toContain(GUARD_COOKIE);
		const rebuilt = await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');
		expect(rebuilt.id).not.toBe(original.id);

		expect(await replay(node.harper.httpURL, original)).toEqual({ actionNotFound: null, redirect: '/;replace', guardSet: true });
		expect(await replay(node.harper.httpURL, original, `${GUARD_COOKIE}=1`)).toEqual({
			actionNotFound: '1',
			redirect: null,
			guardSet: false,
		});
	} finally {
		await node.stop();
	}
});

test('a renamed action reloads the page even when every build shares one key', async ({ page }) => {
	const node = await startFixture(FIXTURE, { env: { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: FIXED_KEY } });
	try {
		await page.goto(node.harper.httpURL);
		const original = await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');
		await markDocument(page);

		await node.restart(() => {
			removeBuild(node)();
			const app = join(componentDir(node.harper.dataRootDir), 'app');
			const actions = join(app, 'actions.js');
			const button = join(app, 'ActionButton.js');
			writeFileSync(actions, readFileSync(actions, 'utf8').replace('function ping(', 'function pingRenamed('));
			writeFileSync(button, readFileSync(button, 'utf8').replace('{ ping }', '{ pingRenamed as ping }'));
		});

		await clickPing(page);
		await expect.poll(() => isSameDocument(page)).toBe(false);
		const renamed = await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');
		expect(renamed.id).not.toBe(original.id);
	} finally {
		await node.stop();
	}
});

test('a page under a basePath reloads to the same page', async ({ page }) => {
	const node = await startFixture(FIXTURE);
	try {
		const config = join(componentDir(node.harper.dataRootDir), 'next.config.mjs');
		await node.restart(() => {
			removeBuild(node)();
			writeFileSync(config, readFileSync(config, 'utf8').replace('withHarper({})', "withHarper({ basePath: '/docs' })"));
		});
		await page.goto(`${node.harper.httpURL}/docs?tab=1`);
		const original = await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');
		await markDocument(page);

		await node.restart(removeBuild(node));
		await clickPing(page);
		await expect.poll(() => isSameDocument(page)).toBe(false);
		expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/docs?tab=1');
		await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');

		const replayed = await fetch(`${node.harper.httpURL}/docs?tab=1`, {
			method: 'POST',
			headers: {
				accept: 'text/x-component',
				'content-type': original.headers['content-type'],
				'next-action': original.id,
				'next-router-state-tree': original.headers['next-router-state-tree'],
			},
			body: original.body,
		});
		await replayed.arrayBuffer();
		expect(replayed.headers.get('x-action-redirect')).toBe('/?tab=1;replace');
		expect(replayed.headers.getSetCookie().find((value) => value.startsWith(`${GUARD_COOKIE}=1;`))).toContain('Path=/docs;');
	} finally {
		await node.stop();
	}
});

test('reloadOnMissingAction: false keeps Next.js’s error', async ({ page }) => {
	const node = await startFixture(FIXTURE);
	try {
		await page.goto(node.harper.httpURL);
		const original = await clickPing(page);
		await expect(page.getByTestId('result')).toHaveText('pong');
		await markDocument(page);

		await node.restart(() => {
			removeBuild(node)();
			appendFileSync(join(componentDir(node.harper.dataRootDir), 'config.yaml'), '  reloadOnMissingAction: false\n');
		});

		await clickPing(page);
		await expect(page.getByTestId('result')).toContainText(ACTION_NOT_FOUND);
		expect(await isSameDocument(page)).toBe(true);
		expect(await replay(node.harper.httpURL, original)).toEqual({ actionNotFound: '1', redirect: null, guardSet: false });
	} finally {
		await node.stop();
	}
});

test('two nodes built from the same source still disagree on action IDs; the page reloads once', async ({ page }) => {
	const nodes: FixtureInstance[] = [];
	try {
		nodes.push(await startFixture(FIXTURE));
		nodes.push(await startFixture(FIXTURE));
		const [nodeA, nodeB] = nodes;
		const a = nodeA.harper.httpURL;
		const b = nodeB.harper.httpURL;
		// A load balancer sending the action POST to the node that did not serve the page. It forwards the
		// public host, or Next.js rejects the POST as cross-origin before looking up the action.
		await page.route(`${a}/**`, async (route) => {
			const request = route.request();
			if (request.method() !== 'POST' || !request.headers()['next-action']) return route.continue();
			const response = await route.fetch({
				url: request.url().replace(a, b),
				headers: { ...(await request.allHeaders()), 'x-forwarded-host': new URL(a).host },
			});
			return route.fulfill({ response });
		});

		await page.goto(a);
		await markDocument(page);
		const fromA = await clickPing(page);
		await expect.poll(() => isSameDocument(page)).toBe(false);
		await expect(page.getByTestId('result')).toHaveText('idle');
		await markDocument(page);
		await clickPing(page);
		await expect(page.getByTestId('result')).toContainText(ACTION_NOT_FOUND);
		expect(await isSameDocument(page)).toBe(true);

		expect(buildId(nodeB.harper.dataRootDir)).not.toBe(buildId(nodeA.harper.dataRootDir));
		expect(await replay(b, fromA)).toEqual({ actionNotFound: null, redirect: '/;replace', guardSet: true });
	} finally {
		await Promise.all(nodes.map((node) => node.stop()));
	}
});
