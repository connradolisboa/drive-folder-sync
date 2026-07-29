export interface DriveFile {
	id: string;
	name: string;
	modifiedTime: string;
	createdTime?: string;
	size?: string;
	trashed?: boolean;
	md5Checksum?: string;
}

export interface DriveFolder {
	id: string;
	name: string;
}

export interface DriveCredentials {
	refresh_token: string;
	access_token: string;
	expiry: number;
}

/** The downloader only controls the source file. Companion-note policy belongs elsewhere. */
export type DeletionBehavior = "keep" | "delete" | "archive";

export type LegacyDeletionBehavior =
	| DeletionBehavior
	| "delete_keep_companion"
	| "archive_keep_companion"
	| "delete_only_companion";

export function mapLegacyDeletionBehavior(value: unknown): DeletionBehavior {
	switch (value) {
		case "delete":
		case "delete_keep_companion":
			return "delete";
		case "archive":
		case "archive_keep_companion":
			return "archive";
		case "keep":
		case "delete_only_companion":
		default:
			return "keep";
	}
}

export interface SyncPair {
	id: string;
	label: string;
	driveFolderId: string;
	vaultDestFolder: string;
	enabled: boolean;
	excludedSubfolders?: string[];
	excludeRootFiles?: boolean;
	rootFilesOnly?: boolean;
	collapseSingleFileFolder?: boolean;
	deletionBehavior?: DeletionBehavior;
	archiveFolder?: string;
	driveArchiveBehavior?: DeletionBehavior;
	driveStartPageToken?: string;
	useChangesApi?: boolean;
	deleteFromDriveAfterSync?: boolean;
}

export interface SyncManifestEntry {
	vaultPath: string;
	driveModifiedTime: string;
	driveCreatedTime?: string;
	pairId: string;
	userDeletedAt?: string;
	driveTrashed?: boolean;
	/**
	 * The downloader intentionally trashed the Drive copy after confirming the vault
	 * copy. Such entries are vault-owned and must never be removed by the deletion pass.
	 */
	deletedFromDriveAt?: string;
	driveMd5?: string;
	contentHash?: string;
	/** Durable integration state while a kept vault PDF has no active Drive source. */
	sourceDisconnectedAt?: string;
	sourceDisconnectedReason?: DriveSourceRemovalReason;
}

export type SyncManifest = Record<string, SyncManifestEntry>;

/**
 * Stable cross-plugin workspace event payload used by:
 * - `drive-downloader:source-disconnected` after a kept PDF loses its Drive source.
 * - `drive-downloader:source-removal-intent` immediately before a Drive-policy
 *   delete/archive mutates the vault PDF.
 * - `drive-downloader:source-reconnected` when an active Drive source returns.
 */
export type DriveSourceRemovalReason = "drive-removed" | "drive-archived";
export interface DriveSourceEventPayload {
	vaultPath: string;
	pairId: string;
	reason: DriveSourceRemovalReason;
}

/** Durable handoff for destructive removals that another plugin may observe later. */
export interface DriveSourceRemovalJournalEvent extends DriveSourceEventPayload {
	id: string;
	driveFileId: string;
	action: "delete" | "archive";
	at: string;
	newVaultPath?: string;
}

export interface DriveSourceRemovalJournal {
	version: 1;
	events: DriveSourceRemovalJournalEvent[];
}

export const DRIVE_DOWNLOADER_SOURCE_EVENTS_FILE =
	"drive-downloader-source-events.json";

export const DRIVE_DOWNLOADER_WORKSPACE_EVENTS = {
	sourceDisconnected: "drive-downloader:source-disconnected",
	sourceRemovalIntent: "drive-downloader:source-removal-intent",
	sourceReconnected: "drive-downloader:source-reconnected",
} as const;

export interface DriveDownloaderSettings {
	clientId: string;
	clientSecret: string;
	syncPairs: SyncPair[];
	driveFolderId: string;
	vaultDestFolder: string;
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	downloadConcurrency: number;
	deletionBehavior: DeletionBehavior;
	archiveFolder: string;
	redownloadUserDeleted: boolean;
	mirrorLocalDeletionToDrive: boolean;
	driveArchiveFolderId: string;
	syncLogEnabled: boolean;
	syncLogPath: string;
	syncActivityLogEnabled: boolean;
	syncActivityLogLevel: "info" | "warn" | "error";
	useSqliteManifest: boolean;
	useChangesApi: boolean;
	downloadCacheEnabled: boolean;
	downloadCacheMaxMb: number;
	offThreadHashing: boolean;
	lastSeenVersion: string;
	errorReportingEnabled: boolean;
	errorReportingEndpoint: string;
	/** One-time import marker for data from the legacy drive-folder-sync plugin. */
	legacyImportCompleted: boolean;
}

export const DEFAULT_SETTINGS: DriveDownloaderSettings = {
	clientId: "",
	clientSecret: "",
	syncPairs: [],
	driveFolderId: "",
	vaultDestFolder: "",
	syncIntervalMinutes: 30,
	syncOnStartup: false,
	downloadConcurrency: 5,
	deletionBehavior: "keep",
	archiveFolder: "Drive Sync Archive",
	redownloadUserDeleted: true,
	mirrorLocalDeletionToDrive: false,
	driveArchiveFolderId: "",
	syncLogEnabled: false,
	syncLogPath: "Drive Sync/.sync-log.md",
	syncActivityLogEnabled: false,
	syncActivityLogLevel: "info",
	useSqliteManifest: false,
	useChangesApi: false,
	downloadCacheEnabled: false,
	downloadCacheMaxMb: 2048,
	offThreadHashing: true,
	lastSeenVersion: "",
	errorReportingEnabled: false,
	errorReportingEndpoint: "",
	legacyImportCompleted: false,
};

export interface SyncResult {
	downloaded: number;
	skipped: number;
	errors: number;
	removed: number;
	moved?: number;
	archived?: number;
	timestamp?: number;
	pairs?: Record<string, SyncResult>;
	wouldDownload?: string[];
	wouldRemove?: string[];
}

export interface DriveFileEntry {
	file: DriveFile;
	relPath: string;
	parentFolderId?: string;
}

export interface DriveFileEntryWithPair extends DriveFileEntry {
	pairId: string;
	destFolder: string;
}
