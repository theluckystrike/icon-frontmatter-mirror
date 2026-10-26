import { Notice, Plugin, TFile } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { setupHello } from './hello/index';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, IconFrontmatterMirrorSettingTab, effectiveOptions, normalizeSettings, propertyRoles, retiredNames, statusText, type IconFrontmatterMirrorSettings } from './settings';
import { MirrorEngine, type Ledger } from './engine';
import { ConfirmModal, ConflictModal } from './conflicts';
import WHATS_NEW from './whats-new.json';

/** How often to ask the license state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;

interface SavedData extends Partial<IconFrontmatterMirrorSettings> {
	ledger?: unknown;
}

/** Keeps only string values of string-keyed objects, so a hand-edited data.json never breaks the ledger. */
export function normalizeLedger(raw: unknown): Ledger {
	const out: Ledger = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const [path, props] of Object.entries(raw as Record<string, unknown>)) {
		if (!props || typeof props !== 'object' || Array.isArray(props)) continue;
		const clean: Record<string, string> = {};
		for (const [k, v] of Object.entries(props as Record<string, unknown>)) if (typeof v === 'string') clean[k] = v;
		if (Object.keys(clean).length) out[path] = clean;
	}
	return out;
}

export default class IconFrontmatterMirrorPlugin extends Plugin {
	settings: IconFrontmatterMirrorSettings = { ...DEFAULT_SETTINGS };
	ledger: Ledger = {};
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	engine: MirrorEngine | null = null;
	private settingTab: IconFrontmatterMirrorSettingTab | null = null;
	private pollId: number | null = null;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.register(
			pro.onChange(() => {
				this.settingTab?.update();
				void this.engine?.run(false);
			}),
		);
		this.settingTab = new IconFrontmatterMirrorSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		const engine = new MirrorEngine({
			app: this.app,
			options: (iconField, colorField, reads) => effectiveOptions(this.settings, isPro(), iconField, colorField, reads),
			ledger: () => this.ledger,
			save: () => this.saveAll(),
			changed: () => this.settingTab?.update(),
			notify: (message) => new Notice(message, 10000),
		});
		this.engine = engine;
		this.register(() => engine.stop());

		this.addCommand({
			id: 'mirror-now',
			name: 'Mirror icons now',
			callback: () => void this.mirrorNow(),
		});
		this.addCommand({
			id: 'apply-held-removals',
			name: 'Apply held icon removals',
			callback: () => this.confirmHeldRemovals(),
		});
		this.addCommand({
			id: 'show-conflicts',
			name: 'Show icon conflicts',
			callback: () => this.showConflicts(),
		});

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) engine.renamed(file.path, oldPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) engine.deleted(file.path);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
			this.startPolling();
		});
	}

	onunload(): void {
		this.engine?.stop();
		resetPro();
	}

	/** Vault events do not fire for files in the config folder, so the plugin polls the stat of the Iconize data file. */
	private startPolling(): void {
		if (this.pollId !== null) window.clearInterval(this.pollId);
		this.pollId = this.registerInterval(window.setInterval(() => void this.engine?.tick(), this.settings.pollSeconds * 1000));
		void this.engine?.tick();
	}

	async mirrorNow(): Promise<void> {
		const engine = this.engine;
		if (!engine) return;
		await engine.run(true);
		await engine.idle();
		const st = engine.status;
		new Notice(st.state === 'ok' ? `Icon Frontmatter Mirror. ${statusText(st, engine.dataPath)}` : statusText(st, engine.dataPath));
	}

	showConflicts(): void {
		const engine = this.engine;
		if (!engine) return;
		new ConflictModal(this.app, engine.status.conflicts, (list) => engine.resolveConflicts(list)).open();
	}

	/** Asks the user, then removes the values that the mass removal guard held. */
	confirmHeldRemovals(): void {
		const engine = this.engine;
		if (!engine) return;
		const held = engine.status.heldRemovals;
		if (held === 0) {
			new Notice('No held icon removals.');
			return;
		}
		new ConfirmModal(
			this.app,
			'Apply held icon removals',
			`The plugin held the removal of icon values from ${held} notes. Check that Iconize has its data first. Remove these values now?`,
			'Remove the values',
			async () => {
				const n = await engine.applyHeldRemovals();
				new Notice(`Removed ${n} icon values.`);
			},
		).open();
	}

	/**
	 * Applies a settings change. When a property name changes in its role (for example the icon property), the
	 * values that the plugin wrote under the old name are removed, and the next run writes the new name.
	 */
	async updateSettings(patch: Partial<IconFrontmatterMirrorSettings>): Promise<void> {
		const engine = this.engine;
		const roles = () => {
			const f = engine?.iconizeFields() ?? { icon: null, color: null, frontmatter: false };
			return propertyRoles(this.settings, isPro(), f.icon, f.color, f.frontmatter);
		};
		const before = roles();
		const oldPoll = this.settings.pollSeconds;
		this.settings = normalizeSettings({ ...this.settings, ...patch });
		await this.saveAll();
		const after = roles();
		if (this.settings.pollSeconds !== oldPoll) this.startPolling();
		if (engine) {
			for (const name of retiredNames(before, after)) await engine.retireProperty(name);
			await engine.run(false);
		}
		this.settingTab?.update();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as SavedData | null;
		this.settings = normalizeSettings(data);
		this.ledger = normalizeLedger(data?.ledger);
	}

	async saveAll(): Promise<void> {
		await this.saveData({ ...this.settings, ledger: this.ledger });
	}
}
