import { App, Modal, Notice, TFile } from "obsidian";
import type { SyncManifestStore } from "../sync/SyncManifest";
import type { PluginSettings } from "../types";

export interface AuditIssue {
	category: string;
	description: string;
	driveFileId?: string;
	path?: string;
}

export async function runAudit(
	app: App,
	manifest: SyncManifestStore,
	settings: PluginSettings
): Promise<AuditIssue[]> {
	const issues: AuditIssue[] = [];
	const entries = manifest.entries();
	const knownPairIds = new Set(settings.syncPairs.map((p) => p.id));
	const companionDriveIdsSeen = new Map<string, string>(); // companionPath → driveFileId

	for (const [driveFileId, entry] of entries) {
		// 1. Vault file missing
		if (entry.vaultPath) {
			const exists = await app.vault.adapter.exists(entry.vaultPath);
			if (!exists) {
				issues.push({
					category: "Missing vault file",
					description: `"${entry.vaultPath}" is tracked in the manifest but no longer exists in the vault.`,
					driveFileId,
					path: entry.vaultPath,
				});
			}
		}

		// 2. Companion path missing
		if (entry.companionPath) {
			const exists = await app.vault.adapter.exists(entry.companionPath);
			if (!exists) {
				issues.push({
					category: "Missing companion note",
					description: `Companion note "${entry.companionPath}" does not exist in the vault.`,
					driveFileId,
					path: entry.companionPath,
				});
			} else {
				// 3. Duplicate companions
				if (companionDriveIdsSeen.has(entry.companionPath)) {
					issues.push({
						category: "Duplicate companion",
						description: `"${entry.companionPath}" is referenced by multiple manifest entries (also by Drive ID: ${companionDriveIdsSeen.get(entry.companionPath)}).`,
						driveFileId,
						path: entry.companionPath,
					});
				} else {
					companionDriveIdsSeen.set(entry.companionPath, driveFileId);
				}

				// 4. Broken companion-of wikilink
				const companionFile = app.vault.getAbstractFileByPath(entry.companionPath);
				if (companionFile instanceof TFile) {
					const cache = app.metadataCache.getFileCache(companionFile);
					const fm = cache?.frontmatter;
					const companionOf = fm?.["companion-of"] as string | undefined;
					if (companionOf) {
						// Extract filename from [[...]]
						const linkMatch = companionOf.match(/\[\[([^\]]+)\]\]/);
						const linkedStem = linkMatch?.[1];
						if (linkedStem) {
							const resolved = app.metadataCache.getFirstLinkpathDest(linkedStem, entry.companionPath);
							if (!resolved) {
								issues.push({
									category: "Broken companion-of link",
									description: `"${entry.companionPath}" has companion-of: [[${linkedStem}]] which does not resolve to any file.`,
									driveFileId,
									path: entry.companionPath,
								});
							}
						}
					}
				}
			}
		}

		// 5. Orphaned pair
		if (entry.pairId && !knownPairIds.has(entry.pairId)) {
			issues.push({
				category: "Orphaned manifest entry",
				description: `Drive file "${entry.vaultPath}" is associated with pair ID "${entry.pairId}" which no longer exists in settings.`,
				driveFileId,
				path: entry.vaultPath,
			});
		}
	}

	// 6. Companion notes referencing a driveFileId not in the manifest
	const allMd = app.vault.getMarkdownFiles();
	const manifestDriveIds = new Set(entries.map(([id]) => id));
	for (const file of allMd) {
		const cache = app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm) continue;
		const driveId = fm["driveFileId"] as string | undefined;
		if (!driveId) continue;
		if (!manifestDriveIds.has(driveId)) {
			issues.push({
				category: "Orphaned companion note",
				description: `"${file.path}" references Drive ID "${driveId}" which is not tracked in the manifest.`,
				path: file.path,
			});
		}
	}

	return issues;
}

export class AuditModal extends Modal {
	constructor(
		app: App,
		private issues: AuditIssue[],
		private manifest: SyncManifestStore,
		private onFixed: () => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Drive Sync — Health Audit" });

		if (this.issues.length === 0) {
			contentEl.createEl("p", { text: "No issues found. Your manifest and vault are in sync." });
			const row = contentEl.createDiv();
			row.style.cssText = "display:flex;justify-content:flex-end;margin-top:12px;";
			const btn = row.createEl("button", { text: "Close" });
			btn.addEventListener("click", () => this.close());
			return;
		}

		contentEl.createEl("p", {
			text: `Found ${this.issues.length} issue${this.issues.length !== 1 ? "s" : ""}:`,
		}).style.cssText = "color:var(--text-muted);margin-bottom:16px;";

		const grouped = new Map<string, AuditIssue[]>();
		for (const issue of this.issues) {
			if (!grouped.has(issue.category)) grouped.set(issue.category, []);
			grouped.get(issue.category)!.push(issue);
		}

		const listEl = contentEl.createDiv();
		listEl.style.cssText = "overflow-y:auto;max-height:400px;";

		for (const [category, items] of grouped) {
			listEl.createEl("h3", { text: `${category} (${items.length})` });
			for (const issue of items) {
				const row = listEl.createDiv();
				row.style.cssText = "padding:8px;margin-bottom:6px;border:1px solid var(--background-modifier-border);border-radius:4px;font-size:13px;";

				row.createEl("p", { text: issue.description }).style.cssText = "margin:0 0 6px;";

				const btnRow = row.createDiv();
				btnRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

				if (issue.path) {
					const openBtn = btnRow.createEl("button", { text: "Open file" });
					openBtn.addEventListener("click", () => {
						const file = this.app.vault.getAbstractFileByPath(issue.path!);
						if (file instanceof TFile) {
							this.app.workspace.getLeaf("tab").openFile(file);
						}
					});
				}

				if (issue.category === "Missing vault file" && issue.driveFileId) {
					const fixBtn = btnRow.createEl("button", { text: "Remove from manifest" });
					fixBtn.style.cssText = "color:var(--text-error);";
					fixBtn.addEventListener("click", async () => {
						this.manifest.delete(issue.driveFileId!);
						await this.manifest.save();
						await this.onFixed();
						new Notice(`Removed "${issue.path}" from manifest.`);
						row.remove();
					});
				}

				if (issue.category === "Missing companion note" && issue.driveFileId) {
					const fixBtn = btnRow.createEl("button", { text: "Clear companion path" });
					fixBtn.addEventListener("click", async () => {
						const entry = this.manifest.get(issue.driveFileId!);
						if (entry) {
							this.manifest.set(issue.driveFileId!, { ...entry, companionPath: null });
							await this.manifest.save();
							await this.onFixed();
							new Notice(`Cleared companion path for "${issue.path}".`);
							row.remove();
						}
					});
				}

				if (issue.category === "Orphaned companion note" && issue.path) {
					const fixBtn = btnRow.createEl("button", { text: "Open and review" });
					fixBtn.addEventListener("click", () => {
						const file = this.app.vault.getAbstractFileByPath(issue.path!);
						if (file instanceof TFile) this.app.workspace.getLeaf("tab").openFile(file);
					});
				}
			}
		}

		const closeRow = contentEl.createDiv();
		closeRow.style.cssText = "display:flex;justify-content:flex-end;margin-top:12px;";
		const closeBtn = closeRow.createEl("button", { text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
