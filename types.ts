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

export interface PluginSettings {
	clientId: string;
	clientSecret: string;
	driveFolderId: string;
	vaultDestFolder: string;
	syncIntervalMinutes: number; // 0 = disabled
	deletionBehavior: DeletionBehavior;
	archiveFolder: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	clientId: "",
	clientSecret: "",
	driveFolderId: "",
	vaultDestFolder: "Drive Sync",
	syncIntervalMinutes: 30,
	deletionBehavior: "keep",
	archiveFolder: "Drive Sync Archive",
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
