import { App, TFile } from "obsidian";
import { DriveFile, PluginSettings, SyncPair } from "../types";

const LOG = "[DriveSync/Companion]";

const DEFAULT_TEMPLATE = `---
processed: false
companion: "[[{{fileName}}]]"
companion-of: "[[{{sourceVaultStem}}]]"
sourceVaultPath: "{{sourceVaultPath}}"
sourceDriveModifiedTime: "{{sourceDriveModifiedTime}}"
syncDate: "{{syncDate}}"
driveFileId: "{{driveFileId}}"
pairLabel: "{{pairLabel}}"
---

# {{title}}

> [!info] Source
> File: [[{{title}}]]
> Drive ID: \`{{driveFileId}}\`
> Last updated: {{sourceDriveModifiedTime}}
> Relative path: {{relativePath}}

## Notes

`;

export class CompanionNoteManager {
	constructor(private app: App, private settings: PluginSettings) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	/**
	 * Compute where the companion note for a given PDF should live.
	 *
	 * Effective folder resolution order:
	 *   1. pair.companionNotesFolder (per-pair override)
	 *   2. settings.companionNotesFolder (global)
	 *   3. empty → place alongside the PDF
	 *
	 * If the resolved folder contains `{{...}}` tokens, they are resolved
	 * using the PDF's vault path segments:
	 *   {{RootFolder}} → first path segment (e.g. "Boox")
	 *   {{folderL1}}   → direct parent dir of the file (e.g. "Active")
	 *   {{folderL2}}   → grandparent dir (e.g. "Books")
	 *   {{folderLN}}   → Nth level up from the file
	 *
	 * In token mode (folder contains `{{`) the resolved folder is used as-is
	 * (no safeLabel/relPath appended) — tokens provide full location control.
	 * In classic mode the old behaviour applies: <folder>/<safeLabel>/<relPath>/.
	 */
	companionPath(pair: SyncPair, relPath: string, pdfName: string): string {
		const stem = pdfName.replace(/\.pdf$/i, "");

		const effectiveFolder = (
			pair.companionNotesFolder !== undefined
				? pair.companionNotesFolder
				: this.settings.companionNotesFolder
		).trim();

		if (effectiveFolder === "/") {
			// Vault root sentinel — place note directly in the root
			return `${stem}.md`;
		}

		if (effectiveFolder) {
			if (effectiveFolder.includes("{{")) {
				// Token mode — resolve tokens and use folder as the full base path
				const pdfVaultPath = relPath
					? `${pair.vaultDestFolder}/${relPath}/${pdfName}`
					: `${pair.vaultDestFolder}/${pdfName}`;
				const resolvedFolder = this.resolvePathTokens(effectiveFolder, pdfVaultPath);
				return `${resolvedFolder}/${stem}.md`;
			} else {
				// Classic mode — append safeLabel + relPath
				const safeLabel = pair.label.replace(/[/\\:*?"<>|]/g, "_");
				const base = relPath
					? `${effectiveFolder}/${safeLabel}/${relPath}`
					: `${effectiveFolder}/${safeLabel}`;
				return `${base}/${stem}.md`;
			}
		} else {
			// No folder — place alongside the PDF
			const base = relPath
				? `${pair.vaultDestFolder}/${relPath}`
				: pair.vaultDestFolder;
			return `${base}/${stem}.md`;
		}
	}

	/**
	 * Create a brand-new companion note from the template.
	 * Returns the vault path of the created note.
	 * If `transcription` is provided it will be substituted for {{transcription}} in the template,
	 * or appended as a ## Transcription section if the template doesn't use that placeholder.
	 */
	async create(
		file: DriveFile,
		pair: SyncPair,
		relPath: string,
		pdfVaultPath: string,
		transcription?: string
	): Promise<string> {
		const notePath = this.companionPath(pair, relPath, file.name);
		console.log(`${LOG} Creating companion note: ${notePath}`);

		const template = await this.loadTemplate(pair);
		const templateHasTranscription = template.includes("{{transcription}}");
		let content = this.renderTemplate(template, file, pair, relPath, pdfVaultPath, transcription);

		if (transcription && !templateHasTranscription) {
			content = content.trimEnd() + "\n\n## Transcription\n\n" + transcription + "\n";
		}

		await this.ensureFolder(notePath);

		const exists = await this.app.vault.adapter.exists(notePath);
		if (exists) {
			// Adopt the existing file — update its tracking frontmatter instead of overwriting user content
			console.log(`${LOG} Companion note already exists — adopting: ${notePath}`);
			await this.update(notePath, file, pair, pdfVaultPath, transcription);
		} else {
			await this.app.vault.create(notePath, content);
			const createdFile = this.app.vault.getAbstractFileByPath(notePath);
			if (createdFile instanceof TFile) {
				await this.app.fileManager.processFrontMatter(createdFile, (fm) => {
					const stem = pdfVaultPath.replace(/\.[^.]+$/, "");
					fm["companion"] = `[[${file.name}]]`;
					fm["companion-of"] = `[[${stem}]]`;
					fm["sourceVaultPath"] = pdfVaultPath;
					fm["sourceDriveModifiedTime"] = file.modifiedTime;
					if (transcription) fm["transcribed"] = true;
				});
			}
		}

		console.log(`${LOG} Companion note created: ${notePath}`);
		return notePath;
	}

	/**
	 * Update frontmatter of an existing companion note when its PDF is re-downloaded.
	 * Preserves user-added frontmatter; refreshes sync-tracking fields.
	 * Migrates legacy `lastUpdate` → `sourceDriveModifiedTime` on first write.
	 * If `transcription` is provided, updates or appends the ## Transcription section and sets transcribed: true.
	 * If `knownMtime` is provided, detects concurrent edits: creates a `.conflict-<ts>.md` backup
	 * when the file's current mtime exceeds the last-known mtime.
	 */
	async update(
		companionNotePath: string,
		file: DriveFile,
		pair: SyncPair,
		pdfVaultPath?: string,
		transcription?: string,
		knownMtime?: number
	): Promise<{ conflictPath: string | null }> {
		console.log(`${LOG} Updating companion note frontmatter: ${companionNotePath}`);

		const tFile = this.app.vault.getAbstractFileByPath(companionNotePath);
		if (!(tFile instanceof TFile)) {
			console.warn(`${LOG} Companion note not found in vault — skipping update: ${companionNotePath}`);
			return { conflictPath: null };
		}

		// 5.4: Detect concurrent edits — backup if user modified companion since last sync
		let conflictPath: string | null = null;
		if (knownMtime !== undefined) {
			const stat = await this.app.vault.adapter.stat(companionNotePath);
			if (stat && stat.mtime > knownMtime) {
				conflictPath = companionNotePath.replace(/\.md$/i, `.conflict-${Date.now()}.md`);
				console.log(`${LOG} Companion edited since last sync — creating conflict backup: ${conflictPath}`);
				const currentContent = await this.app.vault.read(tFile);
				await this.ensureFolder(conflictPath);
				await this.app.vault.create(conflictPath, currentContent);
			}
		}

		await this.app.fileManager.processFrontMatter(tFile, (fm) => {
			// Migration: rename legacy lastUpdate → sourceDriveModifiedTime
			if ("lastUpdate" in fm && !("sourceDriveModifiedTime" in fm)) {
				fm["sourceDriveModifiedTime"] = fm["lastUpdate"];
				delete fm["lastUpdate"];
			}
			fm["processed"] = false;
			fm["sourceDriveModifiedTime"] = file.modifiedTime;
			fm["syncDate"] = new Date().toISOString();
			fm["pairLabel"] = pair.label;
			if (pdfVaultPath) {
				const pdfName = pdfVaultPath.split("/").pop() ?? pdfVaultPath;
				const stem = pdfVaultPath.replace(/\.[^.]+$/, "");
				fm["companion"] = `[[${pdfName}]]`;
				fm["companion-of"] = `[[${stem}]]`;
				fm["sourceVaultPath"] = pdfVaultPath;
			}
			if (transcription) fm["transcribed"] = true;
		});

		if (transcription) {
			await this.updateTranscriptionSection(tFile, transcription);
		}

		console.log(`${LOG} Companion note frontmatter updated: ${companionNotePath}`);
		return { conflictPath };
	}

	/**
	 * Rename a companion note (called when its associated PDF is renamed in Drive).
	 */
	async rename(oldPath: string, newPath: string): Promise<void> {
		console.log(`${LOG} Renaming companion note: ${oldPath} → ${newPath}`);

		const tFile = this.app.vault.getAbstractFileByPath(oldPath);
		if (!(tFile instanceof TFile)) {
			console.warn(`${LOG} Companion note not found for rename: ${oldPath}`);
			return;
		}

		await this.ensureFolder(newPath);
		await this.app.fileManager.renameFile(tFile, newPath);
		console.log(`${LOG} Companion note renamed to: ${newPath}`);
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	/**
	 * Resolve {{RootFolder}}, {{folderL1}}, {{folderL2}} … tokens in a path template
	 * using the segments of the PDF's vault path (directory part only).
	 *
	 * Given vaultFilePath = "Boox/Books/Active/file.pdf":
	 *   dirs = ["Boox", "Books", "Active"]
	 *   {{RootFolder}} → "Boox"   (dirs[0])
	 *   {{folderL1}}   → "Active" (dirs[dirs.length - 1], direct parent)
	 *   {{folderL2}}   → "Books"  (dirs[dirs.length - 2])
	 */
	private resolvePathTokens(template: string, vaultFilePath: string): string {
		const parts = vaultFilePath.split("/");
		parts.pop(); // strip filename
		const dirs = parts.filter(Boolean);

		return template.replace(/\{\{([^}]+)\}\}/g, (match, token: string) => {
			if (token === "RootFolder") return dirs[0] ?? "";
			const lm = token.match(/^folderL(\d+)$/);
			if (lm) {
				const level = parseInt(lm[1], 10);
				return dirs[dirs.length - level] ?? "";
			}
			return match; // leave unrecognised tokens as-is
		});
	}

	/**
	 * Load the template for a given pair, respecting per-pair override then global.
	 */
	private async loadTemplate(pair?: SyncPair): Promise<string> {
		const templatePath = (
			pair?.companionNoteTemplatePath !== undefined
				? pair.companionNoteTemplatePath
				: this.settings.companionNoteTemplatePath
		).trim();

		if (!templatePath) return DEFAULT_TEMPLATE;

		try {
			const exists = await this.app.vault.adapter.exists(templatePath);
			if (!exists) {
				console.warn(`${LOG} Template file not found at "${templatePath}" — using default`);
				return DEFAULT_TEMPLATE;
			}
			const content = await this.app.vault.adapter.read(templatePath);
			console.log(`${LOG} Loaded template from: ${templatePath}`);
			return content;
		} catch (e) {
			console.error(`${LOG} Failed to read template — using default:`, e);
			return DEFAULT_TEMPLATE;
		}
	}

	private resolveTitle(file: DriveFile, pair: SyncPair, relPath: string): string {
		const stem = file.name.replace(/\.pdf$/i, "");
		const titleTemplate = (
			pair.companionNoteTitle !== undefined
				? pair.companionNoteTitle
				: this.settings.companionNoteTitle
		).trim();

		if (!titleTemplate) return stem;

		return titleTemplate
			.replaceAll("{{title}}", stem)
			.replaceAll("{{fileName}}", file.name)
			.replaceAll("{{pairLabel}}", pair.label)
			.replaceAll("{{relativePath}}", relPath);
	}

	private renderTemplate(
		template: string,
		file: DriveFile,
		pair: SyncPair,
		relPath: string,
		pdfVaultPath: string,
		transcription?: string
	): string {
		const stem = file.name.replace(/\.pdf$/i, "");
		const syncDate = new Date().toISOString();
		const title = this.resolveTitle(file, pair, relPath);
		const sourceVaultStem = pdfVaultPath.replace(/\.[^.]+$/, "");

		return template
			.replaceAll("{{title}}", title)
			.replaceAll("{{fileName}}", file.name)
			.replaceAll("{{fileLink}}", `[[${stem}]]`)
			.replaceAll("{{sourceVaultPath}}", pdfVaultPath)
			.replaceAll("{{sourceVaultStem}}", sourceVaultStem)
			.replaceAll("{{sourceDriveModifiedTime}}", file.modifiedTime)
			.replaceAll("{{lastUpdate}}", file.modifiedTime)
			.replaceAll("{{syncDate}}", syncDate)
			.replaceAll("{{driveFileId}}", file.id)
			.replaceAll("{{relativePath}}", relPath)
			.replaceAll("{{pairLabel}}", pair.label)
			.replaceAll("{{transcription}}", transcription ?? "");
	}

	private async updateTranscriptionSection(tFile: TFile, transcription: string): Promise<void> {
		const content = await this.app.vault.read(tFile);
		const header = "## Transcription";
		const headerWithNewline = "\n" + header;

		let newContent: string;
		const sectionIdx = content.indexOf(headerWithNewline);
		if (sectionIdx !== -1) {
			// Replace existing section up to the next ## heading or end of file
			const searchFrom = sectionIdx + 1;
			const nextSection = content.indexOf("\n## ", searchFrom);
			const sectionEnd = nextSection !== -1 ? nextSection : content.length;
			newContent =
				content.slice(0, sectionIdx) +
				"\n\n" + header + "\n\n" + transcription + "\n" +
				content.slice(sectionEnd);
		} else {
			newContent = content.trimEnd() + "\n\n" + header + "\n\n" + transcription + "\n";
		}

		await this.app.vault.modify(tFile, newContent);
		console.log(`${LOG} Transcription section updated in: ${tFile.path}`);
	}

	/**
	 * Scan vault notes for one that declares itself a companion of the given PDF
	 * via the `companion` frontmatter property, e.g. companion: "[[Link File.pdf]]".
	 * Matches by filename (with or without extension) or full vault path.
	 * Returns the note's vault path if found, null otherwise.
	 */
	findCompanionByProperty(pdfVaultPath: string): string | null {
		const pdfName = pdfVaultPath.split("/").pop() ?? "";
		const pdfStem = pdfName.replace(/\.[^.]+$/, "");
		const pdfPathStem = pdfVaultPath.replace(/\.[^.]+$/, "");

		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const raw = fm?.companion;
			if (raw == null) continue;

			let linkTarget: string | null = null;
			if (typeof raw === "string") {
				const m = raw.match(/^\[\[(.+?)\]\]$/);
				linkTarget = m ? m[1] : null;
			} else if (typeof raw === "object" && typeof raw.link === "string") {
				linkTarget = raw.link;
			}

			if (!linkTarget) continue;

			const t = linkTarget.split("|")[0].trim();
			if (t === pdfName || t === pdfStem || t === pdfVaultPath || t === pdfPathStem) {
				console.log(`${LOG} Found companion via property: ${file.path} → ${pdfVaultPath}`);
				return file.path;
			}
		}
		return null;
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));
		if (!dir) return;

		const segments = dir.split("/").filter(Boolean);
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			const exists = await this.app.vault.adapter.exists(current);
			if (!exists) {
				console.log(`${LOG} Creating folder: ${current}`);
				await this.app.vault.createFolder(current);
			}
		}
	}
}
