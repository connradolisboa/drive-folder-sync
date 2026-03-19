import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DriveFolderSyncPlugin from "../main";
import { Automation, AutomationActionType, DeletionBehavior, PeriodicNotesPaths, SyncPair } from "../types";

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

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a sync immediately when the vault opens (requires Google Drive to be connected).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (val) => {
						this.plugin.settings.syncOnStartup = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Download concurrency")
			.setDesc("Number of files to download in parallel (1–10). Higher = faster for large syncs.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.downloadConcurrency ?? 5)
					.setDynamicTooltip()
					.onChange(async (val) => {
						this.plugin.settings.downloadConcurrency = val;
						await this.plugin.saveSettings();
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
					.addOption("delete_keep_companion", "Move to system trash (keep companion note)")
					.addOption("archive", "Move to archive folder")
					.addOption("archive_keep_companion", "Move to archive folder (keep companion note)")
					.setValue(this.plugin.settings.deletionBehavior)
					.onChange(async (val) => {
						this.plugin.settings.deletionBehavior = val as DeletionBehavior;
						await this.plugin.saveSettings();
						archiveSetting.settingEl.toggle(val === "archive" || val === "archive_keep_companion");
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
			this.plugin.settings.deletionBehavior === "archive" ||
			this.plugin.settings.deletionBehavior === "archive_keep_companion"
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
						companionTitleSetting.settingEl.toggle(val);
						companionTemplateSetting.settingEl.toggle(val);
					})
			);

		const companionFolderSetting = new Setting(containerEl)
			.setName("Companion notes folder")
			.setDesc(
				"Root vault folder for companion notes. " +
				"Leave empty to place notes alongside their PDF. " +
				"Use \"/\" to place notes in the vault root. " +
				"With multiple sync pairs, notes are grouped under <folder>/<pair label>/. " +
				"Supports tokens: {{RootFolder}}, {{folderL1}}, {{folderL2}}."
			)
			.addText((text) =>
				text
					.setPlaceholder("(empty = alongside PDF, / = vault root)")
					.setValue(this.plugin.settings.companionNotesFolder)
					.onChange(async (val) => {
						this.plugin.settings.companionNotesFolder = val.trim();
						await this.plugin.saveSettings();
					})
			);

		const companionTitleSetting = new Setting(containerEl)
			.setName("Companion note title")
			.setDesc(
				"Template for the note title (H1 heading and {{title}} in templates). " +
				"Leave empty to use the PDF filename without extension. " +
				"Supports: {{title}} (PDF stem), {{fileName}}, {{pairLabel}}, {{relativePath}}. " +
				"Example: \"Reading: {{title}}\""
			)
			.addText((text) =>
				text
					.setPlaceholder("(empty = PDF filename)")
					.setValue(this.plugin.settings.companionNoteTitle)
					.onChange(async (val) => {
						this.plugin.settings.companionNoteTitle = val.trim();
						await this.plugin.saveSettings();
					})
			);

		const companionTemplateSetting = new Setting(containerEl)
			.setName("Template file path")
			.setDesc(
				"Vault path to a .md file to use as the companion note template. " +
				"Leave empty to use the built-in default. " +
				"Available placeholders: {{title}}, {{fileName}}, {{fileLink}}, " +
				"{{lastUpdate}}, {{syncDate}}, {{driveFileId}}, {{relativePath}}, {{pairLabel}}"
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
		companionTitleSetting.settingEl.toggle(
			this.plugin.settings.companionNotesEnabled
		);
		companionTemplateSetting.settingEl.toggle(
			this.plugin.settings.companionNotesEnabled
		);

		// ── Periodic Notes ────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Periodic Notes" });
		containerEl.createEl("p", {
			text:
				"Configure vault path templates for each periodic note type. " +
				"Used by the \"Embed to weekly/monthly/…\" automation actions to locate the target note. " +
				"Supports moment.js tokens wrapped in {{}}: {{YYYY}}, {{MM}}, {{DD}}, {{[W]WW}}, {{Q}}.",
			cls: "setting-item-description",
		});

		const periodicFields: { key: keyof PeriodicNotesPaths; label: string; placeholder: string }[] = [
			{ key: "daily",     label: "Daily note path",     placeholder: "Journal/Daily/{{YYYY}}-{{MM}}-{{DD}}" },
			{ key: "weekly",    label: "Weekly note path",    placeholder: "Journal/Weekly/{{YYYY}}-{{[W]WW}}" },
			{ key: "monthly",   label: "Monthly note path",   placeholder: "Journal/Monthly/{{YYYY}}-{{MM}}" },
			{ key: "quarterly", label: "Quarterly note path", placeholder: "Journal/Quarterly/{{YYYY}}-Q{{Q}}" },
			{ key: "yearly",    label: "Yearly note path",    placeholder: "Journal/Yearly/{{YYYY}}" },
		];

		for (const { key, label, placeholder } of periodicFields) {
			new Setting(containerEl)
				.setName(label)
				.setDesc("Path template — do not include .md extension.")
				.addText((text) =>
					text
						.setPlaceholder(placeholder)
						.setValue(this.plugin.settings.periodicNotesPaths[key])
						.onChange(async (val) => {
							this.plugin.settings.periodicNotesPaths[key] = val.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		// ── Automations ───────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Automations" });
		containerEl.createEl("p", {
			text:
				"Run actions automatically after a PDF is downloaded. " +
				"Each automation matches a vault folder path and performs an action on the file.",
			cls: "setting-item-description",
		});

		const automationsContainer = containerEl.createDiv();
		this.renderAutomations(automationsContainer);

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("+ Add automation")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.automations.push({
						id: this.generateId(),
						name: `Automation ${this.plugin.settings.automations.length + 1}`,
						enabled: true,
						triggerFolderPath: "",
						action: { type: "embed_to_daily_note", insertPosition: "bottom", dailyNoteNamePattern: "" },
					});
					await this.plugin.saveSettings();
					this.display();
				})
		);

		// ── Sync log ──────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync log" });

		new Setting(containerEl)
			.setName("Enable sync log")
			.setDesc("Append a row to a Markdown table after each sync run.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncLogEnabled)
					.onChange(async (val) => {
						this.plugin.settings.syncLogEnabled = val;
						await this.plugin.saveSettings();
						syncLogPathSetting.settingEl.toggle(val);
					})
			);

		const syncLogPathSetting = new Setting(containerEl)
			.setName("Log file path")
			.setDesc("Vault path to the log file. Created automatically if missing.")
			.addText((text) =>
				text
					.setPlaceholder("Drive Sync/.sync-log.md")
					.setValue(this.plugin.settings.syncLogPath)
					.onChange(async (val) => {
						this.plugin.settings.syncLogPath = val.trim() || "Drive Sync/.sync-log.md";
						await this.plugin.saveSettings();
					})
			);

		syncLogPathSetting.settingEl.toggle(this.plugin.settings.syncLogEnabled);

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
			)
			.addButton((btn) =>
				btn.setButtonText("Dry run").onClick(async () => {
					try {
						btn.setButtonText("Running…").setDisabled(true);
						await this.plugin.runSync(true);
					} catch (e) {
						new Notice(`Dry run failed: ${(e as Error).message}`);
					} finally {
						btn.setButtonText("Dry run").setDisabled(false);
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

			// Ensure defaults for fields added after initial creation
			if (!pair.excludedSubfolders) pair.excludedSubfolders = [];

			// Header row: label + enabled toggle + sync now + delete
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
						.setIcon("refresh-cw")
						.setTooltip("Sync this pair now")
						.onClick(async () => {
							btn.setDisabled(true);
							try {
								const result = await this.plugin.runSyncForPair(pair.id);
								new Notice(
									`"${pair.label}" — ${result.downloaded} downloaded, ` +
									`${result.skipped} up to date` +
									(result.removed > 0 ? `, ${result.removed} removed` : "") +
									(result.errors > 0 ? `, ${result.errors} errors` : "")
								);
							} catch (e) {
								new Notice(`Sync failed: ${(e as Error).message}`);
							} finally {
								btn.setDisabled(false);
							}
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
				.setDesc("The ID from the folder URL: drive.google.com/drive/folders/FOLDER_ID — you can paste the full URL here.")
				.addText((text) =>
					text
						.setPlaceholder("1aBcDeFgHiJkLmNo… or paste full URL")
						.setValue(pair.driveFolderId)
						.onChange(async (val) => {
							const match = val.match(/\/folders\/([a-zA-Z0-9_-]+)/);
							const id = match ? match[1] : val.trim();
							if (match) text.setValue(id);
							this.plugin.settings.syncPairs[i].driveFolderId = id;
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

			new Setting(card)
				.setName("Excluded subfolders")
				.setDesc("Comma-separated subfolder names or paths to skip during sync (e.g. Archive, Old/2023).")
				.addText((text) =>
					text
						.setPlaceholder("Archive, Old/2023")
						.setValue((pair.excludedSubfolders ?? []).join(", "))
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].excludedSubfolders = val
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean);
							await this.plugin.saveSettings();
						})
				);

			new Setting(card)
				.setName("Skip root-level files")
				.setDesc("Ignore files sitting directly inside this Drive folder — only sync files found inside subfolders.")
				.addToggle((toggle) =>
					toggle
						.setValue(pair.excludeRootFiles ?? false)
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].excludeRootFiles = val;
							await this.plugin.saveSettings();
						})
				);

			new Setting(card)
				.setName("Root files only")
				.setDesc("Only sync files directly inside this Drive folder — ignore all subfolders.")
				.addToggle((toggle) =>
					toggle
						.setValue(pair.rootFilesOnly ?? false)
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].rootFilesOnly = val;
							await this.plugin.saveSettings();
						})
				);

			// Advanced overrides (collapsible)
			const advancedEl = card.createDiv();
			advancedEl.style.display = "none";

			const advancedToggle = new Setting(card)
				.setName("Advanced overrides")
				.setDesc("Override global deletion and companion note settings for this pair only.")
				.addToggle((toggle) =>
					toggle.setValue(false).onChange((val) => {
						advancedEl.style.display = val ? "block" : "none";
					})
				);
			// Move the toggle before the advanced block
			card.insertBefore(advancedToggle.settingEl, advancedEl);

			const pairArchiveSetting = new Setting(advancedEl)
				.setName("Deletion behavior (override)")
				.setDesc("Leave unset to use the global setting.")
				.addDropdown((drop) => {
					drop
						.addOption("", "— use global —")
						.addOption("keep", "Keep in vault")
						.addOption("delete", "Move to system trash")
						.addOption("delete_keep_companion", "Move to system trash (keep companion note)")
						.addOption("archive", "Move to archive folder")
						.addOption("archive_keep_companion", "Move to archive folder (keep companion note)")
						.setValue(pair.deletionBehavior ?? "")
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].deletionBehavior =
								val ? val as DeletionBehavior : undefined;
							await this.plugin.saveSettings();
							pairArchivePathSetting.settingEl.toggle(val === "archive" || val === "archive_keep_companion");
						});
				});

			const pairArchivePathSetting = new Setting(advancedEl)
				.setName("Archive folder (override)")
				.setDesc("Vault folder to archive removed files into for this pair.")
				.addText((text) =>
					text
						.setPlaceholder(this.plugin.settings.archiveFolder)
						.setValue(pair.archiveFolder ?? "")
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].archiveFolder = val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);
			pairArchivePathSetting.settingEl.toggle(pair.deletionBehavior === "archive" || pair.deletionBehavior === "archive_keep_companion");

			new Setting(advancedEl)
				.setName("Companion notes (override)")
				.setDesc("Leave unset to use the global setting.")
				.addDropdown((drop) =>
					drop
						.addOption("", "— use global —")
						.addOption("true", "Enabled")
						.addOption("false", "Disabled")
						.setValue(pair.companionNotesEnabled === undefined ? "" : String(pair.companionNotesEnabled))
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].companionNotesEnabled =
								val === "" ? undefined : val === "true";
							await this.plugin.saveSettings();
						})
				);

			new Setting(advancedEl)
				.setName("Companion notes folder (override)")
				.setDesc(
					"Override the global companion notes folder for this pair. " +
					"Leave empty to use the global setting. " +
					"Use \"/\" to place notes in the vault root. " +
					"Supports tokens: {{RootFolder}}, {{folderL1}}, {{folderL2}}. " +
					"Example: Notes/{{RootFolder}}/{{folderL1}}"
				)
				.addText((text) =>
					text
						.setPlaceholder("Notes/{{RootFolder}}/{{folderL1}}")
						.setValue(pair.companionNotesFolder ?? "")
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].companionNotesFolder =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);

			new Setting(advancedEl)
				.setName("Companion note title (override)")
				.setDesc(
					"Override the global title template for companion notes in this pair. " +
					"Leave empty to use the global setting. " +
					"Supports: {{title}} (PDF stem), {{fileName}}, {{pairLabel}}, {{relativePath}}."
				)
				.addText((text) =>
					text
						.setPlaceholder("(empty = use global setting)")
						.setValue(pair.companionNoteTitle ?? "")
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].companionNoteTitle =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);

			new Setting(advancedEl)
				.setName("Companion note template (override)")
				.setDesc(
					"Vault path to a .md template file for companion notes in this pair. " +
					"Leave empty to use the global template. " +
					"Available placeholders: {{title}}, {{fileName}}, {{fileLink}}, " +
					"{{lastUpdate}}, {{syncDate}}, {{driveFileId}}, {{relativePath}}, {{pairLabel}}"
				)
				.addText((text) =>
					text
						.setPlaceholder("Templates/my-template.md")
						.setValue(pair.companionNoteTemplatePath ?? "")
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].companionNoteTemplatePath =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);
		});
	}

	private renderAutomations(container: HTMLElement): void {
		container.empty();

		if (this.plugin.settings.automations.length === 0) {
			container.createEl("p", {
				text: 'No automations configured. Click "+ Add automation" to get started.',
				cls: "setting-item-description",
			});
			return;
		}

		const TOKEN_HINT =
			"Supports date tokens from the PDF filename: " +
			"{{YYYY}} (year), {{MM}} (month), {{DD}} (day), {{Q}} (quarter), " +
			"{{ddd}} / {{dddd}} (weekday), {{MMM}} / {{MMMM}} (month name).";

		this.plugin.settings.automations.forEach((automation, i) => {
			const card = container.createDiv();
			card.style.cssText =
				"border: 1px solid var(--background-modifier-border); " +
				"border-radius: 6px; padding: 4px 12px 4px; margin-bottom: 12px;";

			// Header: name + enabled toggle + delete
			new Setting(card)
				.setName(`Automation ${i + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("Name (e.g. Embed daily PDFs)")
						.setValue(automation.name)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].name = val;
							await this.plugin.saveSettings();
						})
				)
				.addToggle((toggle) =>
					toggle.setValue(automation.enabled).onChange(async (val) => {
						this.plugin.settings.automations[i].enabled = val;
						await this.plugin.saveSettings();
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete this automation")
						.onClick(async () => {
							this.plugin.settings.automations.splice(i, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);

			new Setting(card)
				.setName("Trigger folder")
				.setDesc(
					"Vault path prefix to watch. Date tokens are resolved from the PDF filename. " +
					TOKEN_HINT +
					" Example: Onyx/Notebooks/Daily/{{YYYY}}/Q{{Q}}"
				)
				.addText((text) =>
					text
						.setPlaceholder("Onyx/Notebooks/Daily/{{YYYY}}/Q{{Q}}")
						.setValue(automation.triggerFolderPath)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].triggerFolderPath = val.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(card)
				.setName("Action")
				.setDesc(
					"Periodic embeds insert a link into the matching periodic note (path configured in the Periodic Notes tab). " +
					"append_to_note appends to any named note. " +
					"add_tag_to_companion adds a tag to the companion note's frontmatter. " +
					"link_to_matching_note finds notes in a folder whose name contains all words of the PDF title and inserts an embed."
				)
				.addDropdown((drop) =>
					drop
						.addOption("embed_to_daily_note",     "Embed to daily note")
						.addOption("embed_to_weekly_note",    "Embed to weekly note")
						.addOption("embed_to_monthly_note",   "Embed to monthly note")
						.addOption("embed_to_quarterly_note", "Embed to quarterly note")
						.addOption("embed_to_yearly_note",    "Embed to yearly note")
						.addOption("append_to_note",          "Append to note")
						.addOption("add_tag_to_companion",    "Add tag to companion note")
						.addOption("link_to_matching_note",   "Link to matching note")
						.setValue(automation.action.type)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.type =
								val as AutomationActionType;
							await this.plugin.saveSettings();
							updateActionFieldVisibility(val as AutomationActionType);
						})
				);

			// ── Action-specific fields ────────────────────────────────────
			const dailyPatternSetting = new Setting(card)
				.setName("Daily note name pattern")
				.setDesc(
					"Moment.js format for the daily note filename (without .md extension). " +
					TOKEN_HINT +
					" Example: {{YYYY}}-{{MM}}-{{DD}} → matches 2026-03-18.md. " +
					"Leave empty to search by frontmatter (date: {{YYYY}}-{{MM}}-{{DD}} + tag: periodic/daily)."
				)
				.addText((text) =>
					text
						.setPlaceholder("{{YYYY}}-{{MM}}-{{DD}}")
						.setValue(automation.action.dailyNoteNamePattern)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.dailyNoteNamePattern =
								val.trim();
							await this.plugin.saveSettings();
						})
				);

			const targetNoteSetting = new Setting(card)
				.setName("Target note path")
				.setDesc("Vault path to the note where the embed will be appended (e.g. MOCs/All PDFs.md).")
				.addText((text) =>
					text
						.setPlaceholder("MOCs/All PDFs.md")
						.setValue(automation.action.targetNotePath ?? "")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.targetNotePath = val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);

			const tagNameSetting = new Setting(card)
				.setName("Tag name")
				.setDesc("Tag to add to the companion note's frontmatter tags array (without leading #).")
				.addText((text) =>
					text
						.setPlaceholder("synced")
						.setValue(automation.action.tagName ?? "")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.tagName = val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);

			const searchFolderSetting = new Setting(card)
				.setName("Search folder path")
				.setDesc(
					"Vault folder to search for notes whose name contains all words of the PDF title " +
					'(case-insensitive, punctuation ignored). Example: "Books/Notes".'
				)
				.addText((text) =>
					text
						.setPlaceholder("Books/Notes")
						.setValue(automation.action.searchFolderPath ?? "")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.searchFolderPath =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);

			const insertPositionSetting = new Setting(card)
				.setName("Insert position")
				.setDesc("Where in the note to insert the embed.")
				.addDropdown((drop) =>
					drop
						.addOption("bottom", "Bottom of note")
						.addOption("top", "Top (after frontmatter)")
						.setValue(automation.action.insertPosition)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.insertPosition =
								val as "top" | "bottom";
							await this.plugin.saveSettings();
						})
				);

			const embedCompanionSetting = new Setting(card)
				.setName("Embed companion note instead of file")
				.setDesc(
					"When enabled, inserts a link to the companion note rather than the PDF. " +
					"Falls back to the PDF if no companion note exists."
				)
				.addToggle((toggle) =>
					toggle
						.setValue(automation.action.embedCompanion ?? false)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.embedCompanion = val;
							await this.plugin.saveSettings();
						})
				);

			const isEmbedType = (type: AutomationActionType) =>
				type === "embed_to_daily_note" ||
				type === "embed_to_weekly_note" ||
				type === "embed_to_monthly_note" ||
				type === "embed_to_quarterly_note" ||
				type === "embed_to_yearly_note" ||
				type === "append_to_note" ||
				type === "link_to_matching_note";

			const updateActionFieldVisibility = (type: AutomationActionType) => {
				dailyPatternSetting.settingEl.toggle(type === "embed_to_daily_note");
				targetNoteSetting.settingEl.toggle(type === "append_to_note");
				tagNameSetting.settingEl.toggle(type === "add_tag_to_companion");
				searchFolderSetting.settingEl.toggle(type === "link_to_matching_note");
				insertPositionSetting.settingEl.toggle(isEmbedType(type));
				embedCompanionSetting.settingEl.toggle(isEmbedType(type) && type !== "link_to_matching_note");
			};
			updateActionFieldVisibility(automation.action.type);
		});
	}

	private generateId(): string {
		return Math.random().toString(36).slice(2) + Date.now().toString(36);
	}
}
