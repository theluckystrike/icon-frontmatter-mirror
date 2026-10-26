import { describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import IconFrontmatterMirrorPlugin from '../src/main';
import { MirrorEngine } from '../src/engine';
import { IconFrontmatterMirrorSettingTab, effectiveOptions, retiredNames } from '../src/settings';
import manifest from '../manifest.json';

const DIR = '.obsidian/plugins/obsidian-icon-folder';

async function setup(files: Record<string, string>, data: unknown) {
	const app = App.createConfigured__({ files }) as any;
	await app.vault.adapter.mkdir(DIR);
	await app.vault.adapter.write(`${DIR}/data.json`, JSON.stringify(data));
	const plugin = new IconFrontmatterMirrorPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	plugin.engine = new MirrorEngine({
		app,
		options: (i, c, r) => effectiveOptions(plugin.settings, false, i, c, r),
		ledger: () => plugin.ledger,
		save: () => plugin.saveAll(),
		changed: () => {},
		notify: () => {},
	});
	const tab = new IconFrontmatterMirrorSettingTab(app as never, plugin);
	const fm = (p: string) => app.metadataCache.getFileCache(app.vault.getFileByPath(p))?.frontmatter ?? {};
	return { app, plugin, tab, fm };
}

describe('fix 1: property names apply once, not on each key press', () => {
	it('typing "glyph" key by key writes only glyph and moves the value from icon', async () => {
		const { plugin, tab, fm } = await setup({ 'A.md': 'Body', 'B.md': '---\nnote: x\n---\nBody' }, { 'A.md': 'LiHouse', 'B.md': 'LiStar' });
		await plugin.engine!.run(true);
		expect(fm('A.md')).toEqual({ icon: 'LiHouse' });
		await tab.setControlValue('useIconizeNames', false);
		for (const typed of ['g', 'gl', 'gly', 'glyp', 'glyph']) {
			await tab.setControlValue('iconProperty', typed);
			expect(tab.getControlValue('iconProperty')).toBe(typed);
			expect(Object.keys(fm('A.md'))).toEqual(['icon']);
		}
		expect(plugin.settings.iconProperty).toBe('icon');
		await tab.applyNames();
		expect(plugin.settings.iconProperty).toBe('glyph');
		expect(fm('A.md')).toEqual({ glyph: 'LiHouse' });
		expect(fm('B.md')).toEqual({ note: 'x', glyph: 'LiStar' });
		expect(plugin.ledger).toEqual({ 'A.md': { glyph: 'LiHouse' }, 'B.md': { glyph: 'LiStar' } });
	});

	it('closing the settings applies the typed name; a value the user changed under the old name stays', async () => {
		const { app, plugin, tab, fm } = await setup({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		await plugin.engine!.run(true);
		const f = app.vault.getFileByPath('A.md');
		await app.vault.modify(f, '---\nicon: Mine\n---\nBody');
		await tab.setControlValue('useIconizeNames', false);
		await tab.setControlValue('iconProperty', 'glyph');
		tab.hide();
		await new Promise((r) => setTimeout(r, 20));
		await plugin.engine!.idle();
		expect(fm('A.md')).toEqual({ icon: 'Mine', glyph: 'LiHouse' });
	});

	it('retiredNames: only a name replaced in the same role, never a role that turns off', () => {
		expect(retiredNames(['icon', 'iconColor', null, null, null], ['glyph', 'iconColor', null, null, null])).toEqual(['icon']);
		expect(retiredNames(['icon', 'iconColor', null, null, null], ['icon', null, null, null, null])).toEqual([]);
		expect(retiredNames(['icon', 'iconColor', 'lucide', null, null], ['icon', 'iconColor', null, null, null])).toEqual([]);
		expect(retiredNames(['a', 'b', null, null, null], ['b', 'a', null, null, null])).toEqual([]);
	});
});
