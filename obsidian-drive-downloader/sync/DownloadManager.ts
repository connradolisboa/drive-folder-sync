import { App, TFile } from "obsidian";
import { DriveFile } from "../types";
import type { CacheManager } from "./CacheManager";

const LOG = "[DriveSync/Download]";

export interface DownloadOutcome {
	path: string;
	/** True when the bytes came from the content cache, not the network (Phase 11.3). */
	cacheHit: boolean;
}

export class DownloadManager {
	constructor(private app: App, private cache?: CacheManager) {}

	setCache(cache: CacheManager | undefined): void { this.cache = cache; }

	/**
	 * Downloads a Drive file to the vault.
	 * Returns the vault-relative path and whether the bytes came from the cache.
	 * `targetFileName` overrides the Drive name (already sanitized) — used for
	 * duplicate-name handling, e.g. "Note (2).pdf".
	 */
	async download(
		file: DriveFile,
		token: string,
		destFolder: string,
		relPath: string,
		targetFileName?: string
	): Promise<DownloadOutcome> {
		const folderPath = relPath ? `${destFolder}/${relPath}` : destFolder;
		await this.ensureFolder(folderPath);

		const safeName = targetFileName ?? this.sanitizeFilename(file.name);
		const localPath = `${folderPath}/${safeName}`;

		// Phase 11.3 — content-addressed cache hit (zero bytes downloaded).
		if (this.cache && file.md5Checksum && (await this.cache.has(file.md5Checksum))) {
			const restored = await this.cache.restore(file.md5Checksum, localPath);
			if (restored) {
				console.log(`${LOG} Restored "${file.name}" from cache → ${localPath}`);
				return { path: localPath, cacheHit: true };
			}
		}

		console.log(
			`${LOG} Fetching "${file.name}" (id=${file.id}, size=${file.size ?? "unknown"}) → ${localPath}`
		);

		const resp = await fetch(
			`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
			{ headers: { Authorization: `Bearer ${token}` } }
		);

		if (!resp.ok) {
			const body = await resp.text();
			console.error(
				`${LOG} Download failed for "${file.name}" — status ${resp.status}:`,
				body
			);
			throw new Error(`Download failed for "${file.name}": HTTP ${resp.status}`);
		}

		const buffer = await resp.arrayBuffer();
		console.log(`${LOG} Received ${buffer.byteLength} bytes for "${file.name}"`);

		const exists = await this.app.vault.adapter.exists(localPath);
		if (exists) {
			console.log(`${LOG} Overwriting existing file: ${localPath}`);
			const existing = this.app.vault.getAbstractFileByPath(localPath);
			if (!(existing instanceof TFile)) {
				throw new Error(`Vault index could not resolve existing destination: ${localPath}`);
			}
			// Vault.modifyBinary emits a reliable "modify" event for independently-running plugins.
			await this.app.vault.modifyBinary(existing, buffer);
		} else {
			console.log(`${LOG} Creating new file: ${localPath}`);
			await this.app.vault.createBinary(localPath, buffer);
		}

		// Phase 11.3 — populate the content cache keyed by Drive's md5.
		if (this.cache && file.md5Checksum) {
			await this.cache.store(file.md5Checksum, buffer);
		}

		console.log(`${LOG} Write complete: ${localPath}`);
		return { path: localPath, cacheHit: false };
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

	sanitizeFilename(name: string): string {
		return name.replace(/[/\\:*?"<>|]/g, "_");
	}
}
