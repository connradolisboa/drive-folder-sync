export interface DriveFile {
	id: string;
	name: string;
	modifiedTime: string; // ISO 8601
	size?: string;
}

export interface DriveFolder {
	id: string;
	name: string;
}

export interface DriveCredentials {
	refresh_token: string;
	access_token: string;
	expiry: number; // Unix ms
}

export type DeletionBehavior = "keep" | "delete" | "archive";

export interface SyncPair {
	id: string;
	label: string;
	driveFolderId: string;
	vaultDestFolder: string;
	enabled: boolean;
	excludedSubfolders?: string[];
	// Per-pair overrides (undefined = fall back to global setting)
	deletionBehavior?: DeletionBehavior;
	archiveFolder?: string;
	companionNotesEnabled?: boolean;
}

export interface ManifestEntry {
	vaultPath: string;
	companionPath: string | null;
	driveModifiedTime: string; // ISO 8601
	pairId: string;
}

export type SyncManifest = Record<string, ManifestEntry>; // key = driveFileId

export interface PluginSettings {
	clientId: string;
	clientSecret: string;

	// Feature: multiple sync pairs (replaces legacy driveFolderId + vaultDestFolder)
	syncPairs: SyncPair[];

	// Legacy fields — retained for migration only, cleared after first save
	driveFolderId: string;
	vaultDestFolder: string;

	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	downloadConcurrency: number;
	deletionBehavior: DeletionBehavior;
	archiveFolder: string;

	// Sync log
	syncLogEnabled: boolean;
	syncLogPath: string;

	// Automations
	automations: Automation[];

	// Companion notes (global)
	companionNotesEnabled: boolean;
	companionNotesFolder: string;      // empty = alongside PDF
	companionNoteTemplatePath: string; // vault path to .md template; empty = built-in default
}

export const DEFAULT_SETTINGS: PluginSettings = {
	clientId: "",
	clientSecret: "",
	syncPairs: [],
	driveFolderId: "",
	vaultDestFolder: "",
	syncIntervalMinutes: 30,
	syncOnStartup: false,
	downloadConcurrency: 5,
	automations: [],
	deletionBehavior: "keep",
	archiveFolder: "Drive Sync Archive",
	syncLogEnabled: false,
	syncLogPath: "Drive Sync/.sync-log.md",
	companionNotesEnabled: false,
	companionNotesFolder: "",
	companionNoteTemplatePath: "",
};

// ── Automations ───────────────────────────────────────────────────────────────

export type AutomationActionType = "embed_to_daily_note" | "append_to_note" | "add_tag_to_companion";

export interface AutomationAction {
	type: AutomationActionType;
	insertPosition: "top" | "bottom"; // top = after frontmatter, bottom = end of note
	/**
	 * Moment.js format pattern used to find the daily note by filename.
	 * e.g. "YYYY-MM-DD" matches "2026-03-18.md".
	 * Leave empty to fall back to frontmatter (date: YYYY-MM-DD + periodic/daily tag).
	 */
	dailyNoteNamePattern: string;
	/** For append_to_note: vault path to the target note (e.g. "MOCs/All PDFs.md"). */
	targetNotePath?: string;
	/** For add_tag_to_companion: tag to add to the companion note's frontmatter tags array. */
	tagName?: string;
}

export interface Automation {
	id: string;
	name: string;
	enabled: boolean;
	/** Vault folder path prefix that triggers this automation, e.g. "Onyx/Notebooks/Daily" */
	triggerFolderPath: string;
	action: AutomationAction;
}

export interface SyncResult {
	downloaded: number;
	skipped: number;
	errors: number;
	removed: number;
	timestamp?: number;
	pairs?: Record<string, SyncResult>;
	/** Populated in dry-run mode: paths that would be downloaded. */
	wouldDownload?: string[];
	/** Populated in dry-run mode: vault paths that would be removed. */
	wouldRemove?: string[];
}

export interface DriveFileEntry {
	file: DriveFile;
	relPath: string; // relative path within the synced root, e.g. "Notes/2024"
}

export interface DriveFileEntryWithPair extends DriveFileEntry {
	pairId: string;
	destFolder: string; // resolved vaultDestFolder for this entry
}
