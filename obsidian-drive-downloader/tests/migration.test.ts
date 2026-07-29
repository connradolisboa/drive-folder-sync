import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	mapLegacyDriveFolderSyncSettings,
	prepareLegacyImport,
	sanitizeLegacySyncPair,
} from "../migration";
import { DRIVE_DOWNLOADER_WORKSPACE_EVENTS } from "../types";

test("legacy mapping copies only downloader fields and maps deletion policies", () => {
	const mapped = mapLegacyDriveFolderSyncSettings({
		clientId: "client",
		clientSecret: "secret",
		syncIntervalMinutes: 12.4,
		downloadConcurrency: 100,
		deletionBehavior: "archive_keep_companion",
		automations: [{ id: "must-not-cross" }],
		geminiApiKey: "must-not-cross",
		transcriptionProvider: "gemini",
		companionNotesEnabled: true,
		syncPairs: [
			{
				id: "pair-1",
				label: "Research",
				driveFolderId: "drive-1",
				vaultDestFolder: "PDFs",
				enabled: false,
				deletionBehavior: "delete_keep_companion",
				driveArchiveBehavior: "delete_only_companion",
				driveStartPageToken: "cursor",
				deleteFromDriveAfterSync: true,
				companionNotesFolder: "must-not-cross",
				automationIds: ["must-not-cross"],
			},
		],
	});

	assert.equal(mapped.deletionBehavior, "archive");
	assert.equal(mapped.syncIntervalMinutes, 12);
	assert.equal(mapped.downloadConcurrency, 20);
	assert.equal(mapped.syncPairs?.[0].deletionBehavior, "delete");
	assert.equal(mapped.syncPairs?.[0].driveArchiveBehavior, "keep");
	assert.equal(mapped.syncPairs?.[0].driveStartPageToken, "cursor");
	assert.equal(mapped.syncPairs?.[0].deleteFromDriveAfterSync, true);
	assert.equal("automations" in mapped, false);
	assert.equal("geminiApiKey" in mapped, false);
	assert.equal("transcriptionProvider" in mapped, false);
	assert.equal("companionNotesEnabled" in mapped, false);
	assert.equal("companionNotesFolder" in (mapped.syncPairs?.[0] ?? {}), false);
	assert.equal("automationIds" in (mapped.syncPairs?.[0] ?? {}), false);
});

test("single-pair migration uses a deterministic ID and clears legacy placeholders", () => {
	const legacy = {
		driveFolderId: "folder-id",
		vaultDestFolder: "Imported PDFs",
	};
	const first = mapLegacyDriveFolderSyncSettings(legacy);
	const second = mapLegacyDriveFolderSyncSettings(legacy);

	assert.equal(first.syncPairs?.length, 1);
	assert.equal(first.syncPairs?.[0].id, second.syncPairs?.[0].id);
	assert.match(first.syncPairs?.[0].id ?? "", /^legacy-[0-9a-f]{8}$/);
	assert.equal(first.syncPairs?.[0].driveFolderId, "folder-id");
	assert.equal(first.syncPairs?.[0].vaultDestFolder, "Imported PDFs");
	assert.equal(first.driveFolderId, "");
	assert.equal(first.vaultDestFolder, "");
});

test("invalid pairs are dropped and missing pair values receive safe defaults", () => {
	assert.equal(sanitizeLegacySyncPair({ driveFolderId: "" }), null);
	const pair = sanitizeLegacySyncPair({
		driveFolderId: "folder",
		excludedSubfolders: [" Drafts ", "", "Drafts", 5],
	}, 2);

	assert.equal(pair?.label, "Drive Sync 3");
	assert.equal(pair?.vaultDestFolder, "Drive Sync");
	assert.equal(pair?.enabled, true);
	assert.deepEqual(pair?.excludedSubfolders, ["Drafts"]);
});

test("first import fills gaps, preserves explicit downloader values, and requests persistence", () => {
	const result = prepareLegacyImport(
		{
			clientId: "",
			syncPairs: [],
			syncOnStartup: false,
			mirrorLocalDeletionToDrive: true,
		},
		{
			clientId: "legacy-client",
			clientSecret: "legacy-secret",
			syncOnStartup: true,
			syncIntervalMinutes: 15,
			driveFolderId: "legacy-folder",
			vaultDestFolder: "Legacy PDFs",
		},
	);

	assert.equal(result.settings.clientId, "");
	assert.equal(result.settings.clientSecret, "legacy-secret");
	assert.equal(result.settings.syncOnStartup, false);
	assert.equal(result.settings.syncIntervalMinutes, 15);
	assert.deepEqual(result.settings.syncPairs, []);
	assert.equal(result.settings.mirrorLocalDeletionToDrive, true);
	assert.equal(result.settings.legacyImportCompleted, true);
	assert.equal(result.imported, true);
	assert.equal(result.shouldPersist, true);
});

test("completed imports ignore later legacy changes", () => {
	const first = prepareLegacyImport(
		{ syncIntervalMinutes: 10 },
		{ clientId: "first-client", syncOnStartup: true },
	);
	const second = prepareLegacyImport(
		first.settings,
		{ clientId: "replacement-client", syncIntervalMinutes: 99 },
	);

	assert.equal(second.settings.clientId, "first-client");
	assert.equal(second.settings.syncIntervalMinutes, 10);
	assert.equal(second.settings.syncOnStartup, true);
	assert.equal(second.settings.legacyImportCompleted, true);
	assert.equal(second.imported, false);
	assert.equal(second.shouldPersist, false);
});

test("an absent legacy source still completes the one-time attempt", () => {
	const result = prepareLegacyImport(null, null);

	assert.equal(result.settings.legacyImportCompleted, true);
	assert.equal(result.imported, false);
	assert.equal(result.shouldPersist, true);
});

test("a zero-minute interval survives normalization as the disabled schedule", () => {
	const result = prepareLegacyImport(
		{ syncIntervalMinutes: 0, legacyImportCompleted: true },
		{ syncIntervalMinutes: 30 },
	);

	assert.equal(result.settings.syncIntervalMinutes, 0);
	assert.equal(result.shouldPersist, false);
});

test("current downloader data preserves draft pairs with an empty Drive folder ID", () => {
	const result = prepareLegacyImport(
		{
			legacyImportCompleted: true,
			syncPairs: [
				{
					id: "draft-pair",
					label: "Draft",
					driveFolderId: "",
					vaultDestFolder: "PDFs",
					enabled: false,
				},
			],
		},
		null,
	);

	assert.equal(result.settings.syncPairs.length, 1);
	assert.equal(result.settings.syncPairs[0].id, "draft-pair");
	assert.equal(result.settings.syncPairs[0].driveFolderId, "");
	assert.equal(result.settings.syncPairs[0].enabled, false);
});

test("cross-plugin workspace event names remain stable", () => {
	assert.deepEqual(DRIVE_DOWNLOADER_WORKSPACE_EVENTS, {
		sourceDisconnected: "drive-downloader:source-disconnected",
		sourceRemovalIntent: "drive-downloader:source-removal-intent",
		sourceReconnected: "drive-downloader:source-reconnected",
	});
});
