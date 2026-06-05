import { App, TFile, TFolder } from "obsidian";
import type { Automation } from "../types";

export interface LintIssue {
	automationId: string;
	severity: "error" | "warn";
	message: string;
}

/**
 * Phase 13.10 — validate automation configuration. Pure-read; no side effects.
 * Runs on settings save and inside the audit command.
 */
export function lintAutomations(
	app: App,
	automations: Automation[],
	opts: { mistralConfigured?: boolean } = {}
): LintIssue[] {
	const issues: LintIssue[] = [];
	const folderExists = (p: string) => p === "" || app.vault.getAbstractFileByPath(p) instanceof TFolder;
	const noteExists = (p: string) => app.vault.getAbstractFileByPath(p) instanceof TFile;

	const idToIndex = new Map(automations.map((a, i) => [a.id, i]));

	for (const a of automations) {
		const idx = idToIndex.get(a.id) ?? 0;
		const push = (severity: "error" | "warn", message: string) =>
			issues.push({ automationId: a.id, severity, message });

		if (a.triggerFolderPath && !folderExists(a.triggerFolderPath)) {
			push("error", `Trigger folder does not exist: "${a.triggerFolderPath}"`);
		}
		const action = a.action;
		if (action.targetNotePath && !noteExists(action.targetNotePath)) {
			push("error", `Target note does not exist: "${action.targetNotePath}"`);
		}
		if (action.searchFolderPath && !folderExists(action.searchFolderPath)) {
			push("error", `Search folder does not exist: "${action.searchFolderPath}"`);
		}
		if (action.newNoteFolder && !folderExists(action.newNoteFolder)) {
			push("error", `New-note folder does not exist: "${action.newNoteFolder}"`);
		}
		if (action.newNoteTemplatePath && !noteExists(action.newNoteTemplatePath)) {
			push("error", `New-note template does not exist: "${action.newNoteTemplatePath}"`);
		}
		if (action.matchConfidenceThreshold !== undefined) {
			const t = action.matchConfidenceThreshold;
			if (t < 0 || t > 1) push("error", `matchConfidenceThreshold must be in [0, 1] (got ${t}).`);
		}
		if (action.dailyNoteTemplatePath && !noteExists(action.dailyNoteTemplatePath)) {
			push("error", `Daily note template does not exist: "${action.dailyNoteTemplatePath}"`);
		}
		if (a.enabled && action.type === "split_pages_to_daily_notes" && opts.mistralConfigured === false) {
			push("warn", "split_pages_to_daily_notes needs a Mistral API key (Settings → Transcription) — it will no-op until one is set.");
		}
		if (action.pageIndexEnabled && action.type !== "split_pages_to_daily_notes") {
			push("warn", "pageIndexEnabled only applies to split_pages_to_daily_notes — it will be ignored here.");
		}

		// Composition checks: references must exist and run before this automation.
		for (const refId of action.includeResultsFromAutomationIds ?? []) {
			if (!idToIndex.has(refId)) {
				push("error", `Composition references unknown automation id: "${refId}".`);
			} else if ((idToIndex.get(refId) ?? 0) >= idx) {
				const refName = automations[idToIndex.get(refId) ?? 0]?.name ?? refId;
				push("warn", `Composed source "${refName}" runs at or after this automation — reorder it earlier so its results are available.`);
			}
		}
		for (const refType of action.includeResultsFromTypes ?? []) {
			const earlier = automations.some((b, i) => i < idx && b.action.type === refType);
			if (!earlier) {
				push("warn", `No automation of type "${refType}" runs before this one — composed results may be empty.`);
			}
		}
	}

	// Duplicate-trigger warning.
	const enabled = automations.filter((a) => a.enabled);
	const seen = new Map<string, string>();
	for (const a of enabled) {
		const key = `${a.triggerFolderPath}|${a.action.type}|${a.action.targetNotePath ?? ""}`;
		const prev = seen.get(key);
		if (prev) {
			issues.push({ automationId: a.id, severity: "warn", message: `Shares trigger + action with "${prev}" (may be intentional).` });
		} else {
			seen.set(key, a.name);
		}
	}

	return issues;
}

export function lintIssuesFor(app: App, automations: Automation[], automationId: string): LintIssue[] {
	return lintAutomations(app, automations).filter((i) => i.automationId === automationId);
}
