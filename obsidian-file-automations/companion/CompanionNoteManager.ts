import { App, normalizePath, TFile } from "obsidian";
import type { CompanionRule, FileAutomationSettings } from "../types";
import { resolveFolderTokens } from "./pathTokens";
import { relativePathForRule, selectCompanionRule } from "./rules";

const LOG = "[FileAutomations/Companion]";

// The old frontmatter names and template tokens intentionally remain valid so
// existing notes/templates survive the split without a destructive rewrite.
const DEFAULT_TEMPLATE = `---
processed: false
companion: "[[{{fileName}}]]"
companion-of: "[[{{sourceVaultStem}}]]"
sourceVaultPath: "{{sourceVaultPath}}"
sourceDriveModifiedTime: "{{sourceDriveModifiedTime}}"
syncDate: "{{syncDate}}"
driveFileId: "{{driveFileId}}"
pairLabel: "{{pairLabel}}"
automationRuleId: "{{ruleId}}"
---

# {{title}}

> [!info] Source
> File: [[{{fileName}}]]
> Last updated: {{sourceDriveModifiedTime}}
> Relative path: {{relativePath}}

## Notes

`;

export interface CompanionWriteResult {
	path: string;
	conflictPath: string | null;
	skipped?: boolean;
}

export interface CompanionMoveResult {
	path: string | null;
	ownershipMismatch: boolean;
}

export class CompanionNoteManager {
	constructor(private app: App, private settings: FileAutomationSettings) {}

	updateSettings(settings: FileAutomationSettings): void {
		this.settings = settings;
	}

	findRule(vaultPath: string): CompanionRule | null {
		if (!this.settings.companionNotesEnabled) return null;
		return selectCompanionRule(this.settings.companionRules, vaultPath);
	}

	companionPath(rule: CompanionRule, pdfVaultPath: string): string {
		const fileName = pdfVaultPath.split("/").pop() ?? pdfVaultPath;
		const stem = fileName.replace(/\.pdf$/i, "");
		const relativeFolder = relativePathForRule(rule, pdfVaultPath);
		const configured = (rule.companionFolder ?? this.settings.companionNotesFolder).trim();

		if (configured === "/") return `${stem}.md`;
		if (configured.includes("{{")) {
			const folder = resolveFolderTokens(configured, pdfVaultPath);
			return normalizePath(folder ? `${folder}/${stem}.md` : `${stem}.md`);
		}
		if (configured) {
			const safeLabel = rule.label.replace(/[/\\:*?"<>|]/g, "_");
			const folder = [configured, safeLabel, relativeFolder].filter(Boolean).join("/");
			return normalizePath(`${folder}/${stem}.md`);
		}
		const sourceFolder = pdfVaultPath.includes("/")
			? pdfVaultPath.slice(0, pdfVaultPath.lastIndexOf("/"))
			: "";
		return normalizePath(sourceFolder ? `${sourceFolder}/${stem}.md` : `${stem}.md`);
	}

	/**
	 * Create or refresh a companion. A colliding unrelated note is never adopted:
	 * the allocator adds a deterministic numeric suffix instead.
	 */
	async ensure(
		source: TFile,
		rule: CompanionRule,
		knownPath?: string | null,
		transcription?: string,
		knownMtime?: number,
		isClaimed: (path: string) => boolean = () => false
	): Promise<CompanionWriteResult> {
		let notePath = knownPath ? normalizePath(knownPath) : this.companionPath(rule, source.path);
		const known = knownPath ? this.app.vault.getAbstractFileByPath(notePath) : null;
		if (known instanceof TFile && !this.ownsSource(known, [source.path])) {
			console.warn(`${LOG} Refusing stale tracked companion path "${notePath}" for "${source.path}".`);
			notePath = this.companionPath(rule, source.path);
		}
		if (!(this.app.vault.getAbstractFileByPath(notePath) instanceof TFile) ||
			!this.ownsSource(this.app.vault.getAbstractFileByPath(notePath) as TFile, [source.path])) {
			notePath = this.allocatePath(notePath, source.path, isClaimed);
		}

		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			const update = await this.update(notePath, source, rule, transcription, knownMtime);
			return { path: notePath, ...update };
		}

		const template = await this.loadTemplate(rule);
		const hadPlaceholder = template.includes("{{transcription}}");
		let content = this.renderTemplate(template, source, rule, transcription);
		if (transcription && !hadPlaceholder) {
			content = `${content.trimEnd()}\n\n## Transcription\n\n${transcription}\n`;
		}
		await this.ensureFolder(notePath);
		await this.app.vault.create(notePath, content);
		const created = this.app.vault.getAbstractFileByPath(notePath);
		if (created instanceof TFile) {
			await this.writeTrackingFrontmatter(created, source, rule, !!transcription);
		}
		console.log(`${LOG} Created ${notePath}`);
		return { path: notePath, conflictPath: null };
	}

	async update(
		notePath: string,
		source: TFile,
		rule: CompanionRule,
		transcription?: string,
		knownMtime?: number
	): Promise<{ conflictPath: string | null; skipped?: boolean }> {
		const note = this.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) return { conflictPath: null };

		let conflictPath: string | null = null;
		if (knownMtime !== undefined && note.stat.mtime > knownMtime) {
			const policy = this.settings.conflictPolicy;
			if (policy === "keep-vault") return { conflictPath: null, skipped: true };
			if (policy === "save-both" || policy === "ask") {
				conflictPath = await this.availablePath(notePath.replace(/\.md$/i, `.conflict-${Date.now()}.md`));
				await this.ensureFolder(conflictPath);
				await this.app.vault.create(conflictPath, await this.app.vault.read(note));
			}
		}

		await this.writeTrackingFrontmatter(note, source, rule, !!transcription);
		if (transcription) await this.updateTranscriptionSection(note, transcription);
		return { conflictPath };
	}

