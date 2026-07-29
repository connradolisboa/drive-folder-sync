import {
	App,
	FuzzySuggestModal,
	Menu,
	Modal,
	Notice,
	Plugin,
	Setting,
	TFile,
} from "obsidian";
import { GoogleAuth } from "./auth/GoogleAuth";
import { runAudit, AuditModal } from "./commands/Audit";
import { verifyIntegrity, VerifyIntegrityModal } from "./commands/VerifyIntegrity";
import { EventBus, type BusRecord } from "./events/EventBus";
import { prepareLegacyImport } from "./migration";
import { DriveDownloaderSettingTab } from "./settings/SettingsTab";
import { CacheManager } from "./sync/CacheManager";
import { DownloadManager } from "./sync/DownloadManager";
import { DriveSync } from "./sync/DriveSync";
import { Recycle } from "./sync/Recycle";
import { Scheduler } from "./sync/Scheduler";
import { SyncActivityLog } from "./sync/SyncLog";
import { SyncLogger } from "./sync/SyncLogger";
import {
	createManifestStore,
	type SyncManifestStore,
} from "./sync/SyncManifest";
import { ErrorReporter } from "./telemetry/ErrorReporter";
import {
	DEFAULT_SETTINGS,
	type DriveFileEntry,
	type DriveDownloaderSettings,
	type SyncPair,
	type SyncResult,
} from "./types";
import { ChangelogModal, isNewer, parseChangelog } from "./ui/ChangelogModal";
import { DriveFilePickerModal } from "./ui/DriveFilePickerModal";
import { DryRunModal } from "./ui/DryRunModal";
import { FileStatusModal } from "./ui/FileStatusModal";
import { SyncLogModal } from "./ui/SyncLogModal";
import {
	SYNC_STATUS_VIEW_TYPE,
	SyncStatusView,
} from "./ui/SyncStatusView";
import { HeavyWorkerClient } from "./workers/heavyWorker";

const LOG = "[DriveDownloader]";
const LEGACY_DATA_PATH = "plugins/drive-folder-sync/data.json";

export default class DriveDownloaderPlugin extends Plugin {
	settings: DriveDownloaderSettings = { ...DEFAULT_SETTINGS };
	auth!: GoogleAuth;
	scheduler!: Scheduler;
	manifestStore!: SyncManifestStore;
	bus!: EventBus;
	cacheManager?: CacheManager;
	heavyWorker!: HeavyWorkerClient;
	recycle!: Recycle;
	errorReporter!: ErrorReporter;
	lastSyncResult: SyncResult | null = null;
	recentEvents: BusRecord[] = [];

	private pairHistory = new Map<string, Array<{ at: number; errors: number }>>();
	private driveSync!: DriveSync;
	private downloadManager!: DownloadManager;
	private syncLogger!: SyncLogger;
	private syncActivityLog!: SyncActivityLog;
	private syncing = false;

	async onload(): Promise<void> {
		console.log(`${LOG} Loading`);
		await this.loadSettings();

		this.bus = new EventBus();
		this.scheduler = new Scheduler();
		this.manifestStore = createManifestStore(this.app, this.settings, this.bus);
		await this.manifestStore.load();

		this.syncLogger = new SyncLogger(this.app, this.settings);
		this.syncActivityLog = new SyncActivityLog(this.app, this.settings);
		this.cacheManager = this.settings.downloadCacheEnabled
			? new CacheManager(this.app, this.settings.downloadCacheMaxMb * 1024 * 1024)
			: undefined;
		this.downloadManager = new DownloadManager(this.app, this.cacheManager);
		this.heavyWorker = new HeavyWorkerClient();
		this.recycle = new Recycle(this.app, this.bus);
		this.errorReporter = new ErrorReporter(this.settings, this.manifest.version);
		this.errorReporter.install();
		this.auth = new GoogleAuth(this.app, this.settings, this.bus);
		this.driveSync = new DriveSync(
			this.auth,
			this.downloadManager,
			this.settings,
			this.app,
			this.manifestStore,
			this.bus,
			this.heavyWorker,
			this.recycle
		);

		this.wireEventBus();
		this.registerView(
			SYNC_STATUS_VIEW_TYPE,
			(leaf) => new SyncStatusView(leaf, this)
		);

		this.addRibbonIcon("download-cloud", "Sync Drive PDFs", () => {
			void this.runSync()
				.then((result) => new Notice(this.formatResult(result)))
				.catch((error) => new Notice(`Drive sync failed: ${(error as Error).message}`));
		});
		this.addRibbonIcon("layout-dashboard", "Drive Downloader status", () => {
			void this.activateStatusView();
		});

		this.addSettingTab(new DriveDownloaderSettingTab(this.app, this));
		this.registerCommands();
		this.registerVaultEvents();

		if (await this.auth.isAuthorized()) {
			this.restartScheduler();
			if (this.settings.syncOnStartup) {
				void this.runSync().catch((error) => {
					console.error(`${LOG} Startup sync failed:`, error);
				});
			}
		}

		this.app.workspace.onLayoutReady(() => {
			void this.maybeShowChangelog();
		});
		console.log(`${LOG} Loaded`);
	}

