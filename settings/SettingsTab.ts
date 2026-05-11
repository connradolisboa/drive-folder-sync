import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type DriveFolderSyncPlugin from "../main";
import { Automation, AutomationActionType, DeletionBehavior, PeriodicNotesPaths, PluginSettings, SyncPair } from "../types";

type TabId = "account" | "sync" | "notes" | "automations";

export class DriveSyncSettingTab extends PluginSettingTab {
	private activeTab: TabId = "account";
	private openCards = new Set<string>();

	constructor(app: App, private plugin: DriveFolderSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.injectStyles(containerEl);

		containerEl.createEl("h2", { text: "Drive Folder Sync" });

		const nav = containerEl.createEl("nav", { cls: "drive-sync-tabs" });
		const tabs: { id: TabId; label: string }[] = [
			{ id: "account", label: "Account" },
			{ id: "sync", label: "Sync" },
			{ id: "notes", label: "Notes" },
			{ id: "automations", label: "Automations" },
		];

		const panes: Partial<Record<TabId, HTMLElement>> = {};
		const btnEls: Partial<Record<TabId, HTMLButtonElement>> = {};

		const switchTab = (id: TabId) => {
			this.activeTab = id;
			for (const t of tabs) {
				btnEls[t.id]?.toggleClass("is-active", t.id === id);
				if (panes[t.id]) panes[t.id]!.style.display = t.id === id ? "" : "none";
			}
		};

		for (const tab of tabs) {
			const btn = nav.createEl("button", {
				text: tab.label,
				cls: "drive-sync-tab-btn",
			});
			btnEls[tab.id] = btn;
			btn.addEventListener("click", () => switchTab(tab.id));

			const pane = containerEl.createDiv({ cls: "drive-sync-tab-pane" });
			panes[tab.id] = pane;

			if (tab.id === "account") this.renderAccountTab(pane);
			else if (tab.id === "sync") this.renderSyncTab(pane);
			else if (tab.id === "notes") this.renderNotesTab(pane);
			else if (tab.id === "automations") this.renderAutomationsTab(pane);
		}

		switchTab(this.activeTab);
	}

	private injectStyles(containerEl: HTMLElement): void {
		const style = containerEl.createEl("style");
		style.textContent = `
			.drive-sync-tabs {
				display: flex;
				gap: 2px;
				border-bottom: 1px solid var(--background-modifier-border);
				margin-bottom: 20px;
			}
			.drive-sync-tab-btn {
				padding: 6px 16px;
				border: none;
				background: transparent;
				cursor: pointer;
				color: var(--text-muted);
				font-size: var(--font-ui-small);
				border-bottom: 2px solid transparent;
				margin-bottom: -1px;
				border-radius: 4px 4px 0 0;
				transition: color 0.1s;
			}
			.drive-sync-tab-btn:hover {
				color: var(--text-normal);
				background: var(--background-modifier-hover);
			}
			.drive-sync-tab-btn.is-active {
				color: var(--text-accent);
				border-bottom-color: var(--interactive-accent);
				font-weight: 600;
			}
			.drive-sync-card {
				border: 1px solid var(--background-modifier-border);
				border-radius: 6px;
				margin-bottom: 10px;
				overflow: hidden;
			}
			.drive-sync-card-header {
				display: flex;
				align-items: center;
				padding: 8px 12px;
				cursor: pointer;
				user-select: none;
				gap: 8px;
				background: var(--background-secondary);
			}
			.drive-sync-card-header:hover {
				background: var(--background-modifier-hover);
			}
			.drive-sync-card-chevron {
				color: var(--text-muted);
				flex-shrink: 0;
				display: flex;
				align-items: center;
				transition: transform 0.15s ease;
			}
			.drive-sync-card.is-open .drive-sync-card-chevron {
				transform: rotate(90deg);
			}
			.drive-sync-card-title {
				flex: 1;
				font-weight: 600;
				font-size: var(--font-ui-small);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				color: var(--text-normal);
			}
			.drive-sync-card-controls {
				display: flex;
				align-items: center;
				gap: 2px;
				flex-shrink: 0;
			}
			.drive-sync-header-setting {
				border: none !important;
				padding: 0 !important;
				margin: 0 !important;
				background: none !important;
				box-shadow: none !important;
			}
			.drive-sync-card-body {
				padding: 4px 12px 4px;
				display: none;
			}
			.drive-sync-card.is-open .drive-sync-card-body {
				display: block;
			}
		`;
	}

