import { App, Modal, Setting } from "obsidian";
import type DriveFolderSyncPlugin from "../main";

/**
 * Phase 12.3 — in-app changelog shown once after an update.
 *
 * On load the plugin compares manifest.json version against the stored lastSeenVersion;
 * when they differ it parses the entries newer than lastSeenVersion from CHANGELOG.md and
 * shows them here. A "Don't show again" checkbox persists the current version.
 */
export class ChangelogModal extends Modal {
	private dontShowAgain = true;

	constructor(
		app: App,
		private plugin: DriveFolderSyncPlugin,
		private currentVersion: string,
		private entries: Array<{ version: string; body: string }>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `What's new in Drive Folder Sync ${this.currentVersion}` });

		for (const e of this.entries) {
			contentEl.createEl("h4", { text: e.version });
			const pre = contentEl.createEl("div");
			pre.style.cssText = "white-space: pre-wrap; font-size: 13px;";
			pre.textContent = e.body.trim();
		}

		new Setting(contentEl)
			.setName("Don't show this again")
			.addToggle((t) => t.setValue(true).onChange((v) => { this.dontShowAgain = v; }));

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("View releases on GitHub").onClick(() => {
					window.open("https://github.com/connrado/drive-folder-sync/releases", "_blank");
				})
			)
			.addButton((b) =>
				b.setButtonText("Close").setCta().onClick(async () => {
					if (this.dontShowAgain) {
						this.plugin.settings.lastSeenVersion = this.currentVersion;
						await this.plugin.saveSettings();
					}
					this.close();
				})
			);
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Parse CHANGELOG.md into ordered {version, body} sections (## x.y.z headers). */
export function parseChangelog(md: string): Array<{ version: string; body: string }> {
	const sections: Array<{ version: string; body: string }> = [];
	const re = /^##\s+([0-9][^\n]*)$/gm;
	const matches = [...md.matchAll(re)];
	for (let i = 0; i < matches.length; i++) {
		const version = matches[i][1].trim();
		const start = matches[i].index! + matches[i][0].length;
		const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
		sections.push({ version, body: md.slice(start, end) });
	}
	return sections;
}

/** Semver-ish compare: returns true when `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
	if (!b) return true;
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}
