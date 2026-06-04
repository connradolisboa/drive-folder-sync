import { App, Modal, Notice, Setting, TFile } from "obsidian";
import * as crypto from "crypto";
import type { SyncManifestStore } from "../sync/SyncManifest";

export type DriftType = "missing" | "hash-mismatch" | "mtime-mismatch" | "manifest-only" | "ok";

export interface DriftRow {
	driveFileId: string;
	vaultPath: string;
	type: DriftType;
	detail?: string;
}

export interface IntegrityReport {
	checked: number;
	rows: DriftRow[]; // only non-ok rows
}

/**
 * Phase 13.4 — pure-read integrity check. Walks the manifest, confirms each vault file
 * exists, hashes it and compares to the recorded contentHash. No side effects.
 */
export async function verifyIntegrity(app: App, manifest: SyncManifestStore): Promise<IntegrityReport> {
	const rows: DriftRow[] = [];
	let checked = 0;
	for (const [driveFileId, entry] of manifest.entries()) {
		checked++;
		const file = app.vault.getAbstractFileByPath(entry.vaultPath);
		if (!(file instanceof TFile)) {
			rows.push({ driveFileId, vaultPath: entry.vaultPath, type: "manifest-only", detail: "vault file missing" });
			continue;
		}
		if (entry.contentHash) {
			try {
				const bytes = await app.vault.adapter.readBinary(entry.vaultPath);
				const hash = crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
				if (hash !== entry.contentHash) {
					rows.push({ driveFileId, vaultPath: entry.vaultPath, type: "hash-mismatch", detail: "content differs from last sync" });
				}
			} catch {
				rows.push({ driveFileId, vaultPath: entry.vaultPath, type: "missing", detail: "unreadable" });
			}
		}
	}
	return { checked, rows };
}

export class VerifyIntegrityModal extends Modal {
	constructor(
		app: App,
		private report: IntegrityReport,
		private manifest: SyncManifestStore,
		private onFixed: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, report } = this;
		contentEl.createEl("h3", { text: "Manifest integrity" });
		contentEl.createEl("p", {
			text: `Checked ${report.checked} entr${report.checked === 1 ? "y" : "ies"} — ${report.rows.length} issue(s) found.`,
			cls: "setting-item-description",
		});

		if (report.rows.length === 0) {
			contentEl.createEl("p", { text: "No drift detected. ✅" });
			return;
		}

		const groups = new Map<DriftType, DriftRow[]>();
		for (const r of report.rows) {
			const arr = groups.get(r.type) ?? [];
			arr.push(r);
			groups.set(r.type, arr);
		}

		for (const [type, rowsOfType] of groups) {
			contentEl.createEl("h4", { text: `${type} (${rowsOfType.length})` });
			for (const row of rowsOfType) {
				const setting = new Setting(contentEl).setName(row.vaultPath).setDesc(row.detail ?? "");
				if (type === "manifest-only") {
					setting.addButton((b) =>
						b.setButtonText("Remove from manifest").setWarning().onClick(async () => {
							this.manifest.delete(row.driveFileId);
							await this.manifest.save();
							new Notice(`Removed manifest entry for ${row.vaultPath}`);
							setting.settingEl.remove();
							this.onFixed();
						})
					);
				}
				// hash-mismatch: re-download is handled by a normal sync; offer a hint only.
			}
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