	async rename(
		oldPath: string,
		desiredPath: string,
		sourcePath: string,
		oldSourcePath = sourcePath
	): Promise<CompanionMoveResult> {
		const note = this.app.vault.getAbstractFileByPath(oldPath);
		if (!(note instanceof TFile)) return { path: null, ownershipMismatch: false };
		if (!this.ownsSource(note, [oldSourcePath, sourcePath])) {
			console.warn(`${LOG} Refusing to rename unowned tracked note "${oldPath}".`);
			return { path: null, ownershipMismatch: true };
		}
		if (normalizePath(oldPath) === normalizePath(desiredPath)) {
			await this.rekeySourceOwnership(oldPath, sourcePath, [oldSourcePath, sourcePath]);
			return { path: normalizePath(oldPath), ownershipMismatch: false };
		}
		const path = this.allocatePath(desiredPath, sourcePath, () => false);
		if (path === oldPath) return { path, ownershipMismatch: false };
		await this.ensureFolder(path);
		await this.app.fileManager.renameFile(note, path);
		await this.rekeySourceOwnership(path, sourcePath, [oldSourcePath, sourcePath]);
		return { path, ownershipMismatch: false };
	}

	async applySourceDeletion(
		companionPath: string,
		policy: "keep" | "delete" | "archive",
		archiveFolder: string,
		sourceVaultPaths: string[]
	): Promise<CompanionMoveResult> {
		const note = this.app.vault.getAbstractFileByPath(companionPath);
		if (!(note instanceof TFile)) return { path: null, ownershipMismatch: false };
		if (!this.ownsSource(note, sourceVaultPaths)) {
			console.warn(`${LOG} Refusing destructive action on unowned tracked note "${companionPath}".`);
			return { path: null, ownershipMismatch: true };
		}
		if (policy === "keep") return { path: companionPath, ownershipMismatch: false };
		if (policy === "delete") {
			await this.app.vault.trash(note, true);
			return { path: null, ownershipMismatch: false };
		}
		const folder = archiveFolder.trim() || this.settings.companionArchiveFolder.trim() || "File Automations Archive";
		const desired = normalizePath(`${folder}/${note.name}`);
		const target = await this.availablePath(desired);
		await this.ensureFolder(target);
		await this.app.fileManager.renameFile(note, target);
		const archived = this.app.vault.getAbstractFileByPath(target);
		if (archived instanceof TFile) {
			await this.app.fileManager.processFrontMatter(archived, (fm) => {
				fm.fileAutomationsDetached = true;
			});
		}
		return { path: target, ownershipMismatch: false };
	}