	private createCard(
		container: HTMLElement,
		cardId: string,
		title: string,
	): { cardEl: HTMLElement; bodyEl: HTMLElement; controlsEl: HTMLElement } {
		const isOpen = this.openCards.has(cardId);
		const cardEl = container.createDiv({ cls: "drive-sync-card" + (isOpen ? " is-open" : "") });

		const headerEl = cardEl.createDiv({ cls: "drive-sync-card-header" });

		const chevron = headerEl.createDiv({ cls: "drive-sync-card-chevron" });
		chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

		headerEl.createDiv({ cls: "drive-sync-card-title", text: title });

		const controlsEl = headerEl.createDiv({ cls: "drive-sync-card-controls" });

		const bodyEl = cardEl.createDiv({ cls: "drive-sync-card-body" });

		headerEl.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".drive-sync-card-controls")) return;
			const opening = !cardEl.hasClass("is-open");
			cardEl.toggleClass("is-open", opening);
			if (opening) this.openCards.add(cardId);
			else this.openCards.delete(cardId);
		});

		return { cardEl, bodyEl, controlsEl };
	}

	/** Add an enabled toggle to a card's controls area. */
	private addCardToggle(
		controlsEl: HTMLElement,
		value: boolean,
		onChange: (val: boolean) => void,
	): void {
		const wrapper = controlsEl.createDiv();
		wrapper.addEventListener("click", (e) => e.stopPropagation());
		const s = new Setting(wrapper);
		s.settingEl.addClass("drive-sync-header-setting");
		s.nameEl.style.display = "none";
		s.infoEl.style.display = "none";
		s.addToggle((t) => t.setValue(value).onChange(onChange));
	}

	/** Add an icon button to a card's controls area. */
	private addCardButton(
		controlsEl: HTMLElement,
		svgPath: string,
		tooltip: string,
		onClick: (e: MouseEvent) => void,
	): HTMLButtonElement {
		const btn = controlsEl.createEl("button", { cls: "clickable-icon" });
		btn.innerHTML = svgPath;
		btn.title = tooltip;
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick(e);
		});
		return btn;
	}

	// ── Tab renderers ────────────────────────────────────────────────────────

	private renderAccountTab(el: HTMLElement): void {
		el.createEl("h3", { text: "Google Cloud credentials" });

		new Setting(el)
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

		new Setting(el)
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

		el.createEl("h3", { text: "Google account" });

		new Setting(el)
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

		// ── AI Transcription ──────────────────────────────────────────────────
		el.createEl("h3", { text: "AI Transcription (optional)" });
		el.createEl("p", {
			text:
				"Transcribe handwritten or printed text from synced PDFs using an AI API. " +
				"Output is stored in companion notes and available as {{transcription}} in templates.",
			cls: "setting-item-description",
		});

		const provider = this.plugin.settings.transcriptionProvider ?? "gemini";

		new Setting(el)
			.setName("Enable AI transcription")
			.setDesc("Automatically transcribe PDFs when they are downloaded during sync.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.geminiEnabled)
					.onChange(async (val) => {
						this.plugin.settings.geminiEnabled = val;
						await this.plugin.saveSettings();
						providerSetting.settingEl.toggle(val);
						geminiApiKeySetting.settingEl.toggle(val && currentProvider() === "gemini");
						geminiModelSetting.settingEl.toggle(val && currentProvider() === "gemini");
						geminiPromptSetting.settingEl.toggle(val && currentProvider() === "gemini");
						mistralApiKeySetting.settingEl.toggle(val && currentProvider() === "mistral");
					})
			);

		const currentProvider = () => this.plugin.settings.transcriptionProvider ?? "gemini";

		const providerSetting = new Setting(el)
			.setName("Provider")
			.setDesc("Which AI service to use for transcription.")
			.addDropdown((drop) =>
				drop
					.addOption("gemini", "Google Gemini")
					.addOption("mistral", "Mistral OCR")
					.setValue(provider)
					.onChange(async (val) => {
						this.plugin.settings.transcriptionProvider = val as "gemini" | "mistral";
						await this.plugin.saveSettings();
						const isGemini = val === "gemini";
						geminiApiKeySetting.settingEl.toggle(isGemini);
						geminiModelSetting.settingEl.toggle(isGemini);
						geminiPromptSetting.settingEl.toggle(isGemini);
						mistralApiKeySetting.settingEl.toggle(!isGemini);
					})
			);

		const geminiApiKeySetting = new Setting(el)
			.setName("Gemini API key")
			.setDesc("From Google AI Studio (aistudio.google.com). Free tier available.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("AIza…")
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (val) => {
						this.plugin.settings.geminiApiKey = val.trim();
						await this.plugin.saveSettings();
					});
			});

		const geminiModelSetting = new Setting(el)
			.setName("Model")
			.setDesc("Gemini model to use for transcription.")
			.addDropdown((drop) =>
				drop
					.addOption("gemini-2.0-flash", "Gemini 2.0 Flash (recommended)")
					.addOption("gemini-1.5-flash", "Gemini 1.5 Flash")
					.addOption("gemini-1.5-pro", "Gemini 1.5 Pro")
					.setValue(this.plugin.settings.geminiModel || "gemini-2.0-flash")
					.onChange(async (val) => {
						this.plugin.settings.geminiModel = val;
						await this.plugin.saveSettings();
					})
			);

		const geminiPromptSetting = new Setting(el)
			.setName("Transcription prompt")
			.setDesc("Instructions sent to Gemini for each PDF. Customize for your note-taking style.")
			.addTextArea((text) => {
				text
					.setPlaceholder("Transcribe all text visible in this PDF exactly as written…")
					.setValue(this.plugin.settings.geminiPrompt)
					.onChange(async (val) => {
						this.plugin.settings.geminiPrompt = val;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
				text.inputEl.style.width = "100%";
				text.inputEl.style.resize = "vertical";
			});

		const mistralApiKeySetting = new Setting(el)
			.setName("Mistral API key")
			.setDesc("From console.mistral.ai. Uses the mistral-ocr-latest model.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("…")
					.setValue(this.plugin.settings.mistralApiKey)
					.onChange(async (val) => {
						this.plugin.settings.mistralApiKey = val.trim();
						await this.plugin.saveSettings();
					});
			});

		const enabled = this.plugin.settings.geminiEnabled;
		const isGemini = currentProvider() === "gemini";
		providerSetting.settingEl.toggle(enabled);
		geminiApiKeySetting.settingEl.toggle(enabled && isGemini);
		geminiModelSetting.settingEl.toggle(enabled && isGemini);
		geminiPromptSetting.settingEl.toggle(enabled && isGemini);
		mistralApiKeySetting.settingEl.toggle(enabled && !isGemini);
	}

	private renderSyncTab(el: HTMLElement): void {
		// ── Sync folders ──────────────────────────────────────────────────
		el.createEl("h3", { text: "Sync folders" });
		el.createEl("p", {
			text: "Each entry maps a Google Drive folder to a vault folder.",
			cls: "setting-item-description",
		});

		const pairsContainer = el.createDiv({ cls: "drive-sync-pairs" });
		this.renderPairs(pairsContainer);

		new Setting(el).addButton((btn) =>
			btn
				.setButtonText("+ Add folder pair")
				.setCta()
				.onClick(async () => {
					const id = this.generateId();
					this.plugin.settings.syncPairs.push({
						id,
						label: `Pair ${this.plugin.settings.syncPairs.length + 1}`,
						driveFolderId: "",
						vaultDestFolder: "Drive Sync",
						enabled: true,
					});
					this.openCards.add(`pair-${id}`);
					await this.plugin.saveSettings();
					this.display();
				})
		);

		// ── Sync schedule ─────────────────────────────────────────────────
		el.createEl("h3", { text: "Sync schedule" });

		new Setting(el)
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

		new Setting(el)
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

		new Setting(el)
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
		el.createEl("h3", { text: "Deletion behavior" });

		let archiveSetting: Setting;

		new Setting(el)
			.setName("When a file is removed from Drive")
			.setDesc("What to do with vault files that no longer exist in the Drive folder.")
			.addDropdown((drop) => {
				drop
					.addOption("keep", "Keep in vault")
					.addOption("delete", "Move to system trash")
					.addOption("delete_keep_companion", "Move to system trash (keep companion note)")
					.addOption("delete_only_companion", "Keep PDF, delete companion note only")
					.addOption("archive", "Move to archive folder")
					.addOption("archive_keep_companion", "Move to archive folder (keep companion note)")
					.setValue(this.plugin.settings.deletionBehavior)
					.onChange(async (val) => {
						this.plugin.settings.deletionBehavior = val as DeletionBehavior;
						await this.plugin.saveSettings();
						archiveSetting.settingEl.toggle(val === "archive" || val === "archive_keep_companion");
					});
			});

		archiveSetting = new Setting(el)
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

		// ── Drive Archive folder ───────────────────────────────────────────
		el.createEl("h3", { text: "Drive Archive folder" });
		el.createEl("p", {
			text:
				"Designate a Drive folder as an archive destination. Files moved there are not downloaded " +
				"but are detected during sync — use the per-pair setting below to control what happens to " +
				"the local vault copy when a file is archived in Drive.",
			cls: "setting-item-description",
		});

		new Setting(el)
			.setName("Drive Archive folder ID")
			.setDesc(
				"Folder ID or URL of your Drive archive folder. " +
				"Leave empty to disable. You can paste the full Drive URL here."
			)
			.addText((text) =>
				text
					.setPlaceholder("Folder ID or paste full URL")
					.setValue(this.plugin.settings.driveArchiveFolderId)
					.onChange(async (val) => {
						const match = val.match(/\/folders\/([a-zA-Z0-9_-]+)/);
						const id = match ? match[1] : val.trim();
						if (match) text.setValue(id);
						this.plugin.settings.driveArchiveFolderId = id;
						await this.plugin.saveSettings();
					})
			);

		// ── Sync log ──────────────────────────────────────────────────────
		el.createEl("h3", { text: "Sync log" });

		new Setting(el)
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

		const syncLogPathSetting = new Setting(el)
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
		el.createEl("h3", { text: "Manual sync" });

		new Setting(el)
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
							((result.moved ?? 0) > 0 ? `, ${result.moved} moved` : "") +
							(result.removed > 0 ? `, ${result.removed} removed` : "") +
							((result.archived ?? 0) > 0 ? `, ${result.archived} archived` : "") +
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

	private renderNotesTab(el: HTMLElement): void {
		// ── Companion notes ───────────────────────────────────────────────
		el.createEl("h3", { text: "Companion notes" });
		el.createEl("p", {
			text:
				"For each PDF, automatically create a Markdown note with frontmatter " +
				"(processed, lastUpdate, syncDate, driveFileId). " +
				"The processed property resets to false whenever the PDF is updated.",
			cls: "setting-item-description",
		});

		new Setting(el)
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

		const companionFolderSetting = new Setting(el)
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

		const companionTitleSetting = new Setting(el)
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

		const companionTemplateSetting = new Setting(el)
			.setName("Template file path")
			.setDesc(
				"Vault path to a .md file to use as the companion note template. " +
				"Leave empty to use the built-in default. " +
				"Available placeholders: {{title}}, {{fileName}}, {{fileLink}}, " +
				"{{lastUpdate}}, {{syncDate}}, {{driveFileId}}, {{relativePath}}, {{pairLabel}}, " +
				"{{transcription}} (Gemini transcription text, if enabled)."
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

		companionFolderSetting.settingEl.toggle(this.plugin.settings.companionNotesEnabled);
		companionTitleSetting.settingEl.toggle(this.plugin.settings.companionNotesEnabled);
		companionTemplateSetting.settingEl.toggle(this.plugin.settings.companionNotesEnabled);

		// ── Periodic Notes ────────────────────────────────────────────────
		el.createEl("h3", { text: "Periodic Notes" });
		el.createEl("p", {
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
			new Setting(el)
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
	}

	private renderAutomationsTab(el: HTMLElement): void {
		el.createEl("h3", { text: "Automations" });
		el.createEl("p", {
			text:
				"Run actions automatically after a PDF is downloaded. " +
				"Each automation matches a vault folder path and performs an action on the file.",
			cls: "setting-item-description",
		});

		const automationsContainer = el.createDiv();
		this.renderAutomations(automationsContainer);

		new Setting(el).addButton((btn) =>
			btn
				.setButtonText("+ Add automation")
				.setCta()
				.onClick(async () => {
					const id = this.generateId();
					this.plugin.settings.automations.push({
						id,
						name: `Automation ${this.plugin.settings.automations.length + 1}`,
						enabled: true,
						triggerFolderPath: "",
						action: { type: "embed_to_daily_note", insertPosition: "bottom", dailyNoteNamePattern: "" },
					});
					this.openCards.add(`automation-${id}`);
					await this.plugin.saveSettings();
					this.display();
				})
		);
	}

	// ── Card renderers ───────────────────────────────────────────────────────

	private renderPairs(container: HTMLElement): void {
		container.empty();

		if (this.plugin.settings.syncPairs.length === 0) {
			container.createEl("p", {
				text: "No sync folders configured. Click \"+ Add folder pair\" to get started.",
				cls: "setting-item-description",
			});
			return;
		}

		const SYNC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
		const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

		this.plugin.settings.syncPairs.forEach((pair, i) => {
			if (!pair.excludedSubfolders) pair.excludedSubfolders = [];

			const cardId = `pair-${pair.id}`;
			const { cardEl, bodyEl, controlsEl } = this.createCard(
				container,
				cardId,
				pair.label || `Pair ${i + 1}`,
			);

			// Enabled toggle
			this.addCardToggle(controlsEl, pair.enabled, async (val) => {
				this.plugin.settings.syncPairs[i].enabled = val;
				await this.plugin.saveSettings();
			});

			// Sync now button
			const syncBtn = this.addCardButton(controlsEl, SYNC_ICON, "Sync this pair now", async () => {
				syncBtn.setAttr("disabled", "");
				try {
					const result = await this.plugin.runSyncForPair(pair.id);
					new Notice(
						`"${pair.label}" — ${result.downloaded} downloaded, ` +
						`${result.skipped} up to date` +
						((result.moved ?? 0) > 0 ? `, ${result.moved} moved` : "") +
						(result.removed > 0 ? `, ${result.removed} removed` : "") +
						((result.archived ?? 0) > 0 ? `, ${result.archived} archived` : "") +
						(result.errors > 0 ? `, ${result.errors} errors` : "")
					);
				} catch (e) {
					new Notice(`Sync failed: ${(e as Error).message}`);
				} finally {
					syncBtn.removeAttribute("disabled");
				}
			});

			// Delete button
			this.addCardButton(controlsEl, TRASH_ICON, "Delete this pair", async () => {
				this.plugin.settings.syncPairs.splice(i, 1);
				await this.plugin.saveSettings();
				this.display();
			});

			// ── Body ──────────────────────────────────────────────────────

			new Setting(bodyEl)
				.setName("Label")
				.setDesc("A friendly name for this sync pair.")
				.addText((text) =>
					text
						.setPlaceholder("e.g. Boox Notes")
						.setValue(pair.label)
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].label = val;
							const titleEl = cardEl.querySelector(".drive-sync-card-title");
							if (titleEl) titleEl.textContent = val || `Pair ${i + 1}`;
							await this.plugin.saveSettings();
						})
				);

			new Setting(bodyEl)
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

			new Setting(bodyEl)
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

			new Setting(bodyEl)
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

			new Setting(bodyEl)
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

			new Setting(bodyEl)
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

			new Setting(bodyEl)
				.setName("Collapse single-file folders")
				.setDesc("Strip a wrapper folder when it has the same name as the file inside it. e.g. Books/My Book/My Book.pdf → Books/My Book.pdf")
				.addToggle((toggle) =>
					toggle
						.setValue(pair.collapseSingleFileFolder ?? false)
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].collapseSingleFileFolder = val;
							await this.plugin.saveSettings();
						})
				);

			// Advanced overrides (collapsible)
			const advancedEl = bodyEl.createDiv();
			advancedEl.style.display = "none";

			const advancedToggle = new Setting(bodyEl)
				.setName("Advanced overrides")
				.setDesc("Override global deletion and companion note settings for this pair only.")
				.addToggle((toggle) =>
					toggle.setValue(false).onChange((val) => {
						advancedEl.style.display = val ? "block" : "none";
					})
				);
			bodyEl.insertBefore(advancedToggle.settingEl, advancedEl);

			const pairArchiveSetting = new Setting(advancedEl)
				.setName("Deletion behavior (override)")
				.setDesc("Leave unset to use the global setting.")
				.addDropdown((drop) => {
					drop
						.addOption("", "— use global —")
						.addOption("keep", "Keep in vault")
						.addOption("delete", "Move to system trash")
						.addOption("delete_keep_companion", "Move to system trash (keep companion note)")
						.addOption("delete_only_companion", "Keep PDF, delete companion note only")
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

			const driveArchiveBehaviorSetting = new Setting(advancedEl)
				.setName("Drive archive behavior (override)")
				.setDesc(
					"What to do with the vault copy when a file moves to the Drive Archive folder. " +
					"Leave unset to use this pair's deletion behavior. " +
					"Only applies when a Drive Archive folder ID is configured globally."
				)
				.addDropdown((drop) => {
					drop
						.addOption("", "— use deletion behavior —")
						.addOption("keep", "Do nothing (keep in vault)")
						.addOption("delete", "Move to system trash")
						.addOption("delete_keep_companion", "Move to system trash (keep companion note)")
						.addOption("delete_only_companion", "Keep PDF, delete companion note only")
						.addOption("archive", "Move to local archive folder")
						.addOption("archive_keep_companion", "Move to local archive folder (keep companion note)")
						.setValue(pair.driveArchiveBehavior ?? "")
						.onChange(async (val) => {
							this.plugin.settings.syncPairs[i].driveArchiveBehavior =
								val ? val as DeletionBehavior : undefined;
							await this.plugin.saveSettings();
						});
				});
			driveArchiveBehaviorSetting.settingEl.toggle(!!this.plugin.settings.driveArchiveFolderId);

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

		const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
		const RUN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

		const TOKEN_HINT =
			"Supports date tokens from the PDF filename: " +
			"{{YYYY}} (year), {{MM}} (month), {{DD}} (day), {{Q}} (quarter), " +
			"{{ddd}} / {{dddd}} (weekday), {{MMM}} / {{MMMM}} (month name).";

		this.plugin.settings.automations.forEach((automation, i) => {
			const cardId = `automation-${automation.id}`;
			const { cardEl, bodyEl, controlsEl } = this.createCard(
				container,
				cardId,
				automation.name || `Automation ${i + 1}`,
			);

			// Enabled toggle
			this.addCardToggle(controlsEl, automation.enabled, async (val) => {
				this.plugin.settings.automations[i].enabled = val;
				await this.plugin.saveSettings();
			});

			// Run on existing files button
			this.addCardButton(controlsEl, RUN_ICON, "Run on existing files", () => {
				const count = this.plugin.countMatchingFilesForAutomation(automation.id);
				new RunOnExistingFilesModal(this.app, automation.name, count, (force) => {
					(async () => {
						const notice = new Notice(`Running "${automation.name}"…`, 0);
						try {
							const r = await this.plugin.runAutomationOnExistingFiles(automation.id, { force });
							notice.hide();
							new Notice(
								`"${automation.name}" — ${r.ran} ran, ${r.skipped} skipped` +
								(r.errors > 0 ? `, ${r.errors} errors` : "")
							);
						} catch (err) {
							notice.hide();
							new Notice(`Automation failed: ${(err as Error).message}`);
						}
					})();
				}).open();
			});

			// Delete button
			this.addCardButton(controlsEl, TRASH_ICON, "Delete this automation", async () => {
				this.plugin.settings.automations.splice(i, 1);
				await this.plugin.saveSettings();
				this.display();
			});

			// ── Body ──────────────────────────────────────────────────────

			new Setting(bodyEl)
				.setName("Name")
				.setDesc("A descriptive name for this automation.")
				.addText((text) =>
					text
						.setPlaceholder("e.g. Embed daily PDFs")
						.setValue(automation.name)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].name = val;
							const titleEl = cardEl.querySelector(".drive-sync-card-title");
							if (titleEl) titleEl.textContent = val || `Automation ${i + 1}`;
							await this.plugin.saveSettings();
						})
				);

			new Setting(bodyEl)
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

			new Setting(bodyEl)
				.setName("File scope")
				.setDesc(
					"Which files inside the trigger folder fire this automation. " +
					'"All files" includes every depth. ' +
					'"Root files only" skips subfolders. ' +
					'"Subfolders only" skips files sitting directly in the trigger folder.'
				)
				.addDropdown((drop) =>
					drop
						.addOption("all",              "All files")
						.addOption("root_only",        "Root files only")
						.addOption("subfolders_only",  "Subfolders only")
						.setValue(automation.triggerScope ?? "all")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].triggerScope =
								val as "all" | "root_only" | "subfolders_only";
							await this.plugin.saveSettings();
						})
				);

			new Setting(bodyEl)
				.setName("Excluded subfolders")
				.setDesc(
					"Comma-separated subfolder names (relative to the trigger folder) whose files should be ignored. " +
					'Example: "Archive, Old" skips files inside Archive/ and Old/.'
				)
				.addText((text) =>
					text
						.setPlaceholder("Archive, Old")
						.setValue((automation.excludedSubfolders ?? []).join(", "))
						.onChange(async (val) => {
							const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
							this.plugin.settings.automations[i].excludedSubfolders =
								parts.length ? parts : undefined;
							await this.plugin.saveSettings();
						})
				);

			new Setting(bodyEl)
				.setName("Action")
				.setDesc(
					"Periodic embeds insert a link into the matching periodic note (path configured in the Notes tab). " +
					"append_to_note appends to any named note. " +
					"add_tag_to_companion adds a tag to the companion note's frontmatter. " +
					"link_to_matching_note finds notes in a folder whose name contains all words of the PDF title and inserts an embed. " +
					"transcribe_to_periodic_note appends the Gemini transcription to a periodic note (requires Gemini enabled)."
				)
				.addDropdown((drop) =>
					drop
						.addOption("embed_to_daily_note",        "Embed to daily note")
						.addOption("embed_to_weekly_note",       "Embed to weekly note")
						.addOption("embed_to_monthly_note",      "Embed to monthly note")
						.addOption("embed_to_quarterly_note",    "Embed to quarterly note")
						.addOption("embed_to_yearly_note",       "Embed to yearly note")
						.addOption("append_to_note",             "Append to note")
						.addOption("add_tag_to_companion",       "Add tag to companion note")
						.addOption("link_to_matching_note",      "Link to matching note")
						.addOption("transcribe_to_periodic_note","Transcribe to periodic note")
						.addOption("transcribe_to_companion",    "Transcribe to companion note")
						.setValue(automation.action.type)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.type =
								val as AutomationActionType;
							await this.plugin.saveSettings();
							updateActionFieldVisibility(val as AutomationActionType);
						})
				);

			// ── Action-specific fields ────────────────────────────────────
			const dailyPatternSetting = new Setting(bodyEl)
				.setName("Daily note path (override)")
				.setDesc(
					"Per-automation override for the daily note path. Uses the same format as the global " +
					"Daily note path in the Notes tab (folder + filename with Moment.js tokens). " +
					TOKEN_HINT +
					" Example: Journal/Daily/{{YYYY}}-{{MM}}-{{DD}}. " +
					"Leave empty to use the global Daily note path from the Notes tab " +
					"(or fall back to frontmatter search if that is also unset)."
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

			const targetNoteSetting = new Setting(bodyEl)
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

			const tagNameSetting = new Setting(bodyEl)
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

			const searchFolderSetting = new Setting(bodyEl)
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

			const createNoteIfNotFoundSetting = new Setting(bodyEl)
				.setName("Create note if not found")
				.setDesc(
					"When enabled, a new note is created if no matching note exists in the search folder. " +
					"The new note uses the PDF title as its filename and can be pre-filled from a template."
				)
				.addToggle((toggle) =>
					toggle
						.setValue(automation.action.createNoteIfNotFound ?? false)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.createNoteIfNotFound = val;
							await this.plugin.saveSettings();
							newNoteFolderSetting.settingEl.toggle(val);
							newNoteTemplateSetting.settingEl.toggle(val);
						})
				);

			const createNoteEnabled = automation.action.createNoteIfNotFound ?? false;

			const newNoteFolderSetting = new Setting(bodyEl)
				.setName("New note folder")
				.setDesc("Folder where the new note is created. Defaults to the search folder when left empty.")
				.addText((text) =>
					text
						.setPlaceholder("(uses search folder)")
						.setValue(automation.action.newNoteFolder ?? "")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.newNoteFolder =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);
			newNoteFolderSetting.settingEl.toggle(createNoteEnabled);

			const newNoteTemplateSetting = new Setting(bodyEl)
				.setName("New note template")
				.setDesc(
					"Vault path to a template note whose content is copied into the new note. " +
					"Leave empty to create a blank note."
				)
				.addText((text) =>
					text
						.setPlaceholder("Templates/Note Template.md")
						.setValue(automation.action.newNoteTemplatePath ?? "")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.newNoteTemplatePath =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);
			newNoteTemplateSetting.settingEl.toggle(createNoteEnabled);

			// ── link_to_matching_note advanced options ──────────────────────
			const matchThresholdSetting = new Setting(bodyEl)
				.setName("Match confidence threshold")
				.setDesc(
					"Fraction of PDF title words that must appear in a note name (1.0 = all words). " +
					"Lower values allow partial matches (e.g. 0.5 = half the words)."
				)
				.addSlider((slider) =>
					slider
						.setLimits(0.5, 1.0, 0.05)
						.setValue(automation.action.matchConfidenceThreshold ?? 1.0)
						.setDynamicTooltip()
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.matchConfidenceThreshold = val;
							await this.plugin.saveSettings();
						})
				);

			const matchAliasesSetting = new Setting(bodyEl)
				.setName("Match on aliases")
				.setDesc("Also check note frontmatter aliases fields when searching for a match.")
				.addToggle((toggle) =>
					toggle
						.setValue(automation.action.matchOnAliases ?? false)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.matchOnAliases = val;
							await this.plugin.saveSettings();
						})
				);

			const bidirectionalLinkSetting = new Setting(bodyEl)
				.setName("Bidirectional link")
				.setDesc("Also add a backlink to the matched note inside the companion note.")
				.addToggle((toggle) =>
					toggle
						.setValue(automation.action.bidirectionalLink ?? false)
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.bidirectionalLink = val;
							await this.plugin.saveSettings();
						})
				);

			// ── transcribe_to_periodic_note options ─────────────────────────
			const periodicNoteTypeSetting = new Setting(bodyEl)
				.setName("Periodic note type")
				.setDesc("Which periodic note to append the transcription to.")
				.addDropdown((drop) =>
					drop
						.addOption("daily",     "Daily")
						.addOption("weekly",    "Weekly")
						.addOption("monthly",   "Monthly")
						.addOption("quarterly", "Quarterly")
						.addOption("yearly",    "Yearly")
						.setValue(automation.action.periodicNoteType ?? "daily")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.periodicNoteType =
								val as "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
							await this.plugin.saveSettings();
						})
				);

			const transcriptionTemplateSetting = new Setting(bodyEl)
				.setName("Transcription template")
				.setDesc(
					"Template for the content inserted into the periodic note. " +
					"Placeholders: {{transcription}}, {{title}}, {{date}}, {{link}} → [[file]], {{embed}} → ![[file]]. " +
					"Leave empty to use the default."
				)
				.addTextArea((text) => {
					text
						.setPlaceholder("## Transcription from [[{{title}}]]\n\n{{transcription}}")
						.setValue(automation.action.transcriptionTemplate ?? "")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.transcriptionTemplate =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						});
					text.inputEl.rows = 4;
					text.inputEl.style.width = "100%";
					text.inputEl.style.fontFamily = "monospace";
					text.inputEl.style.resize = "vertical";
				});

			const insertPositionSetting = new Setting(bodyEl)
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

			const embedCompanionSetting = new Setting(bodyEl)
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

			const embedTemplateSetting = new Setting(bodyEl)
				.setName("Embed template")
				.setDesc(
					"Template for the content inserted into the note. Supports multiple lines. " +
					"Leave empty for the default (![[file]]). " +
					"Placeholders: {{embed}} → ![[target]], {{link}} → [[target]], " +
					"{{target}} → embed target name, {{title}} → PDF stem (no extension), {{date}} → YYYY-MM-DD."
				)
				.addTextArea((text) => {
					text
						.setPlaceholder("- {{embed}}")
						.setValue(automation.action.embedTemplate ?? "")
						.onChange(async (val) => {
							this.plugin.settings.automations[i].action.embedTemplate =
								val.trim() || undefined;
							await this.plugin.saveSettings();
						});
					text.inputEl.rows = 4;
					text.inputEl.style.width = "100%";
					text.inputEl.style.fontFamily = "monospace";
					text.inputEl.style.resize = "vertical";
				});

			const isEmbedType = (type: AutomationActionType) =>
				type === "embed_to_daily_note" ||
				type === "embed_to_weekly_note" ||
				type === "embed_to_monthly_note" ||
				type === "embed_to_quarterly_note" ||
				type === "embed_to_yearly_note" ||
				type === "append_to_note" ||
				type === "link_to_matching_note" ||
				type === "transcribe_to_periodic_note";

			const updateActionFieldVisibility = (type: AutomationActionType) => {
				const isLinkToNote = type === "link_to_matching_note";
				const isTranscribePeriodicAction = type === "transcribe_to_periodic_note";
				const isTranscribeCompanionAction = type === "transcribe_to_companion";
				const isAnyTranscribeAction = isTranscribePeriodicAction || isTranscribeCompanionAction;
				const createEnabled = this.plugin.settings.automations[i].action.createNoteIfNotFound ?? false;
				dailyPatternSetting.settingEl.toggle(type === "embed_to_daily_note");
				targetNoteSetting.settingEl.toggle(type === "append_to_note");
				tagNameSetting.settingEl.toggle(type === "add_tag_to_companion");
				searchFolderSetting.settingEl.toggle(isLinkToNote);
				createNoteIfNotFoundSetting.settingEl.toggle(isLinkToNote);
				newNoteFolderSetting.settingEl.toggle(isLinkToNote && createEnabled);
				newNoteTemplateSetting.settingEl.toggle(isLinkToNote && createEnabled);
				matchThresholdSetting.settingEl.toggle(isLinkToNote);
				matchAliasesSetting.settingEl.toggle(isLinkToNote);
				bidirectionalLinkSetting.settingEl.toggle(isLinkToNote);
				periodicNoteTypeSetting.settingEl.toggle(isTranscribePeriodicAction);
				transcriptionTemplateSetting.settingEl.toggle(isAnyTranscribeAction);
				insertPositionSetting.settingEl.toggle(isEmbedType(type));
				embedCompanionSetting.settingEl.toggle(isEmbedType(type) && !isLinkToNote && !isAnyTranscribeAction);
				embedTemplateSetting.settingEl.toggle(isEmbedType(type) && !isAnyTranscribeAction);
			};
			updateActionFieldVisibility(automation.action.type);
		});
	}

	private generateId(): string {
		return Math.random().toString(36).slice(2) + Date.now().toString(36);
	}
}

class RunOnExistingFilesModal extends Modal {
	private force = false;

	constructor(
		app: App,
		private automationName: string,
		private matchedCount: number,
		private onConfirm: (force: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Run "${this.automationName}"` });
		contentEl.createEl("p", {
			text: `This will check ${this.matchedCount} matching file${this.matchedCount !== 1 ? "s" : ""}.`,
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.setName("Force re-run")
			.setDesc("Re-run even for files already completed at the current Drive version.")
			.addToggle((t) => t.setValue(false).onChange((v) => { this.force = v; }));

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Run").setCta().onClick(() => {
					this.close();
					this.onConfirm(this.force);
				})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
