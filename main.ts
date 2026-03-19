import { Notice, Plugin } from "obsidian";
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
import { DEFAULT_SETTINGS, PluginSettings, SyncResult } from "./types";

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
		this.companionManager = new CompanionNoteManager(this.app, this.settings);
		this.automationEngine = new AutomationEngine(this.app, this.settings);
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
			return { downloaded: 0, skipped: 0, errors: 0, removed: 0 };
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
			return { downloaded: 0, skipped: 0, errors: 0, removed: 0 };
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
			(result.removed > 0 ? `, ${result.removed} removed` : "") +
			(result.errors > 0 ? `, ${result.errors} errors` : "")
		);
	}
}
