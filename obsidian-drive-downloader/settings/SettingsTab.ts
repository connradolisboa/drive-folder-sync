import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DriveDownloaderPlugin from "../main";
import type { DeletionBehavior, SyncPair } from "../types";

type Tab = "account" | "sync" | "advanced";

const DELETION_LABELS: Record<DeletionBehavior, string> = {
	keep: "Keep the vault PDF",
	delete: "Move the vault PDF to trash",
	archive: "Move the vault PDF to the archive folder",
};

export class DriveDownloaderSettingTab extends PluginSettingTab {
	private activeTab: Tab = "account";

	constructor(app: App, private plugin: DriveDownloaderPlugin) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();
		this.containerEl.createEl("h2", { text: "Drive Downloader" });

		const navigation = this.containerEl.createDiv();
		navigation.style.cssText =
			"display:flex;gap:4px;border-bottom:1px solid var(--background-modifier-border);margin-bottom:18px;";
		const body = this.containerEl.createDiv();

		const render = (tab: Tab) => {
			this.activeTab = tab;
			body.empty();
			if (tab === "account") this.renderAccount(body);
			else if (tab === "sync") this.renderSync(body);
			else this.renderAdvanced(body);
			for (const button of Array.from(navigation.querySelectorAll("button"))) {
				button.toggleClass("is-active", button.dataset.tab === tab);
				button.style.fontWeight = button.dataset.tab === tab ? "600" : "";
			}
		};

