import { App, getAllTags, TFile } from "obsidian";
import { Automation, AutomationAction, AutomationRunRecord, PeriodicNotesPaths, PluginSettings } from "../types";
import type { SyncManifestStore } from "../sync/SyncManifest";

const LOG = "[DriveSync/Automation]";

// Obsidian bundles moment.js as a global
declare const moment: (date: string, format: string) => { format(pattern: string): string };

type PeriodicPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export class AutomationEngine {
	constructor(
		private app: App,
		private settings: PluginSettings,
		private manifest?: SyncManifestStore
	) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	updateManifest(manifest: SyncManifestStore): void {
		this.manifest = manifest;
	}

	async runForFile(
		vaultPath: string,
		companionPath?: string | null,
		driveCreatedTime?: string,
		transcription?: string,
		driveFileId?: string,
		driveModifiedTime?: string,
		force = false
	): Promise<void> {
		const matching = this.settings.automations.filter(
			(a) => a.enabled && this.matchesTrigger(a, vaultPath)
		);

		if (matching.length === 0) return;

		for (const automation of matching) {
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
				if (driveFileId) {
					this.manifest?.recordAutomationRun(driveFileId, automation.id, {
						lastRunAt: new Date().toISOString(),
						lastRunDriveModifiedTime: driveModifiedTime ?? "",
						result: "success",
					});
				}
			} catch (e) {
				console.error(`${LOG} Automation "${automation.name}" failed for "${vaultPath}":`, e);
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
		}
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
