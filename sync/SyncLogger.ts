import { App, TFile, normalizePath } from "obsidian";
import { PluginSettings, SyncResult } from "../types";

export class SyncLogger {
	constructor(private app: App, private settings: PluginSettings) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	async append(result: SyncResult): Promise<void> {
		if (!this.settings.syncLogEnabled) return;
		const path = normalizePath(this.settings.syncLogPath || "Drive Sync/.sync-log.md");
		const timestamp = new Date(result.timestamp ?? Date.now()).toISOString();
		const row =
			`| ${timestamp} | ${result.downloaded} | ${result.skipped} | ${result.removed} | ${result.errors} |\n`;

		const exists = await this.app.vault.adapter.exists(path);
		if (!exists) {
			await this.ensureParentFolder(path);
			const header =
				"| Timestamp | Downloaded | Skipped | Removed | Errors |\n" +
				"| --- | --- | --- | --- | --- |\n";
			await this.app.vault.create(path, header + row);
		} else {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.app.vault.append(file, row);
			}
		}
	}

	private async ensureParentFolder(filePath: string): Promise<void> {
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));
		if (!dir) return;
		const segments = dir.split("/").filter(Boolean);
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}
