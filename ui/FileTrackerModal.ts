import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import type { SyncManifestStore } from "../sync/SyncManifest";
import type { TranscriptionStore, TranscriptionEntry } from "../ai/TranscriptionStore";
import type { AutomationEngine } from "../automation/AutomationEngine";
import type { PluginSettings } from "../types";

const ONE_DAY_MS = 86_400_000;

/** Sentinel pair id for files added to tracking locally (not synced from Drive). DriveSync's
 * removal pass only iterates over configured sync pairs, so these entries are never reconciled. */
export const LOCAL_PAIR_ID = "__local__";

const MICRO_BTN =
	"font-size: 11px; padding: 1px 5px; border-radius: 4px; cursor: pointer; " +
	"border: 1px solid var(--background-modifier-border); " +
	"background: var(--background-secondary); color: var(--text-muted); " +
	"line-height: 1.4; white-space: nowrap;";

type SortCol = "name" | "updated" | "transcribed";

interface Row {
	driveFileId: string;
	vaultPath: string;
	companionPath: string | null;
	pairId: string;
	driveModifiedTime: string;
	ts: TranscriptionEntry | undefined;
	isPdf: boolean;
	transcriptionDisabled: boolean;
}

export class FileTrackerModal extends Modal {
	private filterText = "";
	private sortCol: SortCol = "updated";
	private sortDir: 1 | -1 = -1;

	constructor(
		app: App,
		private manifest: SyncManifestStore,
		private transcriptionStore: TranscriptionStore,
		private settings: PluginSettings,
		private automationEngine: AutomationEngine,
		private onRetranscribe?: (vaultPath: string) => void
	) {
		super(app);
		this.modalEl.addClass("drive-sync-file-tracker");
	}

	onOpen(): void {
		this.modalEl.style.cssText = "width: min(900px, 92vw); max-height: 80vh;";
		this.contentEl.style.cssText = "display: flex; flex-direction: column; height: 100%;";
		this.render();
	}

	private buildRows(): Row[] {
		return this.manifest.entries().map(([driveFileId, entry]) => ({
			driveFileId,
			vaultPath: entry.vaultPath,
			companionPath: entry.companionPath,
			pairId: entry.pairId,
			driveModifiedTime: entry.driveModifiedTime,
			ts: this.transcriptionStore.get(driveFileId),
			isPdf: entry.vaultPath.toLowerCase().endsWith(".pdf"),
			transcriptionDisabled: entry.transcriptionDisabled ?? false,
		}));
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		const pairLabelMap: Record<string, string> = Object.fromEntries(
			this.settings.syncPairs.map((p) => [p.id, p.label])
		);
		pairLabelMap[LOCAL_PAIR_ID] = "Local";

		const allRows = this.buildRows();
		const transcribed = allRows.filter((r) => r.ts).length;

		// ── Header ────────────────────────────────────────────────────────────
		const header = contentEl.createDiv();
		header.style.cssText = "flex-shrink: 0; padding-bottom: 12px;";

		const titleRow = header.createDiv();
		titleRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 8px;";
		titleRow.createEl("h2", { text: "File Tracker" }).style.margin = "0 0 4px";

		const headerBtns = titleRow.createDiv();
		headerBtns.style.cssText = "display: flex; gap: 6px; flex-shrink: 0;";

		const addBtn = headerBtns.createEl("button", { text: "+ Add file…" });
		addBtn.style.cssText = MICRO_BTN;
		addBtn.title = "Track a PDF that already lives in your vault (not synced from Drive)";
		addBtn.addEventListener("click", () => this.promptAddFile());

		const resetBtn = headerBtns.createEl("button", { text: "Reset all tracking" });
		resetBtn.style.cssText = MICRO_BTN + " color: var(--text-error);";
		resetBtn.title = "Stop tracking every file (clears the manifest). Files on disk are not deleted.";
		resetBtn.addEventListener("click", () => this.promptResetAll());

		header.createEl("p", {
			text: `${allRows.length} files tracked · ${transcribed} transcribed`,
			cls: "setting-item-description",
		}).style.margin = "0 0 10px";

		// Search input
		const searchInput = header.createEl("input", {
			type: "text",
			placeholder: "Filter by filename…",
		});
		searchInput.style.cssText =
			"width: 100%; padding: 6px 10px; border-radius: 4px; " +
			"border: 1px solid var(--background-modifier-border); " +
			"background: var(--background-primary); color: var(--text-normal); font-size: 13px;";
		searchInput.value = this.filterText;
		searchInput.addEventListener("input", () => {
			this.filterText = searchInput.value.toLowerCase();
			this.renderTable(tableWrap, allRows, pairLabelMap);
		});

		// ── Scrollable table area ─────────────────────────────────────────────
		const tableWrap = contentEl.createDiv();
		tableWrap.style.cssText = "flex: 1; overflow-y: auto; overflow-x: auto;";

		this.renderTable(tableWrap, allRows, pairLabelMap);
	}

