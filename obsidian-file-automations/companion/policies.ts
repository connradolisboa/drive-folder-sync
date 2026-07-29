import type { CompanionRule, SourceDeletionPolicy } from "../types";

export type SourceDisconnectReason = "drive-removed" | "drive-archived";

export function resolveCompanionDeletionPolicy(
	rule: CompanionRule | undefined,
	globalPolicy: SourceDeletionPolicy,
	reason: SourceDisconnectReason
): SourceDeletionPolicy {
	if (reason === "drive-archived") {
		return rule?.driveArchiveSourceDeletionPolicy ?? rule?.sourceDeletionPolicy ?? globalPolicy;
	}
	return rule?.sourceDeletionPolicy ?? globalPolicy;
}
