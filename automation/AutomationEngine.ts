import { App, getAllTags, TFile } from "obsidian";
import { Automation, AutomationAction, AutomationRunRecord, PeriodicNotesPaths, PluginSettings } from "../types";
import type { SyncManifestStore } from "../sync/SyncManifest";
import type { EventBus } from "../events/EventBus";
import { MistralClient } from "../ai/MistralClient";

const LOG = "[DriveSync/Automation]";

export interface RunForFileOptions {
	vaultPath: string;
	companionPath?: string | null;
	driveCreatedTime?: string;
	transcription?: string;
	driveFileId?: string;
	driveModifiedTime?: string;
	force?: boolean;
	/** When true, skip the trigger-folder filter and consider every active automation a candidate. */
	ignoreFolderTrigger?: boolean;
}

export interface AdHocRunResult {
	ran: boolean;
	skippedReason?: string;
	error?: string;
	outputs?: string[];
}

// Obsidian bundles moment.js as a global
declare const moment: (date: string, format: string) => { format(pattern: string): string };

type PeriodicPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export class AutomationEngine {
	constructor(
		private app: App,
		private settings: PluginSettings,
		private manifest?: SyncManifestStore,
		private bus?: EventBus
	) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	setBus(bus: EventBus): void {
		this.bus = bus;
	}

	private emitRun(vaultPath: string, automation: Automation, result: "success" | "skipped" | "error", error?: string): void {
		this.bus?.emit("automation-run", {
			vaultPath,
			automationId: automation.id,
			automationName: automation.name,
			result,
			...(error ? { error } : {}),
		});
	}

	updateManifest(manifest: SyncManifestStore): void {
		this.manifest = manifest;
	}

	countMatchingFiles(automationId: string): number {
		const automation = this.settings.automations.find((a) => a.id === automationId);
		if (!automation || !this.manifest) return 0;
		return this.manifest
			.entries()
			.filter(([, entry]) => this.matchesTrigger(automation, entry.vaultPath))
			.length;
	}

	async runForAllMatchingFiles(
		automationId: string,
		opts: { force?: boolean; dryRun?: boolean } = {}
	): Promise<{ matched: number; ran: number; skipped: number; errors: number; preview?: Array<{ vaultPath: string; willRun: boolean; skipReason?: string }> }> {
		const automation = this.settings.automations.find((a) => a.id === automationId);
		if (!automation) return { matched: 0, ran: 0, skipped: 0, errors: 0 };

		const entries = this.manifest?.entries() ?? [];
		let matched = 0, ran = 0, skipped = 0, errors = 0;
		const preview: Array<{ vaultPath: string; willRun: boolean; skipReason?: string }> = [];

		for (const [driveFileId, entry] of entries) {
			if (!this.matchesTrigger(automation, entry.vaultPath)) continue;
			matched++;

			const willRun = this.shouldRunAutomation(
				automation.id,
				driveFileId,
				entry.driveModifiedTime,
				opts.force ?? false
			);

			if (opts.dryRun) {
				if (willRun) {
					ran++;
					preview.push({ vaultPath: entry.vaultPath, willRun: true });
				} else {
					skipped++;
					preview.push({ vaultPath: entry.vaultPath, willRun: false, skipReason: "already ran for this Drive version" });
				}
				continue;
			}

			if (!willRun) {
				skipped++;
				this.manifest?.recordAutomationRun(driveFileId, automation.id, {
					lastRunAt: new Date().toISOString(),
					lastRunDriveModifiedTime: entry.driveModifiedTime ?? "",
					result: "skipped",
				});
				continue;
			}

			console.log(`${LOG} runForAllMatchingFiles: running "${automation.name}" for "${entry.vaultPath}"`);
			try {
				await this.runAction(
					automation.action,
					entry.vaultPath,
					entry.companionPath,
					entry.driveCreatedTime,
					undefined
				);
				this.manifest?.recordAutomationRun(driveFileId, automation.id, {
					lastRunAt: new Date().toISOString(),
					lastRunDriveModifiedTime: entry.driveModifiedTime ?? "",
					result: "success",
				});
				ran++;
			} catch (e) {
				console.error(
					`${LOG} runForAllMatchingFiles: "${automation.name}" failed for "${entry.vaultPath}":`,
					e
				);
				this.manifest?.recordAutomationRun(driveFileId, automation.id, {
					lastRunAt: new Date().toISOString(),
					lastRunDriveModifiedTime: entry.driveModifiedTime ?? "",
					result: "error",
					errorMessage: e instanceof Error ? e.message : String(e),
				});
				errors++;
			}
		}

		if (!opts.dryRun && (ran > 0 || errors > 0)) {
			await this.manifest?.save();
		}

		return { matched, ran, skipped, errors, ...(opts.dryRun ? { preview } : {}) };
	}

	async runForFile(opts: RunForFileOptions): Promise<void> {
		const {
			vaultPath,
			companionPath,
			driveCreatedTime,
			transcription,
			driveFileId,
			driveModifiedTime,
			force = false,
			ignoreFolderTrigger = false,
		} = opts;

		const matching = this.settings.automations.filter(
			(a) => a.enabled && (ignoreFolderTrigger || this.matchesTrigger(a, vaultPath))
		);

		if (matching.length === 0) return;

		// 6.2: Read skip flags from companion frontmatter
		let skipAll = false;
		let skipList: string[] = [];
		if (companionPath) {
			const companionFile = this.app.vault.getAbstractFileByPath(companionPath);
			if (companionFile instanceof TFile) {
				const cache = this.app.metadataCache.getFileCache(companionFile);
				const fm = cache?.frontmatter;
				if (fm?.["drive-sync-skip-all"] === true) skipAll = true;
				if (Array.isArray(fm?.["drive-sync-skip-automations"])) {
					skipList = fm["drive-sync-skip-automations"] as string[];
				}
			}
		}

		if (skipAll) {
			console.log(`${LOG} Skipping all automations for "${vaultPath}" — drive-sync-skip-all: true`);
			return;
		}

		for (const automation of matching) {
			if (skipList.includes(automation.id)) {
				console.log(`${LOG} Skipping automation "${automation.name}" for "${vaultPath}" — in drive-sync-skip-automations`);
				continue;
			}

			const shouldRun = this.shouldRunAutomation(automation.id, driveFileId, driveModifiedTime, force);

			if (!shouldRun) {
				console.log(`${LOG} Skipping automation "${automation.name}" for "${vaultPath}" — already ran for this Drive version`);
				if (driveFileId) {
					this.manifest?.recordAutomationRun(driveFileId, automation.id, {
						lastRunAt: new Date().toISOString(),
						lastRunDriveModifiedTime: driveModifiedTime ?? "",
						result: "skipped",
					});
				}
				continue;
			}

			console.log(`${LOG} Running automation "${automation.name}" for: ${vaultPath}`);
			try {
				await this.runAction(automation.action, vaultPath, companionPath, driveCreatedTime, transcription);
				this.emitRun(vaultPath, automation, "success");
				if (driveFileId) {
					this.manifest?.recordAutomationRun(driveFileId, automation.id, {
						lastRunAt: new Date().toISOString(),
						lastRunDriveModifiedTime: driveModifiedTime ?? "",
						result: "success",
					});
				}
			} catch (e) {
				console.error(`${LOG} Automation "${automation.name}" failed for "${vaultPath}":`, e);
				this.emitRun(vaultPath, automation, "error", e instanceof Error ? e.message : String(e));
				if (driveFileId) {
					this.manifest?.recordAutomationRun(driveFileId, automation.id, {
						lastRunAt: new Date().toISOString(),
						lastRunDriveModifiedTime: driveModifiedTime ?? "",
						result: "error",
						errorMessage: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}
	}

	/**
	 * Run a single automation against any vault file on demand, bypassing the trigger-folder filter.
	 *
	 * Untracked files (no manifest entry) skip the decision matrix entirely — every invocation runs
	 * the action because there's no driveFileId to record history against. Re-running on the same
	 * untracked file is therefore not idempotent at the matrix level; callers that need idempotency
	 * should rely on the actions themselves (which generally check before inserting).
	 */
	async runForFileAdHoc(
		vaultPath: string,
		automationId: string,
		opts: { force?: boolean; dryRun?: boolean } = {}
	): Promise<AdHocRunResult> {
		const automation = this.settings.automations.find((a) => a.id === automationId);
		if (!automation) return { ran: false, skippedReason: "automation not found" };
		if (!automation.enabled) return { ran: false, skippedReason: "automation disabled" };

		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) {
			return { ran: false, skippedReason: `file not found in vault: ${vaultPath}` };
		}

		const entry = this.manifest?.findByVaultPath(vaultPath);
		const tracked = !!entry;

		// Honor skip flags from companion frontmatter (when we have a known companion).
		let companionPath: string | null = null;
		let driveCreatedTime: string | undefined;
		let driveFileId: string | undefined;
		let driveModifiedTime: string | undefined;

		if (entry) {
			const [id, manifestEntry] = entry;
			driveFileId = id;
			companionPath = manifestEntry.companionPath;
			driveCreatedTime = manifestEntry.driveCreatedTime;
			driveModifiedTime = manifestEntry.driveModifiedTime;

			if (companionPath) {
				const companionFile = this.app.vault.getAbstractFileByPath(companionPath);
				if (companionFile instanceof TFile) {
					const cache = this.app.metadataCache.getFileCache(companionFile);
					const fm = cache?.frontmatter;
					if (fm?.["drive-sync-skip-all"] === true) {
						return { ran: false, skippedReason: "drive-sync-skip-all: true" };
					}
					if (Array.isArray(fm?.["drive-sync-skip-automations"]) &&
						(fm["drive-sync-skip-automations"] as string[]).includes(automationId)) {
						return { ran: false, skippedReason: "in drive-sync-skip-automations" };
					}
				}
			}
		} else {
			// Synthetic context for untracked files: no Drive ID, mtime from vault filesystem.
			driveModifiedTime = new Date(file.stat.mtime).toISOString();
		}

		// Matrix only applies to tracked files; untracked are always treated as force.
		const force = opts.force === true || !tracked;
		const shouldRun = this.shouldRunAutomation(automationId, driveFileId, driveModifiedTime, force);

		if (!shouldRun) {
			if (driveFileId && !opts.dryRun) {
				this.manifest?.recordAutomationRun(driveFileId, automationId, {
					lastRunAt: new Date().toISOString(),
					lastRunDriveModifiedTime: driveModifiedTime ?? "",
					result: "skipped",
				});
				await this.manifest?.save();
			}
			return { ran: false, skippedReason: "already ran for this Drive version" };
		}

		if (opts.dryRun) {
			return { ran: true };
		}

		console.log(`${LOG} runForFileAdHoc: running "${automation.name}" for "${vaultPath}" (tracked=${tracked})`);
		try {
			await this.runAction(automation.action, vaultPath, companionPath, driveCreatedTime, undefined);
			this.emitRun(vaultPath, automation, "success");
			if (driveFileId) {
				this.manifest?.recordAutomationRun(driveFileId, automationId, {
					lastRunAt: new Date().toISOString(),
					lastRunDriveModifiedTime: driveModifiedTime ?? "",
					result: "success",
				});
				await this.manifest?.save();
			}
			return { ran: true };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`${LOG} runForFileAdHoc: "${automation.name}" failed for "${vaultPath}":`, e);
			this.emitRun(vaultPath, automation, "error", msg);
			if (driveFileId) {
				this.manifest?.recordAutomationRun(driveFileId, automationId, {
					lastRunAt: new Date().toISOString(),
					lastRunDriveModifiedTime: driveModifiedTime ?? "",
					result: "error",
					errorMessage: msg,
				});
				await this.manifest?.save();
			}
			return { ran: false, error: msg };
		}
	}

	/**
	 * Decision matrix:
	 *   Never run before          → RUN
	 *   Ran before, same modTime  → SKIP (unless force)
	 *   Ran before, newer modTime → RUN
	 *   Last result was error     → RUN
	 */
	private shouldRunAutomation(
		automationId: string,
		driveFileId?: string,
		driveModifiedTime?: string,
		force = false
	): boolean {
		if (force) return true;
		if (!driveFileId || !this.manifest) return true;

		const prior = this.manifest.getAutomationRun(driveFileId, automationId);
		if (!prior) return true;
		if (prior.result === "error") return true;
		if (driveModifiedTime && prior.lastRunDriveModifiedTime !== driveModifiedTime) return true;
		return false;
	}

	// ── Trigger matching ────────────────────────────────────────────────────────

	private matchesTrigger(automation: Automation, vaultPath: string): boolean {
		const dateStr = this.extractDate(vaultPath.split("/").pop() ?? "");
		const resolvedTrigger = this.resolveDatePattern(
			automation.triggerFolderPath.replace(/\/$/, ""),
			dateStr
		);

		const sep = vaultPath.includes("\\") ? "\\" : "/";
		if (!vaultPath.startsWith(resolvedTrigger + "/") && !vaultPath.startsWith(resolvedTrigger + "\\")) {
			return false;
		}

		// Relative path inside the trigger folder (e.g. "2026/MyBook.pdf" or "MyBook.pdf")
		const relative = vaultPath.slice(resolvedTrigger.length + 1);
		const isRootFile = !relative.includes("/") && !relative.includes("\\");

		const scope = automation.triggerScope ?? "all";
		if (scope === "root_only" && !isRootFile) return false;
		if (scope === "subfolders_only" && isRootFile) return false;

		if (automation.excludedSubfolders?.length && !isRootFile) {
			const firstSegment = relative.split(sep)[0];
			if (automation.excludedSubfolders.includes(firstSegment)) return false;
		}

		return true;
	}

	// ── Actions ─────────────────────────────────────────────────────────────────

	private async runAction(
		action: AutomationAction,
		vaultPath: string,
		companionPath?: string | null,
		driveCreatedTime?: string,
		transcription?: string
	): Promise<void> {
		if (action.type === "embed_to_daily_note") {
			await this.embedToDailyNote(vaultPath, companionPath, action, driveCreatedTime);
		} else if (action.type === "embed_to_weekly_note") {
			await this.embedToPeriodicNote("weekly", vaultPath, companionPath, action, driveCreatedTime);
		} else if (action.type === "embed_to_monthly_note") {
			await this.embedToPeriodicNote("monthly", vaultPath, companionPath, action, driveCreatedTime);
		} else if (action.type === "embed_to_quarterly_note") {
			await this.embedToPeriodicNote("quarterly", vaultPath, companionPath, action, driveCreatedTime);
		} else if (action.type === "embed_to_yearly_note") {
			await this.embedToPeriodicNote("yearly", vaultPath, companionPath, action, driveCreatedTime);
		} else if (action.type === "append_to_note") {
			await this.runAppendToNote(vaultPath, companionPath, action);
		} else if (action.type === "add_tag_to_companion") {
			await this.runAddTagToCompanion(companionPath, action);
		} else if (action.type === "link_to_matching_note") {
			await this.runLinkToMatchingNote(vaultPath, companionPath, action);
		} else if (action.type === "transcribe_to_periodic_note") {
			await this.runTranscribeToPeriodicNote(vaultPath, companionPath, action, driveCreatedTime, transcription);
		} else if (action.type === "transcribe_to_companion") {
			await this.runTranscribeToCompanion(companionPath, action, transcription);
		} else if (action.type === "split_pages_to_daily_notes") {
			await this.splitPagesToDailyNotes(vaultPath, action);
		}
	}

	/**
	 * Per-page OCR a multi-page PDF (e.g. a monthly journal), read the handwritten date
	 * at the top of each page, and embed that exact PDF page into the matching daily note.
	 * Uses Mistral OCR, which returns real per-page text so page→date mapping is exact.
	 */
	private async splitPagesToDailyNotes(
		vaultPath: string,
		action: AutomationAction
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) {
			console.log(`${LOG} split_pages_to_daily_notes: file not found: ${vaultPath}`);
			return;
		}
		if (file.extension.toLowerCase() !== "pdf") {
			console.log(`${LOG} split_pages_to_daily_notes: not a PDF — skipping: ${vaultPath}`);
			return;
		}
		if (!this.settings.mistralApiKey) {
			console.warn(`${LOG} split_pages_to_daily_notes: requires a Mistral API key (Settings → Transcription). Skipping.`);
			return;
		}

		let pages: { page: number; text: string }[];
		try {
			const bytes = await this.app.vault.readBinary(file);
			const client = new MistralClient(this.settings.mistralApiKey);
			pages = await client.transcribePdfByPage(bytes);
		} catch (e) {
			console.error(`${LOG} split_pages_to_daily_notes: OCR failed for "${vaultPath}":`, e);
			return;
		}

		const fileName = file.name;
		const pdfStem = file.basename;
		const pattern = action.dailyNoteNamePattern || this.settings.periodicNotesPaths.daily;
		const createMissing = action.createDailyNoteIfMissing !== false;

		let embedded = 0;
		for (const { page, text } of pages) {
			const dateStr = this.extractDate(text);
			if (!dateStr) {
				console.log(`${LOG} split_pages_to_daily_notes: no date found on page ${page} of "${fileName}" — skipping`);
				continue;
			}

			let note = pattern
				? this.findNoteByPattern(dateStr, pattern)
				: this.findDailyNoteByFrontmatter(dateStr);

			if (!note && createMissing) {
				note = await this.createDailyNoteForDate(dateStr, pattern, action.dailyNoteTemplatePath);
			}

			if (!note) {
				console.log(`${LOG} split_pages_to_daily_notes: no daily note for ${dateStr} (page ${page}) — skipping`);
				continue;
			}

			const line = this.buildPageEmbedLine(action.pageEmbedTemplate, fileName, pdfStem, page, dateStr);
			await this.insertEmbed(note, line, action.insertPosition);
			embedded++;
		}

		console.log(`${LOG} split_pages_to_daily_notes: embedded ${embedded}/${pages.length} pages of "${fileName}"`);
	}

	/**
	 * Build the line inserted into a daily note for one PDF page.
	 * Placeholders: {{embed}} → ![[file#page=N]], {{pagelink}} → [[file#page=N]],
	 *               {{link}} → [[file]], {{page}} → N, {{title}} → stem, {{date}} → YYYY-MM-DD.
	 * Default (no template): {{embed}}.
	 */
	private buildPageEmbedLine(
		template: string | undefined,
		fileName: string,
		pdfStem: string,
		page: number,
		dateStr: string
	): string {
		const embed = `![[${fileName}#page=${page}]]`;
		const tpl = template && template.trim() ? template : "{{embed}}";
		return tpl
			.replace(/\{\{embed\}\}/g, embed)
			.replace(/\{\{pagelink\}\}/g, `[[${fileName}#page=${page}]]`)
			.replace(/\{\{link\}\}/g, `[[${fileName}]]`)
			.replace(/\{\{page\}\}/g, String(page))
			.replace(/\{\{title\}\}/g, pdfStem)
			.replace(/\{\{date\}\}/g, dateStr);
	}

	/**
	 * Create (and return) the daily note for a given date.
	 * Path resolution: the action/global daily pattern first, else the core Daily Notes
	 * plugin's folder + format. Seeds content from a template note when provided.
	 */
	private async createDailyNoteForDate(
		dateStr: string,
		pattern: string | undefined,
		templatePath?: string
	): Promise<TFile | null> {
		let notePath: string | null = null;
		if (pattern) {
			notePath = this.resolveDatePattern(pattern, dateStr);
		} else {
			notePath = this.resolveCoreDailyNotePath(dateStr);
		}
		if (!notePath) {
			console.log(`${LOG} createDailyNoteForDate: could not resolve a path for ${dateStr} — set a daily note path in Settings → Notes.`);
			return null;
		}
		if (!notePath.endsWith(".md")) notePath += ".md";

		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) return existing;

		let content = "";
		if (templatePath) {
			const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
			if (templateFile instanceof TFile) {
				content = await this.app.vault.read(templateFile);
			} else {
				console.warn(`${LOG} createDailyNoteForDate: template not found: ${templatePath}`);
			}
		}

		// Ensure parent folders exist.
		const dir = notePath.substring(0, notePath.lastIndexOf("/"));
		if (dir) {
			const parts = dir.split("/").filter(Boolean);
			let partial = "";
			for (const seg of parts) {
				partial = partial ? `${partial}/${seg}` : seg;
				if (!(await this.app.vault.adapter.exists(partial))) {
					await this.app.vault.createFolder(partial);
				}
			}
		}

		const note = await this.app.vault.create(notePath, content);
		console.log(`${LOG} createDailyNoteForDate: created daily note "${notePath}" for ${dateStr}`);
		return note;
	}

	/** Resolve a daily note path from the core Daily Notes plugin's folder + format settings. */
	private resolveCoreDailyNotePath(dateStr: string): string | null {
		try {
			const dp = (this.app as any).internalPlugins?.getPluginById?.("daily-notes");
			if (dp?.enabled) {
				const opts = dp.instance?.options ?? {};
				const format: string = opts.format || "YYYY-MM-DD";
				const folder: string = (opts.folder ?? "").trim();
				const name = moment(dateStr, "YYYY-MM-DD").format(format);
				return folder ? `${folder}/${name}` : name;
			}
		} catch {
			// fall through
		}
		return null;
	}

	private async embedToDailyNote(
		vaultPath: string,
		companionPath: string | null | undefined,
		action: AutomationAction,
		driveCreatedTime?: string
	): Promise<void> {
		const fileName = vaultPath.split("/").pop();
		if (!fileName) return;

		const dateStr = this.resolveDate(fileName, driveCreatedTime);
		if (!dateStr) {
			console.log(`${LOG} No date found for daily note embed: ${fileName}`);
			return;
		}

		// Prefer per-action pattern; fall back to periodicNotesPaths.daily
		const pattern = action.dailyNoteNamePattern || this.settings.periodicNotesPaths.daily;

		const dailyNote = pattern
			? this.findNoteByPattern(dateStr, pattern)
			: this.findDailyNoteByFrontmatter(dateStr);

		if (!dailyNote) {
			console.log(`${LOG} No daily note found for date: ${dateStr}`);
			return;
		}

		console.log(`${LOG} Found daily note: ${dailyNote.path}`);
		const embedTarget = this.resolveEmbedTarget(fileName, companionPath, action);
		const pdfStem = fileName.replace(/\.[^/.]+$/, "");
		const line = this.buildEmbedLine(action.embedTemplate, embedTarget, pdfStem, dateStr);
		await this.insertEmbed(dailyNote, line, action.insertPosition);
	}

	private async embedToPeriodicNote(
		period: PeriodicPeriod,
		vaultPath: string,
		companionPath: string | null | undefined,
		action: AutomationAction,
		driveCreatedTime?: string
	): Promise<void> {
		const fileName = vaultPath.split("/").pop();
		if (!fileName) return;

		const dateStr = this.resolveDate(fileName, driveCreatedTime);
		if (!dateStr) {
			console.log(`${LOG} No date found for ${period} note embed: ${fileName}`);
			return;
		}

		const pathTemplate = this.settings.periodicNotesPaths[period];
		if (!pathTemplate) {
			console.log(`${LOG} No path configured for ${period} notes — skipping. Set it in Settings → Periodic Notes.`);
			return;
		}

		const resolvedPath = this.resolveDatePattern(pathTemplate, dateStr);
		const note = this.findNoteByPath(resolvedPath);

		if (!note) {
			console.log(`${LOG} No ${period} note found for date ${dateStr} (looked for "${resolvedPath}")`);
			return;
		}

		console.log(`${LOG} Found ${period} note: ${note.path}`);
		const embedTarget = this.resolveEmbedTarget(fileName, companionPath, action);
		const pdfStem = fileName.replace(/\.[^/.]+$/, "");
		const line = this.buildEmbedLine(action.embedTemplate, embedTarget, pdfStem, dateStr);
		await this.insertEmbed(note, line, action.insertPosition);
	}

	private async runAppendToNote(
		vaultPath: string,
		companionPath: string | null | undefined,
		action: AutomationAction
	): Promise<void> {
		if (!action.targetNotePath) {
			console.warn(`${LOG} append_to_note: no targetNotePath configured`);
			return;
		}
		const target = this.app.vault.getAbstractFileByPath(action.targetNotePath);
		if (!(target instanceof TFile)) {
			console.log(`${LOG} append_to_note: target note not found: ${action.targetNotePath}`);
			return;
		}
		const fileName = vaultPath.split("/").pop() ?? vaultPath;
		const embedTarget = this.resolveEmbedTarget(fileName, companionPath, action);
		const pdfStem = fileName.replace(/\.[^/.]+$/, "");
		const dateStr = this.extractDate(fileName);
		const line = this.buildEmbedLine(action.embedTemplate, embedTarget, pdfStem, dateStr);
		await this.insertEmbed(target, line, action.insertPosition);
	}

	private async runAddTagToCompanion(
		companionPath: string | null | undefined,
		action: AutomationAction
	): Promise<void> {
		if (!action.tagName) {
			console.warn(`${LOG} add_tag_to_companion: no tagName configured`);
			return;
		}
		if (!companionPath) {
			console.log(`${LOG} add_tag_to_companion: no companion note for this file — skipping`);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(companionPath);
		if (!(file instanceof TFile)) {
			console.log(`${LOG} add_tag_to_companion: companion note not found: ${companionPath}`);
			return;
		}

		const content = await this.app.vault.read(file);
		const newContent = this.addTagToFrontmatter(content, action.tagName);
		if (newContent !== content) {
			await this.app.vault.modify(file, newContent);
			console.log(`${LOG} Added tag "${action.tagName}" to companion note: ${companionPath}`);
		} else {
			console.log(`${LOG} Tag "${action.tagName}" already present in: ${companionPath}`);
		}
	}

	private async runLinkToMatchingNote(
		vaultPath: string,
		companionPath: string | null | undefined,
		action: AutomationAction
	): Promise<void> {
		if (!action.searchFolderPath) {
			console.warn(`${LOG} link_to_matching_note: no searchFolderPath configured`);
			return;
		}

		const fileName = vaultPath.split("/").pop() ?? vaultPath;
		const stem = fileName.replace(/\.[^/.]+$/, "");
		const folderPrefix = action.searchFolderPath.replace(/\/$/, "");
		const stemWords = this.normalizeWords(stem);

		if (stemWords.length === 0) return;

		const threshold = action.matchConfidenceThreshold ?? 1.0;

		const scored = this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(folderPrefix + "/"))
			.map((file) => {
				const candidateWords = this.normalizeWords(file.basename);

				if (action.matchOnAliases) {
					const cache = this.app.metadataCache.getFileCache(file);
					const aliases = cache?.frontmatter?.aliases;
					if (typeof aliases === "string") {
						candidateWords.push(...this.normalizeWords(aliases));
					} else if (Array.isArray(aliases)) {
						for (const a of aliases) {
							if (typeof a === "string") candidateWords.push(...this.normalizeWords(a));
						}
					}
				}

				const matched = stemWords.filter((w) => candidateWords.includes(w)).length;
				const score = stemWords.length === 0 ? 0 : matched / stemWords.length;
				return { file, score };
			})
			.filter((m) => m.score >= threshold)
			.sort((a, b) => b.score - a.score);

		if (scored.length === 0) {
			console.log(`${LOG} link_to_matching_note: no notes in "${folderPrefix}" match stem "${stem}" (threshold=${threshold})`);
			if (action.createNoteIfNotFound) {
				await this.createAndLinkNote(stem, fileName, folderPrefix, action);
			}
			return;
		}

		const dateStr = this.extractDate(fileName);
		const matchLine = this.buildEmbedLine(action.embedTemplate, fileName, stem, dateStr);

		for (const { file: note } of scored) {
			console.log(`${LOG} link_to_matching_note: inserting embed into ${note.path} (score=${scored.find(m => m.file === note)?.score.toFixed(2)})`);
			await this.insertEmbed(note, matchLine, action.insertPosition);
		}

		// Bidirectional: insert backlinks into the companion note
		if (action.bidirectionalLink && companionPath) {
			const companionFile = this.app.vault.getAbstractFileByPath(companionPath);
			if (companionFile instanceof TFile) {
				for (const { file: matchedNote } of scored) {
					const backLink = `[[${matchedNote.basename}]]`;
					await this.insertEmbed(companionFile, backLink, action.insertPosition);
				}
			}
		}
	}

	private async runTranscribeToPeriodicNote(
		vaultPath: string,
		companionPath: string | null | undefined,
		action: AutomationAction,
		driveCreatedTime?: string,
		transcription?: string
	): Promise<void> {
		if (!transcription) {
			console.log(`${LOG} transcribe_to_periodic_note: no transcription available — skipping`);
			return;
		}

		const fileName = vaultPath.split("/").pop();
		if (!fileName) return;

		const dateStr = this.resolveDate(fileName, driveCreatedTime);
		if (!dateStr) {
			console.log(`${LOG} transcribe_to_periodic_note: no date found for "${fileName}" — skipping`);
			return;
		}

		const period = action.periodicNoteType ?? "daily";
		const pathTemplate = this.settings.periodicNotesPaths[period];
		if (!pathTemplate) {
			console.log(`${LOG} transcribe_to_periodic_note: no path configured for ${period} notes — skipping`);
			return;
		}

		const resolvedPath = this.resolveDatePattern(pathTemplate, dateStr);
		const note = this.findNoteByPath(resolvedPath);
		if (!note) {
			console.log(`${LOG} transcribe_to_periodic_note: no ${period} note found for date ${dateStr} ("${resolvedPath}")`);
			return;
		}

		const pdfStem = fileName.replace(/\.[^/.]+$/, "");
		const embedTarget = this.resolveEmbedTarget(fileName, companionPath, action);

		const template = action.transcriptionTemplate
			?? `\n## Transcription from [[${pdfStem}]]\n\n{{transcription}}`;

		const content = template
			.replace(/\{\{transcription\}\}/g, transcription)
			.replace(/\{\{title\}\}/g, pdfStem)
			.replace(/\{\{date\}\}/g, dateStr)
			.replace(/\{\{link\}\}/g, `[[${embedTarget}]]`)
			.replace(/\{\{embed\}\}/g, `![[${embedTarget}]]`);

		console.log(`${LOG} transcribe_to_periodic_note: appending to ${note.path}`);
		await this.insertEmbed(note, content, action.insertPosition);
	}

	private async createAndLinkNote(
		stem: string,
		fileName: string,
		searchFolderPath: string,
		action: AutomationAction
	): Promise<void> {
		const targetFolder = (action.newNoteFolder?.trim() || searchFolderPath).replace(/\/$/, "");
		const notePath = `${targetFolder}/${stem}.md`;

		// If the note already exists (e.g. renamed after last sync), just link it
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		const dateStr = this.extractDate(fileName);
		const embedLine = this.buildEmbedLine(action.embedTemplate, fileName, stem, dateStr);
		if (existing instanceof TFile) {
			console.log(`${LOG} link_to_matching_note: note already exists at "${notePath}", inserting embed`);
			await this.insertEmbed(existing, embedLine, action.insertPosition);
			return;
		}

		// Load template content if specified
		let content = "";
		if (action.newNoteTemplatePath) {
			const templateFile = this.app.vault.getAbstractFileByPath(action.newNoteTemplatePath);
			if (templateFile instanceof TFile) {
				content = await this.app.vault.read(templateFile);
			} else {
				console.warn(`${LOG} link_to_matching_note: template not found: ${action.newNoteTemplatePath}`);
			}
		}

		// Ensure the target folder exists (create intermediate folders as needed)
		const parts = targetFolder.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const partial = parts.slice(0, i).join("/");
			if (!(await this.app.vault.adapter.exists(partial))) {
				await this.app.vault.createFolder(partial);
			}
		}

		const newNote = await this.app.vault.create(notePath, content);
		console.log(`${LOG} link_to_matching_note: created new note at "${notePath}"`);
		await this.insertEmbed(newNote, embedLine, action.insertPosition);
	}

	// ── Embed target resolution ──────────────────────────────────────────────────

	/**
	 * Build the full line to insert into the target note.
	 * If no template is set, falls back to `![[embedTarget]]`.
	 * Available placeholders:
	 *   {{embed}}         → ![[embedTarget]]
	 *   {{link}}          → [[embedTarget]]
	 *   {{target}}        → embedTarget as-is
	 *   {{title}}         → PDF stem (no extension)
	 *   {{date}}          → resolved date string, or empty
	 *   {{transcription}} → transcription text, or empty
	 */
	private buildEmbedLine(
		template: string | undefined,
		embedTarget: string,
		pdfStem: string,
		dateStr?: string | null,
		transcription?: string
	): string {
		if (!template) return `![[${embedTarget}]]`;
		const date = dateStr ?? "";
		return template
			.replace(/\{\{embed\}\}/g, `![[${embedTarget}]]`)
			.replace(/\{\{link\}\}/g, `[[${embedTarget}]]`)
			.replace(/\{\{target\}\}/g, embedTarget)
			.replace(/\{\{title\}\}/g, pdfStem)
			.replace(/\{\{date\}\}/g, date)
			.replace(/\{\{transcription\}\}/g, transcription ?? "");
	}

	/**
	 * Return the basename (without extension) to embed.
	 * When embedCompanion is true and a companion exists, embed the companion note;
	 * otherwise embed the PDF file.
	 */
	private resolveEmbedTarget(
		pdfFileName: string,
		companionPath: string | null | undefined,
		action: AutomationAction
	): string {
		if (action.embedCompanion && companionPath) {
			// Return companion note basename without .md
			const companionBase = companionPath.split("/").pop() ?? companionPath;
			return companionBase.replace(/\.md$/i, "");
		}
		return pdfFileName;
	}

	/**
	 * Patch a YAML frontmatter block to include `tag` in the `tags:` array.
	 * Handles both list and inline array forms. Creates `tags:` if missing.
	 */
	private addTagToFrontmatter(content: string, tag: string): string {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
		if (!fmMatch) {
			return `---\ntags:\n  - ${tag}\n---\n${content}`;
		}

		const fmBody = fmMatch[1];
		const fmEnd = fmMatch[0].length;

		if (new RegExp(`(^|\\s)#?${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m").test(fmBody)) {
			return content;
		}

		const listTagsMatch = fmBody.match(/^(tags:\s*\n(?:[ \t]+-[^\n]*\n)*)/m);
		if (listTagsMatch) {
			const insertAt = content.indexOf(listTagsMatch[0]) + listTagsMatch[0].length;
			return content.slice(0, insertAt) + `  - ${tag}\n` + content.slice(insertAt);
		}

		const inlineTagsMatch = fmBody.match(/^(tags:\s*\[)(.*?)(\])/m);
		if (inlineTagsMatch) {
			const fullMatch = inlineTagsMatch[0];
			const existing = inlineTagsMatch[2].trim();
			const replacement = existing
				? `${inlineTagsMatch[1]}${existing}, ${tag}${inlineTagsMatch[3]}`
				: `${inlineTagsMatch[1]}${tag}${inlineTagsMatch[3]}`;
			return content.replace(fullMatch, replacement);
		}

		const newFmBody = fmBody + `\ntags:\n  - ${tag}`;
		return `---\n${newFmBody}\n---\n` + content.slice(fmEnd);
	}

	// ── Note finders ─────────────────────────────────────────────────────────────

	/**
	 * Find a note by its resolved path (with or without .md) or by basename.
	 * Used for periodic note lookups where the path template gives the full location.
	 */
	private findNoteByPath(resolvedPath: string): TFile | null {
		// Try full path first (with and without .md)
		const withMd = resolvedPath.endsWith(".md") ? resolvedPath : resolvedPath + ".md";
		const candidate = this.app.vault.getAbstractFileByPath(withMd);
		if (candidate instanceof TFile) return candidate;

		// Fallback: search by basename
		const expectedBasename = resolvedPath.split("/").pop() ?? resolvedPath;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.basename === expectedBasename) return file;
		}
		return null;
	}

	/** Find by computing the expected basename from a moment.js-style {{token}} pattern. */
	private findNoteByPattern(dateStr: string, pattern: string): TFile | null {
		const expectedName = this.resolveDatePattern(pattern, dateStr);
		console.log(`${LOG} Looking for note with name: "${expectedName}"`);

		// Try path lookup first (pattern may include folder segments)
		const byPath = this.findNoteByPath(expectedName);
		if (byPath) return byPath;

		// Fallback: basename-only search
		const basename = expectedName.split("/").pop() ?? expectedName;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.basename === basename) return file;
		}
		return null;
	}

	/** Find daily note by frontmatter date + periodic/daily tag (fallback). */
	private findDailyNoteByFrontmatter(dateStr: string): TFile | null {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.frontmatter) continue;

			const rawDate = cache.frontmatter.date;
			if (!rawDate || !String(rawDate).startsWith(dateStr)) continue;

			const tags = getAllTags(cache) ?? [];
			const normalized = tags.map((t) => t.replace(/^#/, ""));
			if (normalized.includes("periodic/daily")) return file;
		}
		return null;
	}

	// ── Embed insertion ──────────────────────────────────────────────────────────

	private async insertEmbed(
		note: TFile,
		line: string,
		position: "top" | "bottom"
	): Promise<void> {
		const content = await this.app.vault.read(note);

		if (content.includes(line)) {
			console.log(`${LOG} Embed already present in ${note.path} — skipping`);
			return;
		}

		let newContent: string;
		if (position === "bottom") {
			newContent = content.trimEnd() + "\n\n" + line + "\n";
		} else {
			const fmEnd = content.indexOf("\n---\n", 3);
			if (fmEnd !== -1) {
				const insertPos = fmEnd + 5;
				newContent =
					content.slice(0, insertPos) +
					"\n" + line + "\n\n" +
					content.slice(insertPos);
			} else {
				newContent = line + "\n\n" + content;
			}
		}

		await this.app.vault.modify(note, newContent);
		console.log(`${LOG} Inserted line "${line}" into ${note.path} (${position})`);
	}

	// ── Helpers ──────────────────────────────────────────────────────────────────

	/** Lowercase, strip punctuation, split into words. Used for fuzzy title matching. */
	private normalizeWords(s: string): string[] {
		return s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
	}

	/** Extract the first YYYY-MM-DD substring from a string. */
	private extractDate(str: string): string | null {
		const m = str.match(/(\d{4}-\d{2}-\d{2})/);
		return m ? m[1] : null;
	}

	/**
	 * Resolve a date string for automation use.
	 * Tries the filename first; falls back to driveCreatedTime if provided.
	 */
	private resolveDate(fileName: string, driveCreatedTime?: string): string | null {
		return (
			this.extractDate(fileName) ??
			(driveCreatedTime ? this.extractDate(driveCreatedTime) ?? driveCreatedTime.substring(0, 10) : null)
		);
	}

	private async runTranscribeToCompanion(
		companionPath: string | null | undefined,
		action: AutomationAction,
		transcription?: string
	): Promise<void> {
		if (!transcription) {
			console.log(`${LOG} transcribe_to_companion: no transcription available — skipping`);
			return;
		}
		if (!companionPath) {
			console.log(`${LOG} transcribe_to_companion: no companion note for this file — skipping`);
			return;
		}

		const companionFile = this.app.vault.getAbstractFileByPath(companionPath);
		if (!(companionFile instanceof TFile)) {
			console.log(`${LOG} transcribe_to_companion: companion note not found: ${companionPath}`);
			return;
		}

		const content = await this.app.vault.read(companionFile);
		const header = "## Transcription";
		const headerNewline = "\n" + header;

		// Build the section content, respecting a custom template if set
		const template = action.transcriptionTemplate ?? "{{transcription}}";
		const sectionBody = template.replace(/\{\{transcription\}\}/g, transcription);

		let newContent: string;
		const sectionIdx = content.indexOf(headerNewline);
		if (sectionIdx !== -1) {
			// Replace existing section up to next ## heading or end of file
			const searchFrom = sectionIdx + 1;
			const nextSection = content.indexOf("\n## ", searchFrom);
			const sectionEnd = nextSection !== -1 ? nextSection : content.length;
			newContent =
				content.slice(0, sectionIdx) +
				"\n\n" + header + "\n\n" + sectionBody + "\n" +
				content.slice(sectionEnd);
		} else {
			newContent = content.trimEnd() + "\n\n" + header + "\n\n" + sectionBody + "\n";
		}

		await this.app.vault.modify(companionFile, newContent);
		console.log(`${LOG} transcribe_to_companion: transcription written to ${companionPath}`);
	}

	/**
	 * Resolve {{token}} placeholders in a pattern string using the given date.
	 * Each {{...}} block is passed to moment().format(); everything else is literal.
	 */
	private resolveDatePattern(pattern: string, dateStr: string | null): string {
		if (!dateStr) return pattern;
		try {
			const m = moment(dateStr, "YYYY-MM-DD");
			return pattern.replace(/\{\{([^}]+)\}\}/g, (_, token: string) => m.format(token));
		} catch {
			console.warn(`${LOG} Failed to resolve date pattern "${pattern}" for "${dateStr}"`);
			return pattern;
		}
	}
}
