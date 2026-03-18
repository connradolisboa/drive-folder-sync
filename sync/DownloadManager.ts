import { App } from "obsidian";
import { DriveFile } from "../types";

const LOG = "[DriveSync/Download]";

export class DownloadManager {
	constructor(private app: App) {}

	/**
	 * Downloads a Drive file to the vault.
	 * Returns the vault-relative path where the file was written.
	 */
	async download(
		file: DriveFile,
		token: string,
		destFolder: string,
		relPath: string
	): Promise<string> {
		const folderPath = relPath ? `${destFolder}/${relPath}` : destFolder;
		await this.ensureFolder(folderPath);

		const safeName = this.sanitizeFilename(file.name);
		const localPath = `${folderPath}/${safeName}`;

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
			await this.app.vault.adapter.writeBinary(localPath, buffer);
		} else {
			console.log(`${LOG} Creating new file: ${localPath}`);
			await this.app.vault.createBinary(localPath, buffer);
		}

		console.log(`${LOG} Write complete: ${localPath}`);
		return localPath;
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
