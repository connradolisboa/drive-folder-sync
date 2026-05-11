import { App, FuzzySuggestModal, Modal, Notice, Plugin, Setting } from "obsidian";
import * as crypto from "crypto";
import { GoogleAuth } from "./auth/GoogleAuth";
import { DriveSync } from "./sync/DriveSync";
import { DownloadManager } from "./sync/DownloadManager";
import { Scheduler } from "./sync/Scheduler";
import { SyncManifestStore } from "./sync/SyncManifest";
import { CompanionNoteManager } from "./sync/CompanionNoteManager";
import { SyncLogger } from "./sync/SyncLogger";
import { DriveSyncSettingTab } from "./settings/SettingsTab";
import { AutomationEngine } from "./automation/AutomationEngine";
import { SyncStatusView, SYNC_STATUS_VIEW_TYPE } from "./ui/SyncStatusView";
import { DryRunModal } from "./ui/DryRunModal";
import { Automation, DEFAULT_SETTINGS, PluginSettings, SyncPair, SyncResult } from "./types";

const LOG = "[DriveSync]";

export default class DriveFolderSyncPlugin extends Plugin {
	settings: PluginSettings;
	auth: GoogleAuth;
	scheduler: Scheduler;
	lastSyncResult: SyncResult | null = null;
	private driveSync: DriveSync;
	private manifestStore: SyncManifestStore;
	private companionManager: CompanionNoteManager;
	private automationEngine: AutomationEngine;
	private syncLogger: SyncLogger;
	private syncing = false;

