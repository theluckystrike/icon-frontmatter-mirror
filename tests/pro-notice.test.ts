import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import IconFrontmatterMirrorPlugin from '../src/main';
import { IconFrontmatterMirrorSettingTab } from '../src/settings';
import { bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

// A free user can select the Pro options of the settings tab. A select shows the shared Pro notice with the
// "Sponsor on GitHub" button. Nothing is saved or kept as a draft, and the rows show the values in effect.
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';
const EXTRA = 'Extra icon properties need Pro.';
const FOLDER = 'Folder icons in folder notes need Pro.';
const notice = (lead: string) => ({ text: `${lead} ${PITCH}Sponsor on GitHub`, buttons: 1 });
const PRO_KEYS = ['extra1Property', 'extra1Format', 'extra2Property', 'extra2Format', 'folderNotes', 'folderNoteMode', 'folderProperty'];

function fakePro(pro: boolean): SponsorsManager {
	return {
		isPro: () => pro,
		onChange: () => () => undefined,
		hasToken: () => false,
		isChecking: () => false,
		getState: () => ({ status: 'unchecked', lastAttemptAt: 0 }),
		config: { sponsorLogin: 'theluckystrike', source: 'icon-frontmatter-mirror' },
	} as unknown as SponsorsManager;
}

async function setup(pro: boolean) {
	const app = App.createConfigured__({ files: {} });
	const plugin = new IconFrontmatterMirrorPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	// A lapsed sponsor: stored Pro values that are not in effect without Pro.
	plugin.settings.extra1Property = 'lucideIcon'; plugin.settings.folderNotes = true;
	const update = vi.spyOn(plugin, 'updateSettings').mockResolvedValue();
	bindPro(fakePro(pro));
	const tab = new IconFrontmatterMirrorSettingTab(app as never, plugin);
	tab.update = vi.fn();
	const shown: { text: string; buttons: number }[] = [];
	vi.spyOn(Notice.prototype as unknown as { constructor__(): void }, 'constructor__').mockImplementation(function (this: Notice) {
		shown.push({ text: this.messageEl.textContent ?? '', buttons: this.messageEl.querySelectorAll('.pf-pro-notice-sponsor').length });
	});
	return { plugin, tab, update, shown };
}
type Item = { control?: { key: string; disabled?: () => boolean }; items?: Item[] };
const controls = (tab: IconFrontmatterMirrorSettingTab) => (tab.productSettingDefinitions() as unknown as Item[]).flatMap((d) => d.items ?? [d]).filter((i) => i.control);

describe('Pro options of the settings tab', () => {
	afterEach(() => { resetPro(); vi.restoreAllMocks(); });

	it('a free user who selects a Pro option gets the Pro notice with a Sponsor button, nothing is saved, and the rows show the values in effect', async () => {
		const { plugin, tab, update, shown } = await setup(false);
		for (const c of controls(tab).filter((i) => PRO_KEYS.includes(i.control!.key))) expect(c.control!.disabled?.() ?? false, c.control!.key).toBe(false);
		const before = JSON.stringify(plugin.settings);
		await tab.setControlValue('extra1Property', 'glyph');
		await tab.setControlValue('extra2Format', 'lucide');
		await tab.setControlValue('folderNotes', true);
		await tab.setControlValue('folderProperty', 'banner');
		expect(shown).toEqual([notice(EXTRA), notice(EXTRA), notice(FOLDER), notice(FOLDER)]);
		expect(update).not.toHaveBeenCalled();
		expect(tab.drafts).toEqual({});
		expect(JSON.stringify(plugin.settings)).toBe(before);
		expect(tab.update).toHaveBeenCalledTimes(4);
		expect(tab.getControlValue('extra1Property')).toBe('');
		expect(tab.getControlValue('folderNotes')).toBe(false);
		await tab.applyNames();
		expect(update).not.toHaveBeenCalled();
		// A free option is not refused.
		await tab.setControlValue('mirrorColor', false);
		expect(update).toHaveBeenCalledWith({ mirrorColor: false });
		expect(shown).toHaveLength(4);
	});

	it('a Pro user types an extra property and turns on folder notes, with no Pro notice', async () => {
		const { tab, update, shown } = await setup(true);
		await tab.setControlValue('extra1Property', 'glyph');
		expect(tab.getControlValue('extra1Property')).toBe('glyph');
		await tab.setControlValue('folderNotes', false);
		expect(update).toHaveBeenCalledWith({ folderNotes: false });
		await tab.applyNames();
		expect(update).toHaveBeenCalledWith({ extra1Property: 'glyph' });
		expect(shown).toEqual([]);
	});
});
