import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseContextFromFilename, resolvePageDate } from "../automation/DateResolver";
import { resolveFolderTokens } from "../companion/pathTokens";
import { pathMatchesFolderRule, selectCompanionRule } from "../companion/rules";
import { importLegacySettings, mapLegacyDeletion, migrateAutomationActions } from "../migration/legacy";
import { mapLegacyRunVersion } from "../migration/versionMapping";
import { resolveCompanionDeletionPolicy } from "../companion/policies";
import { arrayBufferToBase64 } from "../ai/binary";
import { DRIVE_DOWNLOADER_WORKSPACE_EVENTS } from "../events/workspaceEvents";
import { DEFAULT_SETTINGS, FileAutomationSettings } from "../types";

test("date resolution retains the established filename and page behavior", () => {
	assert.deepEqual(parseContextFromFilename("July 2026 journal.pdf"), { year: 2026, month: 7 });
	assert.deepEqual(resolvePageDate("5", { year: 2026, month: 7 }), {
		date: "2026-07-05",
		source: "composed"
	});
	assert.deepEqual(resolvePageDate("2024-02-29", {}), { date: "2024-02-29", source: "full" });
	assert.deepEqual(resolvePageDate("2025-02-29", {}), { date: null, source: "unresolved" });
});

test("folder tokens remain compatible with existing templates", () => {
	const path = "Boox/Books/Active/file.pdf";
	assert.equal(resolveFolderTokens("{{RootFolder}}/index", path), "Boox/index");
	assert.equal(resolveFolderTokens("{{folderL1}}/x", path), "Active/x");
	assert.equal(resolveFolderTokens("{{folderL2}}/x", path), "Books/x");
});

test("folder rule scope and nested exclusions are segment aware", () => {
	assert.equal(pathMatchesFolderRule("Inbox/a.pdf", "Inbox", "root_only"), true);
	assert.equal(pathMatchesFolderRule("Inbox/Sub/a.pdf", "Inbox", "root_only"), false);
	assert.equal(pathMatchesFolderRule("Inbox/Sub/a.pdf", "Inbox", "subfolders_only"), true);
	assert.equal(pathMatchesFolderRule("Inbox/Private/2026/a.pdf", "Inbox", "all", ["Private"]), false);
	assert.equal(pathMatchesFolderRule("Inbox2/a.pdf", "Inbox", "all"), false);
	assert.equal(pathMatchesFolderRule("root.pdf", "", "all"), true);
});

test("the longest matching companion-rule folder wins and ties preserve order", () => {
	const rules = [
		{ id: "root", label: "Root", enabled: true, triggerFolderPath: "Inbox" },
		{ id: "specific", label: "Specific", enabled: true, triggerFolderPath: "Inbox/Books" },
		{ id: "tie", label: "Tie", enabled: true, triggerFolderPath: "Inbox/Books" }
	];
	assert.equal(selectCompanionRule(rules, "Inbox/Books/a.pdf")?.id, "specific");
	assert.equal(selectCompanionRule(rules, "Inbox/a.pdf")?.id, "root");
	assert.equal(selectCompanionRule(rules, "Inbox/Books/a.txt"), null);
});

