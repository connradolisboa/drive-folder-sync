import { App } from "obsidian";
import { ManifestEntry, SyncManifest } from "../types";

const MANIFEST_PATH = ".obsidian/drive-sync-manifest.json";
const LOG = "[DriveSync/Manifest]";

export class SyncManifestStore {
	private data: SyncManifest = {};

	constructor(private app: App) {}

	async load(): Promise<void> {
		try {
			const exists = await this.app.vault.adapter.exists(MANIFEST_PATH);
			if (!exists) {
				console.log(`${LOG} No manifest found — starting fresh`);
				this.data = {};
				return;
			}
			const raw = await this.app.vault.adapter.read(MANIFEST_PATH);
			this.data = JSON.parse(raw) as SyncManifest;
			console.log(`${LOG} Loaded ${Object.keys(this.data).length} manifest entries`);
		} catch (e) {
			console.error(`${LOG} Failed to load manifest — starting fresh:`, e);
			this.data = {};
		}
	}

	async save(): Promise<void> {
		try {
			await this.app.vault.adapter.write(
				MANIFEST_PATH,
				JSON.stringify(this.data, null, 2)
			);
			console.log(`${LOG} Saved ${Object.keys(this.data).length} manifest entries`);
		} catch (e) {
			console.error(`${LOG} Failed to save manifest:`, e);
		}
	}

	get(driveFileId: string): ManifestEntry | undefined {
		return this.data[driveFileId];
	}

	set(driveFileId: string, entry: ManifestEntry): void {
		this.data[driveFileId] = entry;
	}

	delete(driveFileId: string): void {
		delete this.data[driveFileId];
	}

	entries(): [string, ManifestEntry][] {
		return Object.entries(this.data);
	}

	allForPair(pairId: string): [string, ManifestEntry][] {
		return this.entries().filter(([, entry]) => entry.pairId === pairId);
	}
}
