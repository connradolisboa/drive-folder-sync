export interface DriveFile {
	id: string;
	name: string;
	modifiedTime: string; // ISO 8601
	createdTime?: string; // ISO 8601 — used as date fallback in automations
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
	/** Skip files sitting directly in the Drive folder root; only sync files inside subfolders. */
	excludeRootFiles?: boolean;
	/** Only sync files directly in the Drive folder root; ignore all subfolders. */
	rootFilesOnly?: boolean;
	// Per-pair overrides (undefined = fall back to global setting)
	deletionBehavior?: DeletionBehavior;
	archiveFolder?: string;
	companionNotesEnabled?: boolean;
	/** Override global companionNotesFolder for this pair. Supports {{RootFolder}}, {{folderL1}}, {{folderL2}} tokens. */
	companionNotesFolder?: string;
	/** Override global companionNoteTemplatePath for this pair. */
	companionNoteTemplatePath?: string;
}

export interface ManifestEntry {
	vaultPath: string;
	companionPath: string | null;
	driveModifiedTime: string; // ISO 8601
	driveCreatedTime?: string; // ISO 8601 — used as date fallback in automations
	pairId: string;
}

export type SyncManifest = Record<string, ManifestEntry>; // key = driveFileId

/** Vault path templates for each periodic note type. Supports moment.js tokens wrapped in {{}}. */
export interface PeriodicNotesPaths {
	daily: string;      // e.g. "Journal/Daily/{{YYYY}}-{{MM}}-{{DD}}"
	weekly: string;     // e.g. "Journal/Weekly/{{YYYY}}-{{[W]WW}}"
	monthly: string;    // e.g. "Journal/Monthly/{{YYYY}}-{{MM}}"
	quarterly: string;  // e.g. "Journal/Quarterly/{{YYYY}}-Q{{Q}}"
	yearly: string;     // e.g. "Journal/Yearly/{{YYYY}}"
}

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
	companionNotesFolder: string;      // empty = alongside PDF; supports {{RootFolder}}, {{folderL1}}, {{folderL2}}
	companionNoteTemplatePath: string; // vault path to .md template; empty = built-in default

	// Periodic notes paths (used by embed_to_weekly_note etc.)
	periodicNotesPaths: PeriodicNotesPaths;
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
	periodicNotesPaths: {
		daily: "",
		weekly: "",
		monthly: "",
		quarterly: "",
		yearly: "",
	},
};

// ── Automations ───────────────────────────────────────────────────────────────

export type AutomationActionType =
	| "embed_to_daily_note"
	| "embed_to_weekly_note"
	| "embed_to_monthly_note"
	| "embed_to_quarterly_note"
	| "embed_to_yearly_note"
	| "append_to_note"
	| "add_tag_to_companion";

export interface AutomationAction {
	type: AutomationActionType;
	insertPosition: "top" | "bottom"; // top = after frontmatter, bottom = end of note
	/**
	 * Moment.js format pattern used to find the daily note by filename.
	 * e.g. "{{YYYY}}-{{MM}}-{{DD}}" matches "2026-03-18.md".
	 * Leave empty to use periodicNotesPaths.daily from settings.
	 */
	dailyNoteNamePattern: string;
	/** For append_to_note: vault path to the target note (e.g. "MOCs/All PDFs.md"). */
	targetNotePath?: string;
	/** For add_tag_to_companion: tag to add to the companion note's frontmatter tags array. */
	tagName?: string;
	/** When true, embed the companion note instead of the PDF file. */
	embedCompanion?: boolean;
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
