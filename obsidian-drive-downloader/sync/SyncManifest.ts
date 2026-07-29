import { App } from "obsidian";
import { DriveDownloaderSettings, SyncManifest, SyncManifestEntry } from "../types";
import type { EventBus } from "../events/EventBus";

const MANIFEST_PATH = ".obsidian/drive-sync-manifest.json";
const LEGACY_AUTOMATION_BACKUP_PATH =
	".obsidian/drive-sync-manifest.legacy-automation.json";
const BACKUP_DIR = ".obsidian/drive-sync-manifest.backups";
const LOG = "[DriveSync/Manifest]";

/** Phase 13.2 — bump when the persisted manifest shape changes. */
export const MANIFEST_SCHEMA_VERSION = 2;
const MAX_BACKUPS = 20;

function sanitizeEntry(value: unknown): SyncManifestEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	if (typeof source.vaultPath !== "string" || typeof source.pairId !== "string") {
		return null;
	}
	const entry: SyncManifestEntry = {
		vaultPath: source.vaultPath,
		driveModifiedTime:
			typeof source.driveModifiedTime === "string" ? source.driveModifiedTime : "",
		pairId: source.pairId,
	};
	for (const key of [
		"driveCreatedTime",
		"userDeletedAt",
		"deletedFromDriveAt",
		"driveMd5",
		"contentHash",
		"sourceDisconnectedAt",
	] as const) {
		if (typeof source[key] === "string") entry[key] = source[key] as never;
	}
	if (typeof source.driveTrashed === "boolean") {
		entry.driveTrashed = source.driveTrashed;
	}
	if (
		source.sourceDisconnectedReason === "drive-removed" ||
		source.sourceDisconnectedReason === "drive-archived"
	) {
		entry.sourceDisconnectedReason = source.sourceDisconnectedReason;
	}
	return entry;
}

function sanitizeManifest(value: unknown): SyncManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const clean: SyncManifest = {};
	for (const [driveFileId, rawEntry] of Object.entries(value as Record<string, unknown>)) {
		const entry = sanitizeEntry(rawEntry);
		if (entry) clean[driveFileId] = entry;
	}
	return clean;
}

function hasLegacyAutomationState(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const legacyKeys = [
		"companionPath",
		"companionMtime",
		"transcriptionDisabled",
		"automationRuns",
	];
	return Object.values(value as Record<string, unknown>).some((rawEntry) => {
		if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
			return false;
		}
		const entry = rawEntry as Record<string, unknown>;
		return legacyKeys.some((key) => Object.prototype.hasOwnProperty.call(entry, key));
	});
}

/**
 * Phase 11.2 — adapter interface. `JsonManifestStore` (current behavior) and a future
 * `SqliteManifestStore` both implement this; the rest of the codebase depends only on
 * the interface, so the storage backend is swappable without touching call sites.
 */
export interface SyncManifestStore {
	load(): Promise<void>;
	save(): Promise<void>;
	get(driveFileId: string): SyncManifestEntry | undefined;
	set(driveFileId: string, entry: SyncManifestEntry): void;
	delete(driveFileId: string): void;
	/** Remove every entry (used by the File Tracker's "Reset all tracking"). A backup is written on the next save. */
	clear(): void;
	entries(): [string, SyncManifestEntry][];
	allForPair(pairId: string): [string, SyncManifestEntry][];
	findByVaultPath(path: string): [string, SyncManifestEntry] | undefined;
	markUserDeleted(vaultPath: string): boolean;
	clearUserDeleted(driveFileId: string): void;
	healRename(oldPath: string, newPath: string): boolean;
	/** Phase 13.2 — manifest backup management. */
	listBackups(): Promise<string[]>;
	restoreBackup(name: string): Promise<void>;
}

export class JsonManifestStore implements SyncManifestStore {
	private data: SyncManifest = {};
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(private app: App, private bus?: EventBus) {}

	setBus(bus: EventBus): void { this.bus = bus; }

	async load(): Promise<void> {
		try {
			const exists = await this.app.vault.adapter.exists(MANIFEST_PATH);
			if (!exists) {
				console.log(`${LOG} No manifest found — starting fresh`);
				this.data = {};
				return;
			}
			const raw = await this.app.vault.adapter.read(MANIFEST_PATH);
			const parsed = JSON.parse(raw);
			// Tolerate both the bare-map legacy shape and a future {version, entries} wrapper.
			const entries = parsed && parsed.__schemaVersion && parsed.entries
				? parsed.entries
				: parsed;
			if (
				hasLegacyAutomationState(entries) &&
				!(await this.app.vault.adapter.exists(LEGACY_AUTOMATION_BACKUP_PATH))
			) {
				// File Automations imports these fields into its own tracking store. Save
				// one immutable handoff before the downloader trims the shared legacy map.
				await this.app.vault.adapter.write(
					LEGACY_AUTOMATION_BACKUP_PATH,
					JSON.stringify(entries, null, 2)
				);
				console.log(`${LOG} Preserved legacy automation state for one-time migration.`);
			}
			// The legacy store also contained automation/transcription/companion fields.
			// Whitelist downloader-owned state at the persistence boundary.
			this.data = sanitizeManifest(entries);
			console.log(`${LOG} Loaded ${Object.keys(this.data).length} manifest entries`);
		} catch (e) {
			console.error(`${LOG} Failed to load manifest:`, e);
			throw e;
		}
	}

