import { Modal, Notice, type App } from 'obsidian';
import type { Conflict } from './engine';

/** Rows shown in the list. The button applies to all conflicts, also to those not shown. */
const SHOWN = 200;

/** Lists the notes whose property has another value than Iconize. Nothing changes until the user selects the button. */
export class ConflictModal extends Modal {
	constructor(
		app: App,
		private conflicts: Conflict[],
		private resolve: (list: Conflict[]) => Promise<number>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle('Icon conflicts');
		contentEl.addClass('ifm-conflicts');
		if (this.conflicts.length === 0) {
			contentEl.createEl('p', { text: 'No conflicts. Each note property agrees with the icon data or was empty.' });
			return;
		}
		contentEl.createEl('p', {
			text: `${this.conflicts.length} ${this.conflicts.length === 1 ? 'property has' : 'properties have'} another value than Iconize. The plugin did not change them.`,
		});
		const list = contentEl.createEl('ul', { cls: 'ifm-conflict-list' });
		for (const c of this.conflicts.slice(0, SHOWN)) {
			const li = list.createEl('li');
			li.createSpan({ text: c.path, cls: 'ifm-conflict-path' });
			li.createSpan({ text: ` property ${c.property}, note value "${c.current}", Iconize value "${c.iconize}"` });
		}
		if (this.conflicts.length > SHOWN) contentEl.createEl('p', { text: `And ${this.conflicts.length - SHOWN} more.` });
		const row = contentEl.createDiv({ cls: 'modal-button-container' });
		const use = row.createEl('button', { text: 'Replace with the icons from the data file', cls: 'mod-warning' });
		use.addEventListener('click', () => {
			use.disabled = true;
			void this.resolve(this.conflicts).then((n) => {
				new Notice(`Replaced ${n} values with the Iconize icons.`);
				this.close();
			});
		});
		const keep = row.createEl('button', { text: 'Keep the note values' });
		keep.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Asks once before an action that removes values from notes. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private confirmText: string,
		private onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.createEl('p', { text: this.message });
		const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const ok = row.createEl('button', { text: this.confirmText, cls: 'mod-warning' });
		ok.addEventListener('click', () => {
			ok.disabled = true;
			void this.onConfirm().then(() => this.close());
		});
		row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
