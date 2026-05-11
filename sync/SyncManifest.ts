import { App } from "obsidian";
import { AutomationRunRecord, ManifestEntry, SyncManifest } from "../types";

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
		const tmpPath = MANIFEST_PATH + ".tmp";
		const content = JSON.stringify(this.data, null, 2);
		try {
			// Write to tmp then rename — best-effort atomic to protect against partial writes
			await this.app.vault.adapter.write(tmpPath, content);
			await this.app.vault.adapter.rename(tmpPath, MANIFEST_PATH);
			console.log(`${LOG} Saved ${Object.keys(this.data).length} manifest entries`);
		} catch (e) {
			console.error(`${LOG} Atomic save failed — falling back to direct write:`, e);
			try { await this.app.vault.adapter.remove(tmpPath); } catch { /* ignore */ }
			try {
				await this.app.vault.adapter.write(MANIFEST_PATH, content);
				console.log(`${LOG} Saved ${Object.keys(this.data).length} manifest entries (direct write)`);
			} catch (e2) {
				console.error(`${LOG} Failed to save manifest:`, e2);
			}
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

	findByVaultPath(path: string): [string, ManifestEntry] | undefined {
		return this.entries().find(([, entry]) => entry.vaultPath === path);
	}

	findByCompanionPath(path: string): [string, ManifestEntry] | undefined {
		return this.entries().find(([, entry]) => entry.companionPath === path);
	}

	recordAutomationRun(driveFileId: string, automationId: string, run: AutomationRunRecord): void {
		const entry = this.data[driveFileId];
		if (!entry) return;
		if (!entry.automationRuns) entry.automationRuns = {};
		entry.automationRuns[automationId] = run;
	}

	getAutomationRun(driveFileId: string, automationId: string): AutomationRunRecord | undefined {
		return this.data[driveFileId]?.automationRuns?.[automationId];
	}

	/**
	 * Mark a vault path as user-deleted so the sync engine skips re-downloading it
	 * until Drive's modifiedTime advances. Returns true if the entry was found.
	 */
	markUserDeleted(vaultPath: string): boolean {
		const byVault = this.findByVaultPath(vaultPath);
		if (!byVault) return false;
		const [id, entry] = byVault;
		this.data[id] = { ...entry, userDeletedAt: new Date().toISOString() };
		console.log(`${LOG} Marked as user-deleted: "${vaultPath}"`);
		return true;
	}

	/** Clear the userDeletedAt flag so the file will be re-downloaded on next sync. */
	clearUserDeleted(driveFileId: string): void {
		const entry = this.data[driveFileId];
		if (entry) delete entry.userDeletedAt;
	}

	/**
	 * Update vaultPath or companionPath in-memory when the user renames a file in the vault.
	 * Returns true if an entry was updated.
	 */
	healRename(oldPath: string, newPath: string): boolean {
		const byVault = this.findByVaultPath(oldPath);
		if (byVault) {
			const [id, entry] = byVault;
			this.data[id] = { ...entry, vaultPath: newPath };
			console.log(`${LOG} Healed vault rename: "${oldPath}" → "${newPath}"`);
			return true;
		}
		const byCompanion = this.findByCompanionPath(oldPath);
		if (byCompanion) {
			const [id, entry] = byCompanion;
			this.data[id] = { ...entry, companionPath: newPath };
			console.log(`${LOG} Healed companion rename: "${oldPath}" → "${newPath}"`);
			return true;
		}
		return false;
	}
}
