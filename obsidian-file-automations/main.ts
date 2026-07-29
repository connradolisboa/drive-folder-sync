import {
	EventRef,
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	normalizePath
} from "obsidian";
import { AutomationEngine } from "./automation/AutomationEngine";
import { lintAutomations } from "./automation/AutomationLinter";
import { GeminiClient } from "./ai/GeminiClient";
import { MistralClient } from "./ai/MistralClient";
import { analyzePdf } from "./ai/PdfPageHasher";
import { TranscriptionStore } from "./ai/TranscriptionStore";
import { CompanionNoteManager } from "./companion/CompanionNoteManager";
import {
	resolveCompanionDeletionPolicy,
	SourceDisconnectReason
} from "./companion/policies";
import { openTranscribePickerForFile, transcribeCurrentFile } from "./commands/TranscribeCurrentFile";
import { EventBus } from "./events/EventBus";
import { DRIVE_DOWNLOADER_WORKSPACE_EVENTS } from "./events/workspaceEvents";
import { importLegacySettings, migrateAutomationActions } from "./migration/legacy";
import { PdfEmbedFeatures } from "./pdfEmbed/PdfEmbedFeatures";
import { FileAutomationsSettingsTab } from "./settings/SettingsTab";
import { AutomationManifestStore, AutomationTrackingEntry } from "./tracking/AutomationManifestStore";
import { DEFAULT_SETTINGS, FileAutomationSettings } from "./types";
import { AutomationStatusModal } from "./ui/AutomationStatusModal";
import { AutomationDryRunModal } from "./ui/AutomationDryRunModal";

const LOG = "[FileAutomations]";
const LEGACY_SETTINGS_VERSION = 1;
const PIPELINE_DEBOUNCE_MS = 500;

export default class FileAutomationsPlugin extends Plugin {
	settings: FileAutomationSettings = cloneDefaults();
	manifestStore!: AutomationManifestStore;
	transcriptionStore!: TranscriptionStore;
	companionManager!: CompanionNoteManager;
	automationEngine!: AutomationEngine;

	private bus = new EventBus();
	private pdfEmbeds!: PdfEmbedFeatures;
	private pipelineTail: Promise<void> = Promise.resolve();
	private pending = new Map<string, number>();
	private deleteAfterTranscription = new Set<string>();
	private deleteGuardTimers = new Map<string, number>();
	private removalIntents = new Map<string, { reason: SourceDisconnectReason; timer: number }>();
	private watchersStarted = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.manifestStore = new AutomationManifestStore(this.app);
		this.transcriptionStore = new TranscriptionStore(this.app);
		await Promise.all([this.manifestStore.load(), this.transcriptionStore.load()]);
		const [manifestImported, transcriptionsImported] = await Promise.all([
			this.manifestStore.importLegacyOnce(),
			this.transcriptionStore.importLegacyOnce()
		]);

		this.companionManager = new CompanionNoteManager(this.app, this.settings);
		this.automationEngine = new AutomationEngine(this.app, this.settings, this.manifestStore, this.bus);
		this.register(this.bus.on("source-delete-start", ({ vaultPath }) => {
			this.armDeleteAfterTranscriptionGuard(vaultPath);
		}));
		this.register(this.bus.on("source-delete-complete", ({ vaultPath, sourceDeleted }) => {
			if (!sourceDeleted) this.consumeDeleteAfterTranscriptionGuard(vaultPath);
		}));
		this.pdfEmbeds = new PdfEmbedFeatures(this.settings);
		this.pdfEmbeds.refresh();

		this.addSettingTab(new FileAutomationsSettingsTab(this.app, this));
		this.addCommands();
		this.registerFileMenu();
		this.addRibbonIcon("workflow", "File automation status", () => this.openStatus());

		this.app.workspace.onLayoutReady(() => {
			this.startWatchers();
			void (async () => {
				await this.reconcileDownloaderRemovalEvents();
				await this.reconcileDownloaderDisconnects();
				await this.reconcileStartupWindow();
			})();
		});

		this.register(() => {
			for (const timer of this.pending.values()) window.clearTimeout(timer);
			for (const timer of this.deleteGuardTimers.values()) window.clearTimeout(timer);
			for (const intent of this.removalIntents.values()) window.clearTimeout(intent.timer);
			this.pending.clear();
			this.deleteGuardTimers.clear();
			this.removalIntents.clear();
			this.bus.clear();
			this.pdfEmbeds.unload();
		});