	onunload(): void {
		this.scheduler?.stop();
		this.bus?.clear();
		this.heavyWorker?.terminate();
		this.errorReporter?.uninstall();
	}

	private registerCommands(): void {
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.runSync()
					.then((result) => new Notice(this.formatResult(result)))
					.catch((error) => new Notice(`Drive sync failed: ${(error as Error).message}`));
			},
		});

		this.addCommand({
			id: "dry-run",
			name: "Dry run",
			callback: () => {
				void this.runSync(true).catch((error) => {
					new Notice(`Dry run failed: ${(error as Error).message}`);
				});
			},
		});

		this.addCommand({
			id: "sync-pair",
			name: "Sync one folder pair…",
			callback: () => {
				const pairs = this.settings.syncPairs.filter((pair) => pair.enabled);
				if (pairs.length === 0) {
					new Notice("No enabled folder pairs.");
					return;
				}
				new SyncPairPickerModal(this.app, pairs, (pair) => {
					void this.runSyncForPair(pair.id)
						.then((result) => new Notice(this.formatResult(result)))
						.catch((error) => new Notice(`Drive sync failed: ${(error as Error).message}`));
				}).open();
			},
		});

		this.addCommand({
			id: "pull-file-from-drive",
			name: "Pull one file from Drive…",
			callback: () => {
				const pairs = this.settings.syncPairs.filter(
					(pair) => pair.enabled && pair.driveFolderId.trim()
				);
				if (pairs.length === 0) {
					new Notice("No enabled folder pairs with a Drive folder ID.");
					return;
				}
				new SyncPairPickerModal(this.app, pairs, (pair) => {
					new DriveFilePickerModal(
						this.app,
						this.driveSync,
						this.manifestStore,
						pair,
						(entry, options) => this.pullDriveFile(pair, entry, options)
					).open();
				}).open();
			},
		});

		this.addCommand({
			id: "open-status",
			name: "Open sync status",
			callback: () => {
				void this.activateStatusView();
			},
		});

		this.addCommand({
			id: "view-activity-log",
			name: "View sync activity log",
			callback: () => this.openSyncActivityLog(),
		});

		this.addCommand({
			id: "health-audit",
			name: "Audit downloader manifest",
			callback: () => {
				void this.showAudit();
			},
		});

		this.addCommand({
			id: "verify-integrity",
			name: "Verify downloaded file integrity",
			callback: () => {
				void this.showIntegrityReport();
			},
		});

		this.addCommand({
			id: "restore-manifest-backup",
			name: "Restore manifest backup…",
			callback: () => {
				void this.restoreManifestBackup();
			},
		});

		this.addCommand({
			id: "restore-recycle-run",
			name: "Restore files from recycle history…",
			callback: () => {
				void this.restoreRecycleRun();
			},
		});

		this.addCommand({
			id: "undo-last-sync",
			name: "Undo latest destructive sync actions",
			callback: () => {
				void this.undoLastSync();
			},
		});

		this.addCommand({
			id: "test-folder-pair",
			name: "Test one folder pair on a subfolder…",
			callback: () => {
				const pairs = this.settings.syncPairs.filter((pair) => pair.enabled);
				if (pairs.length === 0) {
					new Notice("No enabled folder pairs.");
					return;
				}
				new SyncPairPickerModal(this.app, pairs, (pair) => {
					new TextPromptModal(
						this.app,
						`Test "${pair.label}"`,
						"Relative Drive subfolder path",
						"",
						(value) => {
							if (!value) {
								new Notice("Enter a subfolder path.");
								return;
							}
							void this.runTestSync(pair.id, value)
								.then((result) => new Notice(this.formatResult(result)))
								.catch((error) => new Notice(`Test sync failed: ${(error as Error).message}`));
						}
					).open();
				}).open();
			},
		});
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (this.manifestStore.healRename(oldPath, file.path)) {
					this.saveManifestFromVaultEvent("vault rename");
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile)) return;
				if (this.manifestStore.markUserDeleted(file.path)) {
					this.saveManifestFromVaultEvent("vault deletion");
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (!(file instanceof TFile)) return;
				menu.addItem((item) =>
					item
						.setTitle("Show Drive Downloader status")
						.setIcon("info")
						.onClick(() => new FileStatusModal(this.app, this, file).open())
				);
				const tracked = this.manifestStore.findByVaultPath(file.path);
				if (tracked) {
					menu.addItem((item) =>
						item
							.setTitle("Sync source folder now")
							.setIcon("refresh-cw")
							.onClick(() => {
								void this.runSyncForPair(tracked[1].pairId)
									.then((result) => new Notice(this.formatResult(result)))
									.catch((error) =>
										new Notice(`Drive sync failed: ${(error as Error).message}`)
									);
							})
					);
				}
			})
		);
	}

	private saveManifestFromVaultEvent(context: string): void {
		void this.manifestStore.save().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`${LOG} Failed to persist manifest after ${context}:`, error);
			this.bus.emit("error", {
				message: `Manifest save failed after ${context}: ${message}`,
				context: "manifest-save",
			});
			new Notice("Drive Downloader could not persist its tracking state. Check the console before syncing.");
		});
	}

	async runSync(dryRun = false): Promise<SyncResult> {
		if (this.syncing) throw new Error("A sync is already in progress.");
		this.syncing = true;
		try {
			const result = await this.driveSync.sync(dryRun);
			if (this.driveSync.consumeSettingsDirty()) await this.saveSettings();
			if (dryRun) {
				new DryRunModal(this.app, result).open();
			} else {
				this.lastSyncResult = result;
				this.bus.emit("sync-complete", { result });
				await this.syncLogger.append(result);
				await this.syncActivityLog.log({
					level: result.errors > 0 ? "warn" : "info",
					syncId: String(result.timestamp ?? Date.now()),
					action: "sync",
					result: this.formatResult(result),
				});
				await this.runCacheGc();
			}
			return result;
		} finally {
			this.syncing = false;
		}
	}

	async runSyncForPair(pairId: string): Promise<SyncResult> {
		if (this.syncing) throw new Error("A sync is already in progress.");
		this.syncing = true;
		try {
			const result = await this.driveSync.syncSinglePair(pairId);
			if (this.driveSync.consumeSettingsDirty()) await this.saveSettings();
			this.lastSyncResult = result;
			const statusResult: SyncResult = {
				...result,
				pairs: { [pairId]: result },
			};
			this.bus.emit("sync-complete", { result: statusResult });
			await this.syncLogger.append(result);
			await this.syncActivityLog.log({
				level: result.errors > 0 ? "warn" : "info",
				syncId: String(result.timestamp ?? Date.now()),
				action: "sync-pair",
				result: this.formatResult(result),
				details: pairId,
			});
			await this.runCacheGc();
			return result;
		} finally {
			this.syncing = false;
		}
	}

	async runTestSync(pairId: string, subfolder: string): Promise<SyncResult> {
		if (this.syncing) throw new Error("A sync is already in progress.");
		this.syncing = true;
		try {
			return await this.driveSync.testSync(pairId, subfolder);
		} finally {
			this.syncing = false;
		}
	}

	async pullDriveFile(
		pair: SyncPair,
		entry: DriveFileEntry,
		options: { deleteFromDrive?: boolean }
	): Promise<{
		vaultPath: string | null;
		downloaded: boolean;
		trashed: boolean;
		error?: string;
	}> {
		if (this.syncing) throw new Error("A sync is already in progress.");
		this.syncing = true;
		try {
			return await this.driveSync.pullFile(pair, entry, options);
		} finally {
			this.syncing = false;
		}
	}

	formatResult(result: SyncResult): string {
		return (
			`Drive sync complete — ${result.downloaded} downloaded, ` +
			`${result.skipped} up to date` +
			((result.moved ?? 0) > 0 ? `, ${result.moved} moved` : "") +
			(result.removed > 0 ? `, ${result.removed} removed` : "") +
			((result.archived ?? 0) > 0 ? `, ${result.archived} archived` : "") +
			(result.errors > 0 ? `, ${result.errors} errors` : "")
		);
	}

	private wireEventBus(): void {
		this.bus.onAny((record) => {
			this.recentEvents.push(record);
			if (this.recentEvents.length > 50) {
				this.recentEvents.splice(0, this.recentEvents.length - 50);
			}
			this.refreshStatusViews((view) => view.onBusEvent(record));
		});

		this.bus.on("sync-complete", ({ result }) => {
			this.recordPairHistory(result);
			this.refreshStatusViews((view) => view.updateResult(result));
		});

		this.bus.on("auth-failed", ({ reason }) => {
			this.scheduler.stop();
			new Notice(
				`Drive Downloader authentication expired — ${reason}. Reconnect in settings.`,
				0
			);
			void this.syncActivityLog.log({
				level: "error",
				syncId: "auth",
				action: "auth-failed",
				result: reason,
			});
		});

		this.bus.on("auth-restored", () => {
			new Notice("Drive Downloader authentication restored.");
			this.restartScheduler();
		});

		this.bus.on("error", ({ message, context }) => {
			void this.syncActivityLog.log({
				level: "error",
				syncId: "bus",
				action: context ?? "sync-error",
				result: message,
			});
		});
	}

	private refreshStatusViews(update: (view: SyncStatusView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SYNC_STATUS_VIEW_TYPE)) {
			if (leaf.view instanceof SyncStatusView) update(leaf.view);
		}
	}

	private recordPairHistory(result: SyncResult): void {
		const now = Date.now();
		for (const [pairId, pairResult] of Object.entries(result.pairs ?? {})) {
			const history = this.pairHistory.get(pairId) ?? [];
			history.push({ at: now, errors: pairResult.errors });
			this.pairHistory.set(pairId, history.slice(-10));
		}
	}

	getPairHealth(
		pairId: string
	): {
		level: "green" | "yellow" | "red" | "unknown";
		color: string;
		tooltip: string;
	} {
		const history = this.pairHistory.get(pairId) ?? [];
		if (history.length === 0) {
			return {
				level: "unknown",
				color: "var(--text-faint)",
				tooltip: "No sync recorded this session.",
			};
		}
		const now = Date.now();
		const latest = history[history.length - 1];
		const failuresInHour = history.filter(
			(item) => item.at >= now - 60 * 60 * 1000 && item.errors > 0
		).length;
		const latestThree = history.slice(-3);
		const repeatedFailure =
			latestThree.length === 3 && latestThree.every((item) => item.errors > 0);
		const staleAfter =
			Math.max(1, this.settings.syncIntervalMinutes || 30) * 2 * 60 * 1000;
		const stale = now - latest.at > staleAfter;
		const ageSeconds = Math.round((now - latest.at) / 1000);

		if (repeatedFailure) {
			return {
				level: "red",
				color: "#e5534b",
				tooltip: `Last three syncs reported errors; latest was ${ageSeconds}s ago.`,
			};
		}
		if (failuresInHour > 0 || stale) {
			return {
				level: "yellow",
				color: "#d29922",
				tooltip: `${failuresInHour} sync(s) with errors in the last hour; latest was ${ageSeconds}s ago.`,
			};
		}
		return {
			level: "green",
			color: "#3fb950",
			tooltip: `Latest sync was ${ageSeconds}s ago with no recent errors.`,
		};
	}

	async activateStatusView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SYNC_STATUS_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: SYNC_STATUS_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	restartScheduler(): void {
		this.scheduler.stop();
		const interval = this.settings.syncIntervalMinutes;
		if (interval <= 0) return;
		this.scheduler.start(Math.max(1, interval), () => this.runSync());
	}

	openSyncActivityLog(): void {
		new SyncLogModal(this.app, this.syncActivityLog).open();
	}

	private async showAudit(): Promise<void> {
		const issues = await runAudit(this.app, this.manifestStore, this.settings);
		new AuditModal(this.app, issues, this.manifestStore).open();
	}

	async showIntegrityReport(): Promise<void> {
		const notice = new Notice("Verifying downloaded files…", 0);
		try {
			const report = await verifyIntegrity(this.app, this.manifestStore);
			notice.hide();
			new VerifyIntegrityModal(
				this.app,
				report,
				this.manifestStore,
				() => undefined
			).open();
		} catch (error) {
			notice.hide();
			new Notice(`Verification failed: ${(error as Error).message}`);
		}
	}

	async restoreManifestBackup(): Promise<void> {
		const backups = await this.manifestStore.listBackups();
		if (backups.length === 0) {
			new Notice("No manifest backups found.");
			return;
		}
		new RestoreManifestModal(this.app, backups, (name) => {
			new ConfirmModal(
				this.app,
				"Restore manifest backup?",
				`Replace the current manifest with "${name}"? The restored state is backed up again.`,
				async () => {
					await this.manifestStore.restoreBackup(name);
					new Notice(`Manifest restored from ${name}.`);
				}
			).open();
		}).open();
	}

	async restoreRecycleRun(): Promise<void> {
		const runs = await this.recycle.listRunIds();
		if (runs.length === 0) {
			new Notice("The downloader recycle history is empty.");
			return;
		}
		new RecycleRunModal(this.app, runs, (run) => {
			new ConfirmModal(
				this.app,
				"Restore recycled files?",
				`Restore ${run.count} file(s) from ${new Date(run.at).toLocaleString()}?`,
				async () => {
					const restored = await this.recycle.restoreRun(run.syncRunId);
					new Notice(`Restored ${restored} file(s).`);
				}
			).open();
		}).open();
	}

	async undoLastSync(): Promise<void> {
		const runs = await this.recycle.listRunIds();
		if (runs.length === 0) {
			new Notice("Nothing to undo; the downloader recycle history is empty.");
			return;
		}
		const latest = runs[0];
		new ConfirmModal(
			this.app,
			"Undo latest destructive sync actions?",
			`Restore ${latest.count} file(s) recycled at ${new Date(latest.at).toLocaleString()}?`,
			async () => {
				const restored = await this.recycle.restoreRun(latest.syncRunId);
				new Notice(`Restored ${restored} file(s).`);
			}
		).open();
	}

	async runCacheGc(): Promise<void> {
		if (!this.cacheManager) return;
		const referenced = new Set<string>();
		for (const [, entry] of this.manifestStore.entries()) {
			if (entry.driveMd5) referenced.add(entry.driveMd5);
		}
		await this.cacheManager.gc(referenced);
	}

	previewErrorReport(): void {
		const sample = this.errorReporter.build(
			new Error("Sample Drive Downloader error at /redacted/example.pdf")
		);
		new ErrorReportPreviewModal(
			this.app,
			JSON.stringify(sample, null, 2),
			async () => {
				await this.errorReporter.report(new Error("Drive Downloader test report"));
				new Notice(
					this.settings.errorReportingEndpoint
						? "Test report sent."
						: "No endpoint configured; nothing was sent."
				);
			}
		).open();
	}

	private async maybeShowChangelog(): Promise<void> {
		const currentVersion = this.manifest.version;
		if (!isNewer(currentVersion, this.settings.lastSeenVersion)) return;
		try {
			const path =
				`${this.app.vault.configDir}/plugins/${this.manifest.id}/CHANGELOG.md`;
			if (!(await this.app.vault.adapter.exists(path))) return;
			const markdown = await this.app.vault.adapter.read(path);
			const entries = parseChangelog(markdown).filter((entry) =>
				isNewer(entry.version, this.settings.lastSeenVersion)
			);
			if (entries.length > 0) {
				new ChangelogModal(this.app, this, currentVersion, entries).open();
			}
		} catch (error) {
			console.error(`${LOG} Failed to load changelog:`, error);
		}
	}

	private async loadSettings(): Promise<void> {
		const rawCurrent = await this.loadData();
		let legacyData: unknown;
		let legacyReadFailed = false;
		const currentMarker =
			rawCurrent !== null &&
			typeof rawCurrent === "object" &&
			(rawCurrent as Record<string, unknown>).legacyImportCompleted === true;

		if (!currentMarker) {
			const path = `${this.app.vault.configDir}/${LEGACY_DATA_PATH}`;
			try {
				if (await this.app.vault.adapter.exists(path)) {
					legacyData = JSON.parse(await this.app.vault.adapter.read(path));
				}
			} catch (error) {
				legacyReadFailed = true;
				console.warn(`${LOG} Legacy settings could not be read; import will retry on next load:`, error);
			}
		}

		const prepared = prepareLegacyImport(rawCurrent, legacyData);
		this.settings = legacyReadFailed
			? { ...prepared.settings, legacyImportCompleted: false }
			: prepared.settings;
		if (legacyReadFailed) return;
		if (prepared.shouldPersist) {
			await this.saveData(this.settings);
			console.log(
				prepared.imported
					? `${LOG} Imported downloader settings from drive-folder-sync once.`
					: `${LOG} Legacy settings import checked; no usable source was found.`
			);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.auth?.updateSettings(this.settings);
		this.driveSync?.updateSettings(this.settings);
		this.syncLogger?.updateSettings(this.settings);
		this.syncActivityLog?.updateSettings(this.settings);
		this.errorReporter?.updateSettings(this.settings);

		if (this.settings.downloadCacheEnabled) {
			if (!this.cacheManager) {
				this.cacheManager = new CacheManager(
					this.app,
					this.settings.downloadCacheMaxMb * 1024 * 1024
				);
			} else {
				this.cacheManager.setMaxBytes(
					this.settings.downloadCacheMaxMb * 1024 * 1024
				);
			}
		} else {
			this.cacheManager = undefined;
		}
		this.downloadManager?.setCache(this.cacheManager);
	}
}

