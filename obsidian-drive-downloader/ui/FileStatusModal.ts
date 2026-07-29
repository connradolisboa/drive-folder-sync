import { App, Modal, Notice, TFile } from "obsidian";
import type DriveDownloaderPlugin from "../main";

export class FileStatusModal extends Modal {
	constructor(
		app: App,
		private plugin: DriveDownloaderPlugin,
		private file: TFile
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.style.cssText = "width:min(700px,92vw);max-height:85vh;";
		this.contentEl.style.cssText = "overflow-y:auto;padding:0 4px;";
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl, file } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Drive Downloader — ${file.basename}` });

		const tracked = this.plugin.manifestStore.findByVaultPath(file.path);
		if (!tracked) {
			const notice = contentEl.createDiv();
			notice.style.cssText =
				"padding:12px 16px;background:var(--background-secondary);border-radius:6px;" +
				"color:var(--text-muted);margin:8px 0 16px;";
			notice.textContent = "This file is not tracked by Drive Downloader.";
			return;
		}

		const [driveFileId, entry] = tracked;
		const pair = this.plugin.settings.syncPairs.find((candidate) => candidate.id === entry.pairId);

		const table = contentEl.createEl("table");
		table.style.cssText = "width:100%;border-collapse:collapse;margin:8px 0 16px;";
		this.row(table, "Vault path", entry.vaultPath);
		this.row(table, "Drive file ID", driveFileId);
		this.row(table, "Folder pair", pair ? `${pair.label} (${pair.id})` : entry.pairId);
		this.row(table, "Drive modified", entry.driveModifiedTime);
		if (entry.driveCreatedTime) this.row(table, "Drive created", entry.driveCreatedTime);
		if (entry.driveMd5) this.row(table, "Drive MD5", entry.driveMd5);
		if (entry.contentHash) this.row(table, "Content SHA-256", entry.contentHash);
		if (entry.userDeletedAt) this.row(table, "Local deletion recorded", entry.userDeletedAt);
		if (entry.sourceDisconnectedAt) {
			this.row(
				table,
				"Drive source disconnected",
				`${entry.sourceDisconnectedReason ?? "unknown"} at ${entry.sourceDisconnectedAt}`
			);
		}
		if (entry.deletedFromDriveAt) {
			this.row(table, "Drive copy deleted by downloader", entry.deletedFromDriveAt);
		} else if (entry.driveTrashed) {
			this.row(table, "Drive status", "In Drive trash");
		}

		const actions = contentEl.createDiv();
		actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;";

		const syncButton = actions.createEl("button", { text: "Sync this folder pair" });
		syncButton.addEventListener("click", async () => {
			syncButton.disabled = true;
			try {
				const result = await this.plugin.runSyncForPair(entry.pairId);
				new Notice(this.plugin.formatResult(result));
				this.close();
			} catch (error) {
				new Notice(`Drive sync failed: ${(error as Error).message}`);
			} finally {
				syncButton.disabled = false;
			}
		});

		if (entry.userDeletedAt) {
			const clearButton = actions.createEl("button", { text: "Allow re-download" });
			clearButton.addEventListener("click", async () => {
				this.plugin.manifestStore.clearUserDeleted(driveFileId);
				await this.plugin.manifestStore.save();
				new Notice("The local-deletion marker was cleared.");
				this.render();
			});
		}
	}

	private row(table: HTMLTableElement, label: string, value: string): void {
		const row = table.insertRow();
		const labelCell = row.insertCell();
		labelCell.textContent = label;
		labelCell.style.cssText =
			"padding:4px 8px;color:var(--text-muted);width:190px;vertical-align:top;";
		const valueCell = row.insertCell();
		valueCell.textContent = value;
		valueCell.style.cssText = "padding:4px 8px;overflow-wrap:anywhere;";
	}
}
