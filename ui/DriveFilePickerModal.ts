import { App, Modal, Notice, Setting } from "obsidian";
import type { DriveSync } from "../sync/DriveSync";
import type { SyncManifestStore } from "../sync/SyncManifest";
import { DriveFileEntry, PluginSettings, SyncPair } from "../types";

const LOG = "[DriveSync/FilePicker]";

type ViewMode = "folders" | "modified" | "created";

/**
 * Browse a sync pair's Drive folder and pull individual files into the vault.
 * Options: flat view sorted by newest modified/created, delete the Drive copy
 * (to trash) after sync, and run a chosen automation after the pull.
 */
export class DriveFilePickerModal extends Modal {
	private entries: DriveFileEntry[] = [];
	private viewMode: ViewMode = "folders";
	private filter = "";
	private deleteFromDrive: boolean;
	private automationId = "";
	/** Serializes pulls — parallel pulls would race on the manifest load/save cycle. */
	private busy = false;

	private listEl!: HTMLElement;

	constructor(
		app: App,
		private driveSync: DriveSync,
		private settings: PluginSettings,
		private manifest: SyncManifestStore,
		private pair: SyncPair
	) {
		super(app);
		this.deleteFromDrive = pair.deleteFromDriveAfterSync ?? false;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.style.width = "min(720px, 90vw)";

		contentEl.createEl("h2", { text: `Pull from Drive — ${this.pair.label}` });

		// ── Options ──────────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName("View")
			.addDropdown((drop) =>
				drop
					.addOption("folders", "Grouped by folder")
					.addOption("modified", "All files — newest modified first")
					.addOption("created", "All files — newest created first")
					.setValue(this.viewMode)
					.onChange((val) => {
						this.viewMode = val as ViewMode;
						this.renderList();
					})
			)
			.addSearch((search) => {
				search.setPlaceholder("Filter by name…").onChange((val) => {
					this.filter = val.toLowerCase();
					this.renderList();
				});
			});

		new Setting(contentEl)
			.setName("Delete from Drive after sync")
			.setDesc("Move the Drive copy to Drive trash once the file is in the vault. The vault copy is kept.")
			.addToggle((toggle) =>
				toggle.setValue(this.deleteFromDrive).onChange((val) => {
					this.deleteFromDrive = val;
				})
			);

		const automations = this.settings.automations.filter((a) => a.enabled);
		new Setting(contentEl)
			.setName("Run automation after sync")
			.setDesc("Runs in addition to any automations the file's vault location already triggers.")
			.addDropdown((drop) => {
				drop.addOption("", "— none —");
				for (const a of automations) drop.addOption(a.id, a.name);
				drop.setValue(this.automationId).onChange((val) => {
					this.automationId = val;
				});
			});

		// ── File list ────────────────────────────────────────────────────────
		this.listEl = contentEl.createDiv();
		this.listEl.style.cssText =
			"max-height: 50vh; overflow-y: auto; margin-top: 8px; border-top: 1px solid var(--background-modifier-border);";
		this.listEl.createEl("p", { text: "Loading files from Drive…" });

		try {
			this.entries = await this.driveSync.listPairFiles(this.pair);
			this.renderList();
		} catch (e) {
			console.error(`${LOG} Failed to list Drive files:`, e);
			this.listEl.empty();
			this.listEl.createEl("p", {
				text: `Failed to list Drive files: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	private visibleEntries(): DriveFileEntry[] {
		let list = this.entries;
		if (this.filter) {
			list = list.filter((e) =>
				`${e.relPath}/${e.file.name}`.toLowerCase().includes(this.filter)
			);
		}
		if (this.viewMode === "modified") {
			return [...list].sort((a, b) => b.file.modifiedTime.localeCompare(a.file.modifiedTime));
		}
		if (this.viewMode === "created") {
			return [...list].sort((a, b) =>
				(b.file.createdTime ?? b.file.modifiedTime).localeCompare(a.file.createdTime ?? a.file.modifiedTime)
			);
		}
		// folders: group order by relPath (root first), then by name within a folder
		return [...list].sort(
			(a, b) => a.relPath.localeCompare(b.relPath) || a.file.name.localeCompare(b.file.name)
		);
	}

	private renderList(): void {
		this.listEl.empty();
		const visible = this.visibleEntries();

		if (visible.length === 0) {
			this.listEl.createEl("p", {
				text: this.entries.length === 0 ? "No PDFs found in this Drive folder." : "No files match the filter.",
			});
			return;
		}

		let lastGroup: string | null = null;
		for (const entry of visible) {
			if (this.viewMode === "folders" && entry.relPath !== lastGroup) {
				lastGroup = entry.relPath;
				const groupEl = this.listEl.createEl("div", { text: entry.relPath || "(root)" });
				groupEl.style.cssText =
					"font-weight: 600; font-size: 0.85em; color: var(--text-muted); margin: 10px 0 2px; text-transform: none;";
			}
			this.renderRow(entry);
		}
	}

	private renderRow(entry: DriveFileEntry): void {
		const row = this.listEl.createDiv();
		row.style.cssText =
			"display: flex; align-items: center; gap: 8px; padding: 5px 2px; border-bottom: 1px solid var(--background-modifier-border);";

		const info = row.createDiv();
		info.style.cssText = "flex: 1; min-width: 0;";
		const nameEl = info.createDiv({ text: entry.file.name });
		nameEl.style.cssText = "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
		const meta = info.createDiv({ text: this.metaLine(entry) });
		meta.style.cssText = "font-size: 0.8em; color: var(--text-muted);";

		const statusEl = row.createDiv({ text: this.statusText(entry) });
		statusEl.style.cssText = "font-size: 0.8em; color: var(--text-muted); white-space: nowrap;";

		const btn = row.createEl("button", { text: "Sync" });
		btn.addEventListener("click", () => this.pull(entry, btn, statusEl));
	}

	private metaLine(entry: DriveFileEntry): string {
		const parts: string[] = [];
		if (this.viewMode !== "folders" && entry.relPath) parts.push(entry.relPath);
		const key = this.viewMode === "created" ? entry.file.createdTime ?? entry.file.modifiedTime : entry.file.modifiedTime;
		parts.push(`${this.viewMode === "created" ? "created" : "modified"} ${new Date(key).toLocaleString()}`);
		const bytes = parseInt(entry.file.size ?? "0", 10);
		if (bytes > 0) parts.push(this.formatSize(bytes));
		return parts.join(" · ");
	}

	private formatSize(bytes: number): string {
		if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}

	private statusText(entry: DriveFileEntry): string {
		const m = this.manifest.get(entry.file.id);
		if (!m) return "not synced";
		const upToDate =
			entry.file.md5Checksum && m.driveMd5
				? entry.file.md5Checksum === m.driveMd5
				: entry.file.modifiedTime === m.driveModifiedTime;
		if (m.deletedFromDriveAt) return "in vault · Drive copy trashed";
		return upToDate ? "in vault" : "update available";
	}

	private async pull(entry: DriveFileEntry, btn: HTMLButtonElement, statusEl: HTMLElement): Promise<void> {
		if (this.busy) {
			new Notice("A pull is already running — wait for it to finish.");
			return;
		}
		this.busy = true;
		btn.disabled = true;
		btn.setText("Syncing…");
		statusEl.setText("");

		try {
			const result = await this.driveSync.pullFile(this.pair, entry, {
				deleteFromDrive: this.deleteFromDrive,
				automationId: this.automationId || undefined,
			});

			if (result.error) {
				statusEl.setText("error");
				btn.setText("Retry");
				btn.disabled = false;
				new Notice(result.error);
				return;
			}

			const bits: string[] = [result.downloaded ? "synced ✓" : "already in vault ✓"];
			if (result.automationRan) bits.push("automation ran");
			if (result.trashed) bits.push("Drive copy trashed");
			statusEl.setText(bits.join(" · "));
			btn.setText("Re-sync");
			btn.disabled = false;
			if (result.vaultPath) console.log(`${LOG} Pulled "${entry.file.name}" → "${result.vaultPath}"`);
		} catch (e) {
			console.error(`${LOG} Pull failed for "${entry.file.name}":`, e);
			statusEl.setText("error");
			btn.setText("Retry");
			btn.disabled = false;
			new Notice(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.busy = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
