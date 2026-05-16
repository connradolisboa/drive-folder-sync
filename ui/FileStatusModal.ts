import { App, Modal, Notice, TFile } from "obsidian";
import type DriveFolderSyncPlugin from "../main";
import { openTranscribePickerForFile } from "../commands/TranscribeCurrentFile";

export class FileStatusModal extends Modal {
	constructor(
		app: App,
		private plugin: DriveFolderSyncPlugin,
		private file: TFile
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.style.cssText = "width: min(700px, 92vw); max-height: 85vh;";
		this.contentEl.style.cssText = "overflow-y: auto; padding: 0 4px;";
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl, file } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: `Drive Sync — ${file.basename}` }).style.marginTop = "0";

		const manifest = this.plugin.manifestStore;
		const transcriptionStore = this.plugin.transcriptionStore;
		const settings = this.plugin.settings;

		const entry = manifest.findByVaultPath(file.path);

		if (!entry) {
			this.renderUntracked();
			return;
		}

		const [driveFileId, manifestEntry] = entry;
		const pair = settings.syncPairs.find((p) => p.id === manifestEntry.pairId);

		// ── Drive metadata ────────────────────────────────────────────────────
		this.section("Drive metadata");
		const meta = this.table();
		this.row(meta, "Drive file ID", driveFileId);
		this.row(meta, "Pair", pair ? `${pair.label} (${manifestEntry.pairId})` : manifestEntry.pairId);
		this.row(meta, "Drive modified", manifestEntry.driveModifiedTime);
		if (manifestEntry.driveCreatedTime) {
			this.row(meta, "Drive created", manifestEntry.driveCreatedTime);
		}
		if (manifestEntry.driveTrashed) {
			this.row(meta, "Status", "⚠ In Drive trash");
		}
		if (manifestEntry.userDeletedAt) {
			this.row(meta, "User deleted", manifestEntry.userDeletedAt);
		}
		if (manifestEntry.transcriptionDisabled) {
			this.row(meta, "Transcription", "Disabled for this file");
		}

		// ── Companion note ────────────────────────────────────────────────────
		this.section("Companion note");
		const compTable = this.table();
		if (manifestEntry.companionPath) {
			const companionExists = !!this.app.vault.getAbstractFileByPath(manifestEntry.companionPath);
			const pathRow = compTable.insertRow();
			pathRow.insertCell().textContent = "Path";
			const pathCell = pathRow.insertCell();
			(pathRow.cells[0] as HTMLElement).style.cssText =
				"padding: 3px 6px; font-size: 13px; color: var(--text-muted); width: 180px;";
			(pathCell as HTMLElement).style.cssText = "padding: 3px 6px; font-size: 13px;";
			if (companionExists) {
				const link = pathCell.createEl("a", { text: manifestEntry.companionPath });
				link.style.cursor = "pointer";
				link.addEventListener("click", () => {
					const cf = this.app.vault.getAbstractFileByPath(manifestEntry.companionPath!);
					if (cf instanceof TFile) {
						this.app.workspace.getLeaf(false).openFile(cf);
						this.close();
					}
				});
			} else {
				pathCell.textContent = manifestEntry.companionPath + " (missing)";
			}
			this.row(compTable, "Exists", companionExists ? "Yes" : "No");
			if (manifestEntry.companionMtime) {
				this.row(compTable, "Last written", new Date(manifestEntry.companionMtime).toISOString());
			}
		} else {
			this.row(compTable, "Path", "None");
		}

		// ── Transcription ────────────────────────────────────────────────────
		const tsEntry = transcriptionStore.get(driveFileId);
		if (file.path.toLowerCase().endsWith(".pdf")) {
			this.section("Transcription");
			const tsTable = this.table();
			if (tsEntry) {
				this.row(tsTable, "Last transcribed", tsEntry.lastTranscribedAt);
				this.row(tsTable, "Page count", String(tsEntry.pageCount));
				if (tsEntry.currentPageCount && tsEntry.currentPageCount !== tsEntry.pageCount) {
					this.row(tsTable, "Current pages (Drive)", String(tsEntry.currentPageCount));
				}
				this.row(tsTable, "Hash", tsEntry.pdfHash.slice(0, 16) + "…");
				if (tsEntry.destinations.length) {
					const destRow = tsTable.insertRow();
					destRow.insertCell().textContent = "Destinations";
					const cell = destRow.insertCell();
					(destRow.cells[0] as HTMLElement).style.cssText =
						"padding: 3px 6px; font-size: 13px; color: var(--text-muted); width: 180px;";
					(cell as HTMLElement).style.cssText = "padding: 3px 6px; font-size: 13px;";
					for (const d of tsEntry.destinations) {
						const line = cell.createDiv();
						line.style.cssText = "font-size: 12px; color: var(--text-muted);";
						line.textContent = `${d.type}: ${d.path} (${d.transcribedAt.slice(0, 10)})`;
					}
				}
			} else {
				this.row(tsTable, "Status", "Not yet transcribed");
			}
		}

		// ── Automation runs ───────────────────────────────────────────────────
		if (manifestEntry.automationRuns && Object.keys(manifestEntry.automationRuns).length > 0) {
			this.section("Automation runs");
			const autoTable = this.table();
			const thead = autoTable.querySelector("thead tr")!;
			thead.innerHTML = "";
			["Automation", "Last run", "Result", "Outputs"].forEach((h) => {
				const th = thead.createEl("th", { text: h });
				th.style.cssText =
					"text-align: left; font-size: 11px; color: var(--text-faint); padding: 2px 6px; font-weight: 600;";
			});
			for (const [autoId, run] of Object.entries(manifestEntry.automationRuns)) {
				const automation = settings.automations.find((a) => a.id === autoId);
				const autoRow = autoTable.insertRow();
				autoRow.insertCell().textContent = automation?.name ?? autoId;
				autoRow.insertCell().textContent = run.lastRunAt.slice(0, 16).replace("T", " ");
				const resultCell = autoRow.insertCell();
				resultCell.textContent = run.result;
				resultCell.style.color =
					run.result === "success"
						? "var(--color-green)"
						: run.result === "error"
						? "var(--color-red)"
						: "var(--text-muted)";
				const outCell = autoRow.insertCell();
				if (run.outputs?.length) {
					outCell.textContent = run.outputs.join(", ");
					outCell.style.cssText = "font-size: 11px; color: var(--text-muted);";
				}
				if (run.errorMessage) {
					const errRow = autoTable.insertRow();
					const errCell = errRow.insertCell();
					errCell.colSpan = 4;
					errCell.textContent = `↳ ${run.errorMessage}`;
					errCell.style.cssText =
						"font-size: 11px; color: var(--color-red); padding-left: 12px;";
				}
			}
		}

		// ── Action row ────────────────────────────────────────────────────────
		this.renderActions(driveFileId, manifestEntry.pairId);
	}

	private renderUntracked(): void {
		const { contentEl, file } = this;

		const notice = contentEl.createDiv();
		notice.style.cssText =
			"padding: 12px 16px; background: var(--background-secondary); border-radius: 6px; " +
			"color: var(--text-muted); margin: 8px 0 16px;";
		notice.textContent = "Not tracked by Drive Sync.";

		const isPdf = file.path.toLowerCase().endsWith(".pdf");
		const providerEnabled =
			this.plugin.settings.geminiEnabled || !!this.plugin.settings.mistralApiKey;

		contentEl.createEl("p", {
			text: "Available actions for untracked files:",
			cls: "setting-item-description",
		});

		const row = contentEl.createDiv();
		row.style.cssText = "display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;";

		if (isPdf && providerEnabled) {
			this.actionBtn(row, "Transcribe…", () => {
				openTranscribePickerForFile(this.app, this.plugin, file);
				this.close();
			});
		}

		this.actionBtn(row, "Create companion note (alongside)", async () => {
			try {
				const path = await this.plugin.companionManager.createForArbitraryFile(file, "alongside");
				new Notice(`Companion note created: ${path}`);
				const created = this.app.vault.getAbstractFileByPath(path);
				if (created instanceof TFile) {
					this.app.workspace.getLeaf(false).openFile(created);
				}
			} catch (e) {
				new Notice(`Failed: ${(e as Error).message}`);
			}
			this.close();
		});

		this.actionBtn(row, "Create companion note (root)", async () => {
			try {
				const path = await this.plugin.companionManager.createForArbitraryFile(file, "root");
				new Notice(`Companion note created: ${path}`);
				const created = this.app.vault.getAbstractFileByPath(path);
				if (created instanceof TFile) {
					this.app.workspace.getLeaf(false).openFile(created);
				}
			} catch (e) {
				new Notice(`Failed: ${(e as Error).message}`);
			}
			this.close();
		});
	}

	private renderActions(driveFileId: string, pairId: string): void {
		const { contentEl, file } = this;

		const divider = contentEl.createEl("hr");
		divider.style.cssText =
			"margin: 16px 0 12px; border-color: var(--background-modifier-border);";

		const row = contentEl.createDiv();
		row.style.cssText = "display: flex; gap: 8px; flex-wrap: wrap;";

		const isPdf = file.path.toLowerCase().endsWith(".pdf");
		const providerEnabled =
			this.plugin.settings.geminiEnabled || !!this.plugin.settings.mistralApiKey;

		if (isPdf && providerEnabled) {
			this.actionBtn(row, "Transcribe…", () => {
				openTranscribePickerForFile(this.app, this.plugin, file);
				this.close();
			});
		}

		if (isPdf) {
			this.actionBtn(row, "Force re-transcription", () => {
				this.plugin.transcriptionStore.delete(driveFileId);
				this.plugin.transcriptionStore.save().catch(console.error);
				new Notice(
					`Transcription record cleared for "${file.basename}". Re-sync to re-transcribe.`
				);
				this.close();
			});
		}

		this.actionBtn(row, "Sync pair now", () => {
			this.plugin
				.runSyncForPair(pairId)
				.then(() => new Notice("Pair sync complete."))
				.catch((e: Error) => new Notice(`Sync failed: ${e.message}`));
			this.close();
		});
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private section(title: string): void {
		const h = this.contentEl.createEl("h3", { text: title });
		h.style.cssText =
			"margin: 16px 0 6px; font-size: 14px; color: var(--text-muted); " +
			"text-transform: uppercase; letter-spacing: 0.05em;";
	}

	private table(): HTMLTableElement {
		const t = this.contentEl.createEl("table");
		t.style.cssText = "width: 100%; border-collapse: collapse; margin-bottom: 4px;";
		const thead = t.createEl("thead");
		const tr = thead.createEl("tr");
		["Field", "Value"].forEach((h) => {
			const th = tr.createEl("th", { text: h });
			th.style.cssText =
				"text-align: left; font-size: 11px; color: var(--text-faint); " +
				"padding: 2px 6px; font-weight: 600;";
		});
		return t;
	}

	private row(table: HTMLTableElement, field: string, value: string): HTMLTableRowElement {
		const r = table.insertRow();
		const c0 = r.insertCell();
		const c1 = r.insertCell();
		c0.textContent = field;
		c1.textContent = value;
		c0.style.cssText = "padding: 3px 6px; font-size: 13px; color: var(--text-muted); width: 180px;";
		c1.style.cssText = "padding: 3px 6px; font-size: 13px;";
		return r;
	}

	private actionBtn(container: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
		const btn = container.createEl("button", { text: label });
		btn.style.cssText = "font-size: 13px; cursor: pointer;";
		btn.addEventListener("click", onClick);
		return btn;
	}
}