	private renderTable(
		container: HTMLElement,
		allRows: Row[],
		pairLabelMap: Record<string, string>
	): void {
		container.empty();

		// Filter
		const rows = allRows.filter((r) => {
			if (!this.filterText) return true;
			return r.vaultPath.toLowerCase().includes(this.filterText);
		});

		if (rows.length === 0) {
			const msg = container.createEl("p", {
				text: this.filterText ? "No files match your filter." : "No files synced yet.",
				cls: "setting-item-description",
			});
			msg.style.cssText = "padding: 16px 0; text-align: center;";
			return;
		}

		// Sort
		rows.sort((a, b) => {
			let cmp = 0;
			if (this.sortCol === "name") {
				cmp = basename(a.vaultPath).localeCompare(basename(b.vaultPath));
			} else if (this.sortCol === "updated") {
				cmp = a.driveModifiedTime.localeCompare(b.driveModifiedTime);
			} else {
				const ta = a.ts?.lastTranscribedAt ?? "";
				const tb = b.ts?.lastTranscribedAt ?? "";
				cmp = ta.localeCompare(tb);
			}
			return cmp * this.sortDir;
		});

		// ── Table ─────────────────────────────────────────────────────────────
		const table = container.createEl("table");
		table.style.cssText = "width: 100%; border-collapse: collapse; font-size: 13px;";

		// Header row
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");

		type ColDef = { label: string; key: SortCol | null; tip?: string };
		const cols: ColDef[] = [
			{ label: "File", key: "name" },
			{ label: "Pair", key: null },
			{ label: "Drive Updated", key: "updated" },
			{ label: "Transcription", key: "transcribed" },
			{ label: "Pages", key: null, tip: "Page count at last transcription. Arrow shows growth detected on re-download." },
			{ label: "Destinations", key: null },
			{ label: "Actions", key: null },
		];

		for (const col of cols) {
			const th = headerRow.createEl("th");
			const isActive = col.key && this.sortCol === col.key;
			th.textContent =
				col.label + (isActive ? (this.sortDir === 1 ? " ↑" : " ↓") : "");
			th.title = col.tip ?? "";
			th.style.cssText =
				"text-align: left; padding: 6px 10px; " +
				"border-bottom: 2px solid var(--background-modifier-border); " +
				"white-space: nowrap; font-weight: 600; " +
				(col.key ? "cursor: pointer;" : "cursor: default;");
			if (col.key) {
				const key = col.key;
				th.addEventListener("click", () => {
					if (this.sortCol === key) {
						this.sortDir = (this.sortDir * -1) as 1 | -1;
					} else {
						this.sortCol = key;
						this.sortDir = -1;
					}
					this.renderTable(container, allRows, pairLabelMap);
				});
			}
		}

		// Data rows
		const tbody = table.createEl("tbody");
		for (const row of rows) {
			this.renderRow(tbody, row, pairLabelMap);
		}
	}

