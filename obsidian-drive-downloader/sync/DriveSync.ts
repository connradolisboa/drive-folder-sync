import { App, normalizePath, TFile } from "obsidian";
import { GoogleAuth } from "../auth/GoogleAuth";
import { DownloadManager } from "./DownloadManager";
import type { SyncManifestStore } from "./SyncManifest";
import { analyzePdf, PdfInfo } from "../ai/PdfPageHasher";
import type { EventBus } from "../events/EventBus";
import type { HeavyWorkerClient } from "../workers/heavyWorker";
import { DriveChangesClient } from "./DriveChanges";
import type { Recycle } from "./Recycle";
import { newSyncRunId } from "./Recycle";
import { checkDiskSpace } from "./DiskSpaceCheck";
import {
	DeletionBehavior,
	DriveFile,
	DriveFileEntry,
	DriveFolder,
	DriveDownloaderSettings,
	DRIVE_DOWNLOADER_SOURCE_EVENTS_FILE,
	DRIVE_DOWNLOADER_WORKSPACE_EVENTS,
	DriveSourceRemovalJournal,
	DriveSourceRemovalJournalEvent,
	DriveSourceRemovalReason,
	SyncManifestEntry,
	SyncPair,
	SyncResult,
} from "../types";

const FILES_API = "https://www.googleapis.com/drive/v3/files";
const LOG = "[DriveSync/Sync]";

export class DriveSync {
	private changesClient?: DriveChangesClient;
	/** Set when DriveSync mutates a pair (e.g. changes-API token); the plugin persists after sync. */
	private settingsDirty = false;
	/** Changes cursors are staged until the corresponding scan and deletion pass succeed. */
	private stagedChangeTokens = new Map<string, string>();

	constructor(
		private auth: GoogleAuth,
		private downloader: DownloadManager,
		private settings: DriveDownloaderSettings,
		private app: App,
		private manifest: SyncManifestStore,
		private bus?: EventBus,
		private heavyWorker?: HeavyWorkerClient,
		private recycle?: Recycle
	) {}

	/** Groups recycle-bin entries written during one sync run (Phase 13.5). */
	private currentSyncRunId = newSyncRunId();
	/**
	 * In-flight path claims for the current run (path → driveFileId). Concurrent
	 * processEntry workers for two same-named new files would otherwise both resolve
	 * to the same vault path before either writes its manifest entry. Cleared at the
	 * start of every run.
	 */
	private pathClaims = new Map<string, string>();
	/** Phase 13.3 — per-pair token bucket: timestamps of recent runs for rate-limiting. */
	private pairRunTimestamps = new Map<string, number[]>();

	/** Phase 13.3 — returns false (and logs) when a pair exceeds 30 runs/hour. */
	private withinRateLimit(pairId: string): boolean {
		const now = Date.now();
		const hourAgo = now - 60 * 60 * 1000;
		const recent = (this.pairRunTimestamps.get(pairId) ?? []).filter((t) => t >= hourAgo);
		if (recent.length >= 30) {
			console.warn(`${LOG} Rate cap: pair ${pairId} exceeded 30 runs/hour — skipping this run.`);
			this.pairRunTimestamps.set(pairId, recent);
			return false;
		}
		recent.push(now);
		this.pairRunTimestamps.set(pairId, recent);
		return true;
	}

	/** Phase 11.4 — analyze PDF bytes off-thread when enabled, else synchronously. */
	private async analyzeBytes(bytes: ArrayBuffer): Promise<PdfInfo> {
		if (this.heavyWorker && this.settings.offThreadHashing) {
			return this.heavyWorker.analyze(bytes);
		}
		return analyzePdf(bytes);
	}

	updateSettings(settings: DriveDownloaderSettings): void {
		this.settings = settings;
	}

	/** Phase 11.1 — the plugin calls this after a sync to persist any pair-token mutations. */
	consumeSettingsDirty(): boolean {
		const wasDirty = this.settingsDirty;
		this.settingsDirty = false;
		return wasDirty;
	}

	private getChangesClient(): DriveChangesClient {
		if (!this.changesClient) this.changesClient = new DriveChangesClient(this.auth);
		return this.changesClient;
	}

	/**
	 * Phase 11.1 — cheap pre-walk probe. Returns true when the changes feed proves the
	 * account is idle since this pair's stored token, so the full folder walk can be skipped.
	 * A new token is staged, not persisted here. It is committed only after the
	 * corresponding full scan and deletion pass finish without errors.
	 */
	private async pairIsIdleViaChanges(pair: SyncPair): Promise<boolean> {
		const useChanges = pair.useChangesApi ?? this.settings.useChangesApi;
		if (!useChanges) return false;
		try {
			const client = this.getChangesClient();
			if (!pair.driveStartPageToken) {
				this.stagedChangeTokens.set(pair.id, await client.getStartPageToken());
				return false; // first run — must full-scan to populate the manifest
			}
			const res = await client.listChanges(pair.driveStartPageToken);
			this.stagedChangeTokens.set(pair.id, res.newStartPageToken);
			// Only skip when nothing changed account-wide since the token. Any change → full scan.
			return res.changedFileIds.size === 0;
		} catch (e) {
			console.warn(`${LOG} changes-API probe failed for "${pair.label}" — falling back to full scan:`, e);
			return false;
		}
	}

	private commitStagedChangeToken(pair: SyncPair): void {
		const token = this.stagedChangeTokens.get(pair.id);
		if (!token) return;
		this.stagedChangeTokens.delete(pair.id);
		if (pair.driveStartPageToken === token) return;
		pair.driveStartPageToken = token;
		this.settingsDirty = true;
	}

	async sync(dryRun = false): Promise<SyncResult> {
		this.changesClient?.resetRunCache();
		this.stagedChangeTokens.clear();
		this.currentSyncRunId = newSyncRunId();
		this.pathClaims.clear();

		console.log(`${LOG} Fetching access token`);
		const token = await this.auth.getValidAccessToken();

		const result: SyncResult = {
			downloaded: 0,
			skipped: 0,
			errors: 0,
			removed: 0,
			moved: 0,
			archived: 0,
			timestamp: Date.now(),
			pairs: {},
			...(dryRun ? { wouldDownload: [], wouldRemove: [] } : {}),
		};

		const activePairs = this.settings.syncPairs.filter(
			(p) => p.enabled && p.driveFolderId.trim()
		);
		console.log(`${LOG} Active sync pairs: ${activePairs.length}${dryRun ? " (dry run)" : ""}`);

		// Pre-collect Drive archive IDs. If configured archive detection fails, downloads
		// may continue, but every deletion pass must be suppressed for this run.
		let archivedIds = new Set<string>();
		let archiveDetectionFailed = false;
		if (this.settings.driveArchiveFolderId) {
			try {
				archivedIds = await this.collectArchiveIds(token);
			} catch (error) {
				archiveDetectionFailed = true;
				result.errors++;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`${LOG} Drive archive detection failed; all deletion passes are disabled:`, error);
				this.bus?.emit("error", {
					message: `Drive archive detection failed; deletion passes were skipped: ${message}`,
					context: "drive-archive-detection",
				});
			}
		}
		if (archivedIds.size > 0) {
			console.log(`${LOG} Drive archive folder contains ${archivedIds.size} tracked file(s)`);
		}