		if (manifestImported || transcriptionsImported) {
			console.log(`${LOG} Imported ${manifestImported} legacy tracking and ${transcriptionsImported} transcription records.`);
		}
	}

	onunload(): void {
		this.pdfEmbeds?.unload();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.companionManager?.updateSettings(this.settings);
		this.automationEngine?.updateSettings(this.settings);
		this.pdfEmbeds?.updateSettings(this.settings);
		const issues = lintAutomations(this.app, this.settings.automations, {
			mistralConfigured: !!this.settings.mistralApiKey
		});
		if (issues.length) console.warn(`${LOG} Automation configuration issues:`, issues);
	}

	async runAutomation(automationId: string, dryRun = false): Promise<void> {
		const automation = this.settings.automations.find((item) => item.id === automationId);
		if (!automation) {
			new Notice("Automation no longer exists.");
			return;
		}
		await this.sanitizeTrackedCompanions();
		const result = await this.automationEngine.runForAllMatchingFiles(automationId, { dryRun });
		if (dryRun) {
			new AutomationDryRunModal(this.app, automation.name, result.preview ?? []).open();
			return;
		}
		new Notice(`${automation.name}: ${result.ran} ran, ${result.skipped} skipped, ${result.errors} failed.`);
	}

	private async sanitizeTrackedCompanions(): Promise<void> {
		let changed = false;
		for (const [, entry] of this.manifestStore.entries()) {
			if (!entry.companionPath) continue;
			const note = this.app.vault.getAbstractFileByPath(entry.companionPath);
			if (!(note instanceof TFile) || !this.companionManager.ownsSource(note, [entry.vaultPath])) {
				entry.companionPath = null;
				entry.companionMtime = undefined;
				changed = true;
			}
		}
		if (changed) await this.manifestStore.save();
	}

	private async loadSettings(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		this.settings = {
			...cloneDefaults(),
			...raw,
			periodicNotesPaths: {
				...DEFAULT_SETTINGS.periodicNotesPaths,
				...((raw.periodicNotesPaths as Partial<FileAutomationSettings["periodicNotesPaths"]> | undefined) ?? {})
			},
			automations: Array.isArray(raw.automations) ? raw.automations as FileAutomationSettings["automations"] : [],
			companionRules: Array.isArray(raw.companionRules) ? raw.companionRules as FileAutomationSettings["companionRules"] : []
		};

		let changed = migrateAutomationActions(this.settings.automations) > 0;
		if (this.settings.legacyImportVersion < LEGACY_SETTINGS_VERSION) {
			const legacy = await this.readLegacySettings();
			if (legacy.status === "success") {
				const imported = importLegacySettings(this.settings, legacy.data, raw);
				console.log(`${LOG} Legacy settings import:`, imported);
			}
			if (legacy.status !== "failed") {
				this.settings.legacyImportVersion = LEGACY_SETTINGS_VERSION;
				changed = true;
			}
		}
		this.normalizeSettings();
		if (changed) await this.saveData(this.settings);
	}

	private normalizeSettings(): void {
		this.settings.periodicNotesPaths = {
			...DEFAULT_SETTINGS.periodicNotesPaths,
			...(this.settings.periodicNotesPaths ?? {})
		};
		this.settings.companionRules = this.settings.companionRules.filter(isRecordValue);
		this.settings.automations = this.settings.automations.filter((value) =>
			isRecordValue(value) && isRecordValue(value.action) && typeof value.action.type === "string"
		);
		const usedRuleIds = new Set<string>();
		for (const [index, rule] of this.settings.companionRules.entries()) {
			if (!rule.id || usedRuleIds.has(rule.id)) rule.id = `rule-${index}-${Date.now()}`;
			usedRuleIds.add(rule.id);
			rule.label ||= `Rule ${index + 1}`;
			rule.triggerFolderPath = normalizePath(
				typeof rule.triggerFolderPath === "string" ? rule.triggerFolderPath : ""
			);
			rule.excludedSubfolders ??= [];
		}
		const usedAutomationIds = new Set<string>();
		for (const [index, automation] of this.settings.automations.entries()) {
			if (!automation.id || usedAutomationIds.has(automation.id)) automation.id = `automation-${index}-${Date.now()}`;
			usedAutomationIds.add(automation.id);
			automation.name ||= `Automation ${index + 1}`;
			automation.triggerFolderPath = normalizePath(
				typeof automation.triggerFolderPath === "string" ? automation.triggerFolderPath : ""
			);
			automation.excludedSubfolders ??= [];
			automation.action.insertPosition ??= "bottom";
			automation.action.dailyNoteNamePattern ??= "YYYY-MM-DD";
		}
	}

	private async readLegacySettings(): Promise<
		| { status: "absent" }
		| { status: "success"; data: Record<string, unknown> }
		| { status: "failed" }
	> {
		const configDir = this.app.vault.configDir || ".obsidian";
		const path = normalizePath(`${configDir}/plugins/drive-folder-sync/data.json`);
		if (!(await this.app.vault.adapter.exists(path))) return { status: "absent" };
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(path));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Legacy settings root is not an object.");
			}
			return { status: "success", data: parsed as Record<string, unknown> };
		} catch (error) {
			console.error(`${LOG} Legacy settings were left untouched but could not be imported:`, error);
			return { status: "failed" };
		}
	}

	private addCommands(): void {
		this.addCommand({
			id: "transcribe-current-pdf",
			name: "Transcribe current PDF",
			callback: () => void transcribeCurrentFile(this)
		});
		this.addCommand({
			id: "open-automation-status",
			name: "Open automation status",
			callback: () => this.openStatus()
		});
		this.addCommand({
			id: "process-current-pdf",
			name: "Process current PDF now",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return false;
				if (!checking) this.schedule(file.path, true);
				return true;
			}
		});
		for (const automation of this.settings.automations) {
			this.addCommand({
				id: `run-${automation.id}`,
				name: `Run automation: ${automation.name}`,
				callback: () => void this.runAutomation(automation.id)
			});
		}
	}

	private registerFileMenu(): void {
		this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
			if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return;
			menu.addItem((item) => item
				.setTitle("Transcribe PDF…")
				.setIcon("scan-text")
				.onClick(() => openTranscribePickerForFile(this.app, this, file)));
			menu.addItem((item) => item
				.setTitle("Run file automations now")
				.setIcon("workflow")
				.onClick(() => this.schedule(file.path, true)));
		}));
	}

	private openStatus(): void {
		new AutomationStatusModal(this.app, this.manifestStore, this.transcriptionStore).open();
	}

	private startWatchers(): void {
		if (this.watchersStarted) return;
		this.watchersStarted = true;
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (isPdf(file)) this.schedule(file.path);
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (isPdf(file)) this.schedule(file.path);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			void this.handleRename(file, oldPath);
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			void this.handleDelete(file);
		}));

		// Optional handshake emitted by Drive Downloader when its "keep PDF"
		// policy disconnects a source without causing a vault delete event.
		const workspace = this.app.workspace as unknown as {
			on(name: string, callback: (payload: unknown) => void): EventRef;
		};
		this.registerEvent(workspace.on(DRIVE_DOWNLOADER_WORKSPACE_EVENTS.sourceDisconnected, (payload) => {
			const parsed = parseDownloaderPayload(payload);
			if (parsed) void this.handleSourceDisconnected(parsed.vaultPath, parsed.reason, parsed.at);
		}));
		// Synchronous intent is consumed by the immediately following vault
		// rename/delete, preserving Drive-archive-specific companion behavior.
		this.registerEvent(workspace.on(DRIVE_DOWNLOADER_WORKSPACE_EVENTS.sourceRemovalIntent, (payload) => {
			const parsed = parseDownloaderPayload(payload);
			if (parsed) this.recordRemovalIntent(parsed.vaultPath, parsed.reason);
		}));
		this.registerEvent(workspace.on(DRIVE_DOWNLOADER_WORKSPACE_EVENTS.sourceReconnected, (payload) => {
			const parsed = parseDownloaderPayload(payload);
			if (parsed) void this.handleSourceReconnected(parsed.vaultPath);
		}));
	}

	private async reconcileDownloaderDisconnects(): Promise<void> {
		const configDir = this.app.vault.configDir || ".obsidian";
		const manifestPath = normalizePath(`${configDir}/drive-sync-manifest.json`);
		if (!(await this.app.vault.adapter.exists(manifestPath))) return;
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(manifestPath)) as {
				entries?: Record<string, Record<string, unknown>>;
				[key: string]: unknown;
			};
			const rawEntries = parsed.entries && typeof parsed.entries === "object"
				? parsed.entries
				: parsed as Record<string, Record<string, unknown>>;
			const disconnected = new Set<string>();
			for (const raw of Object.values(rawEntries)) {
				if (
					typeof raw?.vaultPath !== "string" ||
					typeof raw?.sourceDisconnectedAt !== "string"
				) continue;
				const path = normalizePath(raw.vaultPath);
				disconnected.add(path);
				await this.handleSourceDisconnected(
					path,
					raw.sourceDisconnectedReason === "drive-archived" ? "drive-archived" : "drive-removed",
					raw.sourceDisconnectedAt
				);
			}
			// A previously disconnected source absent from the downloader's durable
			// set is active again. This also repairs same-version reconnects.
			for (const [, entry] of this.manifestStore.entries()) {
				if (entry.sourceDisconnectedAt && !disconnected.has(entry.vaultPath)) {
					await this.handleSourceReconnected(entry.vaultPath);
				}
			}
		} catch (error) {
			console.error(`${LOG} Could not reconcile downloader disconnections:`, error);
		}
	}

	private async reconcileDownloaderRemovalEvents(): Promise<void> {
		const configDir = this.app.vault.configDir || ".obsidian";
		const journalPath = normalizePath(`${configDir}/drive-downloader-source-events.json`);
		if (!(await this.app.vault.adapter.exists(journalPath))) return;
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(journalPath)) as {
				version?: unknown;
				events?: unknown;
			};
			if (parsed.version !== 1 || !Array.isArray(parsed.events)) return;
			for (const raw of parsed.events) {
				const event = parseRemovalJournalEvent(raw);
				if (!event || this.manifestStore.hasProcessedSourceEvent(event.id)) continue;
				const oldFile = this.app.vault.getAbstractFileByPath(event.vaultPath);
				const newFile = event.newVaultPath
					? this.app.vault.getAbstractFileByPath(event.newVaultPath)
					: null;
				// The downloader journals before mutation. Never apply an intent
				// whose corresponding delete/archive did not actually complete.
				if (event.action === "delete" && oldFile instanceof TFile) continue;
				if (
					event.action === "archive" &&
					(oldFile instanceof TFile || !(newFile instanceof TFile))
				) continue;

				if (event.action === "delete") {
					const entry = this.manifestStore.get(event.vaultPath);
					if (entry) {
						entry.companionPath ??= this.companionManager.findCompanionByProperty(event.vaultPath);
						const rule = entry.ruleId
							? this.settings.companionRules.find((candidate) => candidate.id === entry.ruleId)
							: this.companionManager.findRule(event.vaultPath) ?? undefined;
						await this.applyCompanionPolicy(entry, rule, event.reason, [event.vaultPath]);
						this.manifestStore.delete(event.vaultPath);
						this.transcriptionStore.delete(event.vaultPath);
					}
				} else if (event.newVaultPath && newFile instanceof TFile) {
					const oldEntry = this.manifestStore.get(event.vaultPath);
					const currentEntry = this.manifestStore.get(event.newVaultPath);
					if (!(
						!oldEntry &&
						currentEntry?.sourceDisconnectedReason === event.reason &&
						currentEntry.disconnectedSourceVersion === versionOf(newFile)
					)) {
						const rule = oldEntry?.ruleId
							? this.settings.companionRules.find((candidate) => candidate.id === oldEntry.ruleId)
							: this.companionManager.findRule(event.vaultPath) ?? undefined;
						const entry = oldEntry
							? this.manifestStore.renameSource(event.vaultPath, event.newVaultPath)!
							: currentEntry ?? this.manifestStore.ensure(event.newVaultPath, versionOf(newFile));
						entry.companionPath ??= this.companionManager.findCompanionByProperty(event.vaultPath);
						this.transcriptionStore.rename(event.vaultPath, event.newVaultPath);
						await this.disconnectEntry(
							entry,
							newFile,
							event.reason,
							event.at,
							[event.vaultPath, event.newVaultPath],
							rule
						);
					}
				}
				this.manifestStore.markSourceEventProcessed(event.id, event.at);
				await Promise.all([this.manifestStore.save(), this.transcriptionStore.save()]);
			}
		} catch (error) {
			console.error(`${LOG} Could not replay downloader removal events:`, error);
		}
	}

	private async reconcileStartupWindow(): Promise<void> {
		await this.sanitizeTrackedCompanions();
		const now = Date.now();
		let trackingChanged = false;
		for (const [, entry] of this.manifestStore.entries()) {
			const file = this.app.vault.getAbstractFileByPath(entry.vaultPath);
			const rule = this.companionManager.findRule(entry.vaultPath);
			if (rule && !entry.ruleId) {
				entry.ruleId = rule.id;
				trackingChanged = true;
			} else if (!rule && entry.ruleId && !entry.sourceDisconnectedAt) {
				entry.ruleId = null;
				trackingChanged = true;
			}
			if (isPdf(file) && entry.sourceVersion !== versionOf(file)) this.schedule(file.path);
		}
		if (trackingChanged) await this.manifestStore.save();
		// Catch files created by another plugin during layout initialization without
		// treating first install as authorization for a vault-wide bulk run.
		for (const file of this.app.vault.getFiles()) {
			if (
				file.extension.toLowerCase() === "pdf" &&
				!this.manifestStore.get(file.path) &&
				now - file.stat.mtime < 15_000
			) this.schedule(file.path);
		}
	}

	private schedule(vaultPath: string, force = false): void {
		const path = normalizePath(vaultPath);
		const existing = this.pending.get(path);
		if (existing !== undefined) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			this.pending.delete(path);
			this.pipelineTail = this.pipelineTail
				.then(() => this.processPdf(path, force))
				.catch((error) => {
					console.error(`${LOG} Pipeline failed for ${path}:`, error);
					this.bus.emit("pipeline-error", {
						vaultPath: path,
						error: error instanceof Error ? error.message : String(error)
					});
				});
		}, force ? 0 : PIPELINE_DEBOUNCE_MS);
		this.pending.set(path, timer);
	}

	private async processPdf(vaultPath: string, force: boolean): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!isPdf(file)) return;
		const rule = this.companionManager.findRule(file.path);
		const hasAutomations = this.automationEngine.hasMatchingAutomation(file.path);
		const existing = this.manifestStore.get(file.path);
		if (!rule && !hasAutomations && !existing) return;
		if (rule && existing && !existing.ruleId) {
			existing.ruleId = rule.id;
			await this.manifestStore.save();
		}
		if (existing?.companionPath) {
			const trackedCompanion = this.app.vault.getAbstractFileByPath(existing.companionPath);
			if (
				!(trackedCompanion instanceof TFile) ||
				!this.companionManager.ownsSource(trackedCompanion, [file.path])
			) {
				console.warn(`${LOG} Detached stale/unowned companion tracking "${existing.companionPath}" from "${file.path}".`);
				existing.companionPath = null;
				existing.companionMtime = undefined;
				await this.manifestStore.save();
			}
		}

		const sourceVersion = versionOf(file);
		if (
			existing?.sourceDisconnectedAt &&
			(force || existing.disconnectedSourceVersion !== sourceVersion)
		) {
			this.clearDisconnectedState(existing);
			existing.sourceVersion = "";
			await this.manifestStore.save();
		}
		if (
			!force &&
			existing?.sourceDisconnectedAt &&
			existing.detachedCompanionPath !== undefined &&
			existing.disconnectedSourceVersion === sourceVersion
		) {
			// Delete/archive policy intentionally detached the companion. An
			// ordinary same-version event must not immediately recreate it.
			return;
		}
		const companionHealthy = !rule || (
			!!existing?.companionPath &&
			this.app.vault.getAbstractFileByPath(existing.companionPath) instanceof TFile
		);
		const automationsHealthy = this.automationEngine.matchingAutomationIds(file.path)
			.every((automationId) => {
				const run = this.manifestStore.getAutomationRun(file.path, automationId);
				return !!run && run.sourceVersion === sourceVersion && run.result !== "error";
			});
		const transcription = this.transcriptionStore.get(file.path);
		const transcriptionHealthy =
			!this.settings.geminiEnabled ||
			existing?.transcriptionDisabled === true ||
			transcription?.lastSourceVersion === sourceVersion;
		if (
			!force &&
			existing?.sourceVersion === sourceVersion &&
			companionHealthy &&
			automationsHealthy &&
			transcriptionHealthy
		) return;

		this.bus.emit("pipeline-start", { vaultPath: file.path });
		const entry = this.manifestStore.ensure(file.path);
		let transcriptionText: string | undefined;
		let pdfInfo: Awaited<ReturnType<typeof analyzePdf>> | null = null;
		let pdfBytes: ArrayBuffer | null = null;
		let transcriptionRecorded = false;
		if (this.settings.geminiEnabled && !entry.transcriptionDisabled) {
			const prior = this.transcriptionStore.get(file.path);
			if (prior?.lastSourceVersion !== sourceVersion) {
				try {
					pdfBytes = await this.app.vault.readBinary(file);
					transcriptionText = await this.transcribe(pdfBytes);
					pdfInfo = await analyzePdf(pdfBytes);
				} catch (error) {
					console.error(`${LOG} Automatic transcription failed for ${file.path}:`, error);
				}
			}
		}
		const priorTranscription = this.transcriptionStore.get(file.path);
		if (priorTranscription) {
			if (!pdfInfo && priorTranscription.currentSourceVersion !== sourceVersion) {
				try {
					pdfBytes ??= await this.app.vault.readBinary(file);
					pdfInfo = await analyzePdf(pdfBytes);
				} catch (error) {
					console.error(`${LOG} Could not refresh PDF hash/page status for ${file.path}:`, error);
				}
			}
			this.transcriptionStore.updateCurrentState(
				file.path,
				sourceVersion,
				pdfInfo?.pageCount,
				pdfInfo?.hash
			);
			await this.transcriptionStore.save();
		}

		let companionPath = entry.companionPath ?? this.companionManager.findCompanionByProperty(file.path);
		if (rule) {
			const result = await this.companionManager.ensure(
				file,
				rule,
				companionPath,
				transcriptionText,
				entry.companionMtime,
				(candidate) => {
					const owner = this.manifestStore.findByCompanionPath(candidate);
					return !!owner && owner[0] !== file.path;
				}
			);
			companionPath = result.path;
			const companion = this.app.vault.getAbstractFileByPath(result.path);
			entry.companionPath = result.path;
			entry.detachedCompanionPath = undefined;
			entry.companionMtime = companion instanceof TFile ? companion.stat.mtime : undefined;
			entry.ruleId = rule.id;
			this.bus.emit("companion-updated", { vaultPath: file.path, companionPath: result.path });
				if (transcriptionText && pdfInfo && !result.skipped) {
				this.transcriptionStore.recordTranscription(
					file.path,
					pdfInfo.hash,
					pdfInfo.pageCount,
					sourceVersion,
					{ type: "companion", path: result.path, transcribedAt: new Date().toISOString() }
				);
				await this.transcriptionStore.save();
				transcriptionRecorded = true;
			}
		} else if (entry.ruleId) {
			if (entry.companionPath) {
				const oldRule = this.settings.companionRules.find((candidate) => candidate.id === entry.ruleId);
				const policy = resolveCompanionDeletionPolicy(
					oldRule,
					this.settings.companionOnSourceDelete,
					"drive-removed"
				);
				const resultPath = await this.applyCompanionPolicy(entry, oldRule);
				if (policy === "archive") {
					entry.detachedCompanionPath = resultPath;
					entry.companionPath = null;
				} else {
					entry.companionPath = resultPath;
					entry.detachedCompanionPath = undefined;
				}
				entry.companionMtime = undefined;
				companionPath = entry.companionPath ?? null;
			}
			entry.ruleId = null;
		}

		const run = await this.automationEngine.runForFile({
			vaultPath: file.path,
			companionPath,
			sourceCreatedTime: new Date(file.stat.ctime).toISOString(),
			sourceVersion,
			transcription: transcriptionText,
			force
		});
		if (
			transcriptionText &&
			pdfInfo &&
			run.transcriptionWritten &&
			!transcriptionRecorded
		) {
			const destination = entry.companionPath
				? {
					type: "companion" as const,
					path: entry.companionPath,
					transcribedAt: new Date().toISOString()
				}
				: undefined;
			this.transcriptionStore.recordTranscription(
				file.path,
				pdfInfo.hash,
				pdfInfo.pageCount,
				sourceVersion,
				destination
			);
			await this.transcriptionStore.save();
		}

		entry.sourceVersion = sourceVersion;
		await this.manifestStore.save();
		this.bus.emit("pipeline-complete", { vaultPath: file.path, sourceDeleted: run.sourceDeleted });
		if (run.errors > 0) {
			console.warn(`${LOG} ${run.errors} automation(s) failed for ${file.path}; their source-version history remains retryable.`);
		}
	}

	private async transcribe(bytes: ArrayBuffer): Promise<string> {
		if (this.settings.transcriptionProvider === "mistral") {
			if (!this.settings.mistralApiKey) throw new Error("Mistral API key is not configured.");
			return new MistralClient(this.settings.mistralApiKey).transcribePdf(bytes);
		}
		if (!this.settings.geminiApiKey) throw new Error("Gemini API key is not configured.");
		return new GeminiClient(
			this.settings.geminiApiKey,
			this.settings.geminiModel,
			this.settings.geminiPrompt
		).transcribePdf(bytes);
	}

	private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		const old = normalizePath(oldPath);
		const removalIntent = this.consumeRemovalIntent(old);
		const timer = this.pending.get(old);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.pending.delete(old);
		}
		if (file instanceof TFile && file.extension.toLowerCase() === "md") {
			if (this.manifestStore.renameCompanion(old, file.path)) await this.manifestStore.save();
			return;
		}
		if (!isPdf(file)) return;

		const entry = this.manifestStore.get(old);
		this.transcriptionStore.rename(old, file.path);
		if (!entry) {
			if (removalIntent) {
				const created = this.manifestStore.ensure(file.path, versionOf(file));
				await this.disconnectEntry(
					created,
					file,
					removalIntent,
					undefined,
					[old, file.path]
				);
				await this.manifestStore.save();
			}
			await this.transcriptionStore.save();
			if (!removalIntent) this.schedule(file.path);
			return;
		}

		const oldRule = entry.ruleId
			? this.settings.companionRules.find((rule) => rule.id === entry.ruleId)
			: this.companionManager.findRule(old) ?? undefined;
		const moved = this.manifestStore.renameSource(old, file.path) as AutomationTrackingEntry;
		if (removalIntent) {
			await this.disconnectEntry(
				moved,
				file,
				removalIntent,
				undefined,
				[old, file.path],
				oldRule
			);
			await Promise.all([this.manifestStore.save(), this.transcriptionStore.save()]);
			return;
		}
		const newRule = this.companionManager.findRule(file.path);
		if (moved.companionPath && newRule) {
			const desired = this.companionManager.companionPath(newRule, file.path);
			const renamed = await this.companionManager.rename(moved.companionPath, desired, file.path, old);
			moved.companionPath = renamed.path;
			moved.ruleId = newRule.id;
			const note = moved.companionPath
				? this.app.vault.getAbstractFileByPath(moved.companionPath)
				: null;
			moved.companionMtime = note instanceof TFile ? note.stat.mtime : undefined;
		} else if (moved.companionPath && !newRule) {
			const policy = resolveCompanionDeletionPolicy(
				oldRule,
				this.settings.companionOnSourceDelete,
				"drive-removed"
			);
			const resultPath = await this.applyCompanionPolicy(
				moved,
				oldRule,
				"drive-removed",
				[old, file.path]
			);
			if (resultPath) {
				await this.companionManager.rekeySourceOwnership(
					resultPath,
					file.path,
					[old, file.path]
				);
			}
			if (policy === "archive") {
				moved.detachedCompanionPath = resultPath;
				moved.companionPath = null;
			} else {
				moved.companionPath = resultPath;
				moved.detachedCompanionPath = undefined;
			}
			moved.companionMtime = undefined;
			moved.ruleId = null;
		} else {
			moved.ruleId = newRule?.id ?? null;
		}
		moved.sourceVersion = "";
		await Promise.all([this.manifestStore.save(), this.transcriptionStore.save()]);
		this.schedule(file.path);
	}

	private async handleDelete(file: TAbstractFile): Promise<void> {
		if (file instanceof TFile && file.extension.toLowerCase() === "md") {
			const found = this.manifestStore.findByCompanionPath(file.path);
			if (found) {
				found[1].companionPath = null;
				found[1].companionMtime = undefined;
				await this.manifestStore.save();
			}
			return;
		}
		if (!isPdf(file)) return;
		const removalIntent = this.consumeRemovalIntent(file.path);
		if (this.deleteAfterTranscription.has(file.path)) {
			// The engine has just written the transcription into the companion.
			// Retain both that note and its tracking record.
			this.consumeDeleteAfterTranscriptionGuard(file.path);
			return;
		}
		const entry = this.manifestStore.get(file.path);
		if (!entry) return;
		const rule = entry.ruleId
			? this.settings.companionRules.find((candidate) => candidate.id === entry.ruleId)
			: this.companionManager.findRule(file.path) ?? undefined;
		await this.applyCompanionPolicy(entry, rule, removalIntent ?? "drive-removed");
		this.manifestStore.delete(file.path);
		this.transcriptionStore.delete(file.path);
		await Promise.all([this.manifestStore.save(), this.transcriptionStore.save()]);
	}

	private async handleSourceDisconnected(
		vaultPath: string,
		reason: SourceDisconnectReason,
		at?: string
	): Promise<void> {
		const path = normalizePath(vaultPath);
		const file = this.app.vault.getAbstractFileByPath(path);
		const entry = this.manifestStore.ensure(path, isPdf(file) ? versionOf(file) : "");
		entry.companionPath ??= this.companionManager.findCompanionByProperty(path);
		await this.disconnectEntry(entry, isPdf(file) ? file : null, reason, at, [path]);
		await this.manifestStore.save();
	}

	private async disconnectEntry(
		entry: AutomationTrackingEntry,
		file: TFile | null,
		reason: SourceDisconnectReason,
		at?: string,
		ownershipPaths: string[] = [entry.vaultPath],
		knownRule?: FileAutomationSettings["companionRules"][number]
	): Promise<void> {
		const currentVersion = file ? versionOf(file) : entry.sourceVersion;
		if (
			(at && entry.sourceDisconnectedAt === at) ||
			(!at &&
				entry.sourceDisconnectedReason === reason &&
				entry.disconnectedSourceVersion === currentVersion)
		) return;
		const rule = knownRule ??
			(entry.ruleId
				? this.settings.companionRules.find((candidate) => candidate.id === entry.ruleId)
				: this.companionManager.findRule(entry.vaultPath) ?? undefined);
		if (rule && !entry.ruleId) entry.ruleId = rule.id;
		const policy = resolveCompanionDeletionPolicy(
			rule,
			this.settings.companionOnSourceDelete,
			reason
		);
		const resultingPath = entry.companionPath
			? await this.applyCompanionPolicy(entry, rule, reason, ownershipPaths)
			: null;
		if (resultingPath) {
			await this.companionManager.rekeySourceOwnership(
				resultingPath,
				entry.vaultPath,
				ownershipPaths
			);
		}
		if (policy === "keep") {
			entry.companionPath = resultingPath;
			entry.detachedCompanionPath = undefined;
			const note = resultingPath ? this.app.vault.getAbstractFileByPath(resultingPath) : null;
			entry.companionMtime = note instanceof TFile ? note.stat.mtime : undefined;
		} else {
			entry.detachedCompanionPath = resultingPath;
			entry.companionPath = null;
			entry.companionMtime = undefined;
		}
		entry.sourceDisconnectedAt = at ?? new Date().toISOString();
		entry.sourceDisconnectedReason = reason;
		entry.disconnectedSourceVersion = currentVersion;
		if (!entry.sourceVersion) entry.sourceVersion = currentVersion;
	}

	private async handleSourceReconnected(vaultPath: string): Promise<void> {
		const entry = this.manifestStore.get(vaultPath);
		if (!entry?.sourceDisconnectedAt) return;
		this.clearDisconnectedState(entry);
		entry.sourceVersion = "";
		await this.manifestStore.save();
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (isPdf(file)) this.schedule(file.path);
	}

	private async applyCompanionPolicy(
		entry: AutomationTrackingEntry,
		rule?: FileAutomationSettings["companionRules"][number],
		reason: SourceDisconnectReason = "drive-removed",
		ownershipPaths: string[] = [entry.vaultPath]
	): Promise<string | null> {
		if (!entry.companionPath) return null;
		const result = await this.companionManager.applySourceDeletion(
			entry.companionPath,
			resolveCompanionDeletionPolicy(rule, this.settings.companionOnSourceDelete, reason),
			rule?.archiveFolder ?? this.settings.companionArchiveFolder,
			ownershipPaths
		);
		return result.path;
	}

	private armDeleteAfterTranscriptionGuard(vaultPath: string): void {
		this.consumeDeleteAfterTranscriptionGuard(vaultPath);
		this.deleteAfterTranscription.add(vaultPath);
		const timer = window.setTimeout(() => {
			this.deleteAfterTranscription.delete(vaultPath);
			this.deleteGuardTimers.delete(vaultPath);
		}, 15_000);
		this.deleteGuardTimers.set(vaultPath, timer);
	}

	private consumeDeleteAfterTranscriptionGuard(vaultPath: string): void {
		this.deleteAfterTranscription.delete(vaultPath);
		const timer = this.deleteGuardTimers.get(vaultPath);
		if (timer !== undefined) window.clearTimeout(timer);
		this.deleteGuardTimers.delete(vaultPath);
	}

	private recordRemovalIntent(vaultPath: string, reason: SourceDisconnectReason): void {
		const path = normalizePath(vaultPath);
		this.consumeRemovalIntent(path);
		const timer = window.setTimeout(() => this.removalIntents.delete(path), 15_000);
		this.removalIntents.set(path, { reason, timer });
	}

	private consumeRemovalIntent(vaultPath: string): SourceDisconnectReason | undefined {
		const path = normalizePath(vaultPath);
		const intent = this.removalIntents.get(path);
		if (!intent) return;
		window.clearTimeout(intent.timer);
		this.removalIntents.delete(path);
		return intent.reason;
	}

	private clearDisconnectedState(entry: AutomationTrackingEntry): void {
		entry.sourceDisconnectedAt = undefined;
		entry.sourceDisconnectedReason = undefined;
		entry.disconnectedSourceVersion = undefined;
		if (entry.detachedCompanionPath !== undefined) {
			entry.companionPath = null;
			entry.companionMtime = undefined;
		}
		entry.detachedCompanionPath = undefined;
	}

}

