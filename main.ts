import { App, FuzzySuggestModal, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import * as crypto from "crypto";
import { GoogleAuth } from "./auth/GoogleAuth";
import { DriveSync } from "./sync/DriveSync";
import { DownloadManager } from "./sync/DownloadManager";
import { Scheduler } from "./sync/Scheduler";
import { SyncManifestStore, createManifestStore } from "./sync/SyncManifest";
import { CompanionNoteManager } from "./sync/CompanionNoteManager";
import { SyncLogger } from "./sync/SyncLogger";
import { SyncActivityLog } from "./sync/SyncLog";
import { DriveSyncSettingTab } from "./settings/SettingsTab";
import { AutomationEngine } from "./automation/AutomationEngine";
import { SyncStatusView, SYNC_STATUS_VIEW_TYPE } from "./ui/SyncStatusView";
import { DryRunModal } from "./ui/DryRunModal";
import { FileTrackerModal } from "./ui/FileTrackerModal";
import { SyncLogModal } from "./ui/SyncLogModal";
import { AutomationDryRunModal } from "./ui/AutomationDryRunModal";
import { ConflictModal } from "./ui/ConflictModal";
import { FileStatusModal } from "./ui/FileStatusModal";
import { TranscriptionStore } from "./ai/TranscriptionStore";
import { EventBus, BusRecord } from "./events/EventBus";
import { CacheManager } from "./sync/CacheManager";
import { HeavyWorkerClient } from "./workers/heavyWorker";
import { Recycle } from "./sync/Recycle";
import { verifyIntegrity, VerifyIntegrityModal } from "./commands/VerifyIntegrity";
import { ErrorReporter } from "./telemetry/ErrorReporter";
import { ChangelogModal, parseChangelog, isNewer } from "./ui/ChangelogModal";
import { checkDiskSpace } from "./sync/DiskSpaceCheck";
import { lintAutomations } from "./automation/AutomationLinter";
import { transcribeCurrentFile, openTranscribePickerForFile } from "./commands/TranscribeCurrentFile";
import { runAudit, AuditModal } from "./commands/Audit";
import { Automation, DEFAULT_SETTINGS, PluginSettings, SyncPair, SyncResult } from "./types";

const LOG = "[DriveSync]";
const PDF_EMBED_STYLE_ID = "drive-sync-pdf-embed-style";

export default class DriveFolderSyncPlugin extends Plugin {
	settings: PluginSettings;
	auth: GoogleAuth;
	scheduler: Scheduler;
	lastSyncResult: SyncResult | null = null;
	manifestStore: SyncManifestStore;
	transcriptionStore: TranscriptionStore;
	bus: EventBus;
	cacheManager?: CacheManager;
	heavyWorker?: HeavyWorkerClient;
	recycle: Recycle;
	errorReporter: ErrorReporter;
	/** Ring buffer of the last 50 bus events, for the live activity ticker (Phase 12.1). */
	recentEvents: BusRecord[] = [];
	/** Per-pair sync history for the health badge (Phase 12.2). Resets each session. */
	private pairHistory = new Map<string, Array<{ at: number; errors: number }>>();
	private driveSync: DriveSync;
	companionManager: CompanionNoteManager;
	automationEngine: AutomationEngine;
	private syncLogger: SyncLogger;
	private syncActivityLog: SyncActivityLog;
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

		this.bus = new EventBus();
		this.manifestStore = createManifestStore(this.app, this.settings, this.bus);
		// Load manifest at startup so vault rename events are healable immediately
		await this.manifestStore.load().catch((e) =>
			console.error(`${LOG} Failed to pre-load manifest:`, e)
		);
		this.transcriptionStore = new TranscriptionStore(this.app);
		await this.transcriptionStore.load().catch((e) =>
			console.error(`${LOG} Failed to pre-load transcription store:`, e)
		);
		this.companionManager = new CompanionNoteManager(this.app, this.settings);
		this.automationEngine = new AutomationEngine(this.app, this.settings, this.manifestStore, this.bus);
		this.syncLogger = new SyncLogger(this.app, this.settings);
		this.syncActivityLog = new SyncActivityLog(this.app, this.settings);

		this.cacheManager = this.settings.downloadCacheEnabled
			? new CacheManager(this.app, this.settings.downloadCacheMaxMb * 1024 * 1024)
			: undefined;
		const downloader = new DownloadManager(this.app, this.cacheManager);
		this.heavyWorker = this.settings.offThreadHashing ? new HeavyWorkerClient() : undefined;
		this.recycle = new Recycle(this.app, this.bus);
		this.errorReporter = new ErrorReporter(this.settings, this.manifest.version);
		this.errorReporter.install();
		this.auth = new GoogleAuth(this.app, this.settings, this.bus);
		this.driveSync = new DriveSync(
			this.auth,
			downloader,
			this.settings,
			this.app,
			this.manifestStore,
			this.companionManager,
			this.automationEngine,
			this.transcriptionStore,
			this.bus,
			this.heavyWorker,
			this.recycle
		);

		this.wireEventBus();
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

		this.addRibbonIcon("file-search", "Drive Sync File Tracker", () => {
			new FileTrackerModal(this.app, this.manifestStore, this.transcriptionStore, this.settings, (vaultPath) => {
						const f = this.app.vault.getAbstractFileByPath(vaultPath);
						if (f instanceof TFile) openTranscribePickerForFile(this.app, this, f);
					}).open();
		});

		this.addSettingTab(new DriveSyncSettingTab(this.app, this));

		this.applyPdfEmbedStyle();

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
			id: "transcribe-current-file",
			name: "Transcribe current file…",
			callback: () => {
				transcribeCurrentFile(this).catch((e) =>
					new Notice(`Transcription failed: ${(e as Error).message}`)
				);
			},
		});

		this.addCommand({
			id: "file-tracker",
			name: "Open file tracker",
			callback: () => {
				new FileTrackerModal(this.app, this.manifestStore, this.transcriptionStore, this.settings, (vaultPath) => {
						const f = this.app.vault.getAbstractFileByPath(vaultPath);
						if (f instanceof TFile) openTranscribePickerForFile(this.app, this, f);
					}).open();
			},
		});

		this.addCommand({
			id: "force-full-retranscribe",
			name: "Force full re-transcription of current file",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				if (!active || !active.path.toLowerCase().endsWith(".pdf")) {
					new Notice("Open a PDF file first.");
					return;
				}
				const entry = this.manifestStore.findByVaultPath(active.path);
				if (!entry) {
					new Notice("This PDF is not tracked by Drive Sync.");
					return;
				}
				const [driveFileId] = entry;
				this.transcriptionStore.delete(driveFileId);
				this.transcriptionStore.save().catch((e) =>
					console.error(`${LOG} Failed to save transcription store after force-clear:`, e)
				);
				new Notice(`Transcription record cleared for "${active.basename}". Re-sync to re-transcribe.`);
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

		this.addCommand({
			id: "run-automation-on-active-file",
			name: "Run automation on active file…",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				if (!active) {
					new Notice("Open a file first.");
					return;
				}
				this.openAdHocAutomationPicker(active);
			},
		});

		this.addCommand({
			id: "run-all-automations-on-active-file",
			name: "Run all automations on active file",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				if (!active) {
					new Notice("Open a file first.");
					return;
				}
				this.runAllAutomationsAdHoc(active);
			},
		});

		this.addCommand({
			id: "create-companion-for-active-file",
			name: "Create companion note for active file",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				if (!active) {
					new Notice("Open a file first.");
					return;
				}
				new CreateCompanionModal(this.app, active, this.companionManager).open();
			},
		});

		this.addCommand({
			id: "view-sync-log",
			name: "View sync activity log",
			callback: () => {
				new SyncLogModal(this.app, this.syncActivityLog).open();
			},
		});

		this.addCommand({
			id: "audit",
			name: "Run health audit",
			callback: () => {
				(async () => {
					const notice = new Notice("Running audit…", 0);
					try {
						const issues = await runAudit(this.app, this.manifestStore, this.settings);
						notice.hide();
						new AuditModal(this.app, issues, this.manifestStore, async () => {
							// nothing extra needed after fix
						}).open();
					} catch (e) {
						notice.hide();
						new Notice(`Audit failed: ${(e as Error).message}`);
					}
				})();
			},
		});

		this.addCommand({
			id: "verify-integrity",
			name: "Verify manifest integrity",
			callback: () => this.runVerifyIntegrity(),
		});

		this.addCommand({
			id: "restore-manifest",
			name: "Restore manifest from backup…",
			callback: () => this.openRestoreManifest(),
		});

		this.addCommand({
			id: "open-recycle",
			name: "Open recycle bin",
			callback: () => this.openRecycleFolder(),
		});

		this.addCommand({
			id: "undo-last-sync",
			name: "Undo last sync",
			callback: () => this.undoLastSync(),
		});

		this.addCommand({
			id: "test-sync-pair",
			name: "Test sync against a sandbox subfolder…",
			callback: () => {
				if (this.settings.syncPairs.length === 0) { new Notice("No sync pairs configured."); return; }
				new SyncPairPickerModal(this.app, this.settings.syncPairs, (pair) => {
					new TextPromptModal(this.app, "Sandbox subfolder", "Subfolder path within the pair (e.g. \"2026/Inbox\")", "", (sub) => {
						this.testSyncPair(pair.id, sub);
					}).open();
				}).open();
			},
		});

		// Phase 12.3 — show the changelog once after an update.
		this.maybeShowChangelog();

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

		// Detect user vault-side deletions — mark manifest entries so re-sync is skipped
		this.registerEvent(
			this.app.vault.on("delete", async (file) => {
				const marked = this.manifestStore.markUserDeleted(file.path);
				if (marked) {
					console.log(`${LOG} User deleted tracked file: ${file.path}`);
					await this.manifestStore.save().catch((e) =>
						console.error(`${LOG} Failed to save manifest after user deletion:`, e)
					);
				}
			})
		);

		// File-explorer right-click menu
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, abstractFile) => {
				if (!(abstractFile instanceof TFile)) return;
				const file = abstractFile;

				const manifestEntry = this.manifestStore.findByVaultPath(file.path);
				const isPdf = file.path.toLowerCase().endsWith(".pdf");
				const providerEnabled =
					this.settings.geminiEnabled || !!this.settings.mistralApiKey;

				// ── Transcription items (PDF + provider enabled) ──────────────────
				if (isPdf && providerEnabled) {
					menu.addItem((item) =>
						item
							.setTitle("Transcribe…")
							.setIcon("mic")
							.setSection("drive-sync")
							.onClick(() => openTranscribePickerForFile(this.app, this, file))
					);
					menu.addItem((item) =>
						item
							.setTitle("Transcribe to companion note")
							.setIcon("mic")
							.setSection("drive-sync")
							.onClick(() => openTranscribePickerForFile(this.app, this, file, "companion"))
					);
					menu.addItem((item) =>
						item
							.setTitle("Transcribe to today's daily note")
							.setIcon("mic")
							.setSection("drive-sync")
							.onClick(() => openTranscribePickerForFile(this.app, this, file, "daily"))
					);
				}

				// ── Companion note (any file) ─────────────────────────────────────
				menu.addItem((item) =>
					item
						.setTitle("Create companion note")
						.setIcon("file-plus")
						.setSection("drive-sync")
						.onClick(() => new CreateCompanionModal(this.app, file, this.companionManager).open())
				);

				// ── Drive Sync status (any file) ──────────────────────────────────
				menu.addItem((item) =>
					item
						.setTitle("Show Drive Sync status…")
						.setIcon("info")
						.setSection("drive-sync")
						.onClick(() => new FileStatusModal(this.app, this, file).open())
				);

				// ── Run automation on this file (any file) ────────────────────────
				if (this.settings.automations.some((a) => a.enabled)) {
					menu.addItem((item) =>
						item
							.setTitle("Run automation on this file…")
							.setIcon("zap")
							.setSection("drive-sync")
							.onClick(() => this.openAdHocAutomationPicker(file))
					);
				}

				// ── Tracked-file-only items ───────────────────────────────────────
				if (manifestEntry) {
					const [driveFileId, entry] = manifestEntry;

					menu.addItem((item) =>
						item
							.setTitle("Sync this pair now")
							.setIcon("refresh-cw")
							.setSection("drive-sync")
							.onClick(() => {
								this.runSyncForPair(entry.pairId)
									.then((r) => new Notice(this.formatResult(r)))
									.catch((e) => new Notice(`Drive sync failed: ${(e as Error).message}`));
							})
					);

					if (isPdf) {
						menu.addItem((item) =>
							item
								.setTitle("Force full re-transcription")
								.setIcon("rotate-ccw")
								.setSection("drive-sync")
								.onClick(() => {
									this.transcriptionStore.delete(driveFileId);
									this.transcriptionStore.save().catch((e) =>
										console.error(`${LOG} Failed to save transcription store:`, e)
									);
									new Notice(
										`Transcription record cleared for "${file.basename}". Re-sync to re-transcribe.`
									);
								})
						);
					}
				}
			})
		);

		const isAuthorized = await this.auth.isAuthorized();
		console.log(`${LOG} Authorized: ${isAuthorized}`);

		if (isAuthorized) {
			console.log(
				`${LOG} Starting scheduler — interval: ${this.settings.syncIntervalMinutes} min`
			);
			this.scheduler.start(this.effectiveInterval(), () =>
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
		this.bus?.clear();
		this.heavyWorker?.terminate();
		this.errorReporter?.uninstall();
		document.getElementById(PDF_EMBED_STYLE_ID)?.remove();
	}

	/**
	 * Inject (or remove) a global stylesheet that caps PDF embeds to a fixed-height
	 * scrollable window instead of letting them expand to the full document height.
	 * Applies vault-wide in both Reading view and Live Preview. Idempotent — call it
	 * on load and after every settings save.
	 */
	applyPdfEmbedStyle(): void {
		document.getElementById(PDF_EMBED_STYLE_ID)?.remove();
		if (!this.settings.pdfEmbedWindowed) return;

		const h = Math.max(100, Math.round(this.settings.pdfEmbedWindowHeight) || 400);
		const style = document.createElement("style");
		style.id = PDF_EMBED_STYLE_ID;
		style.textContent =
			`.internal-embed.pdf-embed {\n` +
			`\theight: ${h}px !important;\n` +
			`}\n` +
			`.internal-embed.pdf-embed .pdf-viewer-container,\n` +
			`.internal-embed.pdf-embed .pdf-container {\n` +
			`\theight: 100% !important;\n` +
			`\tmax-height: ${h}px !important;\n` +
			`\toverflow: auto !important;\n` +
			`}\n`;
		document.head.appendChild(style);
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
			if (this.driveSync.consumeSettingsDirty()) await this.saveSettings();
			if (dryRun) {
				new DryRunModal(this.app, result).open();
			} else {
				this.lastSyncResult = result;
				this.pushResultToStatusView(result);
				await this.syncLogger.append(result);
				await this.gcCache();
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
			if (this.driveSync.consumeSettingsDirty()) await this.saveSettings();
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

	async dryRunAutomationOnExistingFiles(
		automationId: string
	): Promise<{ matched: number; ran: number; skipped: number; errors: number; preview?: Array<{ vaultPath: string; willRun: boolean; skipReason?: string }> }> {
		return this.automationEngine.runForAllMatchingFiles(automationId, { dryRun: true });
	}

	openAdHocAutomationPicker(file: TFile): void {
		const active = this.settings.automations.filter((a) => a.enabled);
		if (active.length === 0) {
			new Notice("No active automations configured.");
			return;
		}
		new AutomationPickerModal(this.app, active, (automation, force) => {
			(async () => {
				const notice = new Notice(`Running "${automation.name}" on "${file.basename}"…`, 0);
				try {
					const r = await this.automationEngine.runForFileAdHoc(file.path, automation.id, { force });
					notice.hide();
					if (r.ran) {
						new Notice(`"${automation.name}" ran on "${file.basename}".`);
					} else if (r.error) {
						new Notice(`"${automation.name}" failed: ${r.error}`);
					} else {
						new Notice(`"${automation.name}" skipped: ${r.skippedReason ?? "no reason"}.`);
					}
				} catch (e) {
					notice.hide();
					new Notice(`Automation failed: ${(e as Error).message}`);
				}
			})();
		}).open();
	}

	runAllAutomationsAdHoc(file: TFile): void {
		const active = this.settings.automations.filter((a) => a.enabled);
		if (active.length === 0) {
			new Notice("No active automations configured.");
			return;
		}
		new RunAllAutomationsConfirmModal(this.app, file, active, (force) => {
			(async () => {
				const notice = new Notice(
					`Running ${active.length} automation${active.length !== 1 ? "s" : ""} on "${file.basename}"…`,
					0
				);
				let ran = 0, skipped = 0, errors = 0;
				try {
					for (const automation of active) {
						const r = await this.automationEngine.runForFileAdHoc(file.path, automation.id, { force });
						if (r.ran) ran++;
						else if (r.error) errors++;
						else skipped++;
					}
					notice.hide();
					new Notice(
						`Done on "${file.basename}" — ${ran} ran, ${skipped} skipped` +
						(errors > 0 ? `, ${errors} errors` : "")
					);
				} catch (e) {
					notice.hide();
					new Notice(`Run-all failed: ${(e as Error).message}`);
				}
			})();
		}).open();
	}

	/**
	 * Phase 11.5 — subscribe the status view, activity log and notice handlers to the
	 * event bus instead of being called directly. Adding a new subscriber (e.g. a badge)
	 * requires zero changes in the producers.
	 */
	private wireEventBus(): void {
		// Live activity ticker buffer (Phase 12.1) — keep the last 50 events.
		this.bus.onAny((rec) => {
			this.recentEvents.push(rec);
			if (this.recentEvents.length > 50) {
				this.recentEvents.splice(0, this.recentEvents.length - 50);
			}
			this.refreshStatusViews((v) => v.onBusEvent(rec));
		});

		// Status view subscribes to whole-run results rather than a direct call.
		this.bus.on("sync-complete", ({ result }) => {
			this.recordPairHistory(result);
			this.refreshStatusViews((v) => v.updateResult(result));
		});

		// Mirror selected events into the activity log.
		this.bus.on("conflict", (p) => {
			void this.syncActivityLog.log({
				level: "warn", syncId: "bus", file: p.vaultPath,
				action: "conflict", result: p.resolution ?? "save-both",
				details: p.backupPath,
			});
		});
		this.bus.on("auth-failed", (p) => {
			void this.syncActivityLog.log({
				level: "error", syncId: "bus", action: "auth-failed", result: "expired", details: p.reason,
			});
		});

		// Surface auth failures as a persistent, non-auto-dismissing notice + pause the
		// scheduler until re-auth (Phase 13.8).
		this.bus.on("auth-failed", (p) => {
			new Notice(`Drive Sync: authentication expired — ${p.reason}. Re-authenticate in settings.`, 0);
			this.scheduler.stop();
		});
		this.bus.on("auth-restored", () => {
			new Notice("Drive Sync: authentication restored — resuming scheduled syncs.");
			this.scheduler.start(this.effectiveInterval(), () => this.runSync());
		});
	}

	/** Phase 13.3 — clamp the user's interval to a 60s floor. */
	effectiveInterval(): number {
		const min = 1 / 60; // 60 seconds expressed in minutes
		if (this.settings.syncIntervalMinutes < min) {
			console.warn(`${LOG} syncIntervalMinutes below 60s floor — clamping.`);
			return min;
		}
		return this.settings.syncIntervalMinutes;
	}

	private refreshStatusViews(fn: (view: SyncStatusView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SYNC_STATUS_VIEW_TYPE)) {
			if (leaf.view instanceof SyncStatusView) fn(leaf.view);
		}
	}

	private pushResultToStatusView(result: SyncResult): void {
		this.bus.emit("sync-complete", { result });
	}

	// ── Phase 13 action methods (used by the Advanced settings tab + commands) ──

	async runVerifyIntegrity(): Promise<void> {
		const notice = new Notice("Verifying manifest integrity…", 0);
		try {
			const report = await verifyIntegrity(this.app, this.manifestStore);
			notice.hide();
			new VerifyIntegrityModal(this.app, report, this.manifestStore, () => undefined).open();
		} catch (e) {
			notice.hide();
			new Notice(`Verify failed: ${(e as Error).message}`);
		}
	}

	async openRestoreManifest(): Promise<void> {
		const backups = await this.manifestStore.listBackups();
		if (backups.length === 0) { new Notice("No manifest backups found yet."); return; }
		new RestoreManifestModal(this.app, backups, (name) => {
			new ConfirmModal(
				this.app,
				"Restore manifest?",
				`This replaces the current manifest with backup "${name}". A fresh backup of the current state is taken first. Continue?`,
				async () => {
					try {
						await this.manifestStore.restoreBackup(name);
						new Notice(`Manifest restored from ${name}.`);
					} catch (e) {
						new Notice(`Restore failed: ${(e as Error).message}`);
					}
				}
			).open();
		}).open();
	}

	async openRecycleFolder(): Promise<void> {
		const path = this.recycle.folderPath;
		if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.adapter.mkdir(path);
		try { await navigator.clipboard.writeText(path); } catch { /* ignore */ }
		new Notice(`Recycle bin: ${path}\n(path copied to clipboard)`);
	}

	async undoLastSync(): Promise<void> {
		const runs = await this.recycle.listRunIds();
		if (runs.length === 0) { new Notice("Nothing to undo — recycle bin is empty."); return; }
		const latest = runs[0];
		new ConfirmModal(
			this.app,
			"Undo last sync?",
			`Restore ${latest.count} file(s) recycled in the most recent run (${new Date(latest.at).toLocaleString()})?`,
			async () => {
				const n = await this.recycle.restoreRun(latest.syncRunId);
				new Notice(`Restored ${n} file(s) from the recycle bin.`);
			}
		).open();
	}

	async testSyncPair(pairId: string, subfolder: string): Promise<void> {
		if (this.syncing) { new Notice("Sync already in progress…"); return; }
		this.syncing = true;
		const notice = new Notice(`Test sync of "${subfolder || "(root)"}"…`, 0);
		try {
			const result = await this.driveSync.testSync(pairId, subfolder);
			notice.hide();
			new ConfirmModal(
				this.app,
				"Test sync complete",
				this.formatResult(result),
				() => undefined
			).open();
		} catch (e) {
			notice.hide();
			new Notice(`Test sync failed: ${(e as Error).message}`);
		} finally {
			this.syncing = false;
		}
	}

	previewErrorReport(): void {
		const sample = this.errorReporter.build(new Error("Sample error for preview at drive-folder-sync"));
		new ErrorReportPreviewModal(this.app, JSON.stringify(sample, null, 2), async () => {
			await this.errorReporter.report(new Error("Test report from drive-folder-sync"));
			new Notice(this.settings.errorReportingEndpoint ? "Test report sent." : "No endpoint set — nothing sent.");
		}).open();
	}

	private async maybeShowChangelog(): Promise<void> {
		const current = this.manifest.version;
		if (!isNewer(current, this.settings.lastSeenVersion)) return;
		try {
			const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/CHANGELOG.md`;
			if (!(await this.app.vault.adapter.exists(path))) return;
			const md = await this.app.vault.adapter.read(path);
			const entries = parseChangelog(md).filter((e) => isNewer(e.version, this.settings.lastSeenVersion));
			if (entries.length === 0) return;
			new ChangelogModal(this.app, this, current, entries).open();
		} catch (e) {
			console.error(`${LOG} Failed to show changelog:`, e);
		}
	}

	private async gcCache(): Promise<void> {
		if (!this.cacheManager) return;
		const referenced = new Set<string>();
		for (const [, entry] of this.manifestStore.entries()) {
			if (entry.driveMd5) referenced.add(entry.driveMd5);
		}
		await this.cacheManager.gc(referenced);
	}

	private recordPairHistory(result: SyncResult): void {
		const now = Date.now();
		const pairs = result.pairs ?? {};
		// When a whole-vault sync ran, attribute the aggregate to every pair touched.
		for (const [pairId, pr] of Object.entries(pairs)) {
			const hist = this.pairHistory.get(pairId) ?? [];
			hist.push({ at: now, errors: pr.errors });
			// Keep last 10 runs + anything within the last hour.
			const cutoff = now - 60 * 60 * 1000;
			const trimmed = hist.filter((h, i) => i >= hist.length - 10 || h.at >= cutoff);
			this.pairHistory.set(pairId, trimmed);
		}
	}

	/** Phase 12.2 — compute a green/yellow/red health badge for a pair. */
	getPairHealth(pairId: string): { level: "green" | "yellow" | "red" | "unknown"; color: string; tooltip: string } {
		const hist = this.pairHistory.get(pairId) ?? [];
		if (hist.length === 0) {
			return { level: "unknown", color: "var(--text-faint)", tooltip: "No sync recorded this session." };
		}
		const now = Date.now();
		const intervalMs = Math.max(1, this.settings.syncIntervalMinutes) * 60 * 1000;
		const last = hist[hist.length - 1];
		const errorsInHour = hist.filter((h) => h.at >= now - 60 * 60 * 1000 && h.errors > 0).length;
		const last3 = hist.slice(-3);
		const last3AllFailed = last3.length === 3 && last3.every((h) => h.errors > 0);
		const stale = now - last.at > 2 * intervalMs;

		const tip = (lvl: string) =>
			`${lvl} — last sync ${Math.round((now - last.at) / 1000)}s ago, ` +
			`${errorsInHour} run(s) with errors in last hour, ${hist.length} run(s) tracked.`;

		if (last3AllFailed) return { level: "red", color: "#e5534b", tooltip: tip("Red: last 3 syncs failed") };
		if (errorsInHour > 0 || stale) return { level: "yellow", color: "#d29922", tooltip: tip("Yellow") };
		return { level: "green", color: "#3fb950", tooltip: tip("Green") };
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
		if (this.syncActivityLog) this.syncActivityLog.updateSettings(this.settings);
		if (this.errorReporter) this.errorReporter.updateSettings(this.settings);
		this.applyPdfEmbedStyle();

		// Phase 13.10 — surface automation-config problems on save.
		const lint = lintAutomations(this.app, this.settings.automations, {
			mistralConfigured: !!this.settings.mistralApiKey,
		});
		const errors = lint.filter((l) => l.severity === "error");
		if (errors.length > 0) {
			console.warn(`${LOG} Automation lint: ${errors.length} error(s)`, errors);
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

class RunAllAutomationsConfirmModal extends Modal {
	private force = false;

	constructor(
		app: App,
		private file: TFile,
		private automations: Automation[],
		private onConfirm: (force: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, file, automations } = this;
		contentEl.createEl("h3", { text: `Run all automations on "${file.basename}"` });
		contentEl.createEl("p", {
			text: `The following ${automations.length} automation${automations.length !== 1 ? "s" : ""} will run on this file (folder triggers bypassed):`,
			cls: "setting-item-description",
		});

		const list = contentEl.createEl("ul");
		for (const a of automations) {
			list.createEl("li", { text: `${a.name} — ${a.action.type}` });
		}

		new Setting(contentEl)
			.setName("Force re-run")
			.setDesc("Re-run even for tracked files already completed at the current Drive version.")
			.addToggle((t) => t.setValue(false).onChange((v) => { this.force = v; }));

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Run all").setCta().onClick(() => {
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

class CreateCompanionModal extends Modal {
	constructor(
		app: App,
		private file: TFile,
		private companionManager: CompanionNoteManager
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, file } = this;
		contentEl.createEl("h3", { text: `Create companion note for "${file.basename}"` });
		contentEl.createEl("p", {
			text: "Choose where to place the companion note:",
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.setName("Alongside the file")
			.setDesc(`Place note in: ${file.parent?.path || "(vault root)"}`)
			.addButton((b) =>
				b.setButtonText("Create here").setCta().onClick(async () => {
					this.close();
					await this.create("alongside");
				})
			);

		new Setting(contentEl)
			.setName("Vault root")
			.setDesc("Place note in the top-level vault folder")
			.addButton((b) =>
				b.setButtonText("Create in root").onClick(async () => {
					this.close();
					await this.create("root");
				})
			);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	private async create(placement: "alongside" | "root"): Promise<void> {
		try {
			const path = await this.companionManager.createForArbitraryFile(this.file, placement);
			new Notice(`Companion note created: ${path}`);
			const created = this.app.vault.getAbstractFileByPath(path);
			if (created instanceof TFile) {
				this.app.workspace.getLeaf(false).openFile(created);
			}
		} catch (e) {
			new Notice(`Failed to create companion note: ${(e as Error).message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Phase 13 modals ────────────────────────────────────────────────────────

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.body, cls: "setting-item-description" });
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Confirm").setCta().onClick(async () => {
					this.close();
					await this.onConfirm();
				})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void { this.contentEl.empty(); }
}

