import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DriveFolderSyncPlugin from "../main";
import { SyncPair } from "../types";

export class DriveSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DriveFolderSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Drive Folder Sync" });

		// ── Google Cloud credentials ──────────────────────────────────────
		containerEl.createEl("h3", { text: "Google Cloud credentials" });

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc(
				"OAuth2 Client ID from your Google Cloud Console project (Desktop app type)"
			)
			.addText((text) =>
				text
					.setPlaceholder("paste client_id here")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (val) => {
						this.plugin.settings.clientId = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client Secret")
			.setDesc("OAuth2 Client Secret from the same project")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("paste client_secret here")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (val) => {
						this.plugin.settings.clientSecret = val;
						await this.plugin.saveSettings();
					});
			});

		// ── Google account ────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Google account" });

		new Setting(containerEl)
			.setName("Connect Google Drive")
			.setDesc(
				"Authorize access to Google Drive. You only need to do this once. " +
				"Your browser will open for Google's consent screen."
			)
			.addButton((btn) =>
				btn.setButtonText("Connect").onClick(async () => {
					if (
						!this.plugin.settings.clientId ||
						!this.plugin.settings.clientSecret
					) {
						new Notice("Please enter your Client ID and Client Secret first.");
						return;
					}
					try {
						btn.setButtonText("Connecting…").setDisabled(true);
						await this.plugin.auth.authorize();
						new Notice("Google Drive connected successfully!");
					} catch (e) {
						new Notice(`Authorization failed: ${(e as Error).message}`);
					} finally {
						btn.setButtonText("Connect").setDisabled(false);
					}
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Disconnect")
					.setWarning()
					.onClick(async () => {
						await this.plugin.auth.disconnect();
						new Notice("Google Drive disconnected.");
					})
			);

		// ── Sync pairs ────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync folders" });
		containerEl.createEl("p", {
			text: "Each entry maps a Google Drive folder to a vault folder.",
			cls: "setting-item-description",
		});

		const pairsContainer = containerEl.createDiv({ cls: "drive-sync-pairs" });
		this.renderPairs(pairsContainer);

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("+ Add folder pair")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.syncPairs.push({
						id: this.generateId(),
						label: `Pair ${this.plugin.settings.syncPairs.length + 1}`,
						driveFolderId: "",
						vaultDestFolder: "Drive Sync",
						enabled: true,
					});
					await this.plugin.saveSettings();
					this.display();
				})
		);

		// ── Sync schedule ─────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync schedule" });

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to automatically sync. Set to 0 to disable.")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (val) => {
						const num = parseInt(val, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.syncIntervalMinutes = num;
							await this.plugin.saveSettings();
							this.plugin.scheduler.restart(num, () =>
								this.plugin.runSync()
							);
						}
					})
			);

		// ── Deletion behavior ─────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Deletion behavior" });

		let archiveSetting: Setting;

		new Setting(containerEl)
			.setName("When a file is removed from Drive")
			.setDesc("What to do with vault files that no longer exist in the Drive folder.")
			.addDropdown((drop) => {
				drop
					.addOption("keep", "Keep in vault")
					.addOption("delete", "Move to system trash")
					.addOption("archive", "Move to archive folder")
					.setValue(this.plugin.settings.deletionBehavior)
					.onChange(async (val) => {
						this.plugin.settings.deletionBehavior = val as
							| "keep"
							| "delete"
							| "archive";
						await this.plugin.saveSettings();
						archiveSetting.settingEl.toggle(val === "archive");
					});
			});

		archiveSetting = new Setting(containerEl)
			.setName("Archive folder")
			.setDesc("Vault folder to move removed files into. Subfolder structure is preserved.")
			.addText((text) =>
				text
					.setPlaceholder("Drive Sync Archive")
					.setValue(this.plugin.settings.archiveFolder)
					.onChange(async (val) => {
						this.plugin.settings.archiveFolder = val.trim() || "Drive Sync Archive";
						await this.plugin.saveSettings();
					})
			);

		archiveSetting.settingEl.toggle(
			this.plugin.settings.deletionBehavior === "archive"
		);

		// ── Companion notes ───────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Companion notes" });
		containerEl.createEl("p", {
			text:
				"For each PDF, automatically create a Markdown note with frontmatter " +
				"(processed, lastUpdate, syncDate, driveFileId). " +
				"The processed property resets to false whenever the PDF is updated.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Enable companion notes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.companionNotesEnabled)
					.onChange(async (val) => {
						this.plugin.settings.companionNotesEnabled = val;
						await this.plugin.saveSettings();
						companionFolderSetting.settingEl.toggle(val);
						companionTemplateSetting.settingEl.toggle(val);
					})
			);

		const companionFolderSetting = new Setting(containerEl)
			.setName("Companion notes folder")
			.setDesc(
				"Root vault folder for companion notes. " +
				"Leave empty to place notes alongside their PDF. " +
				"With multiple sync pairs, notes are grouped under <folder>/<pair label>/."
			)
			.addText((text) =>
				text
					.setPlaceholder("(empty = alongside PDF)")
					.setValue(this.plugin.settings.companionNotesFolder)
					.onChange(async (val) => {
						this.plugin.settings.companionNotesFolder = val.trim();
						await this.plugin.saveSettings();
					})
			);

		const companionTemplateSetting = new Setting(containerEl)
			.setName("Template file path")
			.setDesc(
				"Vault path to a .md file to use as the companion note template. " +
				"Leave empty to use the built-in default. " +
				"Available placeholders: {{title}}, {{fileName}}, {{fileLink}}, " +
				"{{lastUpdate}}, {{syncDate}}, {{driveFileId}}, {{relativePath}}"
			)
			.addText((text) =>
				text
					.setPlaceholder("Templates/drive-sync-note.md")
					.setValue(this.plugin.settings.companionNoteTemplatePath)
					.onChange(async (val) => {
						this.plugin.settings.companionNoteTemplatePath = val.trim();
						await this.plugin.saveSettings();
					})
			);

		companionFolderSetting.settingEl.toggle(
			this.plugin.settings.companionNotesEnabled
		);
		companionTemplateSetting.settingEl.toggle(
			this.plugin.settings.companionNotesEnabled
		);

		// ── Manual sync ───────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Manual sync" });

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Trigger a one-off sync immediately.")
			.addButton((btn) =>
				btn.setButtonText("Sync now").onClick(async () => {
					try {
						btn.setButtonText("Syncing…").setDisabled(true);
						const result = await this.plugin.runSync();
						new Notice(
							`Sync complete — ${result.downloaded} downloaded, ` +
							`${result.skipped} up to date` +
							(result.removed > 0 ? `, ${result.removed} removed` : "") +
							(result.errors > 0 ? `, ${result.errors} errors` : "")
						);
					} catch (e) {
						new Notice(`Sync failed: ${(e as Error).message}`);
					} finally {
						btn.setButtonText("Sync now").setDisabled(false);
					}
				})
			);
	}

	private renderPairs(container: HTMLElement): void {
		container.empty();

		if (this.plugin.settings.syncPairs.length === 0) {
			container.createEl("p", {
				text: "No sync folders configured. Click \"+ Add folder pair\" to get started.",
				cls: "setting-item-description",
			});
			return;
		}

		this.plugin.settings.syncPairs.forEach((pair, i) => {
			const card = container.createDiv({ cls: "drive-sync-pair-card" });
			card.style.cssText =
				"border: 1px solid var(--background-modifier-border); " +
				"border-radius: 6px; padding: 4px 12px 4px; margin-bottom: 12px;";

			// Header row: label + enabled toggle + delete
			new Setting(card)
				.setName(`Pair ${i + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("Label (e.g. Boox Notes)")
						.setValue(pair.label)
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].label = val;
							await this.plugin.saveSettings();
						})
				)
				.addToggle((toggle) =>
					toggle.setValue(pair.enabled).onChange(async (val) => {
						this.plugin.settings.syncPairs[i].enabled = val;
						await this.plugin.saveSettings();
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete this pair")
						.onClick(async () => {
							this.plugin.settings.syncPairs.splice(i, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);

			new Setting(card)
				.setName("Drive folder ID")
				.setDesc("The ID from the folder URL: drive.google.com/drive/folders/FOLDER_ID")
				.addText((text) =>
					text
						.setPlaceholder("1aBcDeFgHiJkLmNo…")
						.setValue(pair.driveFolderId)
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].driveFolderId = val.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(card)
				.setName("Vault destination")
				.setDesc("Folder in your vault where PDFs will appear. Created if missing.")
				.addText((text) =>
					text
						.setPlaceholder("Drive Sync")
						.setValue(pair.vaultDestFolder)
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].vaultDestFolder =
								val.trim() || "Drive Sync";
							await this.plugin.saveSettings();
						})
				);
		});
	}

	private generateId(): string {
		return Math.random().toString(36).slice(2) + Date.now().toString(36);
	}
}
