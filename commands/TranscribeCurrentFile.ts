import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";
import type DriveFolderSyncPlugin from "../main";
import { GeminiClient } from "../ai/GeminiClient";
import { MistralClient } from "../ai/MistralClient";

// Obsidian bundles moment.js as a global
declare const moment: () => { format(pattern: string): string };

const LOG = "[DriveSync/Transcribe]";

export function openTranscribePickerForFile(app: App, plugin: DriveFolderSyncPlugin, file: TFile): void {
	new DestinationPickerModal(app, plugin, file).open();
}

export async function transcribeCurrentFile(plugin: DriveFolderSyncPlugin): Promise<void> {
	const activeFile = plugin.app.workspace.getActiveFile();
	if (!activeFile) {
		new Notice("No file is currently open.");
		return;
	}
	if (!activeFile.path.toLowerCase().endsWith(".pdf")) {
		new Notice("Transcription only supports PDF files.");
		return;
	}
	if (!plugin.settings.geminiEnabled) {
		new Notice("AI transcription is not enabled. Enable it in Drive Sync settings.");
		return;
	}
	const provider = plugin.settings.transcriptionProvider ?? "gemini";
	if (provider === "mistral" && !plugin.settings.mistralApiKey) {
		new Notice("Mistral API key is not set. Add it in Drive Sync settings.");
		return;
	}
	if (provider === "gemini" && !plugin.settings.geminiApiKey) {
		new Notice("Gemini API key is not set. Add it in Drive Sync settings.");
		return;
	}

	new DestinationPickerModal(plugin.app, plugin, activeFile).open();
}

// ── Destination types ─────────────────────────────────────────────────────────

type DestKind =
	| { type: "companion" }
	| { type: "daily" }
	| { type: "note"; file: TFile };

type OverwriteAction = "skip" | "append" | "replace";

// ── Destination picker ────────────────────────────────────────────────────────

class DestinationPickerModal extends Modal {
	constructor(
		app: App,
		private plugin: DriveFolderSyncPlugin,
		private pdfFile: TFile
	) {
		super(app);
	}