function cloneDefaults(): FileAutomationSettings {
	return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as FileAutomationSettings;
}

function isPdf(file: TAbstractFile | null): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

function versionOf(file: TFile): string {
	return `${file.stat.mtime}:${file.stat.size}`;
}

function parseDownloaderPayload(payload: unknown): {
	vaultPath: string;
	reason: SourceDisconnectReason;
	at?: string;
} | null {
	if (typeof payload === "string") {
		return { vaultPath: normalizePath(payload), reason: "drive-removed" };
	}
	if (!payload || typeof payload !== "object") return null;
	const value = payload as { vaultPath?: unknown; reason?: unknown; at?: unknown; sourceDisconnectedAt?: unknown };
	if (typeof value.vaultPath !== "string") return null;
	return {
		vaultPath: normalizePath(value.vaultPath),
		reason: value.reason === "drive-archived" ? "drive-archived" : "drive-removed",
		at: typeof value.at === "string"
			? value.at
			: typeof value.sourceDisconnectedAt === "string" ? value.sourceDisconnectedAt : undefined
	};
}

interface RemovalJournalEvent {
	id: string;
	vaultPath: string;
	newVaultPath?: string;
	reason: SourceDisconnectReason;
	action: "delete" | "archive";
	at: string;
}

function parseRemovalJournalEvent(value: unknown): RemovalJournalEvent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const event = value as Record<string, unknown>;
	if (
		typeof event.id !== "string" ||
		typeof event.vaultPath !== "string" ||
		typeof event.at !== "string" ||
		(event.reason !== "drive-removed" && event.reason !== "drive-archived") ||
		(event.action !== "delete" && event.action !== "archive")
	) return null;
	return {
		id: event.id,
		vaultPath: normalizePath(event.vaultPath),
		newVaultPath: typeof event.newVaultPath === "string"
			? normalizePath(event.newVaultPath)
			: undefined,
		reason: event.reason,
		action: event.action,
		at: event.at
	};
}

function isRecordValue(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
