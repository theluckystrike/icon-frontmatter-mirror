import { describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import IconFrontmatterMirrorPlugin, { normalizeLedger } from '../src/main';
import { DEFAULT_SETTINGS, effectiveOptions, normalizeSettings, statusText } from '../src/settings';
import manifest from '../manifest.json';

describe('IconFrontmatterMirrorPlugin', () => {
	it('loads with default settings against an in-memory vault', async () => {
		const app = App.createConfigured__({ files: { 'notes/a.md': '# Hello world' } });
		const plugin = new IconFrontmatterMirrorPlugin(app as never, manifest as never);
		await plugin.loadSettings();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(plugin.ledger).toEqual({});
	});

	it('repairs bad saved settings and a bad ledger', () => {
		expect(normalizeSettings({ iconProperty: 5 as never, pollSeconds: 900, extra1Format: 'loud' as never })).toEqual({ ...DEFAULT_SETTINGS, pollSeconds: 60 });
		expect(normalizeSettings({ iconProperty: '  ' })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeLedger({ 'a.md': { icon: 'LiHouse', bad: 3 }, 'b.md': 'x', 'c.md': {} })).toEqual({ 'a.md': { icon: 'LiHouse' } });
		expect(normalizeLedger([1])).toEqual({});
	});

	it('uses the Iconize field names by default and the custom names when that is off', () => {
		expect(effectiveOptions(DEFAULT_SETTINGS, false, 'glyph', 'glyphColor')).toEqual({ iconProperty: 'glyph', colorProperty: 'glyphColor', extras: [], folderNotes: null });
		expect(effectiveOptions(DEFAULT_SETTINGS, false, null, null)).toEqual({ iconProperty: 'icon', colorProperty: 'iconColor', extras: [], folderNotes: null });
		const own = { ...DEFAULT_SETTINGS, useIconizeNames: false, iconProperty: 'emoji', mirrorColor: false };
		expect(effectiveOptions(own, false, 'glyph', 'glyphColor')).toEqual({ iconProperty: 'emoji', colorProperty: null, extras: [], folderNotes: null });
	});

	it('keeps the Pro options off without Pro', () => {
		const s = { ...DEFAULT_SETTINGS, extra1Property: 'lucide', extra2Property: 'icon', folderNotes: true };
		expect(effectiveOptions(s, false, null, null)).toEqual({ iconProperty: 'icon', colorProperty: 'iconColor', extras: [], folderNotes: null });
		// Pro on: extra 2 has the same name as the icon property, so it is dropped.
		expect(effectiveOptions(s, true, null, null)).toEqual({
			iconProperty: 'icon',
			colorProperty: 'iconColor',
			extras: [{ property: 'lucide', format: 'kebab' }],
			folderNotes: { mode: 'same-name', property: 'folderIcon' },
		});
	});

	it('says why nothing happens when Iconize data is missing or broken', () => {
		const base = { iconizeEnabled: false, counts: { notes: 0, folders: 0, folderNotes: 0, other: 0, missing: 0 }, written: 0, removed: 0, conflicts: [], waiting: 0, lastRun: null };
		expect(statusText({ ...base, state: 'missing' }, '.obsidian/plugins/obsidian-icon-folder/data.json')).toBe(
			'Iconize data not found at .obsidian/plugins/obsidian-icon-folder/data.json. Install Iconize and set an icon on a note. Iconize is not turned on in Community plugins.',
		);
		expect(statusText({ ...base, iconizeEnabled: true, state: 'broken' }, 'x')).toContain('writes nothing');
		expect(statusText({ ...base, iconizeEnabled: true, state: 'ok', counts: { ...base.counts, notes: 3, folders: 2 } }, 'x')).toBe(
			'3 note icons mirrored. 2 folder icons skipped, because folders have no properties. Last run wrote 0 and removed 0 values. No conflicts.',
		);
		expect(statusText({ ...base, iconizeEnabled: true, state: 'ok', counts: { ...base.counts, notes: 1 }, conflicts: [{ path: 'a.md', property: 'icon', current: 'x', iconize: 'y' }] }, 'x')).toBe(
			'1 note icon mirrored. Last run wrote 0 and removed 0 values. 1 conflict: notes that already have another value.',
		);
	});
});
