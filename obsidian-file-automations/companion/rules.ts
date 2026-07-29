import type { CompanionRule, TriggerScope } from "../types";

export function normalizeVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
}

function relativeToFolder(vaultPath: string, folder: string): string | null {
	const path = normalizeVaultPath(vaultPath);
	const root = normalizeVaultPath(folder);
	if (!root) return path;
	if (path === root) return "";
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

export function pathMatchesFolderRule(
	vaultPath: string,
	triggerFolderPath: string,
	scope: TriggerScope = "all",
	excludedSubfolders: string[] = []
): boolean {
	const relative = relativeToFolder(vaultPath, triggerFolderPath);
	if (relative === null || relative === "") return false;

	const segments = relative.split("/");
	const isRootFile = segments.length === 1;
	if (scope === "root_only" && !isRootFile) return false;
	if (scope === "subfolders_only" && isRootFile) return false;

	const parentRelative = segments.slice(0, -1).join("/");
	for (const rawExclusion of excludedSubfolders) {
		const exclusion = normalizeVaultPath(rawExclusion);
		if (!exclusion) continue;
		if (parentRelative === exclusion || parentRelative.startsWith(`${exclusion}/`)) return false;
	}
	return true;
}

/**
 * Pick exactly one enabled rule. More-specific folder roots win; ties retain
 * the user's rule order so the result is stable and understandable.
 */
export function selectCompanionRule(rules: CompanionRule[], vaultPath: string): CompanionRule | null {
	if (!vaultPath.toLowerCase().endsWith(".pdf")) return null;
	let winner: CompanionRule | null = null;
	let winnerLength = -1;
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (!pathMatchesFolderRule(
			vaultPath,
			rule.triggerFolderPath,
			rule.triggerScope ?? "all",
			rule.excludedSubfolders ?? []
		)) continue;
		const length = normalizeVaultPath(rule.triggerFolderPath).length;
		if (length > winnerLength) {
			winner = rule;
			winnerLength = length;
		}
	}
	return winner;
}

export function relativePathForRule(rule: CompanionRule, vaultPath: string): string {
	const relative = relativeToFolder(vaultPath, rule.triggerFolderPath) ?? normalizeVaultPath(vaultPath);
	const slash = relative.lastIndexOf("/");
	return slash < 0 ? "" : relative.slice(0, slash);
}