	findCompanionByProperty(pdfVaultPath: string): string | null {
		const fileName = pdfVaultPath.split("/").pop() ?? pdfVaultPath;
		const stem = fileName.replace(/\.[^.]+$/, "");
		const pathStem = pdfVaultPath.replace(/\.[^.]+$/, "");
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm?.fileAutomationsDetached === true) continue;
			if (fm?.sourceVaultPath === pdfVaultPath) return file.path;
			const raw = fm?.companion;
			const linked = typeof raw === "string"
				? raw.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim()
				: typeof raw?.link === "string" ? raw.link : "";
			if ([fileName, stem, pdfVaultPath, pathStem].includes(linked)) return file.path;
		}
		return null;
	}

	ownsSource(note: TFile, sourceVaultPaths: string[]): boolean {
		const expected = new Set(sourceVaultPaths.map((path) => normalizePath(path)));
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
		if (typeof fm?.sourceVaultPath === "string" && expected.has(normalizePath(fm.sourceVaultPath))) {
			return true;
		}
		const expectedStems = new Set(Array.from(expected, (path) => path.replace(/\.[^.]+$/, "")));
		const legacy = typeof fm?.["companion-of"] === "string"
			? fm["companion-of"].replace(/^\[\[|\]\]$/g, "").split("|")[0].trim()
			: "";
		return !!legacy && expectedStems.has(normalizePath(legacy));
	}

	async rekeySourceOwnership(
		notePath: string,
		newSourcePath: string,
		acceptedSourcePaths: string[]
	): Promise<boolean> {
		const note = this.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile) || !this.ownsSource(note, acceptedSourcePaths)) {
			console.warn(`${LOG} Refusing to rekey unowned tracked note "${notePath}".`);
			return false;
		}
		const fileName = newSourcePath.split("/").pop() ?? newSourcePath;
		await this.app.fileManager.processFrontMatter(note, (fm) => {
			fm.companion = `[[${fileName}]]`;
			fm["companion-of"] = `[[${newSourcePath.replace(/\.[^.]+$/, "")}]]`;
			fm.sourceVaultPath = newSourcePath;
		});
		return true;
	}

	private allocatePath(desired: string, sourcePath: string, isClaimed: (path: string) => boolean): string {
		const normalized = normalizePath(desired);
		for (let suffix = 0; suffix < 10_000; suffix++) {
			const candidate = suffix === 0 ? normalized : normalized.replace(/\.md$/i, ` (${suffix + 1}).md`);
			const existing = this.app.vault.getAbstractFileByPath(candidate);
			if (!(existing instanceof TFile) && !isClaimed(candidate)) return candidate;
			if (existing instanceof TFile) {
				if (this.ownsSource(existing, [sourcePath]) && !isClaimed(candidate)) return candidate;
			}
		}
		throw new Error(`Unable to allocate a companion note path for ${sourcePath}`);
	}

	private async loadTemplate(rule: CompanionRule): Promise<string> {
		const path = (rule.templatePath ?? this.settings.companionNoteTemplatePath).trim();
		if (!path) return DEFAULT_TEMPLATE;
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? this.app.vault.read(file) : DEFAULT_TEMPLATE;
	}

	private renderTemplate(
		template: string,
		source: TFile,
		rule: CompanionRule,
		transcription?: string
	): string {
		const relativePath = relativePathForRule(rule, source.path);
		const timestamp = new Date(source.stat.mtime).toISOString();
		const syncDate = new Date().toISOString();
		const titleTemplate = (rule.title ?? this.settings.companionNoteTitle).trim();
		const title = (titleTemplate || "{{title}}")
			.replaceAll("{{title}}", source.basename)
			.replaceAll("{{fileName}}", source.name)
			.replaceAll("{{pairLabel}}", rule.label)
			.replaceAll("{{ruleLabel}}", rule.label)
			.replaceAll("{{relativePath}}", relativePath);
		return template
			.replaceAll("{{title}}", title)
			.replaceAll("{{fileName}}", source.name)
			.replaceAll("{{fileLink}}", `[[${source.basename}]]`)
			.replaceAll("{{sourceVaultPath}}", source.path)
			.replaceAll("{{sourceVaultStem}}", source.path.replace(/\.[^.]+$/, ""))
			.replaceAll("{{sourceDriveModifiedTime}}", timestamp)
			.replaceAll("{{lastUpdate}}", timestamp)
			.replaceAll("{{syncDate}}", syncDate)
			.replaceAll("{{driveFileId}}", "")
			.replaceAll("{{relativePath}}", relativePath)
			.replaceAll("{{pairLabel}}", rule.label)
			.replaceAll("{{ruleLabel}}", rule.label)
			.replaceAll("{{ruleId}}", rule.id)
			.replaceAll("{{transcription}}", transcription ?? "");
	}

	private async writeTrackingFrontmatter(
		note: TFile,
		source: TFile,
		rule: CompanionRule,
		transcribed: boolean
	): Promise<void> {
		await this.app.fileManager.processFrontMatter(note, (fm) => {
			// Preserve both legacy keys and values supplied by the user's template.
			if ("lastUpdate" in fm && !("sourceDriveModifiedTime" in fm)) {
				fm.sourceDriveModifiedTime = fm.lastUpdate;
				delete fm.lastUpdate;
			}
			fm.processed = false;
			fm.companion = `[[${source.name}]]`;
			fm["companion-of"] = `[[${source.path.replace(/\.[^.]+$/, "")}]]`;
			fm.sourceVaultPath = source.path;
			fm.sourceDriveModifiedTime = new Date(source.stat.mtime).toISOString();
			fm.syncDate = new Date().toISOString();
			fm.pairLabel = rule.label;
			fm.automationRuleId = rule.id;
			delete fm.fileAutomationsDetached;
			if (transcribed) fm.transcribed = true;
		});
	}

	private async updateTranscriptionSection(note: TFile, transcription: string): Promise<void> {
		const content = await this.app.vault.read(note);
		const start = content.search(/\n## Transcription(?:\r?\n|$)/);
		let next: string;
		if (start >= 0) {
			const bodyStart = start + 1;
			const nextHeading = content.indexOf("\n## ", bodyStart + "## Transcription".length);
			next = `${content.slice(0, start).trimEnd()}\n\n## Transcription\n\n${transcription}\n`;
			if (nextHeading >= 0) next += content.slice(nextHeading + 1);
		} else {
			next = `${content.trimEnd()}\n\n## Transcription\n\n${transcription}\n`;
		}
		await this.app.vault.modify(note, next);
	}

	private async availablePath(desired: string): Promise<string> {
		for (let index = 0; index < 10_000; index++) {
			const candidate = index === 0 ? desired : desired.replace(/(\.[^./]+)$/i, ` (${index + 1})$1`);
			if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
		}
		throw new Error(`Unable to allocate path near ${desired}`);
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const slash = filePath.lastIndexOf("/");
		if (slash < 0) return;
		const parts = filePath.slice(0, slash).split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.createFolder(current);
		}
	}
}
