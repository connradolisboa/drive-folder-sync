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

export type DeletionBehavior =
	| "keep"
	| "delete"
	| "archive"
	| "delete_keep_companion"
	| "archive_keep_companion"
	| "delete_only_companion";

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
	/**
	 * When true, if a file's immediate parent folder has the same name as the file (without extension),
	 * that wrapper folder is stripped from the vault path.
	 * e.g. "Books/My Book/My Book.pdf" → "Books/My Book.pdf"
	 */
	collapseSingleFileFolder?: boolean;
	// Per-pair overrides (undefined = fall back to global setting)
	deletionBehavior?: DeletionBehavior;
	archiveFolder?: string;
	/**
	 * What to do with the vault copy when a file is detected in the Drive archive folder.
	 * Overrides deletionBehavior for archive-triggered removals.
	 * undefined = fall back to the pair's effective deletionBehavior.
	 */
	driveArchiveBehavior?: DeletionBehavior;
	companionNotesEnabled?: boolean;
	/** Override global companionNotesFolder for this pair. Supports {{RootFolder}}, {{folderL1}}, {{folderL2}} tokens. */
	companionNotesFolder?: string;
	/** Override global companionNoteTemplatePath for this pair. */
	companionNoteTemplatePath?: string;
	/** Override global companionNoteTitle for this pair. Supports {{title}}, {{fileName}}, {{pairLabel}}, {{relativePath}}. */
	companionNoteTitle?: string;
}

export interface AutomationRunRecord {
	lastRunAt: string;                 // ISO
	lastRunDriveModifiedTime: string;  // Drive modifiedTime at time of run
	result: "success" | "skipped" | "error";
	outputs?: string[];                // e.g. ["daily-note:2026-05-10", "companion:Notes/foo.md"]
	errorMessage?: string;
}

export interface ManifestEntry {
	vaultPath: string;
	companionPath: string | null;
	driveModifiedTime: string; // ISO 8601
	driveCreatedTime?: string; // ISO 8601 — used as date fallback in automations
	pairId: string;
	automationRuns?: Record<string, AutomationRunRecord>;
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

	/** Google Drive folder ID used as a global archive destination. Files moved here trigger driveArchiveBehavior. */
	driveArchiveFolderId: string;

	// Sync log
	syncLogEnabled: boolean;
	syncLogPath: string;

	// Automations
	automations: Automation[];

	// Companion notes (global)
	companionNotesEnabled: boolean;
	companionNotesFolder: string;      // empty = alongside PDF; "/" = vault root; supports {{RootFolder}}, {{folderL1}}, {{folderL2}}
	companionNoteTemplatePath: string; // vault path to .md template; empty = built-in default
	companionNoteTitle: string;        // title template; empty = PDF stem; supports {{title}}, {{fileName}}, {{pairLabel}}, {{relativePath}}

	// Periodic notes paths (used by embed_to_weekly_note etc.)
	periodicNotesPaths: PeriodicNotesPaths;

	// Gemini AI transcription
	geminiApiKey: string;
	geminiEnabled: boolean;
	geminiModel: string;
	geminiPrompt: string;
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
	driveArchiveFolderId: "",
	syncLogEnabled: false,
	syncLogPath: "Drive Sync/.sync-log.md",
	companionNotesEnabled: false,
	companionNotesFolder: "",
	companionNoteTemplatePath: "",
	companionNoteTitle: "",
	periodicNotesPaths: {
		daily: "",
		weekly: "",
		monthly: "",
		quarterly: "",
		yearly: "",
	},
	geminiApiKey: "",
	geminiEnabled: false,
	geminiModel: "gemini-2.0-flash",
	geminiPrompt: "Transcribe all text visible in this PDF exactly as written, preserving structure. Return plain text only.",
};

// ── Automations ───────────────────────────────────────────────────────────────

export type AutomationActionType =
	| "embed_to_daily_note"
	| "embed_to_weekly_note"
	| "embed_to_monthly_note"
	| "embed_to_quarterly_note"
	| "embed_to_yearly_note"
	| "append_to_note"
	| "add_tag_to_companion"
	| "link_to_matching_note"
	| "transcribe_to_periodic_note"
	| "transcribe_to_companion";

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
	/**
	 * Template for the line inserted into the target note.
	 * Supports: {{embed}} → ![[target]], {{link}} → [[target]],
	 *           {{target}} → embed target name, {{title}} → PDF stem, {{date}} → YYYY-MM-DD.
	 * Leave empty to use the default: ![[target]].
	 */
	embedTemplate?: string;
	/** For link_to_matching_note: vault folder to search for notes whose basename contains all words of the PDF stem. */
	searchFolderPath?: string;
	/** For link_to_matching_note: when true, create a new note if no matching note is found. */
	createNoteIfNotFound?: boolean;
	/** For link_to_matching_note: folder to place newly created notes. Defaults to searchFolderPath when empty. */
	newNoteFolder?: string;
	/** For link_to_matching_note: vault path to a template note for newly created notes. Blank note when empty. */
	newNoteTemplatePath?: string;
	/** For link_to_matching_note: fraction of PDF stem words that must appear in a candidate note name (0.0–1.0). Default 1.0 = all words must match. */
	matchConfidenceThreshold?: number;
	/** For link_to_matching_note: also search frontmatter aliases fields when matching note names. */
	matchOnAliases?: boolean;
	/** For link_to_matching_note: also add a backlink in the companion note pointing to each matched note. */
	bidirectionalLink?: boolean;
	/** For transcribe_to_periodic_note: which periodic note type to append the transcription to. */
	periodicNoteType?: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
	/** For transcribe_to_periodic_note: template for the content inserted. Supports {{transcription}}, {{title}}, {{date}}, {{link}}, {{embed}}. */
	transcriptionTemplate?: string;
}

export interface Automation {
	id: string;
	name: string;
	enabled: boolean;
	/** Vault folder path prefix that triggers this automation, e.g. "Onyx/Notebooks/Daily" */
	triggerFolderPath: string;
	/**
	 * Which files inside the trigger folder fire this automation.
	 * "all" (default) — every file at any depth.
	 * "root_only" — only files sitting directly in the trigger folder (no subfolders).
	 * "subfolders_only" — only files inside a subfolder (not directly in the trigger folder root).
	 */
	triggerScope?: "all" | "root_only" | "subfolders_only";
	/** Subfolder names (relative to triggerFolderPath) whose files should not trigger this automation. */
	excludedSubfolders?: string[];
	action: AutomationAction;
}

export interface SyncResult {
	downloaded: number;
	skipped: number;
	errors: number;
	removed: number;
	/** Files relocated within the vault because they moved in Drive (no re-download). */
	moved?: number;
	/** Files removed from vault because they moved to the Drive archive folder. */
	archived?: number;
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
