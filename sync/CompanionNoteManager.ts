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
	 * If companionNotesFolder is set: <root>/<pair.label>/<relPath>/<stem>.md
	 * If empty: <pair.vaultDestFolder>/<relPath>/<stem>.md  (alongside PDF)
	 */
	companionPath(pair: SyncPair, relPath: string, pdfName: string): string {
		const stem = pdfName.replace(/\.pdf$/i, "");
		const safeLabel = pair.label.replace(/[/\\:*?"<>|]/g, "_");

		let base: string;
		if (this.settings.companionNotesFolder) {
			base = relPath
				? `${this.settings.companionNotesFolder}/${safeLabel}/${relPath}`
				: `${this.settings.companionNotesFolder}/${safeLabel}`;
		} else {
			base = relPath
				? `${pair.vaultDestFolder}/${relPath}`
				: pair.vaultDestFolder;
		}

		return `${base}/${stem}.md`;
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

		const template = await this.loadTemplate();
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
	 * Returns the new path.
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

	private async loadTemplate(): Promise<string> {
		const templatePath = this.settings.companionNoteTemplatePath.trim();
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
