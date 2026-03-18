import { App, TFile } from "obsidian";
import { GoogleAuth } from "../auth/GoogleAuth";
import { DownloadManager } from "./DownloadManager";
import { SyncManifestStore } from "./SyncManifest";
import { CompanionNoteManager } from "./CompanionNoteManager";
import { AutomationEngine } from "../automation/AutomationEngine";
import {
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
	}

	async sync(): Promise<SyncResult> {
		await this.manifest.load();

		console.log(`${LOG} Fetching access token`);
		const token = await this.auth.getValidAccessToken();

		const result: SyncResult = {
			downloaded: 0,
			skipped: 0,
			errors: 0,
			removed: 0,
		};

		const activePairs = this.settings.syncPairs.filter(
			(p) => p.enabled && p.driveFolderId.trim()
		);
		console.log(`${LOG} Active sync pairs: ${activePairs.length}`);

		for (const pair of activePairs) {
			console.log(`${LOG} Processing pair "${pair.label}" → "${pair.vaultDestFolder}"`);
			try {
				await this.syncPair(pair, token, result);
			} catch (e) {
				console.error(`${LOG} Pair "${pair.label}" failed:`, e);
				result.errors++;
			}
		}

		await this.manifest.save();
		return result;
	}

	private async syncPair(
		pair: SyncPair,
		token: string,
		result: SyncResult
	): Promise<void> {
		console.log(`${LOG} Collecting files from Drive folder: ${pair.driveFolderId}`);
		const driveEntries = await this.collectFiles(pair.driveFolderId, "", token);
		console.log(`${LOG} Found ${driveEntries.length} PDF(s) in Drive for pair "${pair.label}"`);

		const seenIds = new Set<string>();

		for (const entry of driveEntries) {
			seenIds.add(entry.file.id);
			const displayPath = entry.relPath
				? `${entry.relPath}/${entry.file.name}`
				: entry.file.name;

			try {
				// Compute expected vault path for this file
				const expectedVaultPath = this.computeVaultPath(
					pair.vaultDestFolder,
					entry.relPath,
					entry.file.name
				);

				// Check manifest for rename detection
				const existing = this.manifest.get(entry.file.id);
				if (existing && existing.vaultPath !== expectedVaultPath) {
					console.log(
						`${LOG} Rename detected: "${existing.vaultPath}" → "${expectedVaultPath}"`
					);
					await this.handleRename(existing, entry, pair, expectedVaultPath);
				}

				// Download check: no manifest entry, or Drive has newer modifiedTime
				const needsDownload =
					!existing ||
					entry.file.modifiedTime !== existing.driveModifiedTime;

				if (needsDownload) {
					console.log(`${LOG} Downloading: ${displayPath}`);
					const vaultPath = await this.downloader.download(
						entry.file,
						token,
						pair.vaultDestFolder,
						entry.relPath
					);

					// Companion note
					let companionPath: string | null = null;
					if (this.settings.companionNotesEnabled) {
						const currentCompanionPath = existing?.companionPath ?? null;
						if (currentCompanionPath) {
							await this.companion.update(currentCompanionPath, entry.file, pair);
							companionPath = currentCompanionPath;
						} else {
							companionPath = await this.companion.create(
								entry.file,
								pair,
								entry.relPath,
								vaultPath
							);
						}
					}

					this.manifest.set(entry.file.id, {
						vaultPath,
						companionPath,
						driveModifiedTime: entry.file.modifiedTime,
						pairId: pair.id,
					});

					// Run automations for newly downloaded/updated file
					if (this.automationEngine) {
						await this.automationEngine.runForFile(vaultPath);
					}

					console.log(`${LOG} Downloaded: ${displayPath}`);
					result.downloaded++;
				} else {
					console.log(`${LOG} Up to date, skipping: ${displayPath}`);
					result.skipped++;
				}
			} catch (e) {
				console.error(`${LOG} Failed to sync "${displayPath}":`, e);
				result.errors++;
			}
		}

		// Deletion pass — manifest-driven
		if (this.settings.deletionBehavior !== "keep") {
			console.log(
				`${LOG} Running deletion pass for pair "${pair.label}" (behavior: ${this.settings.deletionBehavior})`
			);
			const pairEntries = this.manifest.allForPair(pair.id);
			for (const [driveId, entry] of pairEntries) {
				if (!seenIds.has(driveId)) {
					console.log(`${LOG} No longer in Drive — removing: ${entry.vaultPath}`);
					try {
						await this.removeEntry(entry, pair);
						this.manifest.delete(driveId);
						result.removed++;
					} catch (e) {
						console.error(`${LOG} Failed to remove "${entry.vaultPath}":`, e);
					}
				}
			}
		}
	}

	private async handleRename(
		existing: ManifestEntry,
		entry: DriveFileEntry,
		pair: SyncPair,
		newVaultPath: string
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
		if (existing.companionPath && this.settings.companionNotesEnabled) {
			const newCompanionPath = this.companion.companionPath(
				pair,
				entry.relPath,
				entry.file.name
			);
			if (newCompanionPath !== existing.companionPath) {
				await this.companion.rename(existing.companionPath, newCompanionPath);
				// Update manifest entry immediately so downstream code sees the new companion path
				this.manifest.set(entry.file.id, {
					...existing,
					vaultPath: newVaultPath,
					companionPath: newCompanionPath,
				});
			}
		} else {
			// Update just the vault path
			this.manifest.set(entry.file.id, {
				...existing,
				vaultPath: newVaultPath,
			});
		}
	}

	private async removeEntry(
		entry: ManifestEntry,
		pair: SyncPair
	): Promise<void> {
		// Remove PDF
		const pdfFile = this.app.vault.getAbstractFileByPath(entry.vaultPath);
		if (pdfFile instanceof TFile) {
			await this.removeFile(pdfFile, entry.vaultPath, pair);
		} else {
			console.warn(`${LOG} File not found in vault — skipping remove: ${entry.vaultPath}`);
		}

		// Remove companion note
		if (entry.companionPath) {
			const compFile = this.app.vault.getAbstractFileByPath(entry.companionPath);
			if (compFile instanceof TFile) {
				await this.removeFile(compFile, entry.companionPath, pair);
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
		pair: SyncPair
	): Promise<void> {
		if (this.settings.deletionBehavior === "delete") {
			console.log(`${LOG} Trashing: ${filePath}`);
			await this.app.vault.trash(file, true);
		} else if (this.settings.deletionBehavior === "archive") {
			const relToRoot = filePath.slice(pair.vaultDestFolder.length);
			const archivePath = `${this.settings.archiveFolder}${relToRoot}`;
			const archiveDir = archivePath.substring(0, archivePath.lastIndexOf("/"));

			console.log(`${LOG} Archiving ${filePath} → ${archivePath}`);
			await this.ensureFolder(archiveDir);
			await this.app.fileManager.renameFile(file, archivePath);
		}
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
		token: string
	): Promise<DriveFileEntry[]> {
		console.log(`${LOG} Listing folder id=${folderId} relPath="${relPath}"`);

		const [files, subfolders] = await Promise.all([
			this.listItems<DriveFile>(
				token,
				`'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
				"files(id,name,modifiedTime,size)"
			),
			this.listItems<DriveFolder>(
				token,
				`'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
				"files(id,name)"
			),
		]);

		console.log(
			`${LOG} Folder "${relPath || "root"}": ${files.length} PDF(s), ${subfolders.length} subfolder(s)`
		);

		const entries: DriveFileEntry[] = files.map((f) => ({ file: f, relPath }));

		for (const folder of subfolders) {
			const childRelPath = relPath ? `${relPath}/${folder.name}` : folder.name;
			console.log(`${LOG} Descending into subfolder: ${childRelPath}`);
			const childEntries = await this.collectFiles(folder.id, childRelPath, token);
			entries.push(...childEntries);
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
