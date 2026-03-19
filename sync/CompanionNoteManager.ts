import { App, TFile } from "obsidian";
import { DriveFile, PluginSettings, SyncPair } from "../types";

const LOG = "[DriveSync/Companion]";

const DEFAULT_TEMPLATE = `---
processed: false
lastUpdate: "{{lastUpdate}}"
syncDate: "{{syncDate}}"
driveFileId: "{{driveFileId}}"
pairLabel: "{{pairLabel}}"
---

# {{title}}

> [!info] Source
> File: [[{{title}}]]
> Drive ID: \`{{driveFileId}}\`
> Last updated: {{lastUpdate}}
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
	 */
	async create(
		file: DriveFile,
		pair: SyncPair,
		relPath: string,
		pdfVaultPath: string
	): Promise<string> {
		const notePath = this.companionPath(pair, relPath, file.name);
		console.log(`${LOG} Creating companion note: ${notePath}`);

		const template = await this.loadTemplate(pair);
		const content = this.renderTemplate(template, file, pair, relPath, pdfVaultPath);

		await this.ensureFolder(notePath);

		const exists = await this.app.vault.adapter.exists(notePath);
		if (exists) {
			console.log(`${LOG} Companion note already exists — overwriting: ${notePath}`);
			await this.app.vault.adapter.write(notePath, content);
		} else {
			await this.app.vault.create(notePath, content);
		}

		console.log(`${LOG} Companion note created: ${notePath}`);
		return notePath;
	}

	/**
	 * Update frontmatter of an existing companion note when its PDF is re-downloaded.
	 * Only touches processed, lastUpdate, syncDate, and pairLabel — preserves the rest of the note.
	 */
	async update(companionNotePath: string, file: DriveFile, pair: SyncPair): Promise<void> {
		console.log(`${LOG} Updating companion note frontmatter: ${companionNotePath}`);

		const tFile = this.app.vault.getAbstractFileByPath(companionNotePath);
		if (!(tFile instanceof TFile)) {
			console.warn(`${LOG} Companion note not found in vault — skipping update: ${companionNotePath}`);
			return;
		}

		await this.app.fileManager.processFrontMatter(tFile, (fm) => {
			fm["processed"] = false;
			fm["lastUpdate"] = file.modifiedTime;
			fm["syncDate"] = new Date().toISOString();
			fm["pairLabel"] = pair.label;
		});

		console.log(`${LOG} Companion note frontmatter updated: ${companionNotePath}`);
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

	private renderTemplate(
		template: string,
		file: DriveFile,
		pair: SyncPair,
		relPath: string,
		_pdfVaultPath: string
	): string {
		const stem = file.name.replace(/\.pdf$/i, "");
		const syncDate = new Date().toISOString();

		return template
			.replaceAll("{{title}}", stem)
			.replaceAll("{{fileName}}", file.name)
			.replaceAll("{{fileLink}}", `[[${stem}]]`)
			.replaceAll("{{lastUpdate}}", file.modifiedTime)
			.replaceAll("{{syncDate}}", syncDate)
			.replaceAll("{{driveFileId}}", file.id)
			.replaceAll("{{relativePath}}", relPath)
			.replaceAll("{{pairLabel}}", pair.label);
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
