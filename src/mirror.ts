// Pure logic of the mirror: parse the Iconize data file, plan the wanted properties, decide each write.
// No Obsidian imports here, so the golden vectors (packages/spec/vectors/icon-frontmatter-mirror.json) test it directly.

/** The plugin id of Iconize (Iconize manifest.json). Its data file is <configDir>/plugins/<id>/data.json. */
export const ICONIZE_ID = 'obsidian-icon-folder';

/** One icon from the Iconize data file. */
export interface IconEntry {
	icon: string;
	color: string | null;
}

export type ParseResult =
	| {
			ok: true;
			icons: Record<string, IconEntry>;
			/** iconInFrontmatterFieldName from the Iconize settings, or null when it is not set. */
			iconField: string | null;
			/** iconColorInFrontmatterFieldName from the Iconize settings, or null when it is not set. */
			colorField: string | null;
			/** iconInFrontmatterEnabled from the Iconize settings: Iconize reads the icon back from the note. */
			frontmatterEnabled: boolean;
	  }
	| { ok: false; error: string };

function nonEmpty(v: unknown): string | null {
	return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Parses the text of the Iconize data.json. A string value is the icon. An object value gives iconName and
 * iconColor. The key "settings" holds the Iconize settings and is never an icon.
 */
export function parseIconizeData(text: string): ParseResult {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { ok: false, error: 'not valid JSON' };
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'not a JSON object' };
	const icons: Record<string, IconEntry> = {};
	let iconField: string | null = null;
	let colorField: string | null = null;
	let frontmatterEnabled = false;
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (key === 'settings') {
			if (value && typeof value === 'object') {
				const s = value as Record<string, unknown>;
				iconField = nonEmpty(s.iconInFrontmatterFieldName)?.trim() ?? null;
				colorField = nonEmpty(s.iconColorInFrontmatterFieldName)?.trim() ?? null;
				frontmatterEnabled = s.iconInFrontmatterEnabled === true;
			}
			continue;
		}
		if (key === '') continue;
		const icon = typeof value === 'string' ? nonEmpty(value) : value && typeof value === 'object' ? nonEmpty((value as Record<string, unknown>).iconName) : null;
		if (!icon) continue;
		const color = value && typeof value === 'object' ? nonEmpty((value as Record<string, unknown>).iconColor) : null;
		icons[key] = { icon, color };
	}
	return { ok: true, icons, iconField, colorField, frontmatterEnabled };
}

/**
 * stored = as Iconize stores it (LiHouse). name = without the icon pack prefix (House). kebab = house, arrow-big-down.
 * Kebab keeps a run of digits together (Clock12 gives clock-12), because the Iconize name does not keep the dashes.
 */
export type IconFormat = 'stored' | 'name' | 'kebab';

/** True for a pack icon name such as LiHouse. Emoji and other text are not pack names. */
function isPackName(icon: string): boolean {
	return /^[A-Z][a-z]*[A-Z0-9][A-Za-z0-9]*$/.test(icon);
}

/** Formats an icon for a property. Emoji and other text stay as they are in each format. */
export function formatIcon(icon: string, format: IconFormat): string {
	if (format === 'stored' || !isPackName(icon)) return icon;
	// Same split as Iconize nextIdentifier: the prefix ends before the first capital letter or digit after index 0.
	const cut = icon.slice(1).search(/[A-Z0-9]/) + 1;
	const name = icon.slice(cut);
	if (format === 'name') return name;
	return name
		.replace(/([a-z])([A-Z0-9])/g, '$1-$2')
		.replace(/([0-9])([A-Za-z])/g, '$1-$2')
		.replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
		.toLowerCase();
}

export type FolderNoteMode = 'same-name' | 'index';

/** The folder note of a folder: Folder/Folder.md (same-name) or Folder/index.md (index). */
export function folderNotePath(folder: string, mode: FolderNoteMode): string {
	const base = folder.split('/').pop() ?? folder;
	return mode === 'index' ? `${folder}/index.md` : `${folder}/${base}.md`;
}

export interface ExtraProperty {
	property: string;
	format: IconFormat;
}

export interface PlanOptions {
	iconProperty: string;
	/** Null when the color is not mirrored. */
	colorProperty: string | null;
	/** Pro: more properties with a format each. Empty without Pro. */
	extras: ExtraProperty[];
	/** Pro: folder icons go to the folder note. Null without Pro or when off. */
	folderNotes: { mode: FolderNoteMode; property: string } | null;
}

