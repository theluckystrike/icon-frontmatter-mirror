import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian-test-mocks/obsidian';
import { MirrorEngine, type Ledger } from '../src/engine';
import { DEFAULT_SETTINGS, effectiveOptions, type IconFrontmatterMirrorSettings } from '../src/settings';

const DIR = '.obsidian/plugins/obsidian-icon-folder';
const DATA = `${DIR}/data.json`;

interface Rig {
	app: any;
	engine: MirrorEngine;
	ledger: Ledger;
	saves: number;
	notes: string[];
	settings: IconFrontmatterMirrorSettings;
	pro: boolean;
	setData(data: unknown): Promise<void>;
	text(path: string): Promise<string>;
	fm(path: string): Record<string, unknown>;
}

async function rig(files: Record<string, string>, data?: unknown, enabled = true): Promise<Rig> {
	const app = App.createConfigured__({ files }) as any;
	await app.vault.adapter.mkdir(DIR);
	await app.vault.adapter.write('.obsidian/community-plugins.json', JSON.stringify(enabled ? ['obsidian-icon-folder'] : []));
	const r: Rig = {
		app,
		engine: null as never,
		ledger: {},
		saves: 0,
		notes: [],
		settings: { ...DEFAULT_SETTINGS },
		pro: false,
		async setData(d) {
			await app.vault.adapter.write(DATA, typeof d === 'string' ? d : JSON.stringify(d));
		},
		async text(path) {
			return app.vault.read(app.vault.getFileByPath(path));
		},
		fm(path) {
			return app.metadataCache.getFileCache(app.vault.getFileByPath(path))?.frontmatter ?? {};
		},
	};
	r.engine = new MirrorEngine({
		app,
		options: (i, c, reads) => effectiveOptions(r.settings, r.pro, i, c, reads),
		ledger: () => r.ledger,
		save: async () => {
			r.saves++;
		},
		changed: () => {},
		notify: (m) => {
			r.notes.push(m);
		},
	});
	if (data !== undefined) await r.setData(data);
	return r;
}