	private renderRow(
		tbody: HTMLElement,
		row: Row,
		pairLabelMap: Record<string, string>
	): void {
		const tr = tbody.createEl("tr");
		tr.style.cssText = "border-bottom: 1px solid var(--background-modifier-border-hover);";
		tr.addEventListener("mouseenter", () => {
			tr.style.background = "var(--background-modifier-hover)";
		});
		tr.addEventListener("mouseleave", () => {
			tr.style.background = "";
		});

		// ── File ─────────────────────────────────────────────────────────────
		const tdFile = tr.createEl("td");
		tdFile.style.cssText =
			"padding: 7px 10px; max-width: 220px; overflow: hidden; " +
			"text-overflow: ellipsis; white-space: nowrap;";
		const name = basename(row.vaultPath);
		const fileLink = tdFile.createEl("a", { text: name });
		fileLink.title = row.vaultPath;
		fileLink.style.cssText =
			"cursor: pointer; color: var(--link-color); text-decoration: none;";
		fileLink.addEventListener("click", () => this.openFile(row.vaultPath));

		// ── Pair ─────────────────────────────────────────────────────────────
		const tdPair = tr.createEl("td");
		tdPair.style.cssText = "padding: 7px 10px; white-space: nowrap;";
		const pairLabel = pairLabelMap[row.pairId] ?? row.pairId;
		const badge = tdPair.createEl("span", { text: pairLabel });
		badge.style.cssText =
			"font-size: 11px; padding: 2px 7px; border-radius: 10px; " +
			"background: var(--background-modifier-hover); white-space: nowrap;";

		// ── Drive Updated ─────────────────────────────────────────────────────
		const tdDriveUpdated = tr.createEl("td");
		tdDriveUpdated.style.cssText =
			"padding: 7px 10px; white-space: nowrap; color: var(--text-muted);";
		tdDriveUpdated.textContent = relativeTime(row.driveModifiedTime);
		tdDriveUpdated.title = row.driveModifiedTime;

		// ── Transcription status ──────────────────────────────────────────────
		const tdTranscribed = tr.createEl("td");
		tdTranscribed.style.cssText = "padding: 7px 10px;";

		const txWrap = tdTranscribed.createDiv();
		txWrap.style.cssText = "display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;";

		if (!row.ts) {
			const badge2 = txWrap.createEl("span", { text: "—" });
			badge2.style.color = "var(--text-faint)";
		} else {
			const driveUpdatedSince = row.driveModifiedTime !== row.ts.lastTranscribedDriveModifiedTime;

			if (driveUpdatedSince) {
				const chip = txWrap.createEl("span", { text: "⚠ Stale" });
				chip.style.cssText =
					"color: var(--color-orange, #e8a100); font-weight: 500; white-space: nowrap;";
				chip.title =
					`Transcribed ${row.ts.lastTranscribedAt.slice(0, 10)} ` +
					`for Drive version ${row.ts.lastTranscribedDriveModifiedTime.slice(0, 10)}, ` +
					`but Drive file updated ${row.driveModifiedTime.slice(0, 10)}`;
			} else {
				const chip = txWrap.createEl("span", {
					text: "✓ " + relativeTime(row.ts.lastTranscribedAt),
				});
				chip.style.cssText =
					"color: var(--color-green, var(--interactive-success)); white-space: nowrap;";
				chip.title = `Transcribed: ${row.ts.lastTranscribedAt}`;
			}
		}

		if (row.isPdf) {
			// Re-transcribe button
			if (this.onRetranscribe) {
				const btnRetx = txWrap.createEl("button", { text: "↺" });
				btnRetx.title = "Re-transcribe this file";
				btnRetx.style.cssText = MICRO_BTN;
				btnRetx.addEventListener("click", (e) => {
					e.stopPropagation();
					this.close();
					this.onRetranscribe!(row.vaultPath);
				});
			}

			// Disable / enable auto-transcription toggle
			const isOff = row.transcriptionDisabled;
			const btnToggle = txWrap.createEl("button", {
				text: isOff ? "Auto: Off" : "Auto: On",
			});
			btnToggle.title = isOff
				? "Automatic transcription is disabled — click to re-enable"
				: "Click to disable automatic transcription for this file";
			btnToggle.style.cssText =
				MICRO_BTN + (isOff ? " opacity: 0.5;" : "");
			btnToggle.addEventListener("click", async (e) => {
				e.stopPropagation();
				const entry = this.manifest.get(row.driveFileId);
				if (!entry) return;
				this.manifest.set(row.driveFileId, {
					...entry,
					transcriptionDisabled: !isOff,
				});
				await this.manifest.save();
				this.render();
			});
		}

		// ── Pages ─────────────────────────────────────────────────────────────
		const tdPages = tr.createEl("td");
		tdPages.style.cssText =
			"padding: 7px 10px; white-space: nowrap; color: var(--text-muted);";

		if (!row.ts || row.ts.pageCount === 0) {
			tdPages.textContent = "—";
		} else {
			const atTx = row.ts.pageCount;
			const current = row.ts.currentPageCount ?? atTx;
			if (current > atTx) {
				tdPages.textContent = `${atTx} → ${current} pp`;
				tdPages.style.color = "var(--color-orange, #e8a100)";
				tdPages.title = `${atTx} pages when transcribed; ${current} pages on last download`;
			} else {
				tdPages.textContent = `${atTx} pp`;
				tdPages.title = `${atTx} pages at transcription`;
			}
		}

		// ── Destinations ──────────────────────────────────────────────────────
		const tdDest = tr.createEl("td");
		tdDest.style.cssText = "padding: 7px 10px;";

		// Companion note (from manifest)
		if (row.companionPath) {
			this.destLink(tdDest, "📝", "Companion", row.companionPath);
		}

		// Transcription destinations (from TranscriptionStore)
		if (row.ts) {
			for (const dest of row.ts.destinations) {
				if (dest.type === "companion" && dest.path === row.companionPath) continue; // already shown
				const icon = dest.type === "daily" ? "📅" : "📄";
				const label = dest.type === "daily" ? "Daily" : "Note";
				this.destLink(tdDest, icon, label, dest.path, dest.transcribedAt);
			}
		}

		// ── Actions ───────────────────────────────────────────────────────────
		const tdActions = tr.createEl("td");
		tdActions.style.cssText = "padding: 7px 10px; white-space: nowrap;";
		const actWrap = tdActions.createDiv();
		actWrap.style.cssText = "display: flex; gap: 4px; flex-wrap: nowrap;";

		const rerunBtn = actWrap.createEl("button", { text: "Re-run" });
		rerunBtn.title = "Run matching automations for this file again";
		rerunBtn.style.cssText = MICRO_BTN;
		rerunBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.rerunAutomations(row);
		});

		const editBtn = actWrap.createEl("button", { text: "Edit" });
		editBtn.title = "Edit the recorded companion/vault path for this file";
		editBtn.style.cssText = MICRO_BTN;
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.promptEditEntry(row);
		});

		const untrackBtn = actWrap.createEl("button", { text: "Untrack" });
		untrackBtn.title = "Stop tracking this file (the file on disk is not deleted)";
		untrackBtn.style.cssText = MICRO_BTN + " color: var(--text-error);";
		untrackBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.untrack(row);
		});
	}

	// ── Per-row actions ─────────────────────────────────────────────────────────

	private async rerunAutomations(row: Row): Promise<void> {
		await this.automationEngine.runForFile({
			vaultPath: row.vaultPath,
			companionPath: row.companionPath,
			driveFileId: row.driveFileId,
			driveModifiedTime: row.driveModifiedTime,
			force: true,
		});
		await this.manifest.save();
		new Notice(`Re-ran automations for "${basename(row.vaultPath)}".`);
	}

	private async untrack(row: Row): Promise<void> {
		this.manifest.delete(row.driveFileId);
		this.transcriptionStore.delete(row.driveFileId);
		await this.manifest.save();
		await this.transcriptionStore.save();
		new Notice(`Stopped tracking "${basename(row.vaultPath)}".`);
		this.render();
	}

	private promptEditEntry(row: Row): void {
		new EditEntryModal(this.app, row, async (companionPath, vaultPath) => {
			const entry = this.manifest.get(row.driveFileId);
			if (!entry) return;
			this.manifest.set(row.driveFileId, {
				...entry,
				vaultPath: vaultPath.trim() || entry.vaultPath,
				companionPath: companionPath.trim() || null,
			});
			await this.manifest.save();
			new Notice(`Updated tracking record for "${basename(row.vaultPath)}".`);
			this.render();
		}).open();
	}

	private promptAddFile(): void {
		const tracked = new Set(this.manifest.entries().map(([, e]) => e.vaultPath));
		const candidates = this.app.vault
			.getFiles()
			.filter((f) => f.extension.toLowerCase() === "pdf" && !tracked.has(f.path));

		if (candidates.length === 0) {
			new Notice("No untracked PDFs found in the vault.");
			return;
		}

		new AddFilePickerModal(this.app, candidates, async (file) => {
			const id = `local:${(globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random())}`;
			this.manifest.set(id, {
				vaultPath: file.path,
				companionPath: null,
				driveModifiedTime: new Date(file.stat.mtime).toISOString(),
				pairId: LOCAL_PAIR_ID,
			});
			await this.manifest.save();
			new Notice(`Now tracking "${file.name}".`);
			this.render();
		}).open();
	}

	private promptResetAll(): void {
		const ids = this.manifest.entries().map(([id]) => id);
		if (ids.length === 0) {
			new Notice("Nothing is being tracked.");
			return;
		}
		new ConfirmModal(
			this.app,
			"Reset all tracking?",
			`This stops tracking all ${ids.length} file(s) and clears their transcription records. ` +
				`A manifest backup is saved automatically. Files on disk are NOT deleted.`,
			"Reset all",
			async () => {
				for (const id of ids) this.transcriptionStore.delete(id);
				this.manifest.clear();
				await this.manifest.save();
				await this.transcriptionStore.save();
				new Notice("Cleared all tracking.");
				this.render();
			}
		).open();
	}

	private destLink(
		parent: HTMLElement,
		icon: string,
		label: string,
		path: string,
		title?: string
	): void {
		const link = parent.createEl("a", { text: `${icon} ${label}` });
		link.style.cssText =
			"cursor: pointer; color: var(--link-color); text-decoration: none; " +
			"margin-right: 8px; font-size: 12px; white-space: nowrap;";
		link.title = title ? `${path}\n${relativeTime(title)}` : path;
		link.addEventListener("click", () => this.openFile(path));
	}

	private openFile(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			this.app.workspace.getLeaf(false).openFile(file);
			this.close();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Supporting modals ───────────────────────────────────────────────────────────

/** Edit the recorded vault/companion path for a tracked file (manifest record only). */
class EditEntryModal extends Modal {
	constructor(
		app: App,
		private row: Row,
		private onSave: (companionPath: string, vaultPath: string) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Edit tracking — ${basename(this.row.vaultPath)}` });
		contentEl.createEl("p", {
			text: "Changes only update PDF Manager's record, not the files on disk.",
			cls: "setting-item-description",
		});

		let vaultPath = this.row.vaultPath;
		let companionPath = this.row.companionPath ?? "";

		new Setting(contentEl)
			.setName("Vault path")
			.setDesc("Path of the tracked file within the vault.")
			.addText((t) =>
				t.setValue(vaultPath).onChange((v) => {
					vaultPath = v;
				})
			);

		new Setting(contentEl)
			.setName("Companion note path")
			.setDesc("Path of the companion note (leave empty for none).")
			.addText((t) =>
				t.setPlaceholder("Notes/My File.md").setValue(companionPath).onChange((v) => {
					companionPath = v;
				})
			);

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Save").setCta().onClick(async () => {
				await this.onSave(companionPath, vaultPath);
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Fuzzy picker to choose an untracked vault PDF to start tracking. */
class AddFilePickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private onPick: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Pick a PDF to track…");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

/** Generic confirm dialog with a destructive primary action. */
class ConfirmModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private bodyText: string,
		private confirmLabel: string,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.titleText });
		contentEl.createEl("p", { text: this.bodyText, cls: "setting-item-description" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText(this.confirmLabel).setWarning().onClick(async () => {
					await this.onConfirm();
					this.close();
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

function relativeTime(iso: string): string {
	try {
		const ms = Date.now() - new Date(iso).getTime();
		if (ms < 0) return new Date(iso).toLocaleDateString();
		if (ms < 60_000) return "just now";
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < ONE_DAY_MS) return `${Math.floor(ms / 3_600_000)}h ago`;
		if (ms < ONE_DAY_MS * 30) return `${Math.floor(ms / ONE_DAY_MS)}d ago`;
		return new Date(iso).toLocaleDateString();
	} catch {
		return iso;
	}
}
