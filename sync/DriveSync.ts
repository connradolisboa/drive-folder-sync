import { App, TFile } from "obsidian";
import { GoogleAuth } from "../auth/GoogleAuth";
import { DownloadManager } from "./DownloadManager";
import {
	DriveFile,
	DriveFileEntry,
	DriveFolder,
	PluginSettings,
	SyncResult,
} from "../types";

const FILES_API = "https://www.googleapis.com/drive/v3/files";
const LOG = "[DriveSync/Sync]";

export class DriveSync {
	constructor(
		private auth: GoogleAuth,
		private downloader: DownloadManager,
		private settings: PluginSettings,
		private app: App
	) {}

	async sync(): Promise<SyncResult> {
		console.log(`${LOG} Fetching access token`);
		const token = await this.auth.getValidAccessToken();

		console.log(`${LOG} Collecting files from Drive folder:`, this.settings.driveFolderId);
		const driveEntries = await this.collectFiles(
			this.settings.driveFolderId,
			"",
			token
		);
		console.log(`${LOG} Found ${driveEntries.length} PDF(s) in Drive`);

		const result: SyncResult = {
			downloaded: 0,
			skipped: 0,
			errors: 0,
			removed: 0,
		};

		// Download pass
		for (const entry of driveEntries) {
			const displayPath = entry.relPath
				? `${entry.relPath}/${entry.file.name}`
				: entry.file.name;
			try {
				const needsDownload = await this.shouldDownload(entry);
				if (needsDownload) {
					console.log(`${LOG} Downloading: ${displayPath}`);
					await this.downloader.download(
						entry.file,
						token,
						this.settings.vaultDestFolder,
						entry.relPath
					);
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

		// Deletion pass
		if (this.settings.deletionBehavior !== "keep") {
			console.log(`${LOG} Running deletion pass (behavior: ${this.settings.deletionBehavior})`);

			const driveManifest = new Set(
				driveEntries.map((e) => {
					const folder = e.relPath
						? `${this.settings.vaultDestFolder}/${e.relPath}`
						: this.settings.vaultDestFolder;
					return `${folder}/${this.sanitizeFilename(e.file.name)}`;
				})
			);

			const removed = await this.processDeletions(
				this.settings.vaultDestFolder,
				driveManifest,
				token
			);
			result.removed = removed;
			console.log(`${LOG} Deletion pass complete — ${removed} file(s) removed`);
		}

		return result;
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
			const childEntries = await this.collectFiles(
				folder.id,
				childRelPath,
				token
			);
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
			const batch = data.files ?? [];
			console.log(`${LOG} Page ${page} returned ${batch.length} item(s)`);
			items.push(...batch);
			pageToken = data.nextPageToken;
		} while (pageToken);

		return items;
	}

	private async shouldDownload(entry: DriveFileEntry): Promise<boolean> {
		const folder = entry.relPath
			? `${this.settings.vaultDestFolder}/${entry.relPath}`
			: this.settings.vaultDestFolder;
		const localPath = `${folder}/${this.sanitizeFilename(entry.file.name)}`;

		const exists = await this.app.vault.adapter.exists(localPath);
		if (!exists) {
			console.log(`${LOG} Not found locally — will download: ${localPath}`);
			return true;
		}

		const stat = await this.app.vault.adapter.stat(localPath);
		if (!stat) {
			console.log(`${LOG} stat() returned null — will download: ${localPath}`);
			return true;
		}

		const driveModified = new Date(entry.file.modifiedTime).getTime();
		const localMtime = stat.mtime;
		const needsUpdate = driveModified > localMtime;

		console.log(
			`${LOG} ${entry.file.name} — Drive: ${new Date(driveModified).toISOString()}, ` +
			`Local: ${new Date(localMtime).toISOString()}, ` +
			`needs update: ${needsUpdate}`
		);

		return needsUpdate;
	}

	private async processDeletions(
		vaultFolder: string,
		driveManifest: Set<string>,
		_token: string
	): Promise<number> {
		let removed = 0;

		const folderExists = await this.app.vault.adapter.exists(vaultFolder);
		if (!folderExists) {
			console.log(`${LOG} Vault destination folder does not exist — skipping deletion pass`);
			return 0;
		}

		const allVaultFiles = this.app.vault.getFiles().filter(
			(f) => f.path.startsWith(vaultFolder + "/") || f.path === vaultFolder
		);
		console.log(`${LOG} ${allVaultFiles.length} file(s) in vault dest folder`);

		for (const vaultFile of allVaultFiles) {
			if (!driveManifest.has(vaultFile.path)) {
				console.log(`${LOG} Not in Drive manifest — removing: ${vaultFile.path}`);
				try {
					await this.removeFile(vaultFile);
					removed++;
				} catch (e) {
					console.error(`${LOG} Failed to remove "${vaultFile.path}":`, e);
				}
			}
		}

		return removed;
	}

	private async removeFile(file: TFile): Promise<void> {
		if (this.settings.deletionBehavior === "delete") {
			console.log(`${LOG} Trashing: ${file.path}`);
			await this.app.vault.trash(file, true);
		} else if (this.settings.deletionBehavior === "archive") {
			const relToRoot = file.path.slice(this.settings.vaultDestFolder.length);
			const archivePath = `${this.settings.archiveFolder}${relToRoot}`;
			const archiveDir = archivePath.substring(0, archivePath.lastIndexOf("/"));

			console.log(`${LOG} Archiving ${file.path} → ${archivePath}`);
			await this.ensureArchiveFolder(archiveDir);
			await this.app.fileManager.renameFile(file, archivePath);
		}
	}

	private async ensureArchiveFolder(folderPath: string): Promise<void> {
		const segments = folderPath.split("/").filter(Boolean);
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			const exists = await this.app.vault.adapter.exists(current);
			if (!exists) {
				console.log(`${LOG} Creating archive folder: ${current}`);
				await this.app.vault.createFolder(current);
			}
		}
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[/\\:*?"<>|]/g, "_");
	}
}