describe('MirrorEngine', () => {
	it('mirrors a new file icon and its color, and skips folders and other files', async () => {
		const r = await rig({ 'A.md': 'Body', 'Projects/B.md': '---\ntags: x\n---\nText', 'pic.png': '' }, { settings: { iconInFrontmatterFieldName: 'icon' }, 'A.md': 'LiHouse', 'Projects/B.md': { iconName: 'IbStar', iconColor: '#ff0000' }, Projects: 'LiFolder', 'pic.png': 'LiImage' });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
		expect(r.fm('Projects/B.md')).toEqual({ tags: 'x', icon: 'IbStar', iconColor: '#ff0000' });
		expect(await r.text('A.md')).toBe('---\nicon: LiHouse\n---\nBody');
		expect(r.engine.status.counts).toEqual({ notes: 2, folders: 1, folderNotes: 0, other: 1, missing: 0 });
		expect(r.engine.status.written).toBe(3);
		expect(r.ledger).toEqual({ 'A.md': { icon: 'LiHouse' }, 'Projects/B.md': { icon: 'IbStar', iconColor: '#ff0000' } });
	});

	it('follows a change in Iconize and removes the property when the icon is removed', async () => {
		const r = await rig({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		await r.engine.run(true);
		await r.setData({ 'A.md': 'LiStar' });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'LiStar' });
		// Another icon stays in the data, so this is one normal removal (a file with no icons holds it, see fix 2).
		await r.setData({ 'Other.md': 'LiMoon' });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({});
		expect(r.engine.status.removed).toBe(1);
		expect(r.ledger).toEqual({});
	});

	it('edit after create: a value the user typed after the mirror is kept on change and on removal', async () => {
		const r = await rig({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		await r.engine.run(true);
		const f = r.app.vault.getFileByPath('A.md');
		await r.app.vault.modify(f, '---\nicon: MyOwn\n---\nBody');
		await r.setData({ 'A.md': 'LiStar' });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'MyOwn' });
		expect(r.engine.status.conflicts).toEqual([{ path: 'A.md', property: 'icon', current: 'MyOwn', iconize: 'LiStar' }]);
		await r.setData({});
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'MyOwn' });
		expect(r.engine.status.conflicts).toEqual([]);
	});

	it('never overwrites a user value; the user can replace it from the conflict list', async () => {
		const r = await rig({ 'A.md': '---\nicon: 🌲\n---\nBody', 'B.md': '---\nicon: [a, b]\n---\n' }, { 'A.md': 'LiHouse', 'B.md': 'LiStar' });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: '🌲' });
		expect(r.fm('B.md')).toEqual({ icon: ['a', 'b'] });
		expect(r.engine.status.conflicts.map((c) => c.path)).toEqual(['A.md', 'B.md']);
		expect(r.engine.status.conflicts[1]!.current).toBe('["a","b"]');
		const n = await r.engine.resolveConflicts(r.engine.status.conflicts.slice(0, 1));
		expect(n).toBe(1);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
		expect(r.fm('B.md')).toEqual({ icon: ['a', 'b'] });
		expect(r.engine.status.conflicts.map((c) => c.path)).toEqual(['B.md']);
	});

	it('decides again inside processFrontMatter, so a value typed after the cache read is not lost', async () => {
		const r = await rig({ 'A.md': '---\nicon: Typed\n---\nBody' }, { 'A.md': 'LiHouse' });
		// A stale metadata cache: it still shows no frontmatter.
		const real = r.app.metadataCache.getFileCache.bind(r.app.metadataCache);
		r.app.metadataCache.getFileCache = (f: TFile) => ({ ...real(f), frontmatter: undefined });
		await r.engine.run(true);
		r.app.metadataCache.getFileCache = real;
		expect(r.fm('A.md')).toEqual({ icon: 'Typed' });
		expect(r.engine.status.conflicts).toEqual([{ path: 'A.md', property: 'icon', current: 'Typed', iconize: 'LiHouse' }]);
		expect(r.ledger).toEqual({});
	});

	it('rename: the ledger follows the note and a data file from before the rename removes nothing', async () => {
		const r = await rig({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		await r.engine.run(true);
		const f = r.app.vault.getFileByPath('A.md');
		await r.app.vault.rename(f, 'Moved/A.md');
		// The data file still has the old key: Iconize has not saved yet. Force a stale read.
		const stat = r.app.vault.adapter.stat.bind(r.app.vault.adapter);
		r.app.vault.adapter.stat = async (p: string) => ({ ...(await stat(p)), mtime: 1 });
		r.engine.renamed('Moved/A.md', 'A.md');
		// The mock metadata cache does not index a renamed file; a write of the same text indexes it.
		const moved = r.app.vault.getFileByPath('Moved/A.md');
		await r.app.vault.modify(moved, await r.app.vault.read(moved));
		await r.engine.run(true);
		expect(r.fm('Moved/A.md')).toEqual({ icon: 'LiHouse' });
		expect(r.ledger).toEqual({ 'Moved/A.md': { icon: 'LiHouse' } });
		// Iconize saves the moved key: no write, the value stays.
		r.app.vault.adapter.stat = stat;
		await new Promise((res) => setTimeout(res, 5));
		await r.setData({ 'Moved/A.md': 'LiHouse' });
		await r.engine.run(true);
		expect(r.fm('Moved/A.md')).toEqual({ icon: 'LiHouse' });
		expect(r.engine.status.written + r.engine.status.removed).toBe(0);
	});

	it('a new property name leaves the values in the old property as they are', async () => {
		const r = await rig({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		await r.engine.run(true);
		r.settings = { ...r.settings, useIconizeNames: false, iconProperty: 'glyph' };
		await r.engine.run(false);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse', glyph: 'LiHouse' });
	});

	it('fix 2: a data file with settings only (Iconize reset or reinstall) holds the removals until the user applies them', async () => {
		const settings = { iconInFrontmatterFieldName: 'icon', iconColorInFrontmatterFieldName: 'iconColor', migrated: 6 };
		// 4 icons in the last good read (2 of them for notes that do not exist): more than 3, so the empty file holds.
		const r = await rig({ 'A.md': 'Body', 'B.md': 'Body' }, { settings, 'A.md': 'LiHouse', 'B.md': { iconName: 'IbStar', iconColor: '#ff0000' }, 'C.md': 'LiSun', 'D.md': 'LiMoon' });
		await r.engine.run(true);
		await r.setData({ settings });
		await r.engine.run(true);
		expect(r.engine.status.removed).toBe(0);
		expect(r.engine.status.heldRemovals).toBe(2);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
		expect(r.fm('B.md')).toEqual({ icon: 'IbStar', iconColor: '#ff0000' });
		expect(r.notes).toHaveLength(1);
		// The next check of the same file does not show the notice again.
		await r.engine.run(true);
		expect(r.notes).toHaveLength(1);
		expect(await r.engine.applyHeldRemovals()).toBe(3);
		expect(r.fm('A.md')).toEqual({});
		expect(r.fm('B.md')).toEqual({});
		expect(r.engine.status.heldRemovals).toBe(0);
	});

	it('1.0.1: removing the only icon removes the property at once', async () => {
		const r = await rig({ 'A.md': 'Body' }, { settings: { migrated: 6 }, 'A.md': 'LiHouse' });
		await r.engine.run(true);
		await r.setData({ settings: { migrated: 6 } });
		await r.engine.run(true);
		expect(r.engine.status.heldRemovals).toBe(0);
		expect(r.fm('A.md')).toEqual({});
		expect(r.notes).toEqual([]);
	});

	it('1.0.1: after a restart, an empty data file holds the removals when the record has more than 3 notes', async () => {
		const files: Record<string, string> = {};
		const data: Record<string, string> = {};
		for (let i = 0; i < 4; i++) {
			files[`n/${i}.md`] = 'x';
			data[`n/${i}.md`] = 'LiStar';
		}
		const r = await rig(files, data);
		await r.engine.run(true);
		const restarted = new MirrorEngine({ app: r.app, options: (i, c, x) => effectiveOptions(r.settings, false, i, c, x), ledger: () => r.ledger, save: async () => {}, changed: () => {}, notify: () => {} });
		await r.setData({ settings: { migrated: 6 } });
		await restarted.run(true);
		expect(restarted.status.heldRemovals).toBe(4);
		expect(r.fm('n/0.md')).toEqual({ icon: 'LiStar' });
	});

	it('1.0.1: a run that stops part way saved the record of the notes it wrote (restart keeps ownership)', async () => {
		const files: Record<string, string> = {};
		const data: Record<string, string> = {};
		for (let i = 0; i < 1000; i++) {
			files[`N${i}.md`] = 'x';
			data[`N${i}.md`] = 'LiHouse';
		}
		const r = await rig(files, data);
		let saved: Ledger = {};
		const engine = new MirrorEngine({
			app: r.app,
			options: (i, c, x) => effectiveOptions(r.settings, false, i, c, x),
			ledger: () => r.ledger,
			save: async () => {
				saved = JSON.parse(JSON.stringify(r.ledger)) as Ledger;
			},
			changed: () => {},
			notify: () => {},
		});
		// Stop after 300 writes, as an unload or a quit does during a long first run.
		const fileManager = r.app.fileManager;
		const original = fileManager.processFrontMatter.bind(fileManager);
		let calls = 0;
		fileManager.processFrontMatter = async (file: TFile, fn: (fm: Record<string, unknown>) => void) => {
			await original(file, fn);
			if (++calls === 300) engine.stop();
		};
		await engine.run(true);
		fileManager.processFrontMatter = original;
		const written = Object.keys(data).filter((path) => r.fm(path).icon === 'LiHouse');
		expect(written.length).toBe(300);
		expect(Object.keys(saved).sort()).toEqual(written.sort());
		// Restart with the saved record: a change in Iconize updates a note that the first run wrote.
		const restarted = new MirrorEngine({ app: r.app, options: (i, c, x) => effectiveOptions(r.settings, false, i, c, x), ledger: () => saved, save: async () => {}, changed: () => {}, notify: () => {} });
		await r.setData({ ...data, [written[0]!]: 'LiStar' });
		await restarted.run(true);
		expect(r.fm(written[0]!)).toEqual({ icon: 'LiStar' });
		expect(restarted.status.conflicts).toEqual([]);
	});

	it('fix 2: more than 10 notes losing their icon in one check are held; 10 go through', async () => {
		const files: Record<string, string> = { 'keep.md': 'x' };
		const data: Record<string, string> = { 'keep.md': 'LiHouse' };
		for (let i = 0; i < 11; i++) {
			files[`n/${i}.md`] = 'x';
			data[`n/${i}.md`] = 'LiStar';
		}
		const r = await rig(files, data);
		await r.engine.run(true);
		await r.setData({ 'keep.md': 'LiHouse' });
		await r.engine.run(true);
		expect(r.engine.status.heldRemovals).toBe(11);
		expect(r.fm('n/0.md')).toEqual({ icon: 'LiStar' });
		const ten = Object.fromEntries([['keep.md', 'LiHouse'], ...Array.from({ length: 1 }, (_, i) => [`n/${i}.md`, 'LiStar'])]);
		await r.setData(ten);
		await r.engine.run(true);
		expect(r.engine.status.heldRemovals).toBe(0);
		expect(r.engine.status.removed).toBe(10);
		expect(r.fm('n/0.md')).toEqual({ icon: 'LiStar' });
		expect(r.fm('n/1.md')).toEqual({});
	});

	it('fix 3: a value the user typed before that equals the icon stays the user value and is not removed', async () => {
		const r = await rig({ 'A.md': '---\nicon: LiHouse\n---\nBody' }, { 'A.md': 'LiHouse' });
		await r.engine.run(true);
		expect(r.ledger).toEqual({});
		await r.setData({});
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
	});

	it('fix 5: a key that differs only in case is a conflict, not a second key', async () => {
		const r = await rig({ 'A.md': '---\nIcon: mine\n---\nBody' }, { 'A.md': 'LiHouse' });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ Icon: 'mine' });
		expect(r.engine.status.conflicts).toEqual([{ path: 'A.md', property: 'icon', current: 'mine', iconize: 'LiHouse' }]);
		await r.engine.resolveConflicts(r.engine.status.conflicts);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
	});

	it('fix 4: with the Iconize option Use icon in frontmatter on, the color is written even when color mirroring is off', async () => {
		const r = await rig({ 'A.md': 'Body' }, { settings: { iconInFrontmatterEnabled: true }, 'A.md': { iconName: 'LiHouse', iconColor: '#ff0000' } });
		r.settings = { ...r.settings, mirrorColor: false };
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse', iconColor: '#ff0000' });
		await r.setData({ settings: { iconInFrontmatterEnabled: false }, 'A.md': { iconName: 'LiStar', iconColor: '#ff0000' } });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'LiStar', iconColor: '#ff0000' });
	});

	it('delete drops the ledger of the note', async () => {
		const r = await rig({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		await r.engine.run(true);
		r.engine.deleted('A.md');
		expect(r.ledger).toEqual({});
	});

	it('missing data file: no error, no write, a clear status', async () => {
		const r = await rig({ 'A.md': '---\nicon: LiHouse\n---\n' }, undefined, false);
		r.ledger['A.md'] = { icon: 'LiHouse' };
		await r.engine.tick();
		await r.engine.run(true);
		expect(r.engine.status.state).toBe('missing');
		expect(r.engine.status.iconizeEnabled).toBe(false);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
	});

	it('slow sync: a half written file keeps the last good copy and removes nothing', async () => {
		const r = await rig({ 'A.md': 'Body', 'B.md': 'Body' }, { 'A.md': 'LiHouse', 'B.md': 'LiStar' });
		await r.engine.run(true);
		await r.setData('{"A.md":"LiHouse","B.m');
		await r.engine.run(true);
		expect(r.engine.status.state).toBe('broken');
		expect(r.fm('B.md')).toEqual({ icon: 'LiStar' });
		await r.setData({ 'A.md': 'LiHouse', 'B.md': 'LiMoon' });
		await r.engine.run(true);
		expect(r.engine.status.state).toBe('ok');
		expect(r.fm('B.md')).toEqual({ icon: 'LiMoon' });
	});

	it('poll: reads at start, then waits until the file is the same for two polls', async () => {
		const r = await rig({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		const read = vi.spyOn(r.app.vault.adapter, 'read');
		await r.engine.tick();
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
		const reads = read.mock.calls.filter((c) => c[0] === DATA).length;
		await r.engine.tick();
		expect(read.mock.calls.filter((c) => c[0] === DATA).length).toBe(reads);
		await r.setData({ 'A.md': 'LiStarHalf' });
		await r.engine.tick();
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
		await r.engine.tick();
		expect(r.fm('A.md')).toEqual({ icon: 'LiStarHalf' });
	});

	it('a note without metadata at the first run is done at a later poll', async () => {
		const r = await rig({ 'A.md': 'Body' }, { 'A.md': 'LiHouse' });
		const real = r.app.metadataCache.getFileCache.bind(r.app.metadataCache);
		r.app.metadataCache.getFileCache = () => null;
		await r.engine.tick();
		expect(r.engine.status.waiting).toBe(1);
		expect(r.fm('A.md')).toEqual({});
		r.app.metadataCache.getFileCache = real;
		await r.engine.tick();
		expect(r.engine.status.waiting).toBe(0);
		expect(r.fm('A.md')).toEqual({ icon: 'LiHouse' });
	});

	it('large vault: 3,000 equal values give no write; 3,000 new values are written in chunks', async () => {
		const files: Record<string, string> = {};
		const data: Record<string, string> = {};
		for (let i = 0; i < 3000; i++) {
			files[`n/${i}.md`] = i % 2 ? '---\nicon: LiHouse\n---\n' : 'x';
			data[`n/${i}.md`] = 'LiHouse';
		}
		const r = await rig(files, data);
		const pfm = vi.spyOn(r.app.fileManager, 'processFrontMatter');
		await r.engine.run(true);
		expect(pfm).toHaveBeenCalledTimes(1500);
		pfm.mockClear();
		await r.engine.run(true);
		expect(pfm).toHaveBeenCalledTimes(0);
		expect(r.engine.status.counts.notes).toBe(3000);
	});

	it('unload during a run stops between chunks', async () => {
		const files: Record<string, string> = {};
		const data: Record<string, string> = {};
		for (let i = 0; i < 1000; i++) {
			files[`n/${i}.md`] = 'x';
			data[`n/${i}.md`] = 'LiHouse';
		}
		const r = await rig(files, data);
		const p = r.engine.run(true);
		await new Promise((res) => setTimeout(res, 0));
		r.engine.stop();
		await p;
		const written = Object.keys(r.ledger).length;
		expect(written).toBeLessThan(1000);
		await r.engine.run(true);
		expect(Object.keys(r.ledger).length).toBe(written);
	});

	it('Pro: extra properties with a format and folder notes; off without Pro', async () => {
		const r = await rig({ 'A.md': 'Body', 'Work/Work.md': 'Folder note' }, { 'A.md': 'LiArrowBigDown', Work: 'LiBriefcase' });
		r.settings = { ...r.settings, extra1Property: 'lucide', folderNotes: true };
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'LiArrowBigDown' });
		expect(r.fm('Work/Work.md')).toEqual({});
		r.pro = true;
		await r.engine.run(false);
		expect(r.fm('A.md')).toEqual({ icon: 'LiArrowBigDown', lucide: 'arrow-big-down' });
		expect(r.fm('Work/Work.md')).toEqual({ folderIcon: 'LiBriefcase' });
		// Pro off again: the values that Pro wrote stay as they are, and Iconize changes no longer reach them.
		r.pro = false;
		await r.setData({ 'A.md': 'LiStar', Work: 'LiBriefcase' });
		await r.engine.run(true);
		expect(r.fm('A.md')).toEqual({ icon: 'LiStar', lucide: 'arrow-big-down' });
		expect(r.fm('Work/Work.md')).toEqual({ folderIcon: 'LiBriefcase' });
	});
});