	async onload() {
		console.log(`${LOG} Loading plugin`);
		await this.loadSettings();

		console.log(`${LOG} Settings loaded:`, {
			syncPairs: this.settings.syncPairs.length,
			syncIntervalMinutes: this.settings.syncIntervalMinutes,
			deletionBehavior: this.settings.deletionBehavior,
			companionNotesEnabled: this.settings.companionNotesEnabled,
			hasClientId: !!this.settings.clientId,
			hasClientSecret: !!this.settings.clientSecret,
		});

		this.manifestStore = new SyncManifestStore(this.app);
		// Load manifest at startup so vault rename events are healable immediately
		await this.manifestStore.load().catch((e) =>
			console.error(`${LOG} Failed to pre-load manifest:`, e)
		);
		this.companionManager = new CompanionNoteManager(this.app, this.settings);
		this.automationEngine = new AutomationEngine(this.app, this.settings, this.manifestStore);
		this.syncLogger = new SyncLogger(this.app, this.settings);

		const downloader = new DownloadManager(this.app);
		this.auth = new GoogleAuth(this.app, this.settings);
		this.driveSync = new DriveSync(
			this.auth,
			downloader,
			this.settings,
			this.app,
			this.manifestStore,
			this.companionManager,
			this.automationEngine
		);
		this.scheduler = new Scheduler();

		this.registerView(SYNC_STATUS_VIEW_TYPE, (leaf) => new SyncStatusView(leaf, this));

		this.addRibbonIcon("refresh-cw", "Sync Drive folder", async () => {
			if (this.syncing) {
				console.log(`${LOG} Sync already in progress — ignoring ribbon click`);
				new Notice("Sync already in progress…");
				return;
			}
			console.log(`${LOG} Manual sync triggered via ribbon`);
			try {
				const result = await this.runSync();
				const msg = this.formatResult(result);
				console.log(`${LOG}`, msg);
				new Notice(msg);
			} catch (e) {
				console.error(`${LOG} Sync failed:`, e);
				new Notice(`Drive sync failed: ${(e as Error).message}`);
			}
		});

		this.addRibbonIcon("layout-dashboard", "Drive Sync Status", () => {
			this.activateStatusView();
		});

		this.addSettingTab(new DriveSyncSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				this.runSync(false)
					.then((r) => new Notice(this.formatResult(r)))
					.catch((e) => new Notice(`Drive sync failed: ${(e as Error).message}`));
			},
		});

		this.addCommand({
			id: "dry-run",
			name: "Dry run",
			callback: () => {
				this.runSync(true).catch((e) =>
					new Notice(`Drive sync failed: ${(e as Error).message}`)
				);
			},
		});

		this.addCommand({
			id: "sync-pair",
			name: "Sync single pair…",
			callback: () => {
				new SyncPairPickerModal(this.app, this.settings.syncPairs, (pair) => {
					this.runSyncForPair(pair.id)
						.then((r) => new Notice(this.formatResult(r)))
						.catch((e) => new Notice(`Drive sync failed: ${(e as Error).message}`));
				}).open();
			},
		});

		this.addCommand({
			id: "run-automations-all",
			name: "Run all automations on existing files",
			callback: () => {
				const active = this.settings.automations.filter((a) => a.enabled);
				if (active.length === 0) {
					new Notice("No active automations configured.");
					return;
				}
				(async () => {
					const notice = new Notice(
						`Running ${active.length} automation${active.length !== 1 ? "s" : ""}…`,
						0
					);
					let ran = 0, skipped = 0, errors = 0;
					try {
						for (const automation of active) {
							const r = await this.runAutomationOnExistingFiles(automation.id, { force: false });
							ran += r.ran;
							skipped += r.skipped;
							errors += r.errors;
						}
						notice.hide();
						new Notice(
							`All automations complete — ${ran} ran, ${skipped} skipped` +
							(errors > 0 ? `, ${errors} errors` : "")
						);
					} catch (e) {
						notice.hide();
						new Notice(`Automation run failed: ${(e as Error).message}`);
					}
				})();
			},
		});

		this.addCommand({
			id: "run-automation",
			name: "Run automation on existing files…",
			callback: () => {
				const active = this.settings.automations.filter((a) => a.enabled);
				if (active.length === 0) {
					new Notice("No active automations configured.");
					return;
				}
				new AutomationPickerModal(this.app, active, (automation, force) => {
					(async () => {
						const notice = new Notice(`Running "${automation.name}"…`, 0);
						try {
							const r = await this.runAutomationOnExistingFiles(automation.id, { force });
							notice.hide();
							new Notice(
								`"${automation.name}" — ${r.ran} ran, ${r.skipped} skipped` +
								(r.errors > 0 ? `, ${r.errors} errors` : "")
							);
						} catch (e) {
							notice.hide();
							new Notice(`Automation failed: ${(e as Error).message}`);
						}
					})();
				}).open();
			},
		});

		// Heal manifest when user manually moves/renames a synced file in the vault
		this.registerEvent(
			this.app.vault.on("rename", async (file, oldPath) => {
				const healed = this.manifestStore.healRename(oldPath, file.path);
				if (healed) {
					await this.manifestStore.save().catch((e) =>
						console.error(`${LOG} Failed to save manifest after rename heal:`, e)
					);
				}
			})
		);

		const isAuthorized = await this.auth.isAuthorized();
		console.log(`${LOG} Authorized: ${isAuthorized}`);

		if (isAuthorized) {
			console.log(
				`${LOG} Starting scheduler — interval: ${this.settings.syncIntervalMinutes} min`
			);
			this.scheduler.start(this.settings.syncIntervalMinutes, () =>
				this.runSync()
			);
			if (this.settings.syncOnStartup) {
				console.log(`${LOG} syncOnStartup enabled — running initial sync`);
				this.runSync().catch((e) =>
					console.error(`${LOG} Startup sync failed:`, e)
				);
			}
		} else {
			console.log(`${LOG} Not authorized — scheduler not started`);
		}

		console.log(`${LOG} Plugin loaded`);
	}

	onunload() {
		console.log(`${LOG} Unloading plugin — stopping scheduler`);
		this.scheduler.stop();
	}

	async runSync(dryRun = false): Promise<SyncResult> {
		if (this.syncing) {
			console.log(`${LOG} runSync called while already syncing — skipped`);
			return { downloaded: 0, skipped: 0, errors: 0, removed: 0, moved: 0, archived: 0 };
		}
		this.syncing = true;
		console.log(`${LOG} Sync started${dryRun ? " (dry run)" : ""}`);
		try {
			const result = await this.driveSync.sync(dryRun);
			console.log(`${LOG} Sync finished:`, result);
			if (dryRun) {
				new DryRunModal(this.app, result).open();
			} else {
				this.lastSyncResult = result;
				this.pushResultToStatusView(result);
				await this.syncLogger.append(result);
			}
			return result;
		} catch (e) {
			console.error(`${LOG} Sync threw an unhandled error:`, e);
			throw e;
		} finally {
			this.syncing = false;
		}
	}

	async runSyncForPair(pairId: string): Promise<SyncResult> {
		if (this.syncing) {
			console.log(`${LOG} runSyncForPair called while already syncing — skipped`);
			return { downloaded: 0, skipped: 0, errors: 0, removed: 0, moved: 0, archived: 0 };
		}
		this.syncing = true;
		console.log(`${LOG} Single-pair sync started: ${pairId}`);
		try {
			const result = await this.driveSync.syncSinglePair(pairId);
			console.log(`${LOG} Single-pair sync finished:`, result);
			await this.syncLogger.append(result);
			return result;
		} catch (e) {
			console.error(`${LOG} Single-pair sync threw an unhandled error:`, e);
			throw e;
		} finally {
			this.syncing = false;
		}
	}

	countMatchingFilesForAutomation(automationId: string): number {
		return this.automationEngine.countMatchingFiles(automationId);
	}

	async runAutomationOnExistingFiles(
		automationId: string,
		opts: { force?: boolean } = {}
	): Promise<{ matched: number; ran: number; skipped: number; errors: number }> {
		return this.automationEngine.runForAllMatchingFiles(automationId, opts);
	}

	private pushResultToStatusView(result: SyncResult): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SYNC_STATUS_VIEW_TYPE)) {
			if (leaf.view instanceof SyncStatusView) {
				leaf.view.updateResult(result);
			}
		}
	}

	private async activateStatusView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SYNC_STATUS_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SYNC_STATUS_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		this.migrateLegacySettings();
	}

	async saveSettings() {
		console.log(`${LOG} Saving settings`);
		await this.saveData(this.settings);
		if (this.auth) this.auth.updateSettings(this.settings);
		if (this.companionManager) this.companionManager.updateSettings(this.settings);
		if (this.automationEngine) this.automationEngine.updateSettings(this.settings);
		if (this.driveSync) this.driveSync.updateSettings(this.settings);
		if (this.syncLogger) this.syncLogger.updateSettings(this.settings);
	}

	private migrateLegacySettings(): void {
		// Migrate from the old single-pair settings to the new syncPairs array
		const legacyId = (this.settings as PluginSettings & { driveFolderId?: string }).driveFolderId;
		if (legacyId && this.settings.syncPairs.length === 0) {
			console.log(`${LOG} Migrating legacy single-pair settings to syncPairs`);
			this.settings.syncPairs = [
				{
					id: crypto.randomBytes(8).toString("hex"),
					label: "Drive Sync",
					driveFolderId: legacyId,
					vaultDestFolder: this.settings.vaultDestFolder || "Drive Sync",
					enabled: true,
				},
			];
			this.settings.driveFolderId = "";
			this.settings.vaultDestFolder = "";
			// Persist the migration immediately
			this.saveData(this.settings).catch((e) =>
				console.error(`${LOG} Failed to persist migration:`, e)
			);
		}
	}

	private formatResult(result: SyncResult): string {
		return (
			`Drive sync complete — ${result.downloaded} downloaded, ` +
			`${result.skipped} up to date` +
			((result.moved ?? 0) > 0 ? `, ${result.moved} moved` : "") +
			(result.removed > 0 ? `, ${result.removed} removed` : "") +
			((result.archived ?? 0) > 0 ? `, ${result.archived} archived` : "") +
			(result.errors > 0 ? `, ${result.errors} errors` : "")
		);
	}
}

class SyncPairPickerModal extends FuzzySuggestModal<SyncPair> {
	constructor(
		app: App,
		private pairs: SyncPair[],
		private onChoose: (pair: SyncPair) => void
	) {
		super(app);
		this.setPlaceholder("Pick a sync pair…");
	}

	getItems(): SyncPair[] {
		return this.pairs;
	}

	getItemText(pair: SyncPair): string {
		return pair.label;
	}

	onChooseItem(pair: SyncPair): void {
		this.onChoose(pair);
	}
}

class AutomationPickerModal extends FuzzySuggestModal<Automation> {
	constructor(
		app: App,
		private automations: Automation[],
		private onChoose: (automation: Automation, force: boolean) => void
	) {
		super(app);
		this.setPlaceholder("Pick an automation…");
	}

	getItems(): Automation[] {
		return this.automations;
	}

	getItemText(automation: Automation): string {
		return automation.name;
	}

	onChooseItem(automation: Automation): void {
		new AutomationForceModal(this.app, automation, (force) => {
			this.onChoose(automation, force);
		}).open();
	}
}

class AutomationForceModal extends Modal {
	private force = false;

	constructor(
		app: App,
		private automation: Automation,
		private onConfirm: (force: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Run "${this.automation.name}"` });

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
