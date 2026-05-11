import { App, TFile } from "obsidian";
import { GoogleAuth } from "../auth/GoogleAuth";
import { DownloadManager } from "./DownloadManager";
import { SyncManifestStore } from "./SyncManifest";
import { CompanionNoteManager } from "./CompanionNoteManager";
import { AutomationEngine } from "../automation/AutomationEngine";
import { GeminiClient } from "../ai/GeminiClient";
import {
	DeletionBehavior,
	DriveFile,
	DriveFileEntry,
	DriveFolder,
	ManifestEntry,
	PluginSettings,
	SyncPair,
	SyncResult,
} from "../types";

const FILES_API = "https://www.googleapis.com/drive/v3/files";
const LOG = "[DriveSync/Sync]";

export class DriveSync {
	private geminiClient: GeminiClient | null = null;

	constructor(
		private auth: GoogleAuth,
		private downloader: DownloadManager,
		private settings: PluginSettings,
		private app: App,
		private manifest: SyncManifestStore,
		private companion: CompanionNoteManager,
		private automationEngine?: AutomationEngine
	) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
		this.geminiClient = null; // invalidate cached client on settings change
	}

	private getGeminiClient(): GeminiClient | null {
		if (!this.settings.geminiApiKey) return null;

		const hasTranscriptionAutomation = this.settings.automations.some(
			(a) =>
				a.enabled &&
				(a.action.type === "transcribe_to_companion" ||
					a.action.type === "transcribe_to_periodic_note")
		);

		if (!this.settings.geminiEnabled && !hasTranscriptionAutomation) return null;

		if (!this.geminiClient) {
			this.geminiClient = new GeminiClient(
				this.settings.geminiApiKey,
				this.settings.geminiModel || "gemini-2.0-flash",
				this.settings.geminiPrompt || "Transcribe all text visible in this PDF exactly as written, preserving structure. Return plain text only."
			);
		}
		return this.geminiClient;
	}

	async sync(dryRun = false): Promise<SyncResult> {
		await this.manifest.load();

		console.log(`${LOG} Fetching access token`);
		const token = await this.auth.getValidAccessToken();

		const result: SyncResult = {
			downloaded: 0,
			skipped: 0,
			errors: 0,
			removed: 0,
			moved: 0,
			archived: 0,
			timestamp: Date.now(),
			pairs: {},
			...(dryRun ? { wouldDownload: [], wouldRemove: [] } : {}),
		};

		const activePairs = this.settings.syncPairs.filter(
			(p) => p.enabled && p.driveFolderId.trim()
		);
		console.log(`${LOG} Active sync pairs: ${activePairs.length}${dryRun ? " (dry run)" : ""}`);

		// Pre-collect Drive archive folder IDs (one API call, shared across all pairs)
		const archivedIds = this.settings.driveArchiveFolderId
			? await this.collectArchiveIds(token)
			: new Set<string>();
		if (archivedIds.size > 0) {
			console.log(`${LOG} Drive archive folder contains ${archivedIds.size} tracked file(s)`);
		}

		// ── Phase 1: process files for ALL pairs ─────────────────────────────
		// Must complete before any deletion pass so cross-pair moves update pairId
		// in the manifest before Pair 1's deletion pass runs.
		const pairSeenIds = new Map<string, Set<string>>();
		const globalSeenIds = new Set<string>();

		for (const pair of activePairs) {
			console.log(`${LOG} [Phase 1] Processing pair "${pair.label}" → "${pair.vaultDestFolder}"`);
			try {
				const { pairResult, seenIds } = await this.syncPairFiles(pair, token, dryRun);
				pairSeenIds.set(pair.id, seenIds);
				seenIds.forEach((id) => globalSeenIds.add(id));
				result.downloaded += pairResult.downloaded;
				result.skipped += pairResult.skipped;
				result.moved! += pairResult.moved ?? 0;
				result.errors += pairResult.errors;
				result.pairs![pair.id] = pairResult;
				if (dryRun) {
					result.wouldDownload!.push(...(pairResult.wouldDownload ?? []));
				}
			} catch (e) {
				console.error(`${LOG} Pair "${pair.label}" file processing failed:`, e);
				result.errors++;
				result.pairs![pair.id] = { downloaded: 0, skipped: 0, errors: 1, removed: 0, moved: 0, archived: 0 };
			}
		}

		// ── Phase 2: deletion passes for ALL pairs ───────────────────────────
		if (!dryRun) {
			for (const pair of activePairs) {
				const seenIds = pairSeenIds.get(pair.id) ?? new Set<string>();
				try {
					const delResult = await this.runDeletionPass(pair, seenIds, globalSeenIds, archivedIds);
					result.removed += delResult.removed;
					result.archived! += delResult.archived ?? 0;
					result.errors += delResult.errors;
					const pr = result.pairs![pair.id];
					pr.removed = delResult.removed;
					pr.archived = delResult.archived ?? 0;
					pr.errors += delResult.errors;
				} catch (e) {
					console.error(`${LOG} Pair "${pair.label}" deletion pass failed:`, e);
					result.errors++;
				}
			}
		} else {
			// Dry-run deletion pass
			for (const pair of activePairs) {
				const seenIds = pairSeenIds.get(pair.id) ?? new Set<string>();
				const effectiveDeletionBehavior = pair.deletionBehavior ?? this.settings.deletionBehavior;
				if (effectiveDeletionBehavior !== "keep") {
					const pairEntries = this.manifest.allForPair(pair.id);
					for (const [driveId, entry] of pairEntries) {
						if (!globalSeenIds.has(driveId) && !seenIds.has(driveId)) {
							result.wouldRemove!.push(entry.vaultPath);
						}
					}
				}
			}
		}

		if (!dryRun) await this.manifest.save();
		return result;
	}

	async syncSinglePair(pairId: string): Promise<SyncResult> {
		await this.manifest.load();

		console.log(`${LOG} Fetching access token for single-pair sync`);
		const token = await this.auth.getValidAccessToken();

		const pair = this.settings.syncPairs.find((p) => p.id === pairId);
		if (!pair) throw new Error(`Sync pair not found: ${pairId}`);

		const archivedIds = this.settings.driveArchiveFolderId
			? await this.collectArchiveIds(token)
			: new Set<string>();

		console.log(`${LOG} Single-pair sync: "${pair.label}"`);
		const { pairResult, seenIds } = await this.syncPairFiles(pair, token);
		// For single-pair sync, globalSeenIds = seenIds (no cross-pair awareness)
		const delResult = await this.runDeletionPass(pair, seenIds, seenIds, archivedIds);

		const result: SyncResult = {
			...pairResult,
			removed: delResult.removed,
			archived: delResult.archived ?? 0,
			errors: pairResult.errors + delResult.errors,
			timestamp: Date.now(),
		};

		await this.manifest.save();
		return result;
	}

	// ── Phase 1: collect + process files ──────────────────────────────────────

	private async syncPairFiles(
		pair: SyncPair,
		token: string,
		dryRun = false
	): Promise<{ pairResult: SyncResult; seenIds: Set<string> }> {
		const pairResult: SyncResult = {
			downloaded: 0,
			skipped: 0,
			errors: 0,
			removed: 0,
			moved: 0,
			archived: 0,
			...(dryRun ? { wouldDownload: [] } : {}),
		};

		const effectiveCompanionEnabled =
			pair.companionNotesEnabled ?? this.settings.companionNotesEnabled;

		console.log(`${LOG} Collecting files from Drive folder: ${pair.driveFolderId}`);
		const driveEntries = await this.collectFiles(
			pair.driveFolderId, "", token,
			pair.excludedSubfolders ?? [],
			pair.excludeRootFiles ?? false,
			pair.rootFilesOnly ?? false
		);
		console.log(`${LOG} Found ${driveEntries.length} PDF(s) in Drive for pair "${pair.label}"`);

		const seenIds = new Set<string>();
		for (const entry of driveEntries) seenIds.add(entry.file.id);

		if (dryRun) {
			for (const entry of driveEntries) {
				const displayPath = entry.relPath
					? `${entry.relPath}/${entry.file.name}`
					: entry.file.name;
				const existing = this.manifest.get(entry.file.id);
				if (!existing || entry.file.modifiedTime !== existing.driveModifiedTime) {
					pairResult.wouldDownload!.push(`${pair.label}: ${displayPath}`);
				}
			}
			return { pairResult, seenIds };
		}

		const concurrency = Math.max(1, Math.min(this.settings.downloadConcurrency ?? 5, 10));
		console.log(`${LOG} Processing ${driveEntries.length} file(s) with concurrency=${concurrency}`);

		const entryResults = await this.runConcurrent(
			driveEntries,
			concurrency,
			(entry) => this.processEntry(entry, pair, token, effectiveCompanionEnabled)
		);

		for (const r of entryResults) {
			pairResult.downloaded += r.downloaded;
			pairResult.skipped += r.skipped;
			pairResult.moved! += r.moved ?? 0;
			pairResult.errors += r.errors;
		}

		return { pairResult, seenIds };
	}

	// ── Phase 2: deletion pass ────────────────────────────────────────────────

	private async runDeletionPass(
		pair: SyncPair,
		seenIds: Set<string>,
		globalSeenIds: Set<string>,
		archivedIds: Set<string>
	): Promise<SyncResult> {
		const result: SyncResult = { downloaded: 0, skipped: 0, errors: 0, removed: 0, archived: 0 };

		const effectiveDeletionBehavior = pair.deletionBehavior ?? this.settings.deletionBehavior;
		const effectiveArchiveFolder = pair.archiveFolder ?? this.settings.archiveFolder;

		// Skip deletion pass entirely if nothing will be done
		if (effectiveDeletionBehavior === "keep" && !pair.driveArchiveBehavior) {
			return result;
		}

		console.log(
			`${LOG} Running deletion pass for pair "${pair.label}" (behavior: ${effectiveDeletionBehavior})`
		);

		const pairEntries = this.manifest.allForPair(pair.id);
		for (const [driveId, entry] of pairEntries) {
			if (seenIds.has(driveId)) continue; // still present in this pair

			if (globalSeenIds.has(driveId)) {
				// File moved to another pair — pairId already updated in processEntry;
				// skip deletion so the other pair owns it.
				console.log(`${LOG} File moved to another pair — skipping deletion: ${entry.vaultPath}`);
				continue;
			}

			if (archivedIds.has(driveId)) {
				// File moved to Drive archive folder
				const archiveBehavior =
					pair.driveArchiveBehavior ?? effectiveDeletionBehavior;
				if (archiveBehavior === "keep") {
					console.log(`${LOG} Drive-archived (behavior=keep): ${entry.vaultPath}`);
					continue;
				}
				console.log(
					`${LOG} Drive-archived (behavior=${archiveBehavior}): ${entry.vaultPath}`
				);
				try {
					await this.removeEntry(entry, pair, archiveBehavior, effectiveArchiveFolder);
					this.manifest.delete(driveId);
					result.archived!++;
				} catch (e) {
					console.error(`${LOG} Failed to remove archived "${entry.vaultPath}":`, e);
					result.errors++;
				}
				continue;
			}

			// File no longer in Drive at all
			if (effectiveDeletionBehavior === "keep") continue;

			console.log(`${LOG} No longer in Drive — removing: ${entry.vaultPath}`);
			try {
				await this.removeEntry(entry, pair, effectiveDeletionBehavior, effectiveArchiveFolder);
				this.manifest.delete(driveId);
				result.removed++;
			} catch (e) {
				console.error(`${LOG} Failed to remove "${entry.vaultPath}":`, e);
				result.errors++;
			}
		}

		return result;
	}

	// ── Archive folder pre-collection ─────────────────────────────────────────

	private async collectArchiveIds(token: string): Promise<Set<string>> {
		const folderId = this.settings.driveArchiveFolderId;
		if (!folderId) return new Set();
		try {
			console.log(`${LOG} Listing Drive archive folder: ${folderId}`);
			const files = await this.listItems<DriveFile>(
				token,
				`'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
				"files(id)"
			);
			const ids = new Set(files.map((f) => f.id));
			console.log(`${LOG} Drive archive folder: ${ids.size} PDF(s) found`);
			return ids;
		} catch (e) {
			console.error(`${LOG} Failed to list Drive archive folder — skipping archive detection:`, e);
			return new Set();
		}
	}

	// ── Entry processing ──────────────────────────────────────────────────────

	private async runConcurrent<T, R>(
		items: T[],
		concurrency: number,
		fn: (item: T) => Promise<R>
	): Promise<R[]> {
		const results: R[] = [];
		let index = 0;

		async function worker() {
			while (index < items.length) {
				const i = index++;
				results[i] = await fn(items[i]);
			}
		}

		const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
		await Promise.all(workers);
		return results;
	}

	private async processEntry(
		entry: DriveFileEntry,
		pair: SyncPair,
		token: string,
		companionEnabled: boolean
	): Promise<SyncResult> {
		const r: SyncResult = { downloaded: 0, skipped: 0, errors: 0, removed: 0, moved: 0 };
		const displayPath = entry.relPath
			? `${entry.relPath}/${entry.file.name}`
			: entry.file.name;

		try {
			const effectiveRelPath = pair.collapseSingleFileFolder
				? this.collapseRelPath(entry.relPath, entry.file.name)
				: entry.relPath;

			const expectedVaultPath = this.computeVaultPath(
				pair.vaultDestFolder,
				effectiveRelPath,
				entry.file.name
			);

			const existing = this.manifest.get(entry.file.id);
			if (existing && existing.vaultPath !== expectedVaultPath) {
				console.log(`${LOG} Move detected: "${existing.vaultPath}" → "${expectedVaultPath}"`);
				await this.handleRename(existing, entry, pair, expectedVaultPath, companionEnabled);
			}

			const needsDownload = !existing || entry.file.modifiedTime !== existing.driveModifiedTime;

			if (needsDownload) {
				console.log(`${LOG} Downloading: ${displayPath}`);
				const vaultPath = await this.downloader.download(
					entry.file,
					token,
					pair.vaultDestFolder,
					effectiveRelPath
				);

				// Attempt Gemini transcription (non-blocking on failure)
				let transcription: string | undefined;
				const gemini = this.getGeminiClient();
				if (gemini) {
					try {
						const pdfBytes = await this.app.vault.adapter.readBinary(vaultPath);
						transcription = await gemini.transcribePdf(pdfBytes);
					} catch (e) {
						console.error(`${LOG} Gemini transcription failed for "${vaultPath}":`, e);
					}
				}

				let companionPath: string | null = null;
				if (companionEnabled) {
					const currentCompanionPath = existing?.companionPath ?? null;
					if (currentCompanionPath) {
						await this.companion.update(currentCompanionPath, entry.file, pair, transcription);
						companionPath = currentCompanionPath;
					} else {
						companionPath = await this.companion.create(
							entry.file,
							pair,
							entry.relPath,
							vaultPath,
							transcription
						);
					}
				}

				this.manifest.set(entry.file.id, {
					vaultPath,
					companionPath,
					driveModifiedTime: entry.file.modifiedTime,
					driveCreatedTime: entry.file.createdTime,
					pairId: pair.id,
				});

				if (this.automationEngine) {
					// Fall back to manifest's stored companion path when companion notes are
					// currently disabled — lets transcribe_to_companion find an existing note.
					const automationCompanionPath = companionPath ?? existing?.companionPath ?? null;
					await this.automationEngine.runForFile(vaultPath, automationCompanionPath, entry.file.createdTime, transcription);
				}

				console.log(`${LOG} Downloaded: ${displayPath}`);
				r.downloaded++;
			} else if (existing && existing.vaultPath !== expectedVaultPath) {
				// Pure move — no content change, just relocated
				r.moved!++;
			} else {
				console.log(`${LOG} Up to date, skipping: ${displayPath}`);
				r.skipped++;
			}
		} catch (e) {
			console.error(`${LOG} Failed to sync "${displayPath}":`, e);
			r.errors++;
		}

		return r;
	}

	private async handleRename(
		existing: ManifestEntry,
		entry: DriveFileEntry,
		pair: SyncPair,
		newVaultPath: string,
		companionEnabled: boolean
	): Promise<void> {
		// Rename the PDF — Obsidian updates all backlinks automatically
		const oldTFile = this.app.vault.getAbstractFileByPath(existing.vaultPath);
		if (oldTFile instanceof TFile) {
			await this.app.fileManager.renameFile(oldTFile, newVaultPath);
			console.log(`${LOG} PDF renamed in vault: ${existing.vaultPath} → ${newVaultPath}`);
		} else {
			console.warn(`${LOG} PDF not found in vault for rename: ${existing.vaultPath}`);
		}

		// Rename companion note if it exists
		if (existing.companionPath && companionEnabled) {
			const newCompanionPath = this.companion.companionPath(
				pair,
				entry.relPath,
				entry.file.name
			);
			if (newCompanionPath !== existing.companionPath) {
				await this.companion.rename(existing.companionPath, newCompanionPath);
				// Update manifest immediately — pairId updated to current pair
				this.manifest.set(entry.file.id, {
					...existing,
					vaultPath: newVaultPath,
					companionPath: newCompanionPath,
					pairId: pair.id,
				});
				return;
			}
		}

		// Update vault path and pairId (covers both within-pair and cross-pair moves)
		this.manifest.set(entry.file.id, {
			...existing,
			vaultPath: newVaultPath,
			pairId: pair.id,
		});
	}

	private async removeEntry(
		entry: ManifestEntry,
		pair: SyncPair,
		deletionBehavior: DeletionBehavior,
		archiveFolder: string
	): Promise<void> {
		const keepCompanion =
			deletionBehavior === "delete_keep_companion" ||
			deletionBehavior === "archive_keep_companion";
		const onlyCompanion = deletionBehavior === "delete_only_companion";

		const effectivePdfBehavior: DeletionBehavior =
			deletionBehavior === "delete_keep_companion" ? "delete" :
			deletionBehavior === "archive_keep_companion" ? "archive" :
			deletionBehavior === "delete_only_companion" ? "keep" :
			deletionBehavior;

		// Remove (or keep) PDF
		if (!onlyCompanion) {
			const pdfFile = this.app.vault.getAbstractFileByPath(entry.vaultPath);
			if (pdfFile instanceof TFile) {
				await this.removeFile(pdfFile, entry.vaultPath, pair, effectivePdfBehavior, archiveFolder);
			} else {
				console.warn(`${LOG} File not found in vault — skipping remove: ${entry.vaultPath}`);
			}
		}

		// Remove companion note
		if (entry.companionPath && !keepCompanion) {
			const compFile = this.app.vault.getAbstractFileByPath(entry.companionPath);
			if (compFile instanceof TFile) {
				// For delete_only_companion, always delete (not archive) the companion
				const companionBehavior: DeletionBehavior =
					onlyCompanion ? "delete" : effectivePdfBehavior;
				await this.removeFile(compFile, entry.companionPath, pair, companionBehavior, archiveFolder);
			} else {
				console.warn(
					`${LOG} Companion note not found — skipping remove: ${entry.companionPath}`
				);
			}
		}
	}

	private async removeFile(
		file: TFile,
		filePath: string,
		pair: SyncPair,
		deletionBehavior: DeletionBehavior,
		archiveFolder: string
	): Promise<void> {
		if (deletionBehavior === "delete") {
			console.log(`${LOG} Trashing: ${filePath}`);
			await this.app.vault.trash(file, true);
		} else if (deletionBehavior === "archive") {
			const relToRoot = filePath.slice(pair.vaultDestFolder.length);
			const archivePath = `${archiveFolder}${relToRoot}`;
			const archiveDir = archivePath.substring(0, archivePath.lastIndexOf("/"));

			console.log(`${LOG} Archiving ${filePath} → ${archivePath}`);
			await this.ensureFolder(archiveDir);
			await this.app.fileManager.renameFile(file, archivePath);
		}
		// "keep" and "delete_only_companion" for PDF: do nothing
	}

	private collapseRelPath(relPath: string, fileName: string): string {
		if (!relPath) return relPath;
		const parts = relPath.split("/");
		const lastFolder = parts[parts.length - 1];
		const fileStem = fileName.replace(/\.[^.]+$/, "");
		if (lastFolder === fileStem) return parts.slice(0, -1).join("/");
		return relPath;
	}

	private computeVaultPath(
		vaultDestFolder: string,
		relPath: string,
		fileName: string
	): string {
		const safeName = this.downloader.sanitizeFilename(fileName);
		const folder = relPath ? `${vaultDestFolder}/${relPath}` : vaultDestFolder;
		return `${folder}/${safeName}`;
	}

	private async collectFiles(
		folderId: string,
		relPath: string,
		token: string,
		excludedSubfolders: string[] = [],
		excludeRootFiles = false,
		rootFilesOnly = false
	): Promise<DriveFileEntry[]> {
		console.log(`${LOG} Listing folder id=${folderId} relPath="${relPath}"`);

		const isRoot = relPath === "";

		const [files, subfolders] = await Promise.all([
			this.listItems<DriveFile>(
				token,
				`'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
				"files(id,name,modifiedTime,createdTime,size)"
			),
			rootFilesOnly && !isRoot
				? Promise.resolve([] as DriveFolder[])
				: this.listItems<DriveFolder>(
					token,
					`'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
					"files(id,name)"
				),
		]);

		console.log(
			`${LOG} Folder "${relPath || "root"}": ${files.length} PDF(s), ${subfolders.length} subfolder(s)`
		);

		const entries: DriveFileEntry[] =
			(excludeRootFiles && isRoot)
				? (console.log(`${LOG} Skipping ${files.length} root-level file(s) (excludeRootFiles=true)`), [])
				: files.map((f) => ({ file: f, relPath }));

		if (!rootFilesOnly) {
			for (const folder of subfolders) {
				const childRelPath = relPath ? `${relPath}/${folder.name}` : folder.name;
				if (excludedSubfolders.includes(folder.name) || excludedSubfolders.includes(childRelPath)) {
					console.log(`${LOG} Skipping excluded subfolder: ${childRelPath}`);
					continue;
				}
				console.log(`${LOG} Descending into subfolder: ${childRelPath}`);
				const childEntries = await this.collectFiles(
					folder.id, childRelPath, token, excludedSubfolders, excludeRootFiles, rootFilesOnly
				);
				entries.push(...childEntries);
			}
		}

		return entries;
	}

	private async listItems<T>(
		token: string,
		query: string,
		fields: string
	): Promise<T[]> {
		const items: T[] = [];
		let pageToken: string | undefined;
		let page = 0;

		do {
			page++;
			const params = new URLSearchParams({
				q: query,
				fields: `nextPageToken,${fields}`,
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);

			console.log(`${LOG} GET ${FILES_API} page=${page} query="${query}"`);
			const resp = await fetch(`${FILES_API}?${params}`, {
				headers: { Authorization: `Bearer ${token}` },
			});

			if (!resp.ok) {
				const body = await resp.text();
				console.error(`${LOG} files.list failed — status ${resp.status}:`, body);
				throw new Error(`Drive files.list failed: ${resp.status} ${body}`);
			}

			const data = await resp.json();
			const batch: T[] = data.files ?? [];
			console.log(`${LOG} Page ${page} returned ${batch.length} item(s)`);
			items.push(...batch);
			pageToken = data.nextPageToken;
		} while (pageToken);

		return items;
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const segments = folderPath.split("/").filter(Boolean);
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
