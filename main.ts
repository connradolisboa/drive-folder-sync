import { Notice, Plugin } from "obsidian";
import { GoogleAuth } from "./auth/GoogleAuth";
import { DriveSync } from "./sync/DriveSync";
import { DownloadManager } from "./sync/DownloadManager";
import { Scheduler } from "./sync/Scheduler";
import { DriveSyncSettingTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, PluginSettings, SyncResult } from "./types";

const LOG = "[DriveSync]";

export default class DriveFolderSyncPlugin extends Plugin {
	settings: PluginSettings;
	auth: GoogleAuth;
	scheduler: Scheduler;
	private driveSync: DriveSync;
	private syncing = false;

	async onload() {
		console.log(`${LOG} Loading plugin`);
		await this.loadSettings();
		console.log(`${LOG} Settings loaded:`, {
			driveFolderId: this.settings.driveFolderId,
			vaultDestFolder: this.settings.vaultDestFolder,
			syncIntervalMinutes: this.settings.syncIntervalMinutes,
			deletionBehavior: this.settings.deletionBehavior,
			hasClientId: !!this.settings.clientId,
			hasClientSecret: !!this.settings.clientSecret,
		});

		const downloader = new DownloadManager(this.app);
		this.auth = new GoogleAuth(this.app, this.settings);
		this.driveSync = new DriveSync(
			this.auth,
			downloader,
			this.settings,
			this.app
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
				const msg =
					`Drive sync complete — ${result.downloaded} downloaded, ` +
					`${result.skipped} up to date` +
					(result.removed > 0 ? `, ${result.removed} removed` : "") +
					(result.errors > 0 ? `, ${result.errors} errors` : "");
				console.log(`${LOG}`, msg);
				new Notice(msg);
			} catch (e) {
				console.error(`${LOG} Sync failed:`, e);
				new Notice(`Drive sync failed: ${(e as Error).message}`);
			}
		});

		this.addSettingTab(new DriveSyncSettingTab(this.app, this));

		const isAuthorized = await this.auth.isAuthorized();
		console.log(`${LOG} Authorized:`, isAuthorized);

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
	}

	async saveSettings() {
		console.log(`${LOG} Saving settings`);
		await this.saveData(this.settings);
		if (this.auth) this.auth.updateSettings(this.settings);
		if (this.driveSync) {
			const downloader = new DownloadManager(this.app);
			this.driveSync = new DriveSync(
				this.auth,
				downloader,
				this.settings,
				this.app
			);
		}
	}
}
