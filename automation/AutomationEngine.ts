import { App, getAllTags, TFile } from "obsidian";
import { Automation, AutomationAction, PluginSettings } from "../types";

const LOG = "[DriveSync/Automation]";

// Obsidian bundles moment.js as a global
declare const moment: (date: string, format: string) => { format(pattern: string): string };

export class AutomationEngine {
	constructor(private app: App, private settings: PluginSettings) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	async runForFile(vaultPath: string, companionPath?: string | null): Promise<void> {
		const matching = this.settings.automations.filter(
			(a) => a.enabled && this.matchesTrigger(a, vaultPath)
		);

		if (matching.length === 0) return;

		for (const automation of matching) {
			console.log(
				`${LOG} Running automation "${automation.name}" for: ${vaultPath}`
			);
			try {
				await this.runAction(automation.action, vaultPath, companionPath);
			} catch (e) {
				console.error(
					`${LOG} Automation "${automation.name}" failed for "${vaultPath}":`,
					e
				);
			}
		}
	}

	// ── Trigger matching ────────────────────────────────────────────────────────

	private matchesTrigger(automation: Automation, vaultPath: string): boolean {
		const dateStr = this.extractDate(vaultPath.split("/").pop() ?? "");
		const resolvedTrigger = this.resolveDatePattern(
			automation.triggerFolderPath.replace(/\/$/, ""),
			dateStr
		);
		return (
			vaultPath.startsWith(resolvedTrigger + "/") ||
			vaultPath.startsWith(resolvedTrigger + "\\")
		);
	}

	// ── Actions ─────────────────────────────────────────────────────────────────

	private async runAction(action: AutomationAction, vaultPath: string, companionPath?: string | null): Promise<void> {
		if (action.type === "embed_to_daily_note") {
			await this.embedToDailyNote(vaultPath, action);
		} else if (action.type === "append_to_note") {
			await this.runAppendToNote(vaultPath, action);
		} else if (action.type === "add_tag_to_companion") {
			await this.runAddTagToCompanion(companionPath, action);
		}
	}

	private async embedToDailyNote(
		vaultPath: string,
		action: AutomationAction
	): Promise<void> {
		const fileName = vaultPath.split("/").pop();
		if (!fileName) return;

		const dateStr = this.extractDate(fileName);
		if (!dateStr) {
			console.log(`${LOG} No YYYY-MM-DD date found in filename: ${fileName}`);
			return;
		}
		console.log(`${LOG} Extracted date "${dateStr}" from "${fileName}"`);

		const dailyNote = action.dailyNoteNamePattern
			? this.findDailyNoteByName(dateStr, action.dailyNoteNamePattern)
			: this.findDailyNoteByFrontmatter(dateStr);

		if (!dailyNote) {
			console.log(`${LOG} No daily note found for date: ${dateStr}`);
			return;
		}

		console.log(`${LOG} Found daily note: ${dailyNote.path}`);
		await this.insertEmbed(dailyNote, fileName, action.insertPosition);
	}

	private async runAppendToNote(
		vaultPath: string,
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
		await this.insertEmbed(target, fileName, action.insertPosition);
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

	/**
	 * Patch a YAML frontmatter block to include `tag` in the `tags:` array.
	 * Handles both list and inline array forms. Creates `tags:` if missing.
	 */
	private addTagToFrontmatter(content: string, tag: string): string {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
		if (!fmMatch) {
			// No frontmatter — prepend minimal block
			return `---\ntags:\n  - ${tag}\n---\n${content}`;
		}

		const fmBody = fmMatch[1];
		const fmEnd = fmMatch[0].length;

		// Check if tag is already present
		if (new RegExp(`(^|\\s)#?${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m").test(fmBody)) {
			return content;
		}

		// Look for an existing tags: key
		const listTagsMatch = fmBody.match(/^(tags:\s*\n(?:[ \t]+-[^\n]*\n)*)/m);
		if (listTagsMatch) {
			// Append to the list
			const insertAt = content.indexOf(listTagsMatch[0]) + listTagsMatch[0].length;
			return content.slice(0, insertAt) + `  - ${tag}\n` + content.slice(insertAt);
		}

		// Inline array form: tags: [foo, bar]
		const inlineTagsMatch = fmBody.match(/^(tags:\s*\[)(.*?)(\])/m);
		if (inlineTagsMatch) {
			const fullMatch = inlineTagsMatch[0];
			const existing = inlineTagsMatch[2].trim();
			const replacement = existing
				? `${inlineTagsMatch[1]}${existing}, ${tag}${inlineTagsMatch[3]}`
				: `${inlineTagsMatch[1]}${tag}${inlineTagsMatch[3]}`;
			return content.replace(fullMatch, replacement);
		}

		// No tags key — append before closing ---
		const newFmBody = fmBody + `\ntags:\n  - ${tag}`;
		return `---\n${newFmBody}\n---\n` + content.slice(fmEnd);
	}

	// ── Daily note finders ───────────────────────────────────────────────────────

	/** Find by computing the expected basename from a moment.js format pattern. */
	private findDailyNoteByName(dateStr: string, namePattern: string): TFile | null {
		const expectedName = this.resolveDatePattern(namePattern, dateStr);
		console.log(`${LOG} Looking for daily note with name: "${expectedName}"`);

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.basename === expectedName) return file;
		}
		return null;
	}

	/** Find by frontmatter date + periodic/daily tag (fallback when no name pattern set). */
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
		pdfFileName: string,
		position: "top" | "bottom"
	): Promise<void> {
		const embed = `![[${pdfFileName}]]`;
		const content = await this.app.vault.read(note);

		if (content.includes(embed)) {
			console.log(`${LOG} Embed already present in ${note.path} — skipping`);
			return;
		}

		let newContent: string;
		if (position === "bottom") {
			newContent = content.trimEnd() + "\n\n" + embed + "\n";
		} else {
			// Insert after closing frontmatter delimiter (\n---\n)
			const fmEnd = content.indexOf("\n---\n", 3);
			if (fmEnd !== -1) {
				const insertPos = fmEnd + 5;
				newContent =
					content.slice(0, insertPos) +
					"\n" + embed + "\n\n" +
					content.slice(insertPos);
			} else {
				newContent = embed + "\n\n" + content;
			}
		}

		await this.app.vault.modify(note, newContent);
		console.log(`${LOG} Embedded "${pdfFileName}" into ${note.path} (${position})`);
	}

	// ── Helpers ──────────────────────────────────────────────────────────────────

	/** Extract the first YYYY-MM-DD substring from a string. */
	private extractDate(str: string): string | null {
		const m = str.match(/(\d{4}-\d{2}-\d{2})/);
		return m ? m[1] : null;
	}

	/**
	 * Resolve moment.js format tokens in a pattern string using the given date.
	 * If dateStr is null or moment is unavailable, returns the pattern as-is.
	 */
	private resolveDatePattern(pattern: string, dateStr: string | null): string {
		if (!dateStr) return pattern;
		try {
			return moment(dateStr, "YYYY-MM-DD").format(pattern);
		} catch {
			console.warn(`${LOG} Failed to resolve date pattern "${pattern}" for "${dateStr}"`);
			return pattern;
		}
	}
}
