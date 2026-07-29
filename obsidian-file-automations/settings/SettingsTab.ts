import { App, PluginSettingTab, Setting } from "obsidian";
import type {
	Automation,
	AutomationAction,
	AutomationActionType,
	CompanionRule,
	FileAutomationSettings,
	SourceDeletionPolicy,
	TriggerScope
} from "../types";

export interface SettingsHost {
	settings: FileAutomationSettings;
	saveSettings(): Promise<void>;
	runAutomation(automationId: string, dryRun?: boolean): Promise<void>;
}

type Tab = "notes" | "automations" | "transcription" | "pdf";

export class FileAutomationsSettingsTab extends PluginSettingTab {
	private activeTab: Tab = "notes";

	constructor(app: App, private host: SettingsHost) {
		super(app, host as never);
	}

	display(): void {
		this.containerEl.empty();
		this.containerEl.createEl("h2", { text: "File Automations" });
		const nav = this.containerEl.createDiv();
		nav.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px;";
		for (const [id, label] of [
			["notes", "Notes"],
			["automations", "Automations"],
			["transcription", "Transcription"],
			["pdf", "PDF Embed"]
		] as Array<[Tab, string]>) {
			const button = nav.createEl("button", { text: label });
			if (id === this.activeTab) button.addClass("mod-cta");
			button.onclick = () => {
				this.activeTab = id;
				this.display();
			};
		}
		if (this.activeTab === "notes") this.renderNotes();
		if (this.activeTab === "automations") this.renderAutomations();
		if (this.activeTab === "transcription") this.renderTranscription();
		if (this.activeTab === "pdf") this.renderPdf();
	}

	private renderNotes(): void {
		const settings = this.host.settings;
		new Setting(this.containerEl)
			.setName("Enable companion notes")
			.setDesc("Create and refresh notes for PDFs matched by the first most-specific rule.")
			.addToggle((toggle) => toggle.setValue(settings.companionNotesEnabled).onChange(async (value) => {
				settings.companionNotesEnabled = value;
				await this.save(false);
			}));
		this.text("Default companion folder", settings.companionNotesFolder, async (value) => {
			settings.companionNotesFolder = value;
		}, "Empty places companions beside their PDFs; / means the vault root. Folder tokens are supported.");
		this.text("Default template path", settings.companionNoteTemplatePath, async (value) => {
			settings.companionNoteTemplatePath = value;
		});
		this.text("Default title template", settings.companionNoteTitle, async (value) => {
			settings.companionNoteTitle = value;
		}, "Supports {{title}}, {{fileName}}, {{ruleLabel}}, {{pairLabel}}, and {{relativePath}}.");
		this.dropdown(
			"Default source-deletion policy",
			settings.companionOnSourceDelete,
			{ keep: "Keep companion", delete: "Delete companion", archive: "Archive companion" },
			async (value) => { settings.companionOnSourceDelete = value as SourceDeletionPolicy; }
		);
		this.text("Default companion archive folder", settings.companionArchiveFolder, async (value) => {
			settings.companionArchiveFolder = value;
		});
		this.dropdown(
			"Concurrent-edit policy",
			settings.conflictPolicy,
			{
				"save-both": "Save both",
				"keep-vault": "Keep vault note",
				"take-drive": "Refresh tracking fields",
				ask: "Ask (save both in background)"
			},
			async (value) => { settings.conflictPolicy = value as FileAutomationSettings["conflictPolicy"]; }
		);

		this.containerEl.createEl("h3", { text: "Companion rules" });
		this.containerEl.createEl("p", {
			text: "Longer matching folder paths take precedence. Rule IDs stay stable when a rule is edited.",
			cls: "setting-item-description"
		});
		settings.companionRules.forEach((rule, index) => this.renderRule(rule, index));
		new Setting(this.containerEl).addButton((button) => button
			.setButtonText("Add companion rule")
			.setCta()
			.onClick(async () => {
				settings.companionRules.push(newRule());
				await this.save();
			}));
	}

