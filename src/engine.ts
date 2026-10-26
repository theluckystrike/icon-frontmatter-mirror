// The mirror engine: polls the Iconize data file, plans the wanted properties and writes them with
// processFrontMatter. It never writes the Iconize data file.
import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import { ICONIZE_ID, decide, findCaseTwin, holdRemovals, isEmptyValue, parseIconizeData, planWanted, removalAllowed, type IconEntry, type PathKind, type PlanOptions, type Plan, type Decision } from './mirror';

/** Note path to property name to the value that the plugin last wrote or found equal. */
export type Ledger = Record<string, Record<string, string>>;

export interface Conflict {
	path: string;
	property: string;
	current: string;
	iconize: string;
}

export type MirrorState = 'starting' | 'ok' | 'missing' | 'broken';

export interface MirrorStatus {
	state: MirrorState;
	/** True or false from community-plugins.json; null when that file cannot be read. */
	iconizeEnabled: boolean | null;
	counts: Plan['counts'];
	/** Properties written and removed by the last run. */
	written: number;
	removed: number;
	conflicts: Conflict[];
	/** Notes that had no metadata yet; they are done on a later run. */
	waiting: number;
	/** Notes whose removals wait for the user (mass removal guard, mirror.ts holdRemovals). */
	heldRemovals: number;
	lastRun: number | null;
}

export interface MirrorHost {
	app: App;
	/** The plan options from the settings and the Pro state, with the field names that Iconize uses. */
	options(iconField: string | null, colorField: string | null, iconizeReadsFrontmatter: boolean): PlanOptions;
	ledger(): Ledger;
	/** Saves the ledger (and the settings) to the plugin data. */
	save(): Promise<void>;
	/** Called after each run and each status change. */
	changed(): void;
	/** Shows a message to the user (a Notice in the app). */
	notify(message: string): void;
}

/**
 * decide() with one more rule: when the exact key is empty but a key that differs only in case (Icon for icon) has a
 * value, it is a conflict. The plugin never adds a second key that Obsidian shows as a duplicate property.
 */
function decideIn(fm: Record<string, unknown>, prop: string, target: string | null, ledger: string | null): { d: Decision; current: unknown } {
	if (target !== null && isEmptyValue(fm[prop])) {
		const twin = findCaseTwin(Object.keys(fm), prop);
		if (twin !== null && !isEmptyValue(fm[twin])) return { d: 'conflict', current: fm[twin] };
	}
	return { d: decide(fm[prop], target, ledger), current: fm[prop] };
}

/** Notes handled before the engine yields to the app. */
export const CHUNK = 200;

const EMPTY_COUNTS = { notes: 0, folders: 0, folderNotes: 0, other: 0, missing: 0 };