class TextPromptModal extends Modal {
	private value: string;
	constructor(
		app: App,
		private title: string,
		private desc: string,
		initial: string,
		private onSubmit: (value: string) => void
	) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		new Setting(contentEl)
			.setName(this.desc)
			.addText((t) =>
				t.setValue(this.value).onChange((v) => { this.value = v; })
			);
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Run").setCta().onClick(() => {
					this.close();
					this.onSubmit(this.value.trim());
				})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void { this.contentEl.empty(); }
}

class RestoreManifestModal extends FuzzySuggestModal<string> {
	constructor(app: App, private backups: string[], private onChoose: (name: string) => void) {
		super(app);
		this.setPlaceholder("Pick a manifest backup to restore…");
	}
	getItems(): string[] { return this.backups.slice().reverse(); } // newest first
	getItemText(name: string): string { return name; }
	onChooseItem(name: string): void { this.onChoose(name); }
}

class ErrorReportPreviewModal extends Modal {
	constructor(app: App, private json: string, private onSend: () => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Error report preview" });
		contentEl.createEl("p", {
			text: "This is exactly what would be sent. Paths, file names and long literals are stripped.",
			cls: "setting-item-description",
		});
		const pre = contentEl.createEl("pre");
		pre.style.cssText = "max-height:50vh; overflow:auto; font-size:12px; white-space:pre-wrap;";
		pre.textContent = this.json;
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Send test report").setCta().onClick(async () => {
					this.close();
					await this.onSend();
				})
			)
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	onClose(): void { this.contentEl.empty(); }
}