	private renderRule(rule: CompanionRule, index: number): void {
		const card = this.containerEl.createDiv();
		card.style.cssText = "border:1px solid var(--background-modifier-border);border-radius:8px;padding:12px;margin:10px 0;";
		const title = card.createEl("strong", { text: rule.label || `Rule ${index + 1}` });
		title.style.display = "block";
		new Setting(card).setName("Enabled").addToggle((toggle) => toggle.setValue(rule.enabled).onChange(async (value) => {
			rule.enabled = value;
			await this.save();
		}));
		this.textIn(card, "Label", rule.label, async (value) => { rule.label = value; });
		this.textIn(card, "Trigger folder", rule.triggerFolderPath, async (value) => { rule.triggerFolderPath = value; });
		this.dropdownIn(card, "Scope", rule.triggerScope ?? "all", {
			all: "Root and subfolders",
			root_only: "Root files only",
			subfolders_only: "Subfolders only"
		}, async (value) => { rule.triggerScope = value as TriggerScope; });
		this.textIn(card, "Excluded subfolders", (rule.excludedSubfolders ?? []).join(", "), async (value) => {
			rule.excludedSubfolders = value.split(",").map((part) => part.trim()).filter(Boolean);
		}, "Comma-separated paths relative to the trigger folder.");
		this.textIn(card, "Companion folder override", rule.companionFolder ?? "", async (value) => {
			rule.companionFolder = value;
		});
		this.textIn(card, "Template path override", rule.templatePath ?? "", async (value) => {
			rule.templatePath = value;
		});
		this.textIn(card, "Title override", rule.title ?? "", async (value) => { rule.title = value; });
		this.dropdownIn(card, "On source deletion", rule.sourceDeletionPolicy ?? "", {
			"": "Use global default",
			keep: "Keep companion",
			delete: "Delete companion",
			archive: "Archive companion"
		}, async (value) => {
			rule.sourceDeletionPolicy = value ? value as SourceDeletionPolicy : undefined;
		});
		this.dropdownIn(card, "When source is moved to Drive archive", rule.driveArchiveSourceDeletionPolicy ?? "", {
			"": "Use source-deletion policy",
			keep: "Keep companion",
			delete: "Delete companion",
			archive: "Archive companion"
		}, async (value) => {
			rule.driveArchiveSourceDeletionPolicy = value ? value as SourceDeletionPolicy : undefined;
		});
		this.textIn(card, "Archive folder override", rule.archiveFolder ?? "", async (value) => {
			rule.archiveFolder = value;
		});
		new Setting(card)
			.setDesc(`Stable ID: ${rule.id}`)
			.addButton((button) => button.setButtonText("Move up").setDisabled(index === 0).onClick(async () => {
				const rules = this.host.settings.companionRules;
				[rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
				await this.save();
			}))
			.addButton((button) => button
				.setButtonText("Move down")
				.setDisabled(index === this.host.settings.companionRules.length - 1)
				.onClick(async () => {
					const rules = this.host.settings.companionRules;
					[rules[index], rules[index + 1]] = [rules[index + 1], rules[index]];
					await this.save();
				}))
			.addButton((button) => button.setButtonText("Remove").setWarning().onClick(async () => {
				this.host.settings.companionRules.splice(index, 1);
				await this.save();
			}));
	}

	private renderAutomations(): void {
		const settings = this.host.settings;
		this.containerEl.createEl("p", {
			text: "Actions run in this order. The advanced action JSON preserves every supported action field.",
			cls: "setting-item-description"
		});
		settings.automations.forEach((automation, index) => this.renderAutomation(automation, index));
		new Setting(this.containerEl).addButton((button) => button
			.setButtonText("Add automation")
			.setCta()
			.onClick(async () => {
				settings.automations.push(newAutomation());
				await this.save();
			}));
	}

	private renderAutomation(automation: Automation, index: number): void {
		const card = this.containerEl.createDiv();
		card.style.cssText = "border:1px solid var(--background-modifier-border);border-radius:8px;padding:12px;margin:10px 0;";
		card.createEl("strong", { text: automation.name || `Automation ${index + 1}` });
		new Setting(card).setName("Enabled").addToggle((toggle) => toggle.setValue(automation.enabled).onChange(async (value) => {
			automation.enabled = value;
			await this.save();
		}));
		this.textIn(card, "Name", automation.name, async (value) => { automation.name = value; });
		this.textIn(card, "Trigger folder", automation.triggerFolderPath, async (value) => {
			automation.triggerFolderPath = value;
		});
		this.dropdownIn(card, "Scope", automation.triggerScope ?? "all", {
			all: "Root and subfolders",
			root_only: "Root files only",
			subfolders_only: "Subfolders only"
		}, async (value) => { automation.triggerScope = value as TriggerScope; });
		this.textIn(card, "Excluded subfolders", (automation.excludedSubfolders ?? []).join(", "), async (value) => {
			automation.excludedSubfolders = value.split(",").map((part) => part.trim()).filter(Boolean);
		});
		new Setting(card).setName("Action type").addDropdown((dropdown) => dropdown
			.addOptions(actionTypeOptions())
			.setValue(automation.action.type)
			.onChange(async (value) => {
				automation.action.type = value as AutomationActionType;
				await this.save();
			}));
		this.renderActionFields(card, automation);
		new Setting(card)
			.setName("Advanced action JSON")
			.setDesc("Optional escape hatch for advanced edits. Invalid JSON is not saved.")
			.addTextArea((area) => {
				area.setValue(JSON.stringify(automation.action, null, 2));
				area.inputEl.rows = 10;
				area.inputEl.style.width = "100%";
				area.onChange(async (value) => {
					try {
						const parsed = JSON.parse(value) as AutomationAction;
						if (!parsed || typeof parsed.type !== "string") throw new Error("Action type is required");
						automation.action = parsed;
						await this.host.saveSettings();
					} catch {
						// Keep the draft in the textarea; the next valid edit saves it.
					}
				});
			});
		new Setting(card)
			.setDesc(`Stable ID: ${automation.id}`)
			.addButton((button) => button.setButtonText("Run existing").onClick(() => {
				void this.host.runAutomation(automation.id);
			}))
			.addButton((button) => button.setButtonText("Dry run").onClick(() => {
				void this.host.runAutomation(automation.id, true);
			}))
			.addButton((button) => button.setButtonText("Move up").setDisabled(index === 0).onClick(async () => {
				const automations = this.host.settings.automations;
				[automations[index - 1], automations[index]] = [automations[index], automations[index - 1]];
				await this.save();
			}))
			.addButton((button) => button
				.setButtonText("Move down")
				.setDisabled(index === this.host.settings.automations.length - 1)
				.onClick(async () => {
					const automations = this.host.settings.automations;
					[automations[index], automations[index + 1]] = [automations[index + 1], automations[index]];
					await this.save();
				}))
			.addButton((button) => button.setButtonText("Remove").setWarning().onClick(async () => {
				this.host.settings.automations.splice(index, 1);
				await this.save();
			}));
	}

	private renderActionFields(card: HTMLElement, automation: Automation): void {
		const action = automation.action;
		const type = action.type;
		const isPeriodic = type === "add_to_periodic_note";
		const isAppend = type === "append_to_note";
		const isLink = type === "link_to_matching_note";
		const isTranscribe = type === "transcribe_to_companion";
		const isSplit = type === "split_pages_to_daily_notes";
		const periodicType = action.periodicNoteType ?? "daily";
		const runsTranscription = isTranscribe || (isPeriodic && action.runTranscription === true);
		const writesCompanionTranscription =
			isTranscribe ||
			(isPeriodic && action.runTranscription === true && (action.transcriptionTarget ?? "periodic") === "companion");

		if ((isPeriodic && periodicType === "daily") || isSplit) {
			this.textIn(card, "Daily note path override", action.dailyNoteNamePattern ?? "", async (value) => {
				action.dailyNoteNamePattern = value.trim();
			}, "Leave empty to use the global daily-note path.");
		}

		if (isAppend) {
			this.textIn(card, "Target note path", action.targetNotePath ?? "", async (value) => {
				action.targetNotePath = value.trim() || undefined;
			}, "Vault path of the note that receives the entry.");
		}

		if (type === "add_tag_to_companion") {
			this.textIn(card, "Tag name", action.tagName ?? "", async (value) => {
				action.tagName = value.trim().replace(/^#/, "") || undefined;
			}, "Tag to add to the companion note, without the leading #.");
		}

		if (isLink) {
			this.textIn(card, "Search folder path", action.searchFolderPath ?? "", async (value) => {
				action.searchFolderPath = value.trim() || undefined;
			});
			this.toggleIn(card, "Create note if no match is found", action.createNoteIfNotFound ?? false, async (value) => {
				action.createNoteIfNotFound = value;
			}, true);
			if (action.createNoteIfNotFound) {
				this.textIn(card, "New note folder", action.newNoteFolder ?? "", async (value) => {
					action.newNoteFolder = value.trim() || undefined;
				}, "Defaults to the search folder.");
				this.textIn(card, "New note template", action.newNoteTemplatePath ?? "", async (value) => {
					action.newNoteTemplatePath = value.trim() || undefined;
				});
			}
			new Setting(card)
				.setName("Match confidence threshold")
				.setDesc("Fraction of title words that must match, from 0.5 to 1.")
				.addSlider((slider) => slider
					.setLimits(0.5, 1, 0.05)
					.setDynamicTooltip()
					.setValue(action.matchConfidenceThreshold ?? 1)
					.onChange(async (value) => {
						action.matchConfidenceThreshold = value;
						await this.host.saveSettings();
					}));
			this.toggleIn(card, "Match note aliases", action.matchOnAliases ?? false, async (value) => {
				action.matchOnAliases = value;
			});
			this.toggleIn(card, "Add a backlink to the companion", action.bidirectionalLink ?? false, async (value) => {
				action.bidirectionalLink = value;
			});
		}

		if (isPeriodic) {
			this.dropdownIn(card, "Periodic note type", periodicType, {
				daily: "Daily",
				weekly: "Weekly",
				monthly: "Monthly",
				quarterly: "Quarterly",
				yearly: "Yearly"
			}, async (value) => {
				action.periodicNoteType = value as NonNullable<AutomationAction["periodicNoteType"]>;
			}, true);
			this.toggleIn(card, "Run transcription", action.runTranscription ?? false, async (value) => {
				action.runTranscription = value;
			}, true);
			if (action.runTranscription) {
				this.dropdownIn(card, "Transcription destination", action.transcriptionTarget ?? "periodic", {
					periodic: "Periodic note",
					companion: "Companion note"
				}, async (value) => {
					action.transcriptionTarget = value as NonNullable<AutomationAction["transcriptionTarget"]>;
				}, true);
			}
		}

		if (writesCompanionTranscription) {
			this.areaIn(card, "Companion transcription template", action.transcriptionTemplate ?? "", async (value) => {
				action.transcriptionTemplate = value.trim() || undefined;
			}, "Supports {{transcription}}; empty inserts the transcription unchanged.");
			this.dropdownIn(card, "Transcription section position", action.transcriptionInsertPosition ?? "bottom", {
				bottom: "Bottom of note",
				top: "Top, after frontmatter"
			}, async (value) => {
				action.transcriptionInsertPosition = value as NonNullable<AutomationAction["transcriptionInsertPosition"]>;
			});
		}

		if (runsTranscription) {
			this.toggleIn(
				card,
				"Delete source after transcription",
				action.deleteFileAfterTranscription ?? false,
				async (value) => { action.deleteFileAfterTranscription = value; },
				false,
				"Deletes the local source only after transcription was written. Drive Downloader can independently mirror that deletion."
			);
		}

		if (isSplit) {
			this.toggleIn(card, "Create daily note if missing", action.createDailyNoteIfMissing ?? true, async (value) => {
				action.createDailyNoteIfMissing = value;
			});
			this.textIn(card, "Daily note template", action.dailyNoteTemplatePath ?? "", async (value) => {
				action.dailyNoteTemplatePath = value.trim() || undefined;
			});
			this.dropdownIn(card, "Page content", action.pageContentMode ?? "embed", {
				embed: "PDF page embed",
				transcription: "Transcription text",
				both: "Embed and transcription"
			}, async (value) => {
				action.pageContentMode = value as NonNullable<AutomationAction["pageContentMode"]>;
			});
			this.areaIn(card, "Page embed template", action.pageEmbedTemplate ?? "", async (value) => {
				action.pageEmbedTemplate = value.trim() || undefined;
			}, "Supports {{embed}}, {{pagelink}}, {{link}}, {{page}}, {{title}}, {{date}}, and {{transcription}}.");
			this.toggleIn(card, "Write page-index note", action.pageIndexEnabled ?? false, async (value) => {
				action.pageIndexEnabled = value;
			}, true);
			if (action.pageIndexEnabled) {
				this.textIn(card, "Page-index note path", action.pageIndexNotePath ?? "", async (value) => {
					action.pageIndexNotePath = value.trim() || undefined;
				});
				this.textIn(card, "Page-index heading", action.pageIndexHeading ?? "", async (value) => {
					action.pageIndexHeading = value.trim() || undefined;
				});
			}
		}

		if (isPeriodic || isAppend || isLink || isSplit) {
			this.dropdownIn(card, "Insert position", action.insertPosition ?? "bottom", {
				bottom: "Bottom of note",
				top: "Top, after frontmatter"
			}, async (value) => {
				action.insertPosition = value as AutomationAction["insertPosition"];
			});
		}

		if (isPeriodic || isAppend) {
			this.toggleIn(card, "Embed companion instead of source", action.embedCompanion ?? false, async (value) => {
				action.embedCompanion = value;
			});
		}

		if (isPeriodic || isAppend || isLink) {
			this.areaIn(card, "Entry template", action.embedTemplate ?? "", async (value) => {
				action.embedTemplate = value.trim() || undefined;
			}, "Supports {{embed}}, {{link}}, {{target}}, {{title}}, {{date}}, and {{transcription}}.");
		}

		if (isAppend) {
			this.textIn(card, "Include results from automation IDs", (action.includeResultsFromAutomationIds ?? []).join(", "), async (value) => {
				const values = splitList(value);
				action.includeResultsFromAutomationIds = values.length ? values : undefined;
			}, "Comma-separated stable IDs of earlier automations.");
			this.textIn(card, "Include results from action types", (action.includeResultsFromTypes ?? []).join(", "), async (value) => {
				const values = splitList(value) as AutomationActionType[];
				action.includeResultsFromTypes = values.length ? values : undefined;
			}, "Comma-separated action types from earlier automations.");
			this.textIn(card, "Included-results heading", action.includeResultsHeading ?? "", async (value) => {
				action.includeResultsHeading = value.trim() || undefined;
			});
			this.textIn(card, "Included-results line template", action.includeResultsTemplate ?? "", async (value) => {
				action.includeResultsTemplate = value.trim() || undefined;
			}, "Supports {{date}} and {{pages}}.");
		}
	}

	private renderTranscription(): void {
		const settings = this.host.settings;
		new Setting(this.containerEl).setName("Enable AI transcription").addToggle((toggle) =>
			toggle.setValue(settings.geminiEnabled).onChange(async (value) => {
				settings.geminiEnabled = value;
				await this.save(false);
			}));
		this.dropdown("Provider", settings.transcriptionProvider, { gemini: "Gemini", mistral: "Mistral OCR" }, async (value) => {
			settings.transcriptionProvider = value as FileAutomationSettings["transcriptionProvider"];
		});
		this.text("Gemini API key", settings.geminiApiKey, async (value) => { settings.geminiApiKey = value; }, undefined, true);
		this.text("Gemini model", settings.geminiModel, async (value) => { settings.geminiModel = value; });
		new Setting(this.containerEl).setName("Gemini prompt").addTextArea((area) =>
			area.setValue(settings.geminiPrompt).onChange(async (value) => {
				settings.geminiPrompt = value;
				await this.host.saveSettings();
			}));
		this.text("Mistral API key", settings.mistralApiKey, async (value) => { settings.mistralApiKey = value; }, undefined, true);
		this.dropdown("Default command destination", settings.transcribeDefaultDest, {
			ask: "Ask each time",
			companion: "Companion",
			daily: "Daily note",
			note: "Configured note"
		}, async (value) => { settings.transcribeDefaultDest = value as FileAutomationSettings["transcribeDefaultDest"]; });
		this.text("Default note path", settings.transcribeDefaultNotePath, async (value) => {
			settings.transcribeDefaultNotePath = value;
		});
		this.text("Companion fallback folder", settings.transcribeCompanionFallbackFolder, async (value) => {
			settings.transcribeCompanionFallbackFolder = value;
		});
		this.text("Companion template path", settings.transcribeCompanionTemplatePath, async (value) => {
			settings.transcribeCompanionTemplatePath = value;
		});
		this.area("Companion transcription template", settings.transcribeCompanionTemplate, async (value) => {
			settings.transcribeCompanionTemplate = value;
		});
		this.area("Daily transcription template", settings.transcribeDailyTemplate, async (value) => {
			settings.transcribeDailyTemplate = value;
		});
		this.area("Note transcription template", settings.transcribeNoteTemplate, async (value) => {
			settings.transcribeNoteTemplate = value;
		});
		for (const key of ["daily", "weekly", "monthly", "quarterly", "yearly"] as const) {
			this.text(`${key[0].toUpperCase()}${key.slice(1)} note path`, settings.periodicNotesPaths[key], async (value) => {
				settings.periodicNotesPaths[key] = value;
			});
		}
	}

	private renderPdf(): void {
		const settings = this.host.settings;
		new Setting(this.containerEl).setName("Window PDF embeds").addToggle((toggle) =>
			toggle.setValue(settings.pdfEmbedWindowed).onChange(async (value) => {
				settings.pdfEmbedWindowed = value;
				await this.save(false);
			}));
		new Setting(this.containerEl).setName("Embed window height").setDesc("Pixels; minimum 100.")
			.addText((text) => text.setValue(String(settings.pdfEmbedWindowHeight)).onChange(async (value) => {
				const number = Number(value);
				if (Number.isFinite(number)) {
					settings.pdfEmbedWindowHeight = Math.max(100, Math.round(number));
					await this.host.saveSettings();
				}
			}));
		new Setting(this.containerEl).setName("Collapsible PDF embeds").addToggle((toggle) =>
			toggle.setValue(settings.pdfEmbedCollapsible).onChange(async (value) => {
				settings.pdfEmbedCollapsible = value;
				await this.save(false);
			}));
		new Setting(this.containerEl).setName("Start PDF embeds collapsed").addToggle((toggle) =>
			toggle.setValue(settings.pdfEmbedCollapsedByDefault).onChange(async (value) => {
				settings.pdfEmbedCollapsedByDefault = value;
				await this.save(false);
			}));
	}

	private text(name: string, value: string, change: (value: string) => Promise<void>, desc?: string, password = false): void {
		this.textIn(this.containerEl, name, value, change, desc, password);
	}

	private textIn(el: HTMLElement, name: string, value: string, change: (value: string) => Promise<void>, desc?: string, password = false): void {
		const setting = new Setting(el).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addText((text) => {
			text.setValue(value).onChange(async (next) => {
				await change(next);
				await this.host.saveSettings();
			});
			if (password) text.inputEl.type = "password";
		});
	}

	private area(name: string, value: string, change: (value: string) => Promise<void>): void {
		this.areaIn(this.containerEl, name, value, change);
	}

	private areaIn(el: HTMLElement, name: string, value: string, change: (value: string) => Promise<void>, desc?: string): void {
		const setting = new Setting(el).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addTextArea((area) =>
			area.setValue(value).onChange(async (next) => {
				await change(next);
				await this.host.saveSettings();
			}));
	}

	private toggleIn(
		el: HTMLElement,
		name: string,
		value: boolean,
		change: (value: boolean) => Promise<void>,
		redisplay = false,
		desc?: string
	): void {
		const setting = new Setting(el).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addToggle((toggle) => toggle.setValue(value).onChange(async (next) => {
			await change(next);
			await this.host.saveSettings();
			if (redisplay) this.display();
		}));
	}

	private dropdown(name: string, value: string, options: Record<string, string>, change: (value: string) => Promise<void>): void {
		this.dropdownIn(this.containerEl, name, value, options, change);
	}

	private dropdownIn(
		el: HTMLElement,
		name: string,
		value: string,
		options: Record<string, string>,
		change: (value: string) => Promise<void>,
		redisplay = false
	): void {
		new Setting(el).setName(name).addDropdown((dropdown) => dropdown
			.addOptions(options)
			.setValue(value)
			.onChange(async (next) => {
				await change(next);
				await this.host.saveSettings();
				if (redisplay) this.display();
			}));
	}

	private async save(redisplay = true): Promise<void> {
		await this.host.saveSettings();
		if (redisplay) this.display();
	}
}

function id(prefix: string): string {
	return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function newRule(): CompanionRule {
	return {
		id: id("rule"),
		label: "PDF notes",
		enabled: true,
		triggerFolderPath: "",
		triggerScope: "all",
		excludedSubfolders: []
	};
}

function newAutomation(): Automation {
	return {
		id: id("automation"),
		name: "New automation",
		enabled: true,
		triggerFolderPath: "",
		triggerScope: "all",
		excludedSubfolders: [],
		action: {
			type: "add_to_periodic_note",
			insertPosition: "bottom",
			dailyNoteNamePattern: "YYYY-MM-DD",
			periodicNoteType: "daily",
			embedTemplate: "![[{{fileName}}]]"
		}
	};
}

function actionTypeOptions(): Record<AutomationActionType, string> {
	return {
		add_to_periodic_note: "Add to periodic note",
		append_to_note: "Append to note",
		add_tag_to_companion: "Add tag to companion",
		link_to_matching_note: "Link to matching note",
		transcribe_to_companion: "Transcribe to companion",
		split_pages_to_daily_notes: "Split pages to daily notes"
	};
}

function splitList(value: string): string[] {
	return value.split(",").map((part) => part.trim()).filter(Boolean);
}