function text(v: unknown): string {
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

export class MirrorEngine {
	readonly dataPath: string;
	status: MirrorStatus = { state: 'starting', iconizeEnabled: null, counts: { ...EMPTY_COUNTS }, written: 0, removed: 0, conflicts: [], waiting: 0, heldRemovals: 0, lastRun: null };
	/** The last good parse of the data file and the mtime of that read. */
	private icons: Record<string, IconEntry> | null = null;
	private fields: { icon: string | null; color: string | null; frontmatter: boolean } = { icon: null, color: null, frontmatter: false };
	/** True for one run after the user confirms the held removals. */
	private allowMass = false;
	private dataMtime = 0;
	/** mtime and size of the file that the last read used, and of the last stat (debounce of slow writers). */
	private appliedSig: string | null = null;
	private seenSig: string | null = null;
	private running: Promise<void> | null = null;
	private again = false;
	private stopped = false;
	/** Note path to the time of its last rename (ms). */
	private renamedAt = new Map<string, number>();

	constructor(private host: MirrorHost) {
		this.dataPath = normalizePath(`${host.app.vault.configDir}/plugins/${ICONIZE_ID}/data.json`);
	}

	stop(): void {
		this.stopped = true;
	}

	/**
	 * One poll. Reads the data file only when its mtime or size changed and then stayed the same for one more poll.
	 * A sync tool that writes the file slowly changes it on each poll, so the read waits until it is complete.
	 */
	async tick(): Promise<void> {
		if (this.stopped || this.running) return;
		const stat = await this.host.app.vault.adapter.stat(this.dataPath).catch(() => null);
		if (!stat || stat.type !== 'file') {
			this.seenSig = null;
			this.appliedSig = null;
			if (this.status.state !== 'missing') {
				this.status.state = 'missing';
				await this.checkEnabled();
				this.host.changed();
			}
			return;
		}
		const sig = `${stat.mtime}:${stat.size}`;
		if (sig === this.appliedSig) {
			// Notes that had no metadata at the last run: try them again with the same data.
			if (this.status.waiting > 0) await this.run(false);
			return;
		}
		if (sig !== this.seenSig) {
			this.seenSig = sig;
			// The first poll after start reads at once; later changes wait one poll.
			if (this.appliedSig !== null || this.status.state !== 'starting') return;
		}
		await this.run(true);
	}

	/** Reads the data file again (when read is true) and applies it. Only one run is active at a time. */
	async run(read: boolean): Promise<void> {
		if (this.stopped) return;
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				do {
					this.again = false;
					if (read) await this.read();
					await this.apply();
					read = false;
				} while (this.again && !this.stopped);
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	/** Resolves when no run is active. */
	async idle(): Promise<void> {
		while (this.running) await this.running;
	}

	private async checkEnabled(): Promise<void> {
		try {
			const list = JSON.parse(await this.host.app.vault.adapter.read(normalizePath(`${this.host.app.vault.configDir}/community-plugins.json`))) as unknown;
			this.status.iconizeEnabled = Array.isArray(list) ? list.includes(ICONIZE_ID) : null;
		} catch {
			this.status.iconizeEnabled = null;
		}
	}

	private async read(): Promise<void> {
		await this.checkEnabled();
		const adapter = this.host.app.vault.adapter;
		const stat = await adapter.stat(this.dataPath).catch(() => null);
		if (!stat || stat.type !== 'file') {
			this.status.state = 'missing';
			this.appliedSig = null;
			return;
		}
		let raw: string;
		try {
			raw = await adapter.read(this.dataPath);
		} catch {
			this.status.state = 'missing';
			return;
		}
		this.appliedSig = `${stat.mtime}:${stat.size}`;
		this.seenSig = this.appliedSig;
		const parsed = parseIconizeData(raw);
		if (!parsed.ok) {
			// Keep the last good copy. Write nothing until the file changes again.
			this.status.state = 'broken';
			return;
		}
		this.icons = parsed.icons;
		this.fields = { icon: parsed.iconField, color: parsed.colorField, frontmatter: parsed.frontmatterEnabled };
		this.dataMtime = stat.mtime;
		this.status.state = 'ok';
	}

	private kindOf(path: string): PathKind {
		const f = this.host.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) return f.extension === 'md' ? 'md' : 'other';
		if (f instanceof TFolder) return 'folder';
		return 'missing';
	}

	/**
	 * The plan, and the properties that this run manages. A property that is not managed now (a Pro property
	 * without Pro, an old property name, the color when color is off) keeps its value and its ledger entry.
	 */
	private plan(): Plan & { managed: Set<string> } {
		const icons = this.icons ?? {};
		const opts = this.host.options(this.fields.icon, this.fields.color, this.fields.frontmatter);
		const managed = new Set([opts.iconProperty, ...(opts.colorProperty ? [opts.colorProperty] : []), ...opts.extras.map((x) => x.property), ...(opts.folderNotes ? [opts.folderNotes.property] : [])]);
		const kinds: Record<string, PathKind> = {};
		for (const path of Object.keys(icons)) {
			const kind = this.kindOf(path);
			kinds[path] = kind;
			if (kind === 'folder' && opts.folderNotes) {
				const base = path.split('/').pop() ?? path;
				for (const note of [`${path}/${base}.md`, `${path}/index.md`]) kinds[note] = this.kindOf(note);
			}
		}
		return { ...planWanted(icons, kinds, opts), managed };
	}

	/** Applies the last good data to the notes. Does nothing while the data file is missing or was never read. */
	private async apply(): Promise<void> {
		if (this.icons === null || this.status.state !== 'ok') {
			this.host.changed();
			return;
		}
		const { app } = this.host;
		const ledger = this.host.ledger();
		const plan = this.plan();
		const notes = new Set([...Object.keys(plan.wanted), ...Object.keys(ledger)]);
		const conflicts: Conflict[] = [];
		let written = 0;
		let removed = 0;
		let waiting = 0;
		let ledgerChanged = false;
		let n = 0;
		/** Removals wait until the loop ends, so the mass removal guard sees their count first. */
		const removals: { file: TFile; props: string[]; had: Record<string, string> }[] = [];
		for (const path of notes) {
			if (this.stopped) return;
			if (++n % CHUNK === 0) await new Promise<void>((r) => window.setTimeout(r, 0));
			const file = app.vault.getFileByPath(path);
			if (!file || file.extension !== 'md') continue;
			const cache = app.metadataCache.getFileCache(file);
			if (!cache) {
				waiting++;
				continue;
			}
			const fm = (cache.frontmatter ?? {}) as Record<string, unknown>;
			const want = plan.wanted[path] ?? {};
			const had = ledger[path] ?? {};
			const props = new Set([...Object.keys(want), ...Object.keys(had).filter((p) => plan.managed.has(p))]);
			const writes: string[] = [];
			const removes: string[] = [];
			for (const prop of props) {
				const { d, current } = decideIn(fm, prop, want[prop] ?? null, had[prop] ?? null);
				if (d === 'keep' || d === 'forget') {
					// The ledger holds only values that the plugin wrote. An equal value that the user typed stays the user's.
					if (prop in had && had[prop] !== want[prop]) ledgerChanged = this.setLedger(ledger, path, prop, null) || ledgerChanged;
				} else if (d === 'conflict') {
					conflicts.push({ path, property: prop, current: text(current), iconize: want[prop]! });
				} else if (d === 'set') {
					writes.push(prop);
				} else if (d === 'remove' && removalAllowed(this.dataMtime, this.renamedAt.get(path))) {
					removes.push(prop);
				}
			}
			if (removes.length) removals.push({ file, props: removes, had: { ...had } });
			if (writes.length === 0) continue;
			const result = await this.write(file, writes, want, had);
			written += result.written;
			removed += result.removed;
			conflicts.push(...result.conflicts);
			ledgerChanged = ledgerChanged || result.written + result.removed > 0;
		}
		let held = 0;
		const iconCount = Object.keys(this.icons).length;
		if (!this.allowMass && holdRemovals(removals.length, iconCount)) {
			held = removals.length;
			if (held !== this.status.heldRemovals) {
				this.host.notify(
					`Icon Frontmatter Mirror held ${held} icon removals${iconCount === 0 ? ', because the Iconize data has no icons' : ''}. Check Iconize, then run "Apply held icon removals" if you want them.`,
				);
			}
		} else {
			for (const r of removals) {
				if (this.stopped) return;
				const result = await this.write(r.file, r.props, {}, r.had);
				removed += result.removed;
				ledgerChanged = ledgerChanged || result.removed > 0;
			}
		}
		this.allowMass = false;
		this.status = { ...this.status, counts: plan.counts, written, removed, conflicts, waiting, heldRemovals: held, lastRun: Date.now() };
		if (ledgerChanged) await this.host.save();
		this.host.changed();
	}

	private setLedger(ledger: Ledger, path: string, prop: string, value: string | null): boolean {
		const props = ledger[path];
		if (value === null) {
			if (!props || !(prop in props)) return false;
			delete props[prop];
			if (Object.keys(props).length === 0) delete ledger[path];
			return true;
		}
		if (props?.[prop] === value) return false;
		(ledger[path] ??= {})[prop] = value;
		return true;
	}

	/**
	 * Writes the planned properties of one note. The callback decides again on the frontmatter of the file, so a
	 * value that the user typed after the metadata cache was read is not lost.
	 */
	private async write(file: TFile, props: string[], want: Record<string, string>, had: Record<string, string>, force = false): Promise<{ written: number; removed: number; conflicts: Conflict[] }> {
		const ledger = this.host.ledger();
		const out = { written: 0, removed: 0, conflicts: [] as Conflict[] };
		const changes: [string, string | null][] = [];
		try {
			await this.host.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				for (const prop of props) {
					const target = want[prop] ?? null;
					const { d, current } = force && target !== null ? { d: 'set' as Decision, current: fm[prop] } : decideIn(fm, prop, target, had[prop] ?? null);
					if (force && target !== null) {
						// The user chose the Iconize value: it replaces a key that differs only in case, so no duplicate stays.
						const twin = findCaseTwin(Object.keys(fm), prop);
						if (twin !== null) delete fm[twin];
					}
					if (d === 'set' && target !== null) {
						fm[prop] = target;
						changes.push([prop, target]);
						out.written++;
					} else if (d === 'remove') {
						delete fm[prop];
						changes.push([prop, null]);
						out.removed++;
					} else if ((d === 'keep' || d === 'forget') && prop in had && had[prop] !== target) {
						changes.push([prop, null]);
					} else if (d === 'conflict' && target !== null) {
						out.conflicts.push({ path: file.path, property: prop, current: text(current), iconize: target });
					}
				}
			});
		} catch (e) {
			// A note with broken YAML: processFrontMatter throws. Skip the note; the next run tries again.
			console.warn(`Icon Frontmatter Mirror: could not update ${file.path}`, e);
			return { written: 0, removed: 0, conflicts: [] };
		}
		for (const [prop, value] of changes) this.setLedger(ledger, file.path, prop, value);
		return out;
	}

	/** The frontmatter field names and the frontmatter option from the last good Iconize read. */
	iconizeFields(): { icon: string | null; color: string | null; frontmatter: boolean } {
		return { ...this.fields };
	}

	/** The plan options in effect, with the field names and the frontmatter option of the last Iconize read. */
	options(): PlanOptions {
		return this.host.options(this.fields.icon, this.fields.color, this.fields.frontmatter);
	}

	/** Applies the removals that the mass removal guard held. Only after the user confirms it. */
	async applyHeldRemovals(): Promise<number> {
		await this.idle();
		this.allowMass = true;
		await this.run(true);
		this.allowMass = false;
		return this.status.removed;
	}

	/**
	 * A property name changed (old to new). Removes the values that the plugin wrote under the old name, so the note
	 * does not keep a stale copy. A value that the user changed stays. The next run writes the new name.
	 */
	async retireProperty(oldName: string): Promise<number> {
		await this.idle();
		const ledger = this.host.ledger();
		let removed = 0;
		let n = 0;
		for (const path of Object.keys(ledger)) {
			if (this.stopped) break;
			if (++n % CHUNK === 0) await new Promise<void>((r) => window.setTimeout(r, 0));
			const had = ledger[path];
			if (!had || !(oldName in had)) continue;
			const file = this.host.app.vault.getFileByPath(path);
			if (!file) continue;
			removed += (await this.write(file, [oldName], {}, { [oldName]: had[oldName]! })).removed;
			// A value that the user changed is the user's now: drop it from the ledger too.
			this.setLedger(ledger, path, oldName, null);
		}
		await this.host.save();
		return removed;
	}

	/** Replaces the values of the given conflicts with the Iconize values. Only after the user selects it. */
	async resolveConflicts(conflicts: Conflict[]): Promise<number> {
		await this.idle();
		let done = 0;
		const byPath = new Map<string, Conflict[]>();
		for (const c of conflicts) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
		for (const [path, list] of byPath) {
			const file = this.host.app.vault.getFileByPath(path);
			if (!file) continue;
			const want = Object.fromEntries(list.map((c) => [c.property, c.iconize]));
			const r = await this.write(file, Object.keys(want), want, {}, true);
			done += r.written;
		}
		await this.host.save();
		await this.run(false);
		return done;
	}

	/** Vault rename: the ledger follows the note, and a stale data file cannot remove its properties. */
	renamed(path: string, oldPath: string): void {
		const ledger = this.host.ledger();
		this.renamedAt.set(path, Date.now());
		const props = ledger[oldPath];
		if (!props) return;
		ledger[path] = { ...(ledger[path] ?? {}), ...props };
		delete ledger[oldPath];
		void this.host.save();
	}

	/** Vault delete: drop the ledger entries of the note. */
	deleted(path: string): void {
		const ledger = this.host.ledger();
		this.renamedAt.delete(path);
		if (!ledger[path]) return;
		delete ledger[path];
		void this.host.save();
	}
}
