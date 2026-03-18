import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DriveFolderSyncPlugin from "../main";

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
			.setDesc("OAuth2 Client Secret from the same Google Cloud Console project")
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

		// ── Google account connection ─────────────────────────────────────
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
						new Notice(
							"Please enter your Client ID and Client Secret first."
						);
						return;
					}
					try {
						btn.setButtonText("Connecting…").setDisabled(true);
						await this.plugin.auth.authorize();
						new Notice("Google Drive connected successfully!");
					} catch (e) {
						new Notice(`Authorization failed: ${e.message}`);
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

		// ── Sync settings ─────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync settings" });

		new Setting(containerEl)
			.setName("Drive folder ID")
			.setDesc(
				"The ID at the end of the Drive folder URL: " +
				"drive.google.com/drive/folders/FOLDER_ID_HERE"
			)
			.addText((text) =>
				text
					.setPlaceholder("1aBcDeFgHiJkLmNo…")
					.setValue(this.plugin.settings.driveFolderId)
					.onChange(async (val) => {
						this.plugin.settings.driveFolderId = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Vault destination folder")
			.setDesc(
				"Folder inside your vault where synced files will appear. Created automatically if missing."
			)
			.addText((text) =>
				text
					.setPlaceholder("Drive Sync")
					.setValue(this.plugin.settings.vaultDestFolder)
					.onChange(async (val) => {
						this.plugin.settings.vaultDestFolder = val.trim() || "Drive Sync";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to automatically sync. Set to 0 to disable automatic sync.")
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
						// Show/hide archive folder setting
						archiveSetting.settingEl.toggle(val === "archive");
					});
			});

		archiveSetting = new Setting(containerEl)
			.setName("Archive folder")
			.setDesc(
				"Vault folder to move removed files into. Subfolder structure is preserved."
			)
			.addText((text) =>
				text
					.setPlaceholder("Drive Sync Archive")
					.setValue(this.plugin.settings.archiveFolder)
					.onChange(async (val) => {
						this.plugin.settings.archiveFolder =
							val.trim() || "Drive Sync Archive";
						await this.plugin.saveSettings();
					})
			);

		// Only show archive folder input when "archive" is selected
		archiveSetting.settingEl.toggle(
			this.plugin.settings.deletionBehavior === "archive"
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
						new Notice(`Sync failed: ${e.message}`);
					} finally {
						btn.setButtonText("Sync now").setDisabled(false);
					}
				})
			);
	}
}