	onOpen(): void {
		// If a default destination is configured, skip the picker entirely
		const defaultDest = this.plugin.settings.transcribeDefaultDest ?? "ask";
		if (defaultDest === "companion") {
			this.close();
			void this.proceed({ type: "companion" });
			return;
		}
		if (defaultDest === "daily") {
			this.close();
			void this.proceed({ type: "daily" });
			return;
		}
		if (defaultDest === "note") {
			this.close();
			new NotePickerModal(this.app, (file) => void this.proceed({ type: "note", file })).open();
			return;
		}

		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Transcribe "${this.pdfFile.basename}" to…` });

		new Setting(contentEl)
			.setName("Companion note")
			.setDesc("Create or update the companion note alongside this PDF")
			.addButton((b) =>
				b.setButtonText("Select").setCta().onClick(() => {
					this.close();
					void this.proceed({ type: "companion" });
				})
			);

		new Setting(contentEl)
			.setName("Today's daily note")
			.setDesc("Append transcription to today's daily note")
			.addButton((b) =>
				b.setButtonText("Select").onClick(() => {
					this.close();
					void this.proceed({ type: "daily" });
				})
			);

		new Setting(contentEl)
			.setName("Pick a note…")
			.setDesc("Choose any markdown note in your vault")
			.addButton((b) =>
				b.setButtonText("Browse").onClick(() => {
					this.close();
					new NotePickerModal(this.app, (file) =>
						void this.proceed({ type: "note", file })
					).open();
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async proceed(dest: DestKind): Promise<void> {
		const destFile = await this.resolveDestination(dest);
		if (!destFile) return;

		const hasExisting = await hasTranscriptionSection(this.app, destFile);
		if (hasExisting) {
			new OverwriteModal(this.app, destFile.name, async (action) => {
				if (action === "skip") return;
				await this.runTranscription(destFile, action, dest.type);
			}).open();
		} else {
			await this.runTranscription(destFile, "replace", dest.type);
		}
	}

	private async resolveDestination(dest: DestKind): Promise<TFile | null> {
		switch (dest.type) {
			case "companion":
				return this.resolveCompanion();
			case "daily":
				return this.resolveDailyNote();
			case "note":
				return dest.file;
		}
	}

	private async resolveCompanion(): Promise<TFile | null> {
		const { app, plugin, pdfFile } = this;

		// Check manifest for an existing companion
		const manifestEntry = plugin.manifestStore.findByVaultPath(pdfFile.path);
		if (manifestEntry) {
			const [, entry] = manifestEntry;
			if (entry.companionPath) {
				const existing = app.vault.getAbstractFileByPath(entry.companionPath);
				if (existing instanceof TFile) return existing;
			}
		}

		// Determine companion path using fallback folder setting
		const fallbackFolder = plugin.settings.transcribeCompanionFallbackFolder?.trim() ?? "";
		let companionPath: string;

		if (fallbackFolder === "/") {
			companionPath = normalizePath(`${pdfFile.basename}.md`);
		} else if (fallbackFolder) {
			const resolvedFolder = resolvePathTokens(fallbackFolder, pdfFile.path);
			companionPath = normalizePath(`${resolvedFolder}/${pdfFile.basename}.md`);
		} else {
			// Default: place alongside the PDF
			const dir = pdfFile.parent ? pdfFile.parent.path : "";
			companionPath = normalizePath(
				dir ? `${dir}/${pdfFile.basename}.md` : `${pdfFile.basename}.md`
			);
		}

		const existing = app.vault.getAbstractFileByPath(companionPath);
		if (existing instanceof TFile) return existing;

		// Create a stub companion note
		try {
			await ensureFolder(app, companionPath);
			return await app.vault.create(companionPath, `# ${pdfFile.basename}\n\n`);
		} catch (e) {
			new Notice(`Failed to create companion note: ${(e as Error).message}`);
			return null;
		}
	}

	private async resolveDailyNote(): Promise<TFile | null> {
		const { app, plugin } = this;
		const dailyPath = resolveDailyNotePath(app, plugin);

		const existing = app.vault.getAbstractFileByPath(dailyPath);
		if (existing instanceof TFile) return existing;

		try {
			await ensureFolder(app, dailyPath);
			const heading = dailyPath.replace(/\.md$/, "").split("/").pop() ?? "";
			return await app.vault.create(dailyPath, `# ${heading}\n\n`);
		} catch (e) {
			new Notice(`Failed to create daily note: ${(e as Error).message}`);
			return null;
		}
	}

	private async runTranscription(
		destFile: TFile,
		mode: "append" | "replace",
		destType: "companion" | "daily" | "note"
	): Promise<void> {
		const notice = new Notice(`Transcribing "${this.pdfFile.basename}"…`, 0);
		try {
			const pdfBytes = await this.app.vault.readBinary(this.pdfFile);
			const provider = this.plugin.settings.transcriptionProvider ?? "gemini";
			const client: GeminiClient | MistralClient =
				provider === "mistral"
					? new MistralClient(this.plugin.settings.mistralApiKey)
					: new GeminiClient(
						this.plugin.settings.geminiApiKey,
						this.plugin.settings.geminiModel,
						this.plugin.settings.geminiPrompt
					);
			const transcription = await client.transcribePdf(pdfBytes);
			notice.hide();

			const template = await this.resolveTemplate(destType);
			await writeTranscription(this.app, destFile, transcription, mode, this.pdfFile.name, template);
			new Notice(`Transcription written to "${destFile.name}"`);
			await this.recordTranscription(pdfBytes, destFile);
		} catch (e) {
			notice.hide();
			console.error(LOG, "Transcription failed:", e);
			new Notice(`Transcription failed: ${(e as Error).message}`);
		}
	}

	private async resolveTemplate(destType: "companion" | "daily" | "note"): Promise<string | undefined> {
		if (destType === "companion") {
			const filePath = (this.plugin.settings.transcribeCompanionTemplatePath ?? "").trim();
			if (filePath) {
				try {
					const exists = await this.app.vault.adapter.exists(filePath);
					if (exists) return await this.app.vault.adapter.read(filePath);
				} catch {}
			}
			return (this.plugin.settings.transcribeCompanionTemplate ?? "").trim() || undefined;
		}
		if (destType === "daily") {
			return (this.plugin.settings.transcribeDailyTemplate ?? "").trim() || undefined;
		}
		return (this.plugin.settings.transcribeNoteTemplate ?? "").trim() || undefined;
	}

	private async recordTranscription(pdfBytes: ArrayBuffer, destFile: TFile): Promise<void> {
		const store = this.plugin.transcriptionStore;
		if (!store) return;

		const { analyzePdf } = await import("../ai/PdfPageHasher");
		const info = analyzePdf(pdfBytes);

		// Find Drive metadata for this PDF via the manifest
		const manifestEntry = this.plugin.manifestStore.findByVaultPath(this.pdfFile.path);
		const driveFileId = manifestEntry ? manifestEntry[0] : null;
		const driveModifiedTime = manifestEntry ? manifestEntry[1].driveModifiedTime : "";

		if (!driveFileId) return; // file not synced from Drive — skip tracking

		const isCompanion = manifestEntry && manifestEntry[1].companionPath === destFile.path;
		const isDaily = destFile.path.includes(moment().format("YYYY-MM-DD"));
		const destType = isCompanion ? "companion" : isDaily ? "daily" : "note";

		store.recordTranscription(driveFileId, this.pdfFile.path, info.hash, info.pageCount, driveModifiedTime, {
			type: destType as "companion" | "daily" | "note",
			path: destFile.path,
			transcribedAt: new Date().toISOString(),
		});
		await store.save();
	}
}

