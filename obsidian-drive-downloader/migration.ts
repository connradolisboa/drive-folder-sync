import {
	DEFAULT_SETTINGS,
	DriveDownloaderSettings,
	SyncPair,
	mapLegacyDeletionBehavior,
} from "./types";

type UnknownRecord = Record<string, unknown>;

export interface LegacyImportResult {
	/** Fully normalized settings that can be assigned directly by the plugin. */
	settings: DriveDownloaderSettings;
	/** True only when at least one usable value came from the legacy plugin. */
	imported: boolean;
	/** True when the caller must persist settings (including a no-source attempt). */
	shouldPersist: boolean;
}

const STRING_FIELDS = [
	"clientId",
	"clientSecret",
	"archiveFolder",
	"driveArchiveFolderId",
	"syncLogPath",
	"lastSeenVersion",
	"errorReportingEndpoint",
] as const;

const BOOLEAN_FIELDS = [
	"syncOnStartup",
	"redownloadUserDeleted",
	"syncLogEnabled",
	"syncActivityLogEnabled",
	"useSqliteManifest",
	"useChangesApi",
	"downloadCacheEnabled",
	"offThreadHashing",
	"errorReportingEnabled",
] as const;

function asRecord(value: unknown): UnknownRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as UnknownRecord
		: null;
}

