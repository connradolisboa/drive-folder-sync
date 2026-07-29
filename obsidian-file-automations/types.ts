export type SourceDeletionPolicy = "keep" | "delete" | "archive";
export type TriggerScope = "all" | "root_only" | "subfolders_only";

export interface CompanionRule {
	id: string;
	label: string;
	enabled: boolean;
	triggerFolderPath: string;
	triggerScope?: TriggerScope;
	excludedSubfolders?: string[];
	companionFolder?: string;
	templatePath?: string;
	title?: string;
	sourceDeletionPolicy?: SourceDeletionPolicy;
	/** Companion policy when Drive Downloader reports a Drive-archive disconnection. */
	driveArchiveSourceDeletionPolicy?: SourceDeletionPolicy;
	archiveFolder?: string;
}

export interface SourceVersion {
	fingerprint: string;
	mtime: number;
	size: number;
}

export interface AutomationRunRecord {
	lastRunAt: string;
	sourceVersion: string;
	result: "success" | "skipped" | "error";
	outputs?: string[];
	errorMessage?: string;
}

export interface PeriodicNotesPaths {
	daily: string;
	weekly: string;
	monthly: string;
	quarterly: string;
	yearly: string;
}

export interface FileAutomationSettings {
	automations: Automation[];
	companionRules: CompanionRule[];
	companionNotesEnabled: boolean;
	companionNotesFolder: string;
	companionNoteTemplatePath: string;
	companionNoteTitle: string;
	companionOnSourceDelete: SourceDeletionPolicy;
	companionArchiveFolder: string;
	conflictPolicy: "save-both" | "keep-vault" | "take-drive" | "ask";
	periodicNotesPaths: PeriodicNotesPaths;
	transcriptionProvider: "gemini" | "mistral";
	geminiApiKey: string;
	geminiEnabled: boolean;
	geminiModel: string;
	geminiPrompt: string;
	mistralApiKey: string;
	transcribeDefaultDest: "ask" | "companion" | "daily" | "note";
	transcribeCompanionTemplate: string;
	transcribeCompanionTemplatePath: string;
	transcribeDailyTemplate: string;
	transcribeNoteTemplate: string;
	transcribeCompanionFallbackFolder: string;
	transcribeDefaultNotePath: string;
	pdfEmbedWindowed: boolean;
	pdfEmbedWindowHeight: number;
	pdfEmbedCollapsible: boolean;
	pdfEmbedCollapsedByDefault: boolean;
	legacyImportVersion: number;
}

export const DEFAULT_SETTINGS: FileAutomationSettings = {
	automations: [],
	companionRules: [],
	companionNotesEnabled: false,
	companionNotesFolder: "",
	companionNoteTemplatePath: "",
	companionNoteTitle: "",
	companionOnSourceDelete: "keep",
	companionArchiveFolder: "File Automations Archive",
	conflictPolicy: "save-both",
	periodicNotesPaths: { daily: "", weekly: "", monthly: "", quarterly: "", yearly: "" },
	transcriptionProvider: "gemini",
	geminiApiKey: "",
	geminiEnabled: false,
	geminiModel: "gemini-2.0-flash",
	geminiPrompt: "Transcribe all text visible in this PDF exactly as written, preserving structure. Return plain text only.",
	mistralApiKey: "",
	transcribeDefaultDest: "ask",
	transcribeCompanionTemplate: "",
	transcribeCompanionTemplatePath: "",
	transcribeDailyTemplate: "",
	transcribeNoteTemplate: "",
	transcribeCompanionFallbackFolder: "",
	transcribeDefaultNotePath: "",
	pdfEmbedWindowed: false,
	pdfEmbedWindowHeight: 400,
	pdfEmbedCollapsible: false,
	pdfEmbedCollapsedByDefault: false,
	legacyImportVersion: 0
};

export type AutomationActionType =
	| "add_to_periodic_note"
	| "append_to_note"
	| "add_tag_to_companion"
	| "link_to_matching_note"
	| "transcribe_to_companion"
	| "split_pages_to_daily_notes";

export type LegacyAutomationActionType =
	| "embed_to_daily_note"
	| "embed_to_weekly_note"
	| "embed_to_monthly_note"
	| "embed_to_quarterly_note"
	| "embed_to_yearly_note"
	| "transcribe_to_periodic_note";

export interface AutomationAction {
	type: AutomationActionType;
	insertPosition: "top" | "bottom";
	dailyNoteNamePattern: string;
	targetNotePath?: string;
	tagName?: string;
	embedCompanion?: boolean;
	transcribeFullToCompanion?: boolean;
	companionLinkToPeriodicNote?: boolean;
	embedTemplate?: string;
	searchFolderPath?: string;
	createNoteIfNotFound?: boolean;
	newNoteFolder?: string;
	newNoteTemplatePath?: string;
	matchConfidenceThreshold?: number;
	matchOnAliases?: boolean;
	bidirectionalLink?: boolean;
	periodicNoteType?: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
	runTranscription?: boolean;
	transcriptionTarget?: "periodic" | "companion";
	transcriptionTemplate?: string;
	embedFile?: boolean;
	transcriptionPosition?: "above_embed" | "below_embed";
	transcriptionInsertPosition?: "top" | "bottom";
	deleteFileAfterTranscription?: boolean;
	createDailyNoteIfMissing?: boolean;
	dailyNoteTemplatePath?: string;
	pageContentMode?: "embed" | "transcription" | "both";
	pageEmbedTemplate?: string;
	pageIndexEnabled?: boolean;
	pageIndexNotePath?: string;
	pageIndexHeading?: string;
	includeResultsFromAutomationIds?: string[];
	includeResultsFromTypes?: AutomationActionType[];
	includeResultsHeading?: string;
	includeResultsTemplate?: string;
}

export interface AutomationOutput {
	automationId: string;
	type: AutomationActionType;
	pageMappings?: Array<{ page: number; date: string | null; source: string }>;
	outputs?: string[];
	transcriptionWritten?: boolean;
}

export interface AutomationRunReport {
	byId: Record<string, AutomationOutput>;
	byType: Partial<Record<AutomationActionType, AutomationOutput[]>>;
}

export interface Automation {
	id: string;
	name: string;
	enabled: boolean;
	triggerFolderPath: string;
	triggerScope?: TriggerScope;
	excludedSubfolders?: string[];
	action: AutomationAction;
}
