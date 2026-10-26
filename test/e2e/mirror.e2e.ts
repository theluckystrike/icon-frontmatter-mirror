import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';

// Real-app checks for the acceptance criteria of the spec, on minAppVersion and on the latest app (wdio.conf.mts).
// Iconize is not installed in the test vault: the tests write its data.json as Iconize 2.14.7 does.

/** Writes the Iconize data file in the config folder of the vault (never a hard-coded ".obsidian"). */
async function setIconize(data: unknown): Promise<void> {
	await browser.executeObsidian(async ({ app }, text) => {
		const dir = `${app.vault.configDir}/plugins/obsidian-icon-folder`;
		if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
		await app.vault.adapter.write(`${dir}/data.json`, text);
	}, typeof data === 'string' ? data : JSON.stringify(data));
}

async function note(path: string, text: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, p, t) => {
			const dir = p.split('/').slice(0, -1).join('/');
			if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
			const f = app.vault.getFileByPath(p);
			if (f) await app.vault.modify(f, t);
			else await app.vault.create(p, t);
		},
		path,
		text,
	);
}

async function frontmatter(path: string): Promise<Record<string, unknown> | null> {
	return browser.executeObsidian(({ app }, p) => {
		const f = app.vault.getFileByPath(p);
		return f ? ((app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) ?? {}) : null;
	}, path);
}

async function waitFor(path: string, want: Record<string, unknown>, timeout = 15000): Promise<void> {
	let last: unknown = null;
	await browser
		.waitUntil(
			async () => {
				last = await frontmatter(path);
				return JSON.stringify(last) === JSON.stringify(want);
			},
			{ timeout, interval: 200 },
		)
		.catch(() => {
			throw new Error(`${path} frontmatter is ${JSON.stringify(last)}, not ${JSON.stringify(want)}`);
		});
}

async function mirrorNow(): Promise<void> {
	await browser.executeObsidian(async ({ app }, id) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { mirrorNow(): Promise<void> }> } }).plugins.plugins[id]!;
		await plugin.mirrorNow();
	}, pluginId);
}

async function status(): Promise<{ state: string; conflicts: { path: string }[]; counts: { folders: number } }> {
	return browser.executeObsidian(({ app }, id) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { engine: { status: { state: string; conflicts: { path: string }[]; counts: { folders: number } } } }> } }).plugins.plugins[id]!;
		return JSON.parse(JSON.stringify(plugin.engine.status)) as { state: string; conflicts: { path: string }[]; counts: { folders: number } };
	}, pluginId);
}

describe(`${pluginId} mirror`, function () {
	before(async function () {
		await note('Mirror/A.md', 'Alpha body');
		await note('Mirror/B.md', '---\nicon: Mine\n---\nBeta body');
		await note('Mirror/C.md', 'Gamma body');
	});

	it('mirrors a new icon with the command', async function () {
		await setIconize({ settings: { iconInFrontmatterFieldName: 'icon', iconColorInFrontmatterFieldName: 'iconColor' }, 'Mirror/A.md': 'LiHouse', 'Mirror/C.md': { iconName: 'LiStar', iconColor: '#ff0000' }, Mirror: 'LiFolder' });
		await mirrorNow();
		await waitFor('Mirror/A.md', { icon: 'LiHouse' });
		await waitFor('Mirror/C.md', { icon: 'LiStar', iconColor: '#ff0000' });
		expect((await status()).counts.folders).toBe(1);
	});

	it('keeps a user value and lists it as a conflict', async function () {
		await setIconize({ 'Mirror/A.md': 'LiHouse', 'Mirror/B.md': 'LiMoon', 'Mirror/C.md': { iconName: 'LiStar', iconColor: '#ff0000' } });
		await mirrorNow();
		await waitFor('Mirror/B.md', { icon: 'Mine' });
		expect((await status()).conflicts.map((c) => c.path)).toEqual(['Mirror/B.md']);
	});

	it('follows a change without the command (poll of the data file)', async function () {
		await setIconize({ 'Mirror/A.md': 'LiSun', 'Mirror/B.md': 'LiMoon', 'Mirror/C.md': { iconName: 'LiStar', iconColor: '#ff0000' } });
		await waitFor('Mirror/A.md', { icon: 'LiSun' });
	});

	it('edit after create: a value typed after the mirror is kept', async function () {
		await note('Mirror/A.md', '---\nicon: Typed\n---\nAlpha body');
		await waitFor('Mirror/A.md', { icon: 'Typed' });
		await setIconize({ 'Mirror/A.md': 'LiCloud', 'Mirror/B.md': 'LiMoon', 'Mirror/C.md': { iconName: 'LiStar', iconColor: '#ff0000' } });
		await mirrorNow();
		await waitFor('Mirror/A.md', { icon: 'Typed' });
	});

	it('rename keeps the icon while Iconize saves the moved key later', async function () {
		await browser.executeObsidian(async ({ app }) => {
			const f = app.vault.getFileByPath('Mirror/C.md');
			if (f) await app.fileManager.renameFile(f, 'Mirror/Moved C.md');
		});
		// The data file still has the old key, as when Iconize or a sync tool saves late. A run on that file removes nothing.
		await mirrorNow();
		await browser.pause(3000);
		await waitFor('Mirror/Moved C.md', { icon: 'LiStar', iconColor: '#ff0000' }, 2000);
		await setIconize({ 'Mirror/A.md': 'LiCloud', 'Mirror/B.md': 'LiMoon', 'Mirror/Moved C.md': { iconName: 'LiStar', iconColor: '#ff0000' } });
		await mirrorNow();
		await waitFor('Mirror/Moved C.md', { icon: 'LiStar', iconColor: '#ff0000' });
	});

	it('removes the value it wrote when the icon is removed in Iconize', async function () {
		await setIconize({ 'Mirror/A.md': 'LiCloud', 'Mirror/B.md': 'LiMoon' });
		await mirrorNow();
		await waitFor('Mirror/Moved C.md', {});
		await waitFor('Mirror/A.md', { icon: 'Typed' });
	});

	it('a half written data file gives no error and no write', async function () {
		await setIconize('{"Mirror/A.md":"LiCloud","Mirror/B.m');
		await mirrorNow();
		expect((await status()).state).toBe('broken');
		await waitFor('Mirror/B.md', { icon: 'Mine' });
		await setIconize({ 'Mirror/A.md': 'LiCloud', 'Mirror/B.md': 'LiMoon' });
		await mirrorNow();
		expect((await status()).state).toBe('ok');
	});

	it('a missing data file gives a clear notice and no error', async function () {
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.adapter.remove(`${app.vault.configDir}/plugins/obsidian-icon-folder/data.json`);
		});
		await mirrorNow();
		expect((await status()).state).toBe('missing');
		const text = await browser.execute(() => Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent ?? '').join('\n'));
		expect(text).toContain('Iconize data not found');
	});
});
