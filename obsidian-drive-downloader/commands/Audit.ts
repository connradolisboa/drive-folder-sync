import { App, Modal, Notice, TFile } from "obsidian";
import type { SyncManifestStore } from "../sync/SyncManifest";
import type { DriveDownloaderSettings } from "../types";

export interface AuditIssue {
	category: "Missing vault file" | "Orphaned manifest entry";
	description: string;
	driveFileId: string;
	path: string;
}

export async function runAudit(
	app: App,
	manifest: SyncManifestStore,
	settings: DriveDownloaderSettings
): Promise<AuditIssue[]> {
	const issues: AuditIssue[] = [];
	const knownPairIds = new Set(settings.syncPairs.map((pair) => pair.id));
	for (const [driveFileId, entry] of manifest.entries()) {
		if (!(await app.vault.adapter.exists(entry.vaultPath))) {
			issues.push({
				category: "Missing vault file",
				description: `"${entry.vaultPath}" is tracked but no longer exists in the vault.`,
				driveFileId,
				path: entry.vaultPath,
			});
		}
		if (entry.pairId && !knownPairIds.has(entry.pairId)) {
			issues.push({
				category: "Orphaned manifest entry",
				description: `"${entry.vaultPath}" refers to deleted pair "${entry.pairId}".`,
				driveFileId,
				path: entry.vaultPath,
			});
		}
	}
	return issues;
}

export class AuditModal extends Modal {
	constructor(
		app: App,
		private issues: AuditIssue[],
		private manifest: SyncManifestStore
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Drive Downloader — Health Audit" });
		if (this.issues.length === 0) {
			this.contentEl.createEl("p", { text: "No downloader manifest issues found." });
			return;
		}
		this.contentEl.createEl("p", { text: `${this.issues.length} issue(s) found.` });
		for (const issue of this.issues) {
			const row = this.contentEl.createDiv();
			row.style.cssText = "padding:8px;margin-bottom:6px;border:1px solid var(--background-modifier-border);border-radius:4px;";
			row.createEl("strong", { text: issue.category });
			row.createEl("p", { text: issue.description });
			if (this.app.vault.getAbstractFileByPath(issue.path) instanceof TFile) {
				const open = row.createEl("button", { text: "Open file" });
				open.onclick = () => {
					const file = this.app.vault.getAbstractFileByPath(issue.path);
					if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
				};
			}
			if (issue.category === "Missing vault file") {
				const remove = row.createEl("button", { text: "Remove from manifest" });
				remove.style.marginLeft = "6px";
				remove.onclick = async () => {
					this.manifest.delete(issue.driveFileId);
					await this.manifest.save();
					row.remove();
					new Notice(`Removed manifest entry for "${issue.path}".`);
				};
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