	save(): Promise<void> {
		const next = this.saveQueue.then(() => this.saveNow());
		// Keep the queue usable after a rejected caller-visible save.
		this.saveQueue = next.catch(() => undefined);
		return next;
	}

	private async saveNow(): Promise<void> {
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
				throw e2;
			}
		}
		// Phase 13.2 — snapshot a timestamped backup after every successful write.
		await this.writeBackup(content).catch((e) => console.error(`${LOG} Backup write failed:`, e));
		this.bus?.emit("manifest-write", { entryCount: Object.keys(this.data).length });
	}

	get(driveFileId: string): SyncManifestEntry | undefined { return this.data[driveFileId]; }
	set(driveFileId: string, entry: SyncManifestEntry): void { this.data[driveFileId] = entry; }
	delete(driveFileId: string): void { delete this.data[driveFileId]; }
	clear(): void { this.data = {}; }
	entries(): [string, SyncManifestEntry][] { return Object.entries(this.data); }

	allForPair(pairId: string): [string, SyncManifestEntry][] {
		return this.entries().filter(([, entry]) => entry.pairId === pairId);
	}

	findByVaultPath(path: string): [string, SyncManifestEntry] | undefined {
		return this.entries().find(([, entry]) => entry.vaultPath === path);
	}

	markUserDeleted(vaultPath: string): boolean {
		const byVault = this.findByVaultPath(vaultPath);
		if (!byVault) return false;
		const [id, entry] = byVault;
		this.data[id] = { ...entry, userDeletedAt: new Date().toISOString() };
		console.log(`${LOG} Marked as user-deleted: "${vaultPath}"`);
		return true;
	}

	clearUserDeleted(driveFileId: string): void {
		const entry = this.data[driveFileId];
		if (entry) delete entry.userDeletedAt;
	}

	healRename(oldPath: string, newPath: string): boolean {
		const byVault = this.findByVaultPath(oldPath);
		if (byVault) {
			const [id, entry] = byVault;
			this.data[id] = { ...entry, vaultPath: newPath };
			console.log(`${LOG} Healed vault rename: "${oldPath}" → "${newPath}"`);
			return true;
		}
		return false;
	}

	// ── Phase 13.2: schema-versioned backups ────────────────────────────────

	private async writeBackup(content: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(BACKUP_DIR))) {
			await this.app.vault.adapter.mkdir(BACKUP_DIR);
		}
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const wrapped = JSON.stringify(
			{ __schemaVersion: MANIFEST_SCHEMA_VERSION, savedAt: new Date().toISOString(), entries: JSON.parse(content) },
			null, 2
		);
		await this.app.vault.adapter.write(`${BACKUP_DIR}/${ts}.json`, wrapped);
		await this.gcBackups();
	}

	private async gcBackups(): Promise<void> {
		const names = await this.listBackups();
		if (names.length <= MAX_BACKUPS) return;
		const toRemove = names.slice(0, names.length - MAX_BACKUPS); // oldest first
		for (const name of toRemove) {
			await this.app.vault.adapter.remove(`${BACKUP_DIR}/${name}`).catch(() => undefined);
		}
	}

	async listBackups(): Promise<string[]> {
		if (!(await this.app.vault.adapter.exists(BACKUP_DIR))) return [];
		const listing = await this.app.vault.adapter.list(BACKUP_DIR);
		return listing.files
			.map((f) => f.split("/").pop() ?? f)
			.filter((n) => n.endsWith(".json"))
			.sort(); // ISO timestamps sort chronologically
	}

	async restoreBackup(name: string): Promise<void> {
		const path = `${BACKUP_DIR}/${name}`;
		const raw = await this.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw);
		const entries = parsed.entries ?? parsed;
		this.data = sanitizeManifest(entries);
		await this.save();
		console.log(`${LOG} Restored manifest from backup: ${name}`);
	}
}

/**
 * Phase 11.2 — factory. Returns the JSON store today. When `useSqliteManifest` is set
 * and a bundled SQLite backend is available, this will return `SqliteManifestStore`
 * (deferred — see IMPROVEMENTS.md Phase 11.2 decisions).
 */
export function createManifestStore(app: App, settings: DriveDownloaderSettings, bus?: EventBus): SyncManifestStore {
	if (settings.useSqliteManifest) {
		console.warn(`${LOG} useSqliteManifest is on, but the SQLite backend is not bundled yet — using JSON store.`);
	}
	return new JsonManifestStore(app, bus);
}