		// ── Phase 1: process files for ALL pairs ─────────────────────────────
		// Must complete before any deletion pass so cross-pair moves update pairId
		// in the manifest before Pair 1's deletion pass runs.
		const pairSeenIds = new Map<string, Set<string>>();
		const pairTrashedIds = new Map<string, Set<string>>();
		const globalSeenIds = new Set<string>();
		const failedPairIds = new Set<string>();
		const incompletePairIds = new Set<string>();
		const tokenCommitReadyPairIds = new Set<string>();

		for (const pair of activePairs) {
			console.log(`${LOG} [Phase 1] Processing pair "${pair.label}" → "${pair.vaultDestFolder}"`);
			try {
				const { pairResult, seenIds, trashedIds, scanComplete } =
					await this.syncPairFiles(pair, token, dryRun);
				pairSeenIds.set(pair.id, seenIds);
				pairTrashedIds.set(pair.id, trashedIds);
				if (!scanComplete) incompletePairIds.add(pair.id);
				seenIds.forEach((id) => globalSeenIds.add(id));
				result.downloaded += pairResult.downloaded;
				result.skipped += pairResult.skipped;
				result.moved! += pairResult.moved ?? 0;
				result.errors += pairResult.errors;
				result.pairs![pair.id] = pairResult;
				if (dryRun) {
					result.wouldDownload!.push(...(pairResult.wouldDownload ?? []));
				}
			} catch (e) {
				console.error(`${LOG} Pair "${pair.label}" file processing failed:`, e);
				// A failed scan proves nothing about what disappeared from Drive. Never
				// run a destructive deletion pass with an empty/partial seen set.
				failedPairIds.add(pair.id);
				result.errors++;
				result.pairs![pair.id] = { downloaded: 0, skipped: 0, errors: 1, removed: 0, moved: 0, archived: 0 };
			}
		}

		// ── Phase 2: deletion passes for ALL pairs ───────────────────────────
		// Cross-pair move safety depends on a complete global scan. If any pair or
		// archive lookup failed, no pair is safe to delete from this run.
		const deletionPhaseSafe =
			failedPairIds.size === 0 &&
			incompletePairIds.size === 0 &&
			!archiveDetectionFailed;
		if (!deletionPhaseSafe) {
			console.warn(
				`${LOG} Skipping every deletion pass because the global Drive view is incomplete.`
			);
		} else if (!dryRun) {
			for (const pair of activePairs) {
				const seenIds = pairSeenIds.get(pair.id) ?? new Set<string>();
				const trashedIds = pairTrashedIds.get(pair.id) ?? new Set<string>();
				try {
					const delResult = await this.runDeletionPass(pair, seenIds, globalSeenIds, archivedIds, trashedIds);
					result.removed += delResult.removed;
					result.archived! += delResult.archived ?? 0;
					result.errors += delResult.errors;
					const pr = result.pairs![pair.id];
					pr.removed = delResult.removed;
					pr.archived = delResult.archived ?? 0;
					pr.errors += delResult.errors;
					if (pr.errors === 0) tokenCommitReadyPairIds.add(pair.id);
					} catch (e) {
						console.error(`${LOG} Pair "${pair.label}" deletion pass failed:`, e);
						result.errors++;
						result.pairs![pair.id].errors++;
					}
			}
		} else {
			// Dry-run deletion pass
			for (const pair of activePairs) {
				const seenIds = pairSeenIds.get(pair.id) ?? new Set<string>();
				const effectiveDeletionBehavior = pair.deletionBehavior ?? this.settings.deletionBehavior;
				const trashedIds = pairTrashedIds.get(pair.id) ?? new Set<string>();
				const pairEntries = this.manifest.allForPair(pair.id);
				for (const [driveId, entry] of pairEntries) {
					if (
						globalSeenIds.has(driveId) ||
						seenIds.has(driveId) ||
						trashedIds.has(driveId) ||
						entry.deletedFromDriveAt
					) {
						continue;
					}
					const behavior = archivedIds.has(driveId)
						? pair.driveArchiveBehavior ?? effectiveDeletionBehavior
						: effectiveDeletionBehavior;
					if (behavior !== "keep") {
						result.wouldRemove!.push(entry.vaultPath);
					}
				}
			}
		}

