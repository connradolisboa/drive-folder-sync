import { Notice, Plugin } from "obsidian";
import * as crypto from "crypto";
import { GoogleAuth } from "./auth/GoogleAuth";
import { DriveSync } from "./sync/DriveSync";
import { DownloadManager } from "./sync/DownloadManager";
import { Scheduler } from "./sync/Scheduler";
import { SyncManifestStore } from "./sync/SyncManifest";
import { CompanionNoteManager } from "./sync/CompanionNoteManager";
import { DriveSyncSettingTab } from "./settings/SettingsTab";
import { AutomationEngine } from "./automation/AutomationEngine";
import { DEFAULT_SETTINGS, PluginSettings, SyncResult } from "./types";

const LOG = "[DriveSync]";

export default class DriveFolderSyncPlugin extends Plugin {
	settings: PluginSettings;
	auth: GoogleAuth;
	scheduler: Scheduler;
	private driveSync: DriveSync;
	private manifestStore: SyncManifestStore;
	private companionManager: CompanionNoteManager;
	private automationEngine: AutomationEngine;
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
		} else {
			console.log(`${LOG} Not authorized — scheduler not started`);
		}

		console.log(`${LOG} Plugin loaded`);
	}

	onunload() {
		console.log(`${LOG} Unloading plugin — stopping scheduler`);
		this.scheduler.stop();
	}

	async runSync(): Promise<SyncResult> {
		if (this.syncing) {
			console.log(`${LOG} runSync called while already syncing — skipped`);
			return { downloaded: 0, skipped: 0, errors: 0, removed: 0 };
		}
		this.syncing = true;
		console.log(`${LOG} Sync started`);
		try {
			const result = await this.driveSync.sync();
			console.log(`${LOG} Sync finished:`, result);
			return result;
		} catch (e) {
			console.error(`${LOG} Sync threw an unhandled error:`, e);
			throw e;
		} finally {
			this.syncing = false;
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
		if (this.driveSync) {
			const downloader = new DownloadManager(this.app);
			this.driveSync = new DriveSync(
				this.auth,
				downloader,
				this.settings,
				this.app,
				this.manifestStore,
				this.companionManager,
				this.automationEngine
			);
		}
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