		for (const [id, label] of [
			["account", "Account"],
			["sync", "Sync"],
			["advanced", "Advanced"],
		] as const) {
			const button = navigation.createEl("button", { text: label });
			button.dataset.tab = id;
			button.style.cssText = "border:none;background:transparent;padding:7px 14px;cursor:pointer;";
			button.addEventListener("click", () => render(id));
		}
		render(this.activeTab);
	}

	private renderAccount(container: HTMLElement): void {
		container.createEl("h3", { text: "Google Cloud OAuth" });
		container.createEl("p", {
			text:
				"Use credentials from a Google Cloud OAuth client configured as a desktop app. " +
				"Credentials remain in this plugin's local data.",
			cls: "setting-item-description",
		});

		new Setting(container)
			.setName("Client ID")
			.addText((text) =>
				text
					.setPlaceholder("OAuth client ID")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(container)
			.setName("Client secret")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("OAuth client secret")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(container)
			.setName("Google Drive account")
			.setDesc("Connect once in the browser. Disconnecting removes stored OAuth tokens.")
			.addButton((button) =>
				button.setButtonText("Connect").setCta().onClick(async () => {
					if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
						new Notice("Enter the client ID and client secret first.");
						return;
					}
					button.setDisabled(true).setButtonText("Connecting…");
					try {
						await this.plugin.auth.authorize();
						this.plugin.restartScheduler();
						new Notice("Google Drive connected.");
					} catch (error) {
						new Notice(`Authorization failed: ${(error as Error).message}`);
					} finally {
						button.setDisabled(false).setButtonText("Connect");
					}
				})
			)
			.addButton((button) =>
				button.setButtonText("Disconnect").setWarning().onClick(async () => {
					this.plugin.scheduler.stop();
					await this.plugin.auth.disconnect();
					new Notice("Google Drive disconnected.");
				})
			);
	}

	private renderSync(container: HTMLElement): void {
		container.createEl("h3", { text: "Folder pairs" });
		container.createEl("p", {
			text: "Each enabled pair downloads PDFs from one Drive folder into one vault folder.",
			cls: "setting-item-description",
		});

		for (const pair of this.plugin.settings.syncPairs) {
			this.renderPair(container, pair);
		}

		new Setting(container).addButton((button) =>
			button.setButtonText("Add folder pair").setCta().onClick(async () => {
				this.plugin.settings.syncPairs.push({
					id: this.generateId(),
					label: `Pair ${this.plugin.settings.syncPairs.length + 1}`,
					driveFolderId: "",
					vaultDestFolder: "Drive Downloads",
					enabled: true,
				});
				await this.plugin.saveSettings();
				this.display();
			})
		);

		container.createEl("h3", { text: "Schedule" });
		new Setting(container)
			.setName("Sync interval")
			.setDesc("Minutes between automatic syncs. Use 0 to disable scheduling.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed) || parsed < 0) return;
						this.plugin.settings.syncIntervalMinutes = parsed;
						await this.plugin.saveSettings();
						this.plugin.restartScheduler();
					})
			);

		new Setting(container)
			.setName("Sync on startup")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(container)
			.setName("Download concurrency")
			.setDesc("Parallel downloads, from 1 to 10.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.downloadConcurrency)
					.onChange(async (value) => {
						this.plugin.settings.downloadConcurrency = value;
						await this.plugin.saveSettings();
					})
			);

		container.createEl("h3", { text: "Deletion policy" });
		new Setting(container)
			.setName("When a Drive source disappears")
			.setDesc("Default action for its downloaded vault PDF. A pair can override this.")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(DELETION_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.deletionBehavior)
					.onChange(async (value) => {
						this.plugin.settings.deletionBehavior = value as DeletionBehavior;
						await this.plugin.saveSettings();
					});
			});

		new Setting(container)
			.setName("Archive folder")
			.setDesc("Vault destination used when the effective deletion policy is Archive.")
			.addText((text) =>
				text.setValue(this.plugin.settings.archiveFolder).onChange(async (value) => {
					this.plugin.settings.archiveFolder = value.trim() || "Drive Sync Archive";
					await this.plugin.saveSettings();
				})
			);

		new Setting(container)
			.setName("Re-download locally deleted files")
			.setDesc("Only after the Drive version changes. Otherwise the local deletion is respected.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.redownloadUserDeleted).onChange(async (value) => {
					this.plugin.settings.redownloadUserDeleted = value;
					await this.plugin.saveSettings();
				})
			);

		const mirror = new Setting(container)
			.setName("Mirror local PDF deletion to Drive trash")
			.setDesc(
				"Destructive: when a tracked PDF is deleted in the vault, move its Drive source to trash. " +
				"The manifest record is kept until Drive confirms the trash operation. Requires full Drive access."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.mirrorLocalDeletionToDrive).onChange(async (value) => {
					this.plugin.settings.mirrorLocalDeletionToDrive = value;
					await this.plugin.saveSettings();
				})
			);
		mirror.settingEl.addClass("mod-warning");

		new Setting(container)
			.setName("Drive archive folder ID")
			.setDesc("Optional folder whose PDFs should use the per-pair Drive archive policy.")
			.addText((text) =>
				text.setValue(this.plugin.settings.driveArchiveFolderId).onChange(async (value) => {
					this.plugin.settings.driveArchiveFolderId = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(container)
			.setName("Manual actions")
			.addButton((button) =>
				button.setButtonText("Sync now").setCta().onClick(async () => {
					try {
						const result = await this.plugin.runSync();
						new Notice(this.plugin.formatResult(result));
					} catch (error) {
						new Notice(`Drive sync failed: ${(error as Error).message}`);
					}
				})
			)
			.addButton((button) =>
				button.setButtonText("Dry run").onClick(async () => {
					try {
						await this.plugin.runSync(true);
					} catch (error) {
						new Notice(`Dry run failed: ${(error as Error).message}`);
					}
				})
			)
			.addButton((button) =>
				button.setButtonText("Open status").onClick(() => {
					void this.plugin.activateStatusView();
				})
			);
	}

	private renderPair(container: HTMLElement, pair: SyncPair): void {
		const card = container.createDiv();
		card.style.cssText =
			"border:1px solid var(--background-modifier-border);border-radius:6px;" +
			"padding:10px 12px;margin-bottom:10px;";
		card.createEl("h4", { text: pair.label || pair.id }).style.margin = "0 0 8px";

		new Setting(card)
			.setName("Enabled")
			.addToggle((toggle) =>
				toggle.setValue(pair.enabled).onChange(async (value) => {
					pair.enabled = value;
					await this.plugin.saveSettings();
				})
			)
			.addButton((button) =>
				button.setButtonText("Remove").setWarning().onClick(async () => {
					this.plugin.settings.syncPairs = this.plugin.settings.syncPairs.filter(
						(candidate) => candidate.id !== pair.id
					);
					await this.plugin.saveSettings();
					this.display();
				})
			);

		this.pairText(card, "Label", pair.label, async (value) => {
			pair.label = value.trim() || pair.id;
		});
		this.pairText(card, "Drive folder ID", pair.driveFolderId, async (value) => {
			pair.driveFolderId = value.trim();
		});
		this.pairText(card, "Vault destination", pair.vaultDestFolder, async (value) => {
			pair.vaultDestFolder = value.trim();
		});
		this.pairText(
			card,
			"Excluded subfolders",
			(pair.excludedSubfolders ?? []).join(", "),
			async (value) => {
				pair.excludedSubfolders = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
			},
			"Comma-separated folder names or relative paths."
		);

		this.pairToggle(card, "Exclude root-level PDFs", pair.excludeRootFiles ?? false, async (value) => {
			pair.excludeRootFiles = value;
		});
		this.pairToggle(card, "Only download root-level PDFs", pair.rootFilesOnly ?? false, async (value) => {
			pair.rootFilesOnly = value;
		});
		this.pairToggle(
			card,
			"Collapse same-named wrapper folder",
			pair.collapseSingleFileFolder ?? false,
			async (value) => {
				pair.collapseSingleFileFolder = value;
			}
		);

		new Setting(card)
			.setName("Drive removal policy")
			.setDesc("Use the global policy or override it for this pair.")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Use global setting");
				for (const [value, label] of Object.entries(DELETION_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(pair.deletionBehavior ?? "").onChange(async (value) => {
					pair.deletionBehavior = value ? value as DeletionBehavior : undefined;
					await this.plugin.saveSettings();
				});
			});

		this.pairText(card, "Archive folder override", pair.archiveFolder ?? "", async (value) => {
			pair.archiveFolder = value.trim() || undefined;
		}, "Leave blank to use the global archive folder.");

		new Setting(card)
			.setName("Drive archive policy")
			.setDesc("Action when this source is found in the configured Drive archive folder.")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Use removal policy");
				for (const [value, label] of Object.entries(DELETION_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(pair.driveArchiveBehavior ?? "").onChange(async (value) => {
					pair.driveArchiveBehavior = value ? value as DeletionBehavior : undefined;
					await this.plugin.saveSettings();
				});
			});

		this.pairToggle(card, "Use Drive changes shortcut", pair.useChangesApi ?? false, async (value) => {
			pair.useChangesApi = value;
		});

		const deleteAfter = new Setting(card)
			.setName("Delete Drive copy after a verified sync")
			.setDesc(
				"Destructive: after the current PDF is present in the vault, move its Drive copy to trash. " +
				"The vault PDF then becomes the retained copy."
			)
			.addToggle((toggle) =>
				toggle.setValue(pair.deleteFromDriveAfterSync ?? false).onChange(async (value) => {
					pair.deleteFromDriveAfterSync = value;
					await this.plugin.saveSettings();
				})
			);
		deleteAfter.settingEl.addClass("mod-warning");

		let testSubfolder = "";
		new Setting(card)
			.setName("Test this pair")
			.setDesc("Download only one Drive subfolder, with no deletion pass.")
			.addText((text) =>
				text.setPlaceholder("relative/subfolder").onChange((value) => {
					testSubfolder = value.trim();
				})
			)
			.addButton((button) => button.setButtonText("Run test").onClick(async () => {
				if (!testSubfolder) {
					new Notice("Enter a relative subfolder path.");
					return;
				}
				try {
					const result = await this.plugin.runTestSync(pair.id, testSubfolder);
					new Notice(this.plugin.formatResult(result));
				} catch (error) {
					new Notice(`Test sync failed: ${(error as Error).message}`);
				}
			}));
	}

	private renderAdvanced(container: HTMLElement): void {
		container.createEl("h3", { text: "Performance" });
		this.globalToggle(
			container,
			"Use Drive changes API",
			"Skip a full folder walk when the Drive changes feed proves the account is idle.",
			this.plugin.settings.useChangesApi,
			async (value) => {
				this.plugin.settings.useChangesApi = value;
			}
		);
		this.globalToggle(
			container,
			"Hash PDFs off the main thread",
			"Use a worker for SHA-256 and page scanning when the platform supports it.",
			this.plugin.settings.offThreadHashing,
			async (value) => {
				this.plugin.settings.offThreadHashing = value;
			}
		);
		this.globalToggle(
			container,
			"Download cache",
			"Keep content-addressed bytes in the plugin cache to avoid repeat downloads.",
			this.plugin.settings.downloadCacheEnabled,
			async (value) => {
				this.plugin.settings.downloadCacheEnabled = value;
			}
		);

		new Setting(container)
			.setName("Download cache cap (MB)")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.downloadCacheMaxMb)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed) || parsed < 1) return;
					this.plugin.settings.downloadCacheMaxMb = parsed;
					await this.plugin.saveSettings();
				})
			)
			.addButton((button) => button.setButtonText("Run cache cleanup").onClick(async () => {
				await this.plugin.runCacheGc();
				new Notice("Download cache cleanup complete.");
			}));

		this.globalToggle(
			container,
			"Request SQLite manifest backend",
			"Compatibility switch. The bundled build currently falls back to the JSON manifest.",
			this.plugin.settings.useSqliteManifest,
			async (value) => {
				this.plugin.settings.useSqliteManifest = value;
			}
		);

		container.createEl("h3", { text: "Logs" });
		this.globalToggle(
			container,
			"Vault sync summary log",
			"Append one Markdown row per sync.",
			this.plugin.settings.syncLogEnabled,
			async (value) => {
				this.plugin.settings.syncLogEnabled = value;
			}
		);
		new Setting(container)
			.setName("Summary log path")
			.addText((text) => text.setValue(this.plugin.settings.syncLogPath).onChange(async (value) => {
				this.plugin.settings.syncLogPath = value.trim() || "Drive Sync/.sync-log.md";
				await this.plugin.saveSettings();
			}));
		this.globalToggle(
			container,
			"Structured activity log",
			"Write rotating JSON-line activity records inside the vault configuration folder.",
			this.plugin.settings.syncActivityLogEnabled,
			async (value) => {
				this.plugin.settings.syncActivityLogEnabled = value;
			}
		);
		new Setting(container)
			.setName("Activity log level")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("info", "Info")
					.addOption("warn", "Warnings")
					.addOption("error", "Errors only")
					.setValue(this.plugin.settings.syncActivityLogLevel)
					.onChange(async (value) => {
						this.plugin.settings.syncActivityLogLevel = value as "info" | "warn" | "error";
						await this.plugin.saveSettings();
					})
			)
			.addButton((button) =>
				button.setButtonText("View activity log").onClick(() => this.plugin.openSyncActivityLog())
			);

		container.createEl("h3", { text: "Recovery and verification" });
		new Setting(container)
			.setName("Manifest tools")
			.addButton((button) =>
				button.setButtonText("Verify files").onClick(() => void this.plugin.showIntegrityReport())
			)
			.addButton((button) =>
				button.setButtonText("Restore backup").onClick(() => void this.plugin.restoreManifestBackup())
			);
		new Setting(container)
			.setName("Recycle bin")
			.setDesc("Deleted PDFs are recoverable from the downloader's seven-day recycle history.")
			.addButton((button) =>
				button.setButtonText("Restore run").onClick(() => void this.plugin.restoreRecycleRun())
			)
			.addButton((button) =>
				button.setButtonText("Undo latest sync").onClick(() => void this.plugin.undoLastSync())
			);

		container.createEl("h3", { text: "Anonymous error reporting" });
		this.globalToggle(
			container,
			"Send redacted error reports",
			"Off by default. Reports are only sent when an endpoint is also configured.",
			this.plugin.settings.errorReportingEnabled,
			async (value) => {
				this.plugin.settings.errorReportingEnabled = value;
			}
		);
		new Setting(container)
			.setName("Reporting endpoint")
			.addText((text) =>
				text.setValue(this.plugin.settings.errorReportingEndpoint).onChange(async (value) => {
					this.plugin.settings.errorReportingEndpoint = value.trim();
					await this.plugin.saveSettings();
				})
			)
			.addButton((button) =>
				button.setButtonText("Preview payload").onClick(() => this.plugin.previewErrorReport())
			);
	}

	private pairText(
		container: HTMLElement,
		name: string,
		value: string,
		update: (value: string) => Promise<void>,
		description?: string
	): void {
		const setting = new Setting(container).setName(name);
		if (description) setting.setDesc(description);
		setting.addText((text) =>
			text.setValue(value).onChange(async (next) => {
				await update(next);
				await this.plugin.saveSettings();
			})
		);
	}

	private pairToggle(
		container: HTMLElement,
		name: string,
		value: boolean,
		update: (value: boolean) => Promise<void>
	): void {
		new Setting(container).setName(name).addToggle((toggle) =>
			toggle.setValue(value).onChange(async (next) => {
				await update(next);
				await this.plugin.saveSettings();
			})
		);
	}

	private globalToggle(
		container: HTMLElement,
		name: string,
		description: string,
		value: boolean,
		update: (value: boolean) => Promise<void>
	): void {
		new Setting(container).setName(name).setDesc(description).addToggle((toggle) =>
			toggle.setValue(value).onChange(async (next) => {
				await update(next);
				await this.plugin.saveSettings();
			})
		);
	}

	private generateId(): string {
		if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
			return crypto.randomUUID();
		}
		return `pair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}
}