/** What a path in the vault is: a Markdown note, a folder, another file, or nothing. */
export type PathKind = 'md' | 'folder' | 'other' | 'missing';

export interface Plan {
	/** Note path to property name to wanted value. */
	wanted: Record<string, Record<string, string>>;
	counts: { notes: number; folders: number; folderNotes: number; other: number; missing: number };
}

/**
 * Plans the wanted properties of each note. Only Markdown notes get properties: folders have no frontmatter.
 * kinds gives the kind of each path; a path not in kinds counts as missing.
 */
export function planWanted(icons: Record<string, IconEntry>, kinds: Record<string, PathKind>, opts: PlanOptions): Plan {
	const wanted: Record<string, Record<string, string>> = {};
	const counts = { notes: 0, folders: 0, folderNotes: 0, other: 0, missing: 0 };
	const put = (note: string, prop: string, value: string) => {
		const props = (wanted[note] ??= {});
		props[prop] = value;
	};
	for (const [path, entry] of Object.entries(icons)) {
		const kind = kinds[path] ?? 'missing';
		if (kind === 'md') {
			counts.notes++;
			put(path, opts.iconProperty, entry.icon);
			if (opts.colorProperty && entry.color) put(path, opts.colorProperty, entry.color);
			for (const x of opts.extras) put(path, x.property, formatIcon(entry.icon, x.format));
		} else if (kind === 'folder') {
			counts.folders++;
			if (opts.folderNotes) {
				const note = folderNotePath(path, opts.folderNotes.mode);
				if (kinds[note] === 'md') {
					counts.folderNotes++;
					put(note, opts.folderNotes.property, entry.icon);
				}
			}
		} else if (kind === 'other') counts.other++;
		else counts.missing++;
	}
	return { wanted, counts };
}

/**
 * keep = the value is already right (the ledger takes it). set = write the target. remove = delete the property.
 * conflict = the user has another value: no write. forget = drop the ledger entry, no write. none = nothing.
 */
export type Decision = 'keep' | 'set' | 'remove' | 'conflict' | 'forget' | 'none';

/** True when a frontmatter value counts as no value. */
export function isEmptyValue(v: unknown): boolean {
	return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

/**
 * Decides one property of one note. current is the frontmatter value now, target the value from Iconize (null when
 * Iconize has no icon), ledger the value that this plugin last wrote or found equal (null when none).
 */
export function decide(current: unknown, target: string | null, ledger: string | null): Decision {
	const empty = isEmptyValue(current);
	if (target !== null) {
		if (current === target) return 'keep';
		if (empty) return 'set';
		if (ledger !== null && current === ledger) return 'set';
		return 'conflict';
	}
	if (ledger === null) return 'none';
	if (!empty && current === ledger) return 'remove';
	return 'forget';
}

/**
 * A removal is safe only when the data file was written after the last rename of the note. Iconize moves its key
 * when it saves after the rename event, so an older read still lists the old path.
 */
export function removalAllowed(dataMtime: number, renamedAt: number | undefined): boolean {
	return renamedAt === undefined || dataMtime > renamedAt;
}

/**
 * A key of the frontmatter that differs from prop only in letter case (Icon for icon), or null. Obsidian shows such
 * keys as two properties, so the plugin treats a case twin with a value as a conflict and never adds a second key.
 */
export function findCaseTwin(keys: string[], prop: string): string | null {
	const low = prop.toLowerCase();
	return keys.find((k) => k !== prop && k.toLowerCase() === low) ?? null;
}

/**
 * Removals in one pass above this number of notes wait for the user. Iconize removes one icon for each action, so a
 * normal pass removes 1 or 2 values. A larger count comes from a reset, a reinstall or a data file that a sync tool
 * has not brought yet, and a sync tool would spread those removals to every device.
 */
export const REMOVAL_LIMIT = 10;

/**
 * True when the removals of one pass must wait for the user: more than REMOVAL_LIMIT notes, or any removal while the
 * data file has no icons at all (Iconize writes a file with settings only when it starts without its data).
 */
export function holdRemovals(notes: number, icons: number, limit: number = REMOVAL_LIMIT): boolean {
	return notes > 0 && (icons === 0 || notes > limit);
}
