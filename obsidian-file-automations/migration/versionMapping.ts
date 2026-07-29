/**
 * A legacy run is fresh for the current local source only when the legacy
 * current/source version and the run version explicitly agree. Missing or
 * mismatched evidence stays distinct so the standalone plugin safely reruns.
 */
export function mapLegacyRunVersion(
	currentLocalVersion: string,
	legacyCurrentVersion: unknown,
	legacyRunVersion: unknown
): string {
	const current = typeof legacyCurrentVersion === "string" ? legacyCurrentVersion : "";
	const run = typeof legacyRunVersion === "string" ? legacyRunVersion : "";
	if (current && run && current === run) return currentLocalVersion;
	return `legacy:${run || "unknown"}`;
}
