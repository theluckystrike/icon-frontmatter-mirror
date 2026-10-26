import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { lastNotice, pluginId, reloadPlugin } from './load';

describe(`${pluginId} smoke test`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const state = await reloadPlugin(pluginId);
		expect(state).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('runs the Mirror icons now command', async function () {
		await obsidianPage.write('Smoke.md', 'one two three');
		await obsidianPage.openFile('Smoke.md');
		await browser.executeObsidianCommand(`${pluginId}:mirror-now`);
		await browser.waitUntil(async () => /Iconize data not found|Icon Frontmatter Mirror\./.test(await lastNotice()), { timeout: 5000 });
	});
});
