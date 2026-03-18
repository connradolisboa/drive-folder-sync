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
	deletionBehavior: DeletionBehavior;
	archiveFolder: string;

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
	deletionBehavior: "keep",
	archiveFolder: "Drive Sync Archive",
	companionNotesEnabled: false,
	companionNotesFolder: "",
	companionNoteTemplatePath: "",
};

export interface SyncResult {
	downloaded: number;
	skipped: number;
	errors: number;
	removed: number;
}

export interface DriveFileEntry {
	file: DriveFile;
	relPath: string; // relative path within the synced root, e.g. "Notes/2024"
}

export interface DriveFileEntryWithPair extends DriveFileEntry {
	pairId: string;
	destFolder: string; // resolved vaultDestFolder for this entry
}