test("legacy settings import is idempotent, non-destructive, and maps pair policies", () => {
	const settings = cloneSettings();
	const legacy = {
		companionNotesEnabled: true,
		companionNotesFolder: "Legacy Notes",
		deletionBehavior: "archive_keep_companion",
		archiveFolder: "Old Archive",
		syncPairs: [{
			id: "pair-1",
			label: "Books",
			vaultDestFolder: "Inbox/Books",
			enabled: true,
			companionNotesEnabled: true,
			companionNotesFolder: "Rule Notes",
			deletionBehavior: "delete_only_companion",
			excludedSubfolders: ["Private"]
		}]
	};
	const first = importLegacySettings(settings, legacy);
	const second = importLegacySettings(settings, legacy);
	assert.equal(first.rulesImported, 1);
	assert.equal(second.rulesImported, 0);
	assert.equal(settings.companionRules[0].id, "legacy-pair-1");
	assert.equal(settings.companionRules[0].sourceDeletionPolicy, "delete");
	assert.equal(settings.companionRules[0].driveArchiveSourceDeletionPolicy, "delete");
	assert.deepEqual(settings.companionRules[0].excludedSubfolders, ["Private"]);
	assert.equal(settings.companionOnSourceDelete, "keep");
	assert.equal(settings.companionNotesEnabled, true);

	const protectedSettings = cloneSettings();
	protectedSettings.companionNotesFolder = "New value";
	importLegacySettings(protectedSettings, legacy, { companionNotesFolder: "New value" });
	assert.equal(protectedSettings.companionNotesFolder, "New value");
	assert.equal(mapLegacyDeletion("archive"), "archive");
	assert.equal(mapLegacyDeletion("delete_keep_companion"), "keep");
});

test("legacy automation action migration preserves transcription intent", () => {
	const settings = cloneSettings();
	settings.automations = [{
		id: "a",
		name: "Legacy",
		enabled: true,
		triggerFolderPath: "Inbox",
		action: {
			type: "embed_to_daily_note" as never,
			insertPosition: "bottom",
			dailyNoteNamePattern: "YYYY-MM-DD",
			transcribeFullToCompanion: true
		}
	}];
	assert.equal(migrateAutomationActions(settings.automations), 1);
	assert.equal(settings.automations[0].action.type, "add_to_periodic_note");
	assert.equal(settings.automations[0].action.periodicNoteType, "daily");
	assert.equal(settings.automations[0].action.transcriptionTarget, "companion");
});

test("legacy version mapping only marks explicitly matching runs current", () => {
	assert.equal(mapLegacyRunVersion("100:20", "drive-v2", "drive-v2"), "100:20");
	assert.equal(mapLegacyRunVersion("100:20", "drive-v2", "drive-v1"), "legacy:drive-v1");
	assert.equal(mapLegacyRunVersion("100:20", undefined, undefined), "legacy:unknown");
});

test("malformed legacy arrays are ignored without aborting valid import", () => {
	const settings = cloneSettings();
	assert.doesNotThrow(() => importLegacySettings(settings, {
		syncPairs: [null, 7, { id: "ok", label: "OK", vaultDestFolder: "PDFs", enabled: true }],
		automations: [null, { action: null }]
	}));
	assert.equal(settings.companionRules.length, 1);
	assert.doesNotThrow(() => migrateAutomationActions([null as never, { action: null } as never]));
});

test("Drive archive reason selects the archive-specific companion policy", () => {
	const rule = {
		id: "r",
		label: "Rule",
		enabled: true,
		triggerFolderPath: "PDFs",
		sourceDeletionPolicy: "keep" as const,
		driveArchiveSourceDeletionPolicy: "delete" as const
	};
	assert.equal(resolveCompanionDeletionPolicy(rule, "archive", "drive-removed"), "keep");
	assert.equal(resolveCompanionDeletionPolicy(rule, "archive", "drive-archived"), "delete");
});

test("browser base64 helper stays correct across chunk boundaries", () => {
	const bytes = Uint8Array.from({ length: 30_000 }, (_, index) => index % 251);
	assert.equal(arrayBufferToBase64(bytes.buffer), Buffer.from(bytes).toString("base64"));
});

test("downloader workspace event contract names are stable", () => {
	assert.deepEqual(DRIVE_DOWNLOADER_WORKSPACE_EVENTS, {
		sourceDisconnected: "drive-downloader:source-disconnected",
		sourceRemovalIntent: "drive-downloader:source-removal-intent",
		sourceReconnected: "drive-downloader:source-reconnected"
	});
});

function cloneSettings(): FileAutomationSettings {
	return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as FileAutomationSettings;
}