class SyncPairPickerModal extends FuzzySuggestModal<SyncPair> {
	constructor(
		app: App,
		private pairs: SyncPair[],
		private choose: (pair: SyncPair) => void
	) {
		super(app);
		this.setPlaceholder("Choose a folder pair…");
	}

	getItems(): SyncPair[] {
		return this.pairs;
	}

	getItemText(pair: SyncPair): string {
		return pair.label;
	}

	onChooseItem(pair: SyncPair): void {
		this.choose(pair);
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private confirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Confirm").setCta().onClick(async () => {
					this.close();
					await this.confirm();
				})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TextPromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private title: string,
		private label: string,
		initial: string,
		private submit: (value: string) => void
	) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		new Setting(this.contentEl)
			.setName(this.label)
			.addText((text) =>
				text.setValue(this.value).onChange((value) => {
					this.value = value;
				})
			);
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Run").setCta().onClick(() => {
					this.close();
					this.submit(this.value.trim());
				})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class RestoreManifestModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private backups: string[],
		private choose: (name: string) => void
	) {
		super(app);
		this.setPlaceholder("Choose a manifest backup…");
	}

	getItems(): string[] {
		return this.backups.slice().reverse();
	}

	getItemText(name: string): string {
		return name;
	}

	onChooseItem(name: string): void {
		this.choose(name);
	}
}