		if (!dryRun) {
			await this.manifest.save();
			// Manifest durability comes first. Only then may main persist a cursor that
			// allows future runs to skip this completed Drive history.
			for (const pair of activePairs) {
				if (tokenCommitReadyPairIds.has(pair.id)) {
					this.commitStagedChangeToken(pair);
				}
			}
		}
		return result;
	}

	async syncSinglePair(pairId: string): Promise<SyncResult> {
		this.changesClient?.resetRunCache();
		this.stagedChangeTokens.clear();
		this.currentSyncRunId = newSyncRunId();
		this.pathClaims.clear();

		console.log(`${LOG} Fetching access token for single-pair sync`);
		const token = await this.auth.getValidAccessToken();

		const pair = this.settings.syncPairs.find((p) => p.id === pairId);
		if (!pair) throw new Error(`Sync pair not found: ${pairId}`);

		console.log(`${LOG} Single-pair sync: "${pair.label}"`);
		// A single-pair scan cannot prove whether an absent file moved into another
		// configured Drive root. Download/update this pair, but defer removal policy
		// to a complete all-pair sync.
		const { pairResult } = await this.syncPairFiles(pair, token, false, false);
		console.log(`${LOG} Single-pair sync defers Drive-removal deletion to the next full sync.`);

		const result: SyncResult = {
			...pairResult,
			removed: 0,
			archived: 0,
			timestamp: Date.now(),
		};

		await this.manifest.save();
		return result;
	}

	/**
	 * Phase 12.5 — sandbox "test sync". Runs one sync round limited to a single subfolder
	 * of the pair, with no deletion pass, so a config can be proven on a small slice first.
	 */
	async testSync(pairId: string, subfolderPath: string): Promise<SyncResult> {
		this.pathClaims.clear();
		const token = await this.auth.getValidAccessToken();
		const pair = this.settings.syncPairs.find((p) => p.id === pairId);
		if (!pair) throw new Error(`Sync pair not found: ${pairId}`);

		const norm = subfolderPath.replace(/^\/+|\/+$/g, "");
		const all = await this.collectFiles(
			pair.driveFolderId, "", token, pair.excludedSubfolders ?? [], false, false
		);
		const scoped = all.filter(
			(e) => !e.file.trashed && (e.relPath === norm || e.relPath.startsWith(`${norm}/`))
		);
		console.log(`${LOG} Test sync: ${scoped.length} file(s) under "${norm}" in pair "${pair.label}"`);

		const result: SyncResult = { downloaded: 0, skipped: 0, errors: 0, removed: 0, moved: 0, archived: 0, timestamp: Date.now() };
		for (const entry of scoped) {
			const r = await this.processEntry(entry, pair, token);
			result.downloaded += r.downloaded;
			result.skipped += r.skipped;
			result.moved! += r.moved ?? 0;
			result.errors += r.errors;
		}

		await this.manifest.save();
		return result;
	}

	// ── Single-file pull (Drive file picker) ──────────────────────────────────

	/** List every active (non-trashed) PDF in a pair's Drive folder, honoring the pair's subfolder rules. */
	async listPairFiles(pair: SyncPair): Promise<DriveFileEntry[]> {
		const token = await this.auth.getValidAccessToken();
		const all = await this.collectFiles(
			pair.driveFolderId, "", token,
			pair.excludedSubfolders ?? [],
			pair.excludeRootFiles ?? false,
			pair.rootFilesOnly ?? false
		);
		return all.filter((e) => !e.file.trashed);
	}

	/**
	 * Pull a single Drive file into the vault, then optionally move the Drive copy
	 * to trash after the vault copy is verified.
	 */
	async pullFile(
		pair: SyncPair,
		entry: DriveFileEntry,
		opts: { deleteFromDrive?: boolean } = {}
	): Promise<{ vaultPath: string | null; downloaded: boolean; trashed: boolean; error?: string }> {
		this.pathClaims.clear();
		const token = await this.auth.getValidAccessToken();
		const r = await this.processEntry(entry, pair, token);
		const vaultPath = this.manifest.get(entry.file.id)?.vaultPath ?? null;

		let error: string | undefined;
		let trashed = false;

		if (r.errors > 0 || !vaultPath) {
			error = `Sync failed for "${entry.file.name}" — see console for details.`;
		} else {
			if (opts.deleteFromDrive) {
				try {
					await this.trashSyncedDriveFile(entry.file.id, pair, token, entry);
					trashed = !!this.manifest.get(entry.file.id)?.deletedFromDriveAt;
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
			}
		}

		await this.manifest.save();
		return { vaultPath, downloaded: r.downloaded > 0, trashed, error };
	}

	// ── Delete-after-sync (Drive trash) ───────────────────────────────────────

	/**
	 * Move the Drive copy of a successfully synced file to Drive trash and mark the
	 * manifest entry as vault-owned (deletedFromDriveAt) so the deletion pass never
	 * removes the vault copy — even after Drive purges the trash for good.
	 * No-ops when already done or when the vault copy can't be verified to exist.
	 * Returns true when the file was trashed by this call.
	 */
	private async trashSyncedDriveFile(
		driveFileId: string,
		pair: SyncPair,
		token: string,
		driveEntry?: DriveFileEntry
	): Promise<boolean> {
		const entry = this.manifest.get(driveFileId);
		if (!entry) return false;
		if (entry.deletedFromDriveAt) return false; // already trashed by us
		// Never trash the only copy — the vault file must verifiably exist.
		if (!(await this.app.vault.adapter.exists(entry.vaultPath))) {
			console.warn(`${LOG} delete-after-sync: vault copy missing — keeping Drive file: ${entry.vaultPath}`);
			return false;
		}
		await this.trashDriveFile(driveFileId, token);
		this.manifest.set(driveFileId, {
			...entry,
			deletedFromDriveAt: new Date().toISOString(),
			driveTrashed: true,
		});
		console.log(`${LOG} delete-after-sync: moved Drive copy to trash: ${entry.vaultPath}`);
		this.bus?.emit("drive-trashed", { vaultPath: entry.vaultPath, pairId: pair.id, driveFileId });

		// Wrapper-folder cleanup: a folder named after the file that held only that file
		// is left empty by the trash above — trash it too. Never fails the file op.
		if (driveEntry) {
			try {
				await this.maybeTrashWrapperFolder(driveEntry, pair, token);
			} catch (e) {
				console.warn(`${LOG} delete-after-sync: wrapper-folder cleanup failed for "${entry.vaultPath}":`, e);
			}
		}
		return true;
	}

	/**
	 * After a file's Drive copy was trashed: if its parent folder has the same name as
	 * the file (the "Books/My Book/My Book.pdf" wrapper pattern) and now holds nothing
	 * else, move the folder to Drive trash as well. The pair's root folder is never touched.
	 */
	private async maybeTrashWrapperFolder(
		driveEntry: DriveFileEntry,
		pair: SyncPair,
		token: string
	): Promise<void> {
		const parentId = driveEntry.parentFolderId;
		if (!parentId || parentId === pair.driveFolderId) return;

		const stem = driveEntry.file.name.replace(/\.[^.]+$/, "");
		const parentName = driveEntry.relPath.split("/").pop() ?? "";
		if (parentName !== stem) return;

		const remaining = await this.listItems<{ id: string }>(
			token,
			`'${parentId}' in parents and trashed=false`,
			"files(id)"
		);
		if (remaining.length > 0) {
			console.log(
				`${LOG} delete-after-sync: wrapper folder "${parentName}" still has ${remaining.length} item(s) — keeping it`
			);
			return;
		}

		await this.trashDriveFile(parentId, token);
		console.log(`${LOG} delete-after-sync: trashed empty wrapper folder "${parentName}" (${parentId})`);
	}

	/** files.update {trashed:true} — recoverable for ~30 days, matching the Drive UI's "delete". */
	private async trashDriveFile(fileId: string, token: string): Promise<void> {
		const resp = await this.fetchWithRetry(`${FILES_API}/${fileId}`, {
			method: "PATCH",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ trashed: true }),
		});
		if (!resp.ok) {
			const body = await resp.text();
			if (resp.status === 403) {
				throw new Error(
					"Drive delete rejected (403) — the account was authorized read-only. " +
					"Disconnect and reconnect your Google account to grant full Drive access."
				);
			}
			throw new Error(`Drive files.update (trash) failed: ${resp.status} ${body}`);
		}
	}

	/**
	 * Mirror locally-deleted tracked files to Drive before any changes-API or rate-limit
	 * shortcut can return. A manifest entry is removed only after Drive confirms the trash.
	 */
	private async mirrorPendingLocalDeletions(
		pair: SyncPair,
		token: string,
		result: SyncResult
	): Promise<void> {
		if (!this.settings.mirrorLocalDeletionToDrive) return;
		for (const [driveFileId, entry] of this.manifest.allForPair(pair.id)) {
			if (!entry.userDeletedAt) continue;
			// A delete event can race with an undo/restore before the next sync. Never
			// act on a stale marker when a vault file is present at the tracked path.
			if (await this.app.vault.adapter.exists(entry.vaultPath)) {
				this.manifest.clearUserDeleted(driveFileId);
				console.log(`${LOG} Local deletion was undone — keeping Drive source: ${entry.vaultPath}`);
				continue;
			}
			try {
				await this.trashDriveFile(driveFileId, token);
				this.manifest.delete(driveFileId);
				this.bus?.emit("drive-trashed", {
					vaultPath: entry.vaultPath,
					pairId: pair.id,
					driveFileId,
				});
				console.log(`${LOG} Mirrored local deletion to Drive trash: ${entry.vaultPath}`);
			} catch (error) {
				result.errors++;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`${LOG} Failed to mirror local deletion for "${entry.vaultPath}":`, error);
				this.bus?.emit("error", {
					message: `Failed to mirror local deletion for "${entry.vaultPath}": ${message}`,
					context: "mirror-local-deletion",
				});
			}
		}
	}

	// ── Phase 1: collect + process files ──────────────────────────────────────

	private async syncPairFiles(
		pair: SyncPair,
		token: string,
		dryRun = false,
		useChangesShortcut = true
	): Promise<{
		pairResult: SyncResult;
		seenIds: Set<string>;
		trashedIds: Set<string>;
		scanComplete: boolean;
	}> {
		const pairResult: SyncResult = {
			downloaded: 0,
			skipped: 0,
			errors: 0,
			removed: 0,
			moved: 0,
			archived: 0,
			...(dryRun ? { wouldDownload: [] } : {}),
		};

		if (!dryRun) {
			await this.mirrorPendingLocalDeletions(pair, token, pairResult);
		}

		// Phase 13.3 — per-pair rate cap. Mark all tracked files as "seen" so the deletion
		// pass never mistakes a skipped run for missing files.
		if (!dryRun && !this.withinRateLimit(pair.id)) {
			const tracked = this.manifest.allForPair(pair.id);
			pairResult.skipped = tracked.length;
			return {
				pairResult,
				seenIds: new Set(tracked.map(([id]) => id)),
				trashedIds: new Set<string>(),
				scanComplete: false,
			};
		}

		// Phase 11.1 — skip the full folder walk when the changes feed shows the account
		// is idle since this pair's last sync. All tracked files are reported as "seen" so
		// the deletion pass does not mistake the shortcut for missing files.
		if (!dryRun && useChangesShortcut && (await this.pairIsIdleViaChanges(pair))) {
			const tracked = this.manifest.allForPair(pair.id);
			// A cursor without any local tracking cannot prove the initial inventory was
			// ever built (for example, after a manifest reset). Rebuild from Drive.
			let forceFullWalk = tracked.length === 0;
			for (const [driveFileId, trackedEntry] of tracked) {
				if (trackedEntry.sourceDisconnectedReason) {
					await this.emitSourceDisconnectedIfPresent(
						driveFileId,
						trackedEntry,
						pair.id,
						trackedEntry.sourceDisconnectedReason
					);
				}
				if (
					!trackedEntry.userDeletedAt &&
					!trackedEntry.deletedFromDriveAt &&
					!trackedEntry.driveTrashed &&
					!trackedEntry.sourceDisconnectedAt &&
					!(await this.app.vault.adapter.exists(trackedEntry.vaultPath))
				) {
					forceFullWalk = true;
				}
			}
			if (forceFullWalk) {
				console.warn(
					`${LOG} Changes-API reported idle, but local tracking is incomplete — forcing a full walk.`
				);
			} else {
			console.log(`${LOG} Changes-API: pair "${pair.label}" idle — skipping full walk (${tracked.length} tracked)`);
			pairResult.skipped = tracked.length;
			const seenIds = new Set(tracked.map(([id]) => id));
				return {
					pairResult,
					seenIds,
					trashedIds: new Set<string>(),
					scanComplete: true,
				};
			}
		}

		console.log(`${LOG} Collecting files from Drive folder: ${pair.driveFolderId}`);
		const allDriveEntries = await this.collectFiles(
			pair.driveFolderId, "", token,
			pair.excludedSubfolders ?? [],
			pair.excludeRootFiles ?? false,
			pair.rootFilesOnly ?? false
		);
		const driveEntries = allDriveEntries.filter((e) => !e.file.trashed);
		const trashedIds = new Set(allDriveEntries.filter((e) => e.file.trashed).map((e) => e.file.id));
		console.log(
			`${LOG} Found ${driveEntries.length} active PDF(s)` +
			(trashedIds.size > 0 ? `, ${trashedIds.size} trashed` : "") +
			` in Drive for pair "${pair.label}"`
		);

		const seenIds = new Set<string>();
		for (const entry of driveEntries) seenIds.add(entry.file.id);

		if (dryRun) {
			for (const entry of driveEntries) {
				const displayPath = entry.relPath
					? `${entry.relPath}/${entry.file.name}`
					: entry.file.name;
				const existing = this.manifest.get(entry.file.id);
				const driveChanged =
					entry.file.md5Checksum && existing?.driveMd5
						? entry.file.md5Checksum !== existing.driveMd5
						: entry.file.modifiedTime !== existing?.driveModifiedTime;
				const missingUnexpectedly =
					!!existing &&
					!existing.userDeletedAt &&
					!(await this.app.vault.adapter.exists(existing.vaultPath));
				const userDeletionCanRedownload =
					!!existing?.userDeletedAt &&
					this.settings.redownloadUserDeleted &&
					entry.file.modifiedTime !== existing.driveModifiedTime;
				if (
					!existing ||
					(!existing.userDeletedAt && (driveChanged || missingUnexpectedly)) ||
					userDeletionCanRedownload
				) {
					pairResult.wouldDownload!.push(`${pair.label}: ${displayPath}`);
				}
			}
			return { pairResult, seenIds, trashedIds, scanComplete: true };
		}

		// Phase 13.1 — disk-space pre-flight. Estimate the bytes for files that actually need
		// downloading and abort the pair before any write if 2× that won't fit.
		let expectedBytes = 0;
		for (const e of driveEntries) {
			const existing = this.manifest.get(e.file.id);
			const driveChanged =
				e.file.md5Checksum && existing?.driveMd5
					? e.file.md5Checksum !== existing.driveMd5
					: e.file.modifiedTime !== existing?.driveModifiedTime;
			const missingUnexpectedly =
				!!existing &&
				!existing.userDeletedAt &&
				!(await this.app.vault.adapter.exists(existing.vaultPath));
			const userDeletionCanRedownload =
				!!existing?.userDeletedAt &&
				this.settings.redownloadUserDeleted &&
				e.file.modifiedTime !== existing.driveModifiedTime;
			const willDownload =
				!existing ||
				(!existing.userDeletedAt && (driveChanged || missingUnexpectedly)) ||
				userDeletionCanRedownload;
			if (willDownload) expectedBytes += parseInt(e.file.size ?? "0", 10) || 0;
		}
		const space = await checkDiskSpace(expectedBytes);
		if (!space.ok) {
			this.bus?.emit("error", { message: `Disk-space pre-flight aborted pair "${pair.label}": ${space.reason}`, context: "disk-space" });
			console.error(`${LOG} ${space.reason} — aborting pair "${pair.label}"`);
			throw new Error(`Insufficient disk space for "${pair.label}": ${space.reason}`);
		}

		const concurrency = Math.max(1, Math.min(this.settings.downloadConcurrency ?? 5, 10));
		console.log(`${LOG} Processing ${driveEntries.length} file(s) with concurrency=${concurrency}`);

		const entryResults = await this.runConcurrent(
			driveEntries,
			concurrency,
			(entry) => this.processEntry(entry, pair, token)
		);

		for (const r of entryResults) {
			pairResult.downloaded += r.downloaded;
			pairResult.skipped += r.skipped;
			pairResult.moved! += r.moved ?? 0;
			pairResult.errors += r.errors;
		}

		return { pairResult, seenIds, trashedIds, scanComplete: true };
	}

	// ── Phase 2: deletion pass ────────────────────────────────────────────────

	private async runDeletionPass(
		pair: SyncPair,
		seenIds: Set<string>,
		globalSeenIds: Set<string>,
		archivedIds: Set<string>,
		trashedIds: Set<string> = new Set()
	): Promise<SyncResult> {
		const result: SyncResult = { downloaded: 0, skipped: 0, errors: 0, removed: 0, archived: 0 };

		const effectiveDeletionBehavior = pair.deletionBehavior ?? this.settings.deletionBehavior;
		const effectiveArchiveFolder = pair.archiveFolder ?? this.settings.archiveFolder;

		console.log(
			`${LOG} Running deletion pass for pair "${pair.label}" (behavior: ${effectiveDeletionBehavior})`
		);

		const pairEntries = this.manifest.allForPair(pair.id);
		for (const [driveId, entry] of pairEntries) {
			if (seenIds.has(driveId)) continue; // still present in this pair

			if (entry.deletedFromDriveAt) {
				// The plugin trashed the Drive copy on purpose (delete-after-sync) —
				// the vault copy is vault-owned now; never remove it, even after Drive
				// purges the trashed file for good.
				continue;
			}

			if (globalSeenIds.has(driveId)) {
				// File moved to another pair — pairId already updated in processEntry;
				// skip deletion so the other pair owns it.
				console.log(`${LOG} File moved to another pair — skipping deletion: ${entry.vaultPath}`);
				continue;
			}

			if (archivedIds.has(driveId)) {
				// File moved to Drive archive folder
					const archiveBehavior =
						pair.driveArchiveBehavior ?? effectiveDeletionBehavior;
					if (archiveBehavior === "keep") {
						console.log(`${LOG} Drive-archived (behavior=keep): ${entry.vaultPath}`);
						await this.emitSourceDisconnectedIfPresent(
							driveId,
							entry,
							pair.id,
							"drive-archived"
						);
						continue;
				}
				console.log(
					`${LOG} Drive-archived (behavior=${archiveBehavior}): ${entry.vaultPath}`
				);
				try {
					await this.removeEntry(
						driveId,
						entry,
						pair,
						archiveBehavior,
						effectiveArchiveFolder,
						"drive-archived"
					);
					this.manifest.delete(driveId);
					this.bus?.emit("removed", { vaultPath: entry.vaultPath, pairId: pair.id, behavior: `drive-archived:${archiveBehavior}` });
					result.archived!++;
				} catch (e) {
					console.error(`${LOG} Failed to remove archived "${entry.vaultPath}":`, e);
					result.errors++;
				}
				continue;
			}

			// 5.6: File is in Drive Trash — preserve vault copy, update manifest flag
			if (trashedIds.has(driveId)) {
				if (!entry.driveTrashed) {
					this.manifest.set(driveId, { ...entry, driveTrashed: true });
				}
				console.log(`${LOG} In Drive trash — preserving vault copy: ${entry.vaultPath}`);
				continue;
			}

				// File no longer in Drive at all
				if (effectiveDeletionBehavior === "keep") {
					await this.emitSourceDisconnectedIfPresent(
						driveId,
						entry,
						pair.id,
						"drive-removed"
					);
					continue;
				}

			console.log(`${LOG} No longer in Drive — removing: ${entry.vaultPath}`);
			try {
				await this.removeEntry(
					driveId,
					entry,
					pair,
					effectiveDeletionBehavior,
					effectiveArchiveFolder,
					"drive-removed"
				);
				this.manifest.delete(driveId);
				this.bus?.emit("removed", { vaultPath: entry.vaultPath, pairId: pair.id, behavior: effectiveDeletionBehavior });
				result.removed++;
			} catch (e) {
				console.error(`${LOG} Failed to remove "${entry.vaultPath}":`, e);
				result.errors++;
			}
		}

		return result;
	}

	/**
	 * Best-effort optional integration hook with no compile-time dependency.
	 * Emit only when the source removal actually leaves a PDF in the vault.
	 */
	private async emitSourceDisconnectedIfPresent(
		driveFileId: string,
		entry: SyncManifestEntry,
		pairId: string,
		reason: "drive-removed" | "drive-archived"
	): Promise<void> {
		if (!(await this.app.vault.adapter.exists(entry.vaultPath))) return;
		this.manifest.set(driveFileId, {
			...entry,
			// Keep durable state for startup reconciliation, and replay the workspace
			// event every sync so a plugin enabled later cannot miss the transition.
			sourceDisconnectedAt:
				entry.sourceDisconnectedReason === reason
					? entry.sourceDisconnectedAt ?? new Date().toISOString()
					: new Date().toISOString(),
			sourceDisconnectedReason: reason,
		});
		this.app.workspace.trigger(DRIVE_DOWNLOADER_WORKSPACE_EVENTS.sourceDisconnected, {
			vaultPath: entry.vaultPath,
			pairId,
			reason,
		});
	}

	// ── Archive folder pre-collection ─────────────────────────────────────────

	private async collectArchiveIds(token: string): Promise<Set<string>> {
		const folderId = this.settings.driveArchiveFolderId;
		if (!folderId) return new Set();
		console.log(`${LOG} Listing Drive archive folder: ${folderId}`);
		const files = await this.listItems<DriveFile>(
			token,
			`'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
			"files(id)"
		);
		const ids = new Set(files.map((f) => f.id));
		console.log(`${LOG} Drive archive folder: ${ids.size} PDF(s) found`);
		return ids;
	}

	// ── Entry processing ──────────────────────────────────────────────────────

	private async runConcurrent<T, R>(
		items: T[],
		concurrency: number,
		fn: (item: T) => Promise<R>
	): Promise<R[]> {
		const results: R[] = [];
		let index = 0;

		async function worker() {
			while (index < items.length) {
				const i = index++;
				results[i] = await fn(items[i]);
			}
		}

		const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
		await Promise.all(workers);
		return results;
	}

	private async processEntry(
		entry: DriveFileEntry,
		pair: SyncPair,
		token: string
	): Promise<SyncResult> {
		const r: SyncResult = { downloaded: 0, skipped: 0, errors: 0, removed: 0, moved: 0 };
		const displayPath = entry.relPath
			? `${entry.relPath}/${entry.file.name}`
			: entry.file.name;

		try {
			const effectiveRelPath = pair.collapseSingleFileFolder
				? this.collapseRelPath(entry.relPath, entry.file.name)
				: entry.relPath;

			// Duplicate-name handling: distinct Drive files sharing a name get a stable
			// numbered suffix instead of silently overwriting each other in the vault.
				const expectedVaultPath = await this.resolvePathCollision(
					entry.file.id,
					this.computeVaultPath(pair.vaultDestFolder, effectiveRelPath, entry.file.name)
				);

			const existing = this.manifest.get(entry.file.id);
			const hadDisconnectedState =
				!!existing?.sourceDisconnectedAt || !!existing?.sourceDisconnectedReason;
			const reconnectReason = existing?.sourceDisconnectedReason;
			if (existing && existing.vaultPath !== expectedVaultPath) {
				console.log(`${LOG} Move detected: "${existing.vaultPath}" → "${expectedVaultPath}"`);
					await this.handleRename(existing, entry, pair, expectedVaultPath);
			}
			const vaultCopyExists = await this.app.vault.adapter.exists(expectedVaultPath);

			// 5.3: Skip re-download if user deleted the file from the vault
			if (existing?.userDeletedAt) {
				const driveChanged = entry.file.modifiedTime !== existing.driveModifiedTime;
				if (!driveChanged || !this.settings.redownloadUserDeleted) {
					if (driveChanged) {
						// Advance the stored modifiedTime so we don't flag this every sync
						const current = this.manifest.get(entry.file.id) ?? existing;
						this.manifest.set(entry.file.id, {
							...current,
							driveModifiedTime: entry.file.modifiedTime,
						});
					}
					if (hadDisconnectedState) {
						this.clearSourceDisconnectedState(
							entry.file.id,
							pair.id,
							reconnectReason,
							vaultCopyExists
						);
					}
					console.log(`${LOG} User-deleted — skipping: ${displayPath}`);
					r.skipped++;
					return r;
				}
				console.log(`${LOG} Drive version advanced past user deletion — re-downloading: ${displayPath}`);
				this.manifest.clearUserDeleted(entry.file.id);
			}

			// Prefer Drive's md5Checksum for change detection (skips wasted downloads
			// when modifiedTime bumps but content is identical).
				// Fall back to modifiedTime when md5 is unavailable.
			const contentChanged =
				entry.file.md5Checksum && existing?.driveMd5
					? entry.file.md5Checksum !== existing.driveMd5
					: entry.file.modifiedTime !== existing?.driveModifiedTime;
			// Recover a missing tracked file when no vault delete event was observed
			// (for example, it was removed while Obsidian was closed).
			const needsDownload = !existing || contentChanged || !vaultCopyExists;

			if (needsDownload) {
				console.log(`${LOG} Downloading: ${displayPath}`);
				const { path: vaultPath, cacheHit } = await this.downloader.download(
					entry.file,
					token,
					pair.vaultDestFolder,
					effectiveRelPath,
					expectedVaultPath.split("/").pop()
				);

					// Always retain a SHA-256 for integrity verification.
					const pdfBytes = await this.app.vault.adapter.readBinary(vaultPath);
					const info = await this.analyzeBytes(pdfBytes);

					this.manifest.set(entry.file.id, {
						vaultPath,
						driveModifiedTime: entry.file.modifiedTime,
						driveCreatedTime: entry.file.createdTime,
						pairId: pair.id,
						driveMd5: entry.file.md5Checksum,
						contentHash: info.hash,
					});
					if (hadDisconnectedState && reconnectReason) {
						this.emitSourceReconnected(vaultPath, pair.id, reconnectReason);
					}

					console.log(`${LOG} Downloaded: ${displayPath}${cacheHit ? " (cache hit)" : ""}`);
					this.bus?.emit("downloaded", { vaultPath, pairId: pair.id, driveFileId: entry.file.id, cacheHit });
					r.downloaded++;
			} else if (existing && existing.vaultPath !== expectedVaultPath) {
				if (hadDisconnectedState) {
					this.clearSourceDisconnectedState(
						entry.file.id,
						pair.id,
						reconnectReason,
						true
					);
				}
				// Pure move — no content change, just relocated
				this.bus?.emit("moved", { fromPath: existing.vaultPath, toPath: expectedVaultPath, pairId: pair.id });
				r.moved!++;
			} else {
				if (hadDisconnectedState) {
					this.clearSourceDisconnectedState(
						entry.file.id,
						pair.id,
						reconnectReason,
						true
					);
				}
				// Clear stale trash/vault-owned flags when the Drive source is active.
				if (existing?.driveTrashed || existing?.deletedFromDriveAt) {
					const current = this.manifest.get(entry.file.id) ?? existing;
					this.manifest.set(entry.file.id, {
						...current,
						driveTrashed: undefined,
						deletedFromDriveAt: undefined,
					});
				}
				console.log(`${LOG} Up to date, skipping: ${displayPath}`);
				this.bus?.emit("skipped", { vaultPath: existing?.vaultPath ?? expectedVaultPath, pairId: pair.id, reason: "up to date" });
				r.skipped++;
			}

			// Delete-after-sync: the vault verifiably holds the current version — trash the Drive copy.
			// A failure here never fails the file itself (the sync succeeded); it's surfaced separately.
			if (pair.deleteFromDriveAfterSync) {
				try {
					await this.trashSyncedDriveFile(entry.file.id, pair, token, entry);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`${LOG} delete-after-sync failed for "${displayPath}":`, e);
					this.bus?.emit("error", { message: `Delete-after-sync failed for "${displayPath}": ${msg}`, context: "delete-after-sync" });
					// Keep the changes cursor staged so a later full walk retries the
					// requested Drive trash operation.
					r.errors++;
				}
			}
		} catch (e) {
			console.error(`${LOG} Failed to sync "${displayPath}":`, e);
			r.errors++;
		}

		return r;
	}

	private clearSourceDisconnectedState(
		driveFileId: string,
		pairId: string,
		reason: DriveSourceRemovalReason | undefined,
		emitReconnected: boolean
	): void {
		const current = this.manifest.get(driveFileId);
		if (!current) return;
		this.manifest.set(driveFileId, {
			...current,
			sourceDisconnectedAt: undefined,
			sourceDisconnectedReason: undefined,
		});
		if (emitReconnected && reason) {
			this.emitSourceReconnected(current.vaultPath, pairId, reason);
		}
	}

	private emitSourceReconnected(
		vaultPath: string,
		pairId: string,
		reason: DriveSourceRemovalReason
	): void {
		this.app.workspace.trigger(
			DRIVE_DOWNLOADER_WORKSPACE_EVENTS.sourceReconnected,
			{ vaultPath, pairId, reason }
		);
	}

	private async handleRename(
		existing: SyncManifestEntry,
		entry: DriveFileEntry,
		pair: SyncPair,
		newVaultPath: string
	): Promise<void> {
		// Rename the PDF — Obsidian updates all backlinks automatically
		const oldTFile = this.app.vault.getAbstractFileByPath(existing.vaultPath);
		if (oldTFile instanceof TFile) {
			await this.app.fileManager.renameFile(oldTFile, newVaultPath);
			console.log(`${LOG} PDF renamed in vault: ${existing.vaultPath} → ${newVaultPath}`);
		} else {
			console.warn(`${LOG} PDF not found in vault for rename: ${existing.vaultPath}`);
		}

		// Update vault path and pairId (covers both within-pair and cross-pair moves)
		this.manifest.set(entry.file.id, {
			...existing,
			vaultPath: newVaultPath,
			pairId: pair.id,
		});
	}

	private async removeEntry(
		driveFileId: string,
		entry: SyncManifestEntry,
		pair: SyncPair,
		deletionBehavior: DeletionBehavior,
		archiveFolder: string,
		reason: DriveSourceRemovalReason
	): Promise<void> {
		const pdfFile = this.app.vault.getAbstractFileByPath(entry.vaultPath);
		if (pdfFile instanceof TFile) {
			await this.removeFile(
				driveFileId,
				pdfFile,
				entry.vaultPath,
				pair,
				deletionBehavior,
				archiveFolder,
				reason
			);
		} else {
			console.warn(`${LOG} File not found in vault — skipping remove: ${entry.vaultPath}`);
		}
	}

	private async removeFile(
		driveFileId: string,
		file: TFile,
		filePath: string,
		pair: SyncPair,
		deletionBehavior: DeletionBehavior,
		archiveFolder: string,
		reason: DriveSourceRemovalReason
	): Promise<void> {
		if (deletionBehavior === "delete") {
			// Phase 13.5 — back up the bytes before the (destructive) trash.
			if (this.recycle) {
				try {
					const bytes = await this.app.vault.adapter.readBinary(filePath);
					await this.recycle.backup(filePath, bytes, {
						driveFileId: null, pairId: pair.id, action: "delete", syncRunId: this.currentSyncRunId,
					});
				} catch (e) {
					console.error(`${LOG} Recycle backup before trash failed for "${filePath}":`, e);
				}
			}
			console.log(`${LOG} Trashing: ${filePath}`);
			await this.appendSourceRemovalEvent({
				driveFileId,
				vaultPath: filePath,
				pairId: pair.id,
				reason,
				action: "delete",
			});
			this.emitSourceRemovalIntent(filePath, pair.id, reason);
			await this.app.vault.trash(file, true);
		} else if (deletionBehavior === "archive") {
			const relToRoot = filePath.slice(pair.vaultDestFolder.length);
			const archivePath = `${archiveFolder}${relToRoot}`;
			const archiveDir = archivePath.substring(0, archivePath.lastIndexOf("/"));

			console.log(`${LOG} Archiving ${filePath} → ${archivePath}`);
			await this.ensureFolder(archiveDir);
			await this.appendSourceRemovalEvent({
				driveFileId,
				vaultPath: filePath,
				newVaultPath: archivePath,
				pairId: pair.id,
				reason,
				action: "archive",
			});
			this.emitSourceRemovalIntent(filePath, pair.id, reason);
			await this.app.fileManager.renameFile(file, archivePath);
		}
		// "keep" does nothing.
	}

	private async appendSourceRemovalEvent(
		event: Omit<DriveSourceRemovalJournalEvent, "id" | "at">
	): Promise<void> {
		const configDir = this.app.vault.configDir || ".obsidian";
		const path = normalizePath(`${configDir}/${DRIVE_DOWNLOADER_SOURCE_EVENTS_FILE}`);
		let journal: DriveSourceRemovalJournal = { version: 1, events: [] };
		if (await this.app.vault.adapter.exists(path)) {
			const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as Partial<DriveSourceRemovalJournal>;
			if (parsed.version !== 1 || !Array.isArray(parsed.events)) {
				throw new Error(`Invalid source-removal journal: ${path}`);
			}
			journal = { version: 1, events: parsed.events };
		}
		const at = new Date().toISOString();
		journal.events.push({ ...event, at, id: `${event.driveFileId}:${at}` });
		journal.events = journal.events.slice(-1000);
		const content = JSON.stringify(journal, null, 2);
		const tempPath = `${path}.tmp`;
		try {
			await this.app.vault.adapter.write(tempPath, content);
			await this.app.vault.adapter.rename(tempPath, path);
		} catch (error) {
			try { await this.app.vault.adapter.remove(tempPath); } catch { /* ignore */ }
			await this.app.vault.adapter.write(path, content).catch(() => {
				throw error;
			});
		}
	}

	private emitSourceRemovalIntent(
		vaultPath: string,
		pairId: string,
		reason: DriveSourceRemovalReason
	): void {
		this.app.workspace.trigger(DRIVE_DOWNLOADER_WORKSPACE_EVENTS.sourceRemovalIntent, {
			vaultPath,
			pairId,
			reason,
		});
	}

	// ── Duplicate-name handling ───────────────────────────────────────────────

	/**
	 * Resolve path collisions between distinct Drive files that share a name.
	 * When `desiredPath` already belongs to another tracked file (manifest) or was
	 * claimed earlier in this run, a numbered suffix is appended before the
	 * extension — "Note (2).pdf", "Note (3).pdf"… (Windows/Drive convention).
	 * A file keeps its previously assigned numbered path across syncs, so names
	 * never thrash between runs; if the clean name frees up later, the normal
	 * move detection renames the file back.
	 */
	private async resolvePathCollision(
		ownerId: string,
		desiredPath: string
	): Promise<string> {
		const taken = (p: string): boolean => {
			const claimant = this.pathClaims.get(p);
			if (claimant && claimant !== ownerId) return true;
			const found = this.manifest.findByVaultPath(p);
			return !!found && found[0] !== ownerId;
		};
		const claim = (p: string): string => {
			this.pathClaims.set(p, ownerId);
			return p;
		};

		const currentOwnerPath = this.manifest.get(ownerId)?.vaultPath;
		const desiredExists = await this.app.vault.adapter.exists(desiredPath);
		// A path occupied by an untracked vault file belongs to the user. Number the
		// downloader's file instead of overwriting it.
		if (
			!taken(desiredPath) &&
			(!desiredExists || currentOwnerPath === desiredPath)
		) {
			return claim(desiredPath);
		}

		const dot = desiredPath.lastIndexOf(".");
		const slash = desiredPath.lastIndexOf("/");
		const hasExt = dot > slash;
		const base = hasExt ? desiredPath.slice(0, dot) : desiredPath;
		const ext = hasExt ? desiredPath.slice(dot) : "";

		// Prefer the numbered variant this file already owns — stable across syncs.
		const existing = this.manifest.get(ownerId);
		const current = existing?.vaultPath;
		if (current) {
			const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const variant = new RegExp(`^${escaped(base)} \\(\\d+\\)${escaped(ext)}$`);
			if (variant.test(current) && !taken(current)) return claim(current);
		}

		for (let n = 2; n < 1000; n++) {
			const candidate = `${base} (${n})${ext}`;
			if (taken(candidate)) continue;
			// Never clobber an untracked vault file that happens to sit at a candidate
			// path (e.g. the user's own "Note (2).pdf").
			if (await this.app.vault.adapter.exists(candidate)) continue;
			console.log(`${LOG} Name collision: "${desiredPath}" taken — using "${candidate}"`);
			return claim(candidate);
		}
		// Practically unreachable; guarantees termination.
		return claim(`${base} (${Date.now()})${ext}`);
	}

	private collapseRelPath(relPath: string, fileName: string): string {
		if (!relPath) return relPath;
		const parts = relPath.split("/");
		const lastFolder = parts[parts.length - 1];
		const fileStem = fileName.replace(/\.[^.]+$/, "");
		if (lastFolder === fileStem) return parts.slice(0, -1).join("/");
		return relPath;
	}

	private computeVaultPath(
		vaultDestFolder: string,
		relPath: string,
		fileName: string
	): string {
		const safeName = this.downloader.sanitizeFilename(fileName);
		const folder = relPath ? `${vaultDestFolder}/${relPath}` : vaultDestFolder;
		return `${folder}/${safeName}`;
	}

	private async collectFiles(
		folderId: string,
		relPath: string,
		token: string,
		excludedSubfolders: string[] = [],
		excludeRootFiles = false,
		rootFilesOnly = false
	): Promise<DriveFileEntry[]> {
		console.log(`${LOG} Listing folder id=${folderId} relPath="${relPath}"`);

		const isRoot = relPath === "";

		const [files, subfolders] = await Promise.all([
			this.listItems<DriveFile>(
				token,
				`'${folderId}' in parents and mimeType='application/pdf'`,
				"files(id,name,modifiedTime,createdTime,size,trashed,md5Checksum)"
			),
			rootFilesOnly && !isRoot
				? Promise.resolve([] as DriveFolder[])
				: this.listItems<DriveFolder>(
					token,
					`'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
					"files(id,name)"
				),
		]);

		console.log(
			`${LOG} Folder "${relPath || "root"}": ${files.length} PDF(s), ${subfolders.length} subfolder(s)`
		);

		const entries: DriveFileEntry[] =
			(excludeRootFiles && isRoot)
				? (console.log(`${LOG} Skipping ${files.length} root-level file(s) (excludeRootFiles=true)`), [])
				: files.map((f) => ({ file: f, relPath, parentFolderId: folderId }));

		if (!rootFilesOnly) {
			for (const folder of subfolders) {
				const childRelPath = relPath ? `${relPath}/${folder.name}` : folder.name;
				if (excludedSubfolders.includes(folder.name) || excludedSubfolders.includes(childRelPath)) {
					console.log(`${LOG} Skipping excluded subfolder: ${childRelPath}`);
					continue;
				}
				console.log(`${LOG} Descending into subfolder: ${childRelPath}`);
				const childEntries = await this.collectFiles(
					folder.id, childRelPath, token, excludedSubfolders, excludeRootFiles, rootFilesOnly
				);
				entries.push(...childEntries);
			}
		}

		return entries;
	}

	/** Fetch with exponential backoff — retries on 429 and 5xx responses. */
	private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				const delay = 1000 * Math.pow(2, attempt - 1); // 1 s, 2 s, 4 s
				console.log(`${LOG} Drive API retry ${attempt}/${maxRetries} after ${delay}ms`);
				await new Promise((r) => setTimeout(r, delay));
			}
			try {
				const resp = await fetch(url, options);
				// Return immediately on success or a non-retriable client error
				if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
					return resp;
				}
				lastError = new Error(`HTTP ${resp.status}`);
				console.warn(`${LOG} Drive API returned ${resp.status} — will retry`);
			} catch (e) {
				lastError = e;
				console.warn(`${LOG} Drive API fetch failed — will retry:`, e);
			}
		}
		throw lastError;
	}

	private async listItems<T>(
		token: string,
		query: string,
		fields: string
	): Promise<T[]> {
		const items: T[] = [];
		let pageToken: string | undefined;
		let page = 0;

		do {
			page++;
			const params = new URLSearchParams({
				q: query,
				fields: `nextPageToken,${fields}`,
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);

			console.log(`${LOG} GET ${FILES_API} page=${page} query="${query}"`);
			const resp = await this.fetchWithRetry(`${FILES_API}?${params}`, {
				headers: { Authorization: `Bearer ${token}` },
			});

			if (!resp.ok) {
				const body = await resp.text();
				console.error(`${LOG} files.list failed — status ${resp.status}:`, body);
				throw new Error(`Drive files.list failed: ${resp.status} ${body}`);
			}

			const data = await resp.json();
			const batch: T[] = data.files ?? [];
			console.log(`${LOG} Page ${page} returned ${batch.length} item(s)`);
			items.push(...batch);
			pageToken = data.nextPageToken;
		} while (pageToken);

		return items;
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const segments = folderPath.split("/").filter(Boolean);
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			const exists = await this.app.vault.adapter.exists(current);
			if (!exists) {
				console.log(`${LOG} Creating folder: ${current}`);
				await this.app.vault.createFolder(current);
			}
		}
	}
}