// ── Overwrite modal ───────────────────────────────────────────────────────────

class OverwriteModal extends Modal {
	constructor(
		app: App,
		private noteName: string,
		private onConfirm: (action: OverwriteAction) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Transcription already exists" });
		contentEl.createEl("p", {
			text: `"${this.noteName}" already has a ## Transcription section. What would you like to do?`,
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Skip").onClick(() => {
					this.close();
					this.onConfirm("skip");
				})
			)
			.addButton((b) =>
				b.setButtonText("Append").onClick(() => {
					this.close();
					this.onConfirm("append");
				})
			)
			.addButton((b) =>
				b.setButtonText("Replace").setCta().onClick(() => {
					this.close();
					this.onConfirm("replace");
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Note picker ───────────────────────────────────────────────────────────────

class NotePickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Pick a note…");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveDailyNotePath(app: App, plugin: DriveFolderSyncPlugin): string {
	// 1. Core Daily Notes plugin settings
	try {
		const dp = (app as any).internalPlugins?.getPluginById?.("daily-notes");
		if (dp?.enabled) {
			const opts = dp.instance?.options ?? {};
			const format: string = opts.format || "YYYY-MM-DD";
			const folder: string = (opts.folder ?? "").trim();
			const dateStr = moment().format(format);
			return normalizePath(folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`);
		}
	} catch {}

	// 2. Plugin periodicNotesPaths.daily template
	const tpl = plugin.settings.periodicNotesPaths?.daily?.trim();
	if (tpl) {
		const dateStr = tpl.replace(/\{\{([^}]+)\}\}/g, (_: string, fmt: string) =>
			moment().format(fmt)
		);
		return normalizePath(`${dateStr}.md`);
	}

	// 3. Hard fallback: YYYY-MM-DD.md in vault root
	return normalizePath(`${moment().format("YYYY-MM-DD")}.md`);
}

function resolvePathTokens(template: string, vaultFilePath: string): string {
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
		return match;
	});
}

async function hasTranscriptionSection(app: App, file: TFile): Promise<boolean> {
	try {
		const content = await app.vault.read(file);
		return content.includes("## Transcription");
	} catch {
		return false;
	}
}

async function writeTranscription(
	app: App,
	file: TFile,
	transcription: string,
	mode: "append" | "replace",
	sourceName: string,
	template?: string
): Promise<void> {
	await app.vault.process(file, (content) => {
		const HEADER = "## Transcription";

		let newBlock: string;
		if (template) {
			const stem = sourceName.replace(/\.pdf$/i, "");
			const date = moment().format("YYYY-MM-DD");
			newBlock = template
				.replaceAll("{{transcription}}", transcription)
				.replaceAll("{{title}}", stem)
				.replaceAll("{{fileName}}", sourceName)
				.replaceAll("{{date}}", date)
				.replaceAll("{{link}}", `[[${stem}]]`)
				.replaceAll("{{embed}}", `![[${sourceName}]]`);
		} else {
			newBlock = `${HEADER}\n\n*Source: ${sourceName}*\n\n${transcription}`;
		}

		const sectionIdx = content.indexOf("\n" + HEADER);

		if (sectionIdx !== -1) {
			if (mode === "replace") {
				const nextSection = content.indexOf("\n## ", sectionIdx + 1);
				const end = nextSection !== -1 ? nextSection : content.length;
				return content.slice(0, sectionIdx) + "\n\n" + newBlock + content.slice(end);
			} else {
				// append: add a dated sub-entry inside the section
				const nextSection = content.indexOf("\n## ", sectionIdx + 1);
				const insertAt = nextSection !== -1 ? nextSection : content.length;
				const ts = moment().format("YYYY-MM-DD");
				const block = `\n\n### ${ts} — ${sourceName}\n\n${transcription}`;
				return content.slice(0, insertAt) + block + content.slice(insertAt);
			}
		}

		// No existing section: append at end
		return content.trimEnd() + "\n\n" + newBlock;
	});
}

async function ensureFolder(app: App, filePath: string): Promise<void> {
	const dir = filePath.substring(0, filePath.lastIndexOf("/"));
	if (!dir) return;
	const segments = dir.split("/").filter(Boolean);
	let current = "";
	for (const seg of segments) {
		current = current ? `${current}/${seg}` : seg;
		if (!(await app.vault.adapter.exists(current))) {
			await app.vault.createFolder(current);
		}
	}
}
