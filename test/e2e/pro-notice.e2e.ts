import { browser, expect } from '@wdio/globals';
import type IconFrontmatterMirrorPlugin from '../../src/main';
import type { SponsorsManager } from '../../src/license/index';

// A free user can select the Pro options of the settings tab. A select shows the shared Pro notice with the
// "Sponsor on GitHub" button. Nothing is saved, and the row shows the value in effect. A Pro user turns folder notes on.
type Host = { plugins: { plugins: Record<string, IconFrontmatterMirrorPlugin> }; setting: { open(): void; close(): void; openTabById(id: string): void; activeTab?: { containerEl: HTMLElement } } };
const EXTRA = 'Extra icon properties need Pro.';
const FOLDER = 'Folder icons in folder notes need Pro.';

async function setPro(on: boolean): Promise<boolean> {
	return browser.executeObsidian(async ({ app }, enabled) => {
		const p = (app as unknown as Host).plugins.plugins['icon-frontmatter-mirror']!;
		const pro = p.pro as SponsorsManager;
		if (!enabled) { pro.signOut(); return pro.isPro(); }
		// Synthetic token store and HTTP answer. No network request or Keychain key.
		let token: string | null = 'gho_' + '0'.repeat(36);
		pro.opts.tokens.get = () => token; pro.opts.tokens.set = (v) => { token = v; }; pro.opts.tokens.clear = () => { token = null; };
		pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader', totalSponsorshipAmountAsSponsorInCents: 1500 }, user: { viewerIsSponsoring: true, sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		await pro.refreshNow();
		return pro.isPro();
	}, on);
}

async function openTab(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		const s = (app as unknown as Host).setting; s.open(); s.openTabById('icon-frontmatter-mirror');
		(window as unknown as { activeWindow: Window }).activeWindow.document.querySelectorAll('.notice').forEach((n) => n.remove());
	});
}

/** The row with this name: its toggle state or text value. With act, a real select: focus and click the toggle, or type a key. */
async function row(name: string, act: 'click' | 'type' | null) {
	return browser.executeObsidian(({ app }, name, act) => {
		const root = (app as unknown as Host).setting.activeTab?.containerEl ?? document.body;
		const item = [...root.querySelectorAll<HTMLElement>('.setting-item')].find((r) => r.querySelector('.setting-item-name')?.textContent === name);
		if (!item) return null;
		const box = item.querySelector<HTMLElement>('.checkbox-container');
		const text = item.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
		const disabled = item.classList.contains('is-disabled') || !!text?.disabled || !!box?.classList.contains('is-disabled');
		if (act === 'click' && box) { box.focus(); box.click(); }
		if (act === 'type' && text) { text.focus(); text.value = text.value + 'x'; text.dispatchEvent(new Event('input', { bubbles: true })); text.dispatchEvent(new Event('change', { bubbles: true })); }
		return { disabled, on: box ? box.classList.contains('is-enabled') : null, value: text ? text.value : null };
	}, name, act);
}

async function state() {
	return browser.executeObsidian(async ({ app }) => {
		const p = (app as unknown as Host).plugins.plugins['icon-frontmatter-mirror']!;
		return {
			notices: [...(window as unknown as { activeWindow: Window }).activeWindow.document.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', sponsor: n.querySelectorAll('.pf-pro-notice-sponsor').length })),
			saved: JSON.stringify((await p.loadData())?.settings ?? (await p.loadData()) ?? {}),
			settings: JSON.stringify(p.settings),
		};
	});
}

describe('Pro options of the settings tab', function () {
	afterEach(async () => {
		await setPro(false);
		await browser.executeObsidian(async ({ app }) => {
			const p = (app as unknown as Host).plugins.plugins['icon-frontmatter-mirror']!;
			await p.updateSettings({ folderNotes: false });
			(app as unknown as Host).setting.close();
		});
	});

	it('a free user who selects Folder icons to folder notes or types in Extra property 1 gets the Pro notice with a Sponsor button, and nothing is saved', async () => {
		expect(await setPro(false)).toBe(false);
		await openTab();
		const before = await state();
		const folder = await row('Folder icons to folder notes', 'click');
		expect(folder?.disabled).toBe(false);
		await browser.pause(400);
		expect((await row('Folder icons to folder notes', null))?.on).toBe(false);
		const extra = await row('Extra property 1', 'type');
		expect(extra?.disabled).toBe(false);
		await browser.pause(400);
		expect((await row('Extra property 1', null))?.value).toBe('');
		const after = await state();
		if (!after.notices.some((n) => n.text.includes(FOLDER) && n.sponsor === 1)) throw new Error(`No folder Pro notice: ${JSON.stringify(after.notices)}`);
		if (!after.notices.some((n) => n.text.includes(EXTRA) && n.sponsor === 1)) throw new Error(`No extra Pro notice: ${JSON.stringify(after.notices)}`);
		expect(after.settings).toBe(before.settings);
		expect(after.saved).toBe(before.saved);
	});

	it('a Pro user who selects Folder icons to folder notes turns it on, with no Pro notice', async () => {
		expect(await setPro(true)).toBe(true);
		await openTab();
		await row('Folder icons to folder notes', 'click');
		await browser.pause(400);
		expect((await row('Folder icons to folder notes', null))?.on).toBe(true);
		const after = await state();
		expect(after.settings).toContain('"folderNotes":true');
		expect(after.notices.filter((n) => n.sponsor > 0)).toEqual([]);
	});
});
