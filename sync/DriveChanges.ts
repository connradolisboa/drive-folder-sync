import { GoogleAuth } from "../auth/GoogleAuth";

const CHANGES_API = "https://www.googleapis.com/drive/v3/changes";
const LOG = "[DriveSync/Changes]";

export interface ChangesResult {
	/** Drive file IDs that changed since the supplied page token. */
	changedFileIds: Set<string>;
	/** Whether any of the changes touched a folder (structural change → prefer full scan). */
	hasFolderChange: boolean;
	/** The next start page token to persist for the following sync. */
	newStartPageToken: string;
}

/**
 * Phase 11.1 — thin wrapper over the Drive `changes` API.
 *
 * Used as a cheap "is anything different?" probe so an idle Drive can skip the full
 * per-pair folder walk. The changes feed is account-wide; we cache results per token
 * within a single sync run so multiple pairs sharing a token cost one API call.
 */
export class DriveChangesClient {
	private cache = new Map<string, Promise<ChangesResult>>();

	constructor(private auth: GoogleAuth) {}

	/** Reset the per-run cache. Call at the start of each sync. */
	resetRunCache(): void { this.cache.clear(); }

	async getStartPageToken(): Promise<string> {
		const token = await this.auth.getValidAccessToken();
		const resp = await fetch(`${CHANGES_API}/startPageToken`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!resp.ok) throw new Error(`changes.getStartPageToken failed: HTTP ${resp.status}`);
		const data = await resp.json();
		return data.startPageToken as string;
	}

	/** List changes since `pageToken`, paging to completion. Cached per token within a run. */
	listChanges(pageToken: string): Promise<ChangesResult> {
		const cached = this.cache.get(pageToken);
		if (cached) return cached;
		const promise = this.listChangesUncached(pageToken);
		this.cache.set(pageToken, promise);
		return promise;
	}

	private async listChangesUncached(pageToken: string): Promise<ChangesResult> {
		const accessToken = await this.auth.getValidAccessToken();
		const changedFileIds = new Set<string>();
		let hasFolderChange = false;
		let cursor: string | undefined = pageToken;
		let newStartPageToken = pageToken;

		do {
			const params = new URLSearchParams({
				pageToken: cursor!,
				pageSize: "1000",
				fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,mimeType,trashed,parents))",
				includeRemoved: "true",
				spaces: "drive",
			});
			const resp = await fetch(`${CHANGES_API}?${params}`, {
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (!resp.ok) throw new Error(`changes.list failed: HTTP ${resp.status}`);
			const data = await resp.json();
			for (const change of data.changes ?? []) {
				if (change.fileId) changedFileIds.add(change.fileId);
				if (change.file?.mimeType === "application/vnd.google-apps.folder") hasFolderChange = true;
			}
			if (data.newStartPageToken) newStartPageToken = data.newStartPageToken;
			cursor = data.nextPageToken;
		} while (cursor);

		console.log(`${LOG} ${changedFileIds.size} change(s) since token; folderChange=${hasFolderChange}`);
		return { changedFileIds, hasFolderChange, newStartPageToken };
	}
}