function own(record: UnknownRecord, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function finiteInteger(
	value: unknown,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function stablePairId(source: string): string {
	// FNV-1a is deterministic across reloads and does not require Node or Web Crypto.
	let hash = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		hash ^= source.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `legacy-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sanitizeStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value
		.map(nonEmptyString)
		.filter((item): item is string => item !== undefined);
	return strings.length > 0 ? Array.from(new Set(strings)) : [];
}

/**
 * Reduce an old sync-pair object to fields the standalone downloader owns.
 * Automation, transcription, and companion-note properties are intentionally
 * omitted rather than copied and ignored later.
 */
function sanitizeSyncPair(
	value: unknown,
	index: number,
	requireDriveFolderId: boolean,
): SyncPair | null {
	const source = asRecord(value);
	if (!source) return null;

	const driveFolderId = nonEmptyString(source.driveFolderId) ?? "";
	if (requireDriveFolderId && !driveFolderId) return null;

	const label = nonEmptyString(source.label) ?? `Drive Sync ${index + 1}`;
	const vaultDestFolder = nonEmptyString(source.vaultDestFolder) ?? "Drive Sync";
	const providedId = nonEmptyString(source.id);
	const pair: SyncPair = {
		id: providedId ?? stablePairId(`${driveFolderId}\0${vaultDestFolder}\0${label}\0${index}`),
		label,
		driveFolderId,
		vaultDestFolder,
		enabled: typeof source.enabled === "boolean" ? source.enabled : true,
	};

	const excludedSubfolders = sanitizeStringList(source.excludedSubfolders);
	if (excludedSubfolders !== undefined) pair.excludedSubfolders = excludedSubfolders;

	for (const key of [
		"excludeRootFiles",
		"rootFilesOnly",
		"collapseSingleFileFolder",
		"useChangesApi",
		"deleteFromDriveAfterSync",
	] as const) {
		const setting = source[key];
		if (typeof setting === "boolean") pair[key] = setting;
	}

	if (own(source, "deletionBehavior")) {
		pair.deletionBehavior = mapLegacyDeletionBehavior(source.deletionBehavior);
	}
	if (own(source, "driveArchiveBehavior")) {
		pair.driveArchiveBehavior = mapLegacyDeletionBehavior(source.driveArchiveBehavior);
	}

	const archiveFolder = nonEmptyString(source.archiveFolder);
	if (archiveFolder) pair.archiveFolder = archiveFolder;
	const driveStartPageToken = nonEmptyString(source.driveStartPageToken);
	if (driveStartPageToken) pair.driveStartPageToken = driveStartPageToken;

	return pair;
}

export function sanitizeLegacySyncPair(value: unknown, index = 0): SyncPair | null {
	return sanitizeSyncPair(value, index, true);
}

/**
 * Convert legacy drive-folder-sync data to a downloader-only partial.
 *
 * The return value is deliberately whitelisted. Unknown properties—including
 * automations, API keys, transcription state, and companion-note settings—never
 * cross the migration boundary.
 */
export function mapLegacyDriveFolderSyncSettings(
	value: unknown,
): Partial<DriveDownloaderSettings> {
	const source = asRecord(value);
	if (!source) return {};

	const mapped: Partial<DriveDownloaderSettings> = {};
	for (const key of STRING_FIELDS) {
		if (typeof source[key] === "string") mapped[key] = source[key] as never;
	}
	for (const key of BOOLEAN_FIELDS) {
		if (typeof source[key] === "boolean") mapped[key] = source[key] as never;
	}

	const syncIntervalMinutes = finiteInteger(source.syncIntervalMinutes, 0);
	if (syncIntervalMinutes !== undefined) mapped.syncIntervalMinutes = syncIntervalMinutes;
	const downloadConcurrency = finiteInteger(source.downloadConcurrency, 1, 20);
	if (downloadConcurrency !== undefined) mapped.downloadConcurrency = downloadConcurrency;
	const downloadCacheMaxMb = finiteInteger(source.downloadCacheMaxMb, 1);
	if (downloadCacheMaxMb !== undefined) mapped.downloadCacheMaxMb = downloadCacheMaxMb;

	if (own(source, "deletionBehavior")) {
		mapped.deletionBehavior = mapLegacyDeletionBehavior(source.deletionBehavior);
	}
	if (
		source.syncActivityLogLevel === "info"
		|| source.syncActivityLogLevel === "warn"
		|| source.syncActivityLogLevel === "error"
	) {
		mapped.syncActivityLogLevel = source.syncActivityLogLevel;
	}

	const pairs = Array.isArray(source.syncPairs)
		? source.syncPairs
			.map((pair, index) => sanitizeLegacySyncPair(pair, index))
			.filter((pair): pair is SyncPair => pair !== null)
		: [];

	if (pairs.length > 0) {
		mapped.syncPairs = pairs;
		mapped.driveFolderId = "";
		mapped.vaultDestFolder = "";
	} else {
		const driveFolderId = nonEmptyString(source.driveFolderId);
		if (driveFolderId) {
			const vaultDestFolder = nonEmptyString(source.vaultDestFolder) ?? "Drive Sync";
			mapped.syncPairs = [
				sanitizeLegacySyncPair(
					{
						label: "Drive Sync",
						driveFolderId,
						vaultDestFolder,
						enabled: true,
					},
					0,
				)!,
			];
			mapped.driveFolderId = "";
			mapped.vaultDestFolder = "";
		}
	}

	return mapped;
}

/**
 * Normalize downloader-owned data without accepting removed feature fields.
 * This uses the same whitelist as legacy migration, plus downloader-only fields.
 */
function mapCurrentDownloaderSettings(value: unknown): Partial<DriveDownloaderSettings> {
	const source = asRecord(value);
	if (!source) return {};

	const mapped = mapLegacyDriveFolderSyncSettings(source);
	if (typeof source.mirrorLocalDeletionToDrive === "boolean") {
		mapped.mirrorLocalDeletionToDrive = source.mirrorLocalDeletionToDrive;
	}
	if (typeof source.legacyImportCompleted === "boolean") {
		mapped.legacyImportCompleted = source.legacyImportCompleted;
	}

	// Downloader-owned draft pairs are valid before a Drive folder ID is entered.
	// Legacy import remains stricter so empty historical placeholders do not migrate.
	if (Array.isArray(source.syncPairs)) {
		mapped.syncPairs = source.syncPairs
			.map((pair, index) => sanitizeSyncPair(pair, index, false))
			.filter((pair): pair is SyncPair => pair !== null);
	}
	// Preserve downloader-owned legacy placeholders exactly when they are saved.
	if (typeof source.driveFolderId === "string" && !source.driveFolderId.trim()) {
		mapped.driveFolderId = "";
	}
	if (typeof source.vaultDestFolder === "string" && !source.vaultDestFolder.trim()) {
		mapped.vaultDestFolder = "";
	}

	return mapped;
}

/**
 * Complete a one-time legacy import using raw `loadData()` output.
 *
 * Call this before merging raw data with defaults. On the first attempt, legacy
 * values fill gaps while already-saved downloader values win. The attempt is
 * marked complete even if the legacy file is absent, preventing a later plugin
 * install from silently changing configured settings.
 */
export function prepareLegacyImport(
	currentData: unknown,
	legacyData: unknown,
): LegacyImportResult {
	const currentSource = asRecord(currentData);
	const current = mapCurrentDownloaderSettings(currentSource);

	if (currentSource?.legacyImportCompleted === true) {
		return {
			settings: {
				...DEFAULT_SETTINGS,
				...current,
				legacyImportCompleted: true,
			},
			imported: false,
			shouldPersist: false,
		};
	}

	const legacy = mapLegacyDriveFolderSyncSettings(legacyData);
	const imported = Object.keys(legacy).length > 0;
	return {
		settings: {
			...DEFAULT_SETTINGS,
			...legacy,
			...current,
			legacyImportCompleted: true,
		},
		imported,
		shouldPersist: true,
	};
}
