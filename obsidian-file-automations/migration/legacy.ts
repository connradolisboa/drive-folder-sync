import type {
	Automation,
	AutomationAction,
	CompanionRule,
	FileAutomationSettings,
	SourceDeletionPolicy
} from "../types";

type UnknownRecord = Record<string, unknown>;

const AUTOMATION_SETTING_KEYS: Array<keyof FileAutomationSettings> = [
	"automations",
	"companionNotesEnabled",
	"companionNotesFolder",
	"companionNoteTemplatePath",
	"companionNoteTitle",
	"conflictPolicy",
	"periodicNotesPaths",
	"transcriptionProvider",
	"geminiApiKey",
	"geminiEnabled",
	"geminiModel",
	"geminiPrompt",
	"mistralApiKey",
	"transcribeDefaultDest",
	"transcribeCompanionTemplate",
	"transcribeCompanionTemplatePath",
	"transcribeDailyTemplate",
	"transcribeNoteTemplate",
	"transcribeCompanionFallbackFolder",
	"transcribeDefaultNotePath",
	"pdfEmbedWindowed",
	"pdfEmbedWindowHeight",
	"pdfEmbedCollapsible",
	"pdfEmbedCollapsedByDefault"
];

export function importLegacySettings(
	settings: FileAutomationSettings,
	legacy: UnknownRecord,
	currentRaw: UnknownRecord = {}
): { settingsImported: number; rulesImported: number; actionsMigrated: number } {
	let settingsImported = 0;
	for (const key of AUTOMATION_SETTING_KEYS) {
		if (currentRaw[key] !== undefined || legacy[key] === undefined) continue;
		(settings as unknown as UnknownRecord)[key] = structuredCloneSafe(legacy[key]);
		settingsImported++;
	}

	const pairs = Array.isArray(legacy.syncPairs)
		? legacy.syncPairs.filter(isRecord)
		: [];
	if (!pairs.length && typeof legacy.driveFolderId === "string" && legacy.driveFolderId) {
		pairs.push({
			id: "legacy-single-pair",
			label: "Drive Sync",
			vaultDestFolder: typeof legacy.vaultDestFolder === "string" ? legacy.vaultDestFolder : "",
			enabled: true
		});
	}
	let rulesImported = 0;
	for (const pair of pairs) {
		const pairId = stringValue(pair.id) || stableId(
			`${stringValue(pair.label)}|${stringValue(pair.vaultDestFolder)}`
		);
		const id = `legacy-${pairId}`;
		if (settings.companionRules.some((rule) => rule.id === id)) continue;
		const globallyEnabled = legacy.companionNotesEnabled === true;
		const pairEnabled = typeof pair.companionNotesEnabled === "boolean"
			? pair.companionNotesEnabled
			: globallyEnabled;
		settings.companionRules.push({
			id,
			label: stringValue(pair.label) || "Imported Drive folder",
			enabled: pair.enabled !== false && pairEnabled,
			triggerFolderPath: stringValue(pair.vaultDestFolder),
			triggerScope: pair.rootFilesOnly === true
				? "root_only"
				: pair.excludeRootFiles === true ? "subfolders_only" : "all",
			excludedSubfolders: stringArray(pair.excludedSubfolders),
			companionFolder: optionalString(pair.companionNotesFolder),
			templatePath: optionalString(pair.companionNoteTemplatePath),
			title: optionalString(pair.companionNoteTitle),
			sourceDeletionPolicy: mapLegacyDeletion(
				typeof pair.deletionBehavior === "string"
					? pair.deletionBehavior
					: stringValue(legacy.deletionBehavior)
			),
			driveArchiveSourceDeletionPolicy: mapLegacyDeletion(
				typeof pair.driveArchiveBehavior === "string"
					? pair.driveArchiveBehavior
					: typeof pair.deletionBehavior === "string"
						? pair.deletionBehavior
						: stringValue(legacy.deletionBehavior)
			),
			archiveFolder: optionalString(pair.archiveFolder) ?? optionalString(legacy.archiveFolder)
		});
		rulesImported++;
	}
	if (currentRaw.companionNotesEnabled === undefined && settings.companionRules.some((rule) => rule.enabled)) {
		settings.companionNotesEnabled = true;
	}

	// Preserve the old global policy as the new rule fallback.
	if (currentRaw.companionOnSourceDelete === undefined && typeof legacy.deletionBehavior === "string") {
		settings.companionOnSourceDelete = mapLegacyDeletion(legacy.deletionBehavior);
	}
	if (currentRaw.companionArchiveFolder === undefined && typeof legacy.archiveFolder === "string") {
		settings.companionArchiveFolder = legacy.archiveFolder;
	}

	const actionsMigrated = migrateAutomationActions(settings.automations);
	return { settingsImported, rulesImported, actionsMigrated };
}

export function migrateAutomationActions(automations: Automation[]): number {
	const periodMap: Record<string, "daily" | "weekly" | "monthly" | "quarterly" | "yearly"> = {
		embed_to_daily_note: "daily",
		embed_to_weekly_note: "weekly",
		embed_to_monthly_note: "monthly",
		embed_to_quarterly_note: "quarterly",
		embed_to_yearly_note: "yearly"
	};
	let changed = 0;
	for (const automation of automations) {
		if (!isRecord(automation) || !isRecord(automation.action)) continue;
		const action = automation.action as unknown as AutomationAction;
		const type = action.type as string;
		if (periodMap[type]) {
			action.type = "add_to_periodic_note";
			action.periodicNoteType = periodMap[type];
			if (action.transcribeFullToCompanion) {
				action.runTranscription = true;
				action.transcriptionTarget = "companion";
			}
			changed++;
		} else if (type === "transcribe_to_periodic_note") {
			action.type = "add_to_periodic_note";
			action.periodicNoteType ??= "daily";
			action.runTranscription = true;
			action.transcriptionTarget = "periodic";
			action.embedTemplate = synthesizePeriodicTemplate(action);
			changed++;
		}
	}
	return changed;
}

export function mapLegacyDeletion(value: string): SourceDeletionPolicy {
	switch (value) {
		case "delete":
		case "delete_only_companion":
			return "delete";
		case "archive":
			return "archive";
		default:
			return "keep";
	}
}

function synthesizePeriodicTemplate(action: AutomationAction): string {
	if (action.transcriptionTemplate?.trim()) return action.transcriptionTemplate;
	const header = "## Transcription from [[{{title}}]]\n\n{{transcription}}";
	if (!action.embedFile) return header;
	return action.transcriptionPosition === "above_embed"
		? `${header}\n\n{{embed}}`
		: `{{embed}}\n\n${header}`;
}

function structuredCloneSafe<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stableId(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