interface RecycleRun {
	syncRunId: string;
	at: string;
	count: number;
}

class RecycleRunModal extends FuzzySuggestModal<RecycleRun> {
	constructor(
		app: App,
		private runs: RecycleRun[],
		private choose: (run: RecycleRun) => void
	) {
		super(app);
		this.setPlaceholder("Choose a recycle run…");
	}

	getItems(): RecycleRun[] {
		return this.runs;
	}

	getItemText(run: RecycleRun): string {
		return `${new Date(run.at).toLocaleString()} — ${run.count} file(s)`;
	}

	onChooseItem(run: RecycleRun): void {
		this.choose(run);
	}
}

class ErrorReportPreviewModal extends Modal {
	constructor(
		app: App,
		private json: string,
		private send: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: "Error report preview" });
		this.contentEl.createEl("p", {
			text: "This is exactly what would be sent after path and file-name redaction.",
			cls: "setting-item-description",
		});
		const preview = this.contentEl.createEl("pre");
		preview.style.cssText =
			"max-height:50vh;overflow:auto;font-size:12px;white-space:pre-wrap;";
		preview.textContent = this.json;
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Send test report").setCta().onClick(async () => {
					this.close();
					await this.send();
				})
			)
			.addButton((button) =>
				button.setButtonText("Close").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
