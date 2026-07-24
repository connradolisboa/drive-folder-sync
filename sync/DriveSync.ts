import { App, TFile } from "obsidian";
import { GoogleAuth } from "../auth/GoogleAuth";
import { DownloadManager } from "./DownloadManager";
import type { SyncManifestStore } from "./SyncManifest";
import { CompanionNoteManager } from "./CompanionNoteManager";
import { AutomationEngine } from "../automation/AutomationEngine";
import { GeminiClient } from "../ai/GeminiClient";
import { MistralClient } from "../ai/MistralClient";
import { TranscriptionStore } from "../ai/TranscriptionStore";
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
	ManifestEntry,
	PluginSettings,
	SyncPair,
	SyncResult,
} from "../types";

const FILES_API = "https://www.googleapis.com/drive/v3/files";
const LOG = "[DriveSync/Sync]";

export class DriveSync {
	private transcriptionClient: GeminiClient | MistralClient | null = null;
	private changesClient?: DriveChangesClient;
	/** Set when DriveSync mutates a pair (e.g. changes-API token); the plugin persists after sync. */
	private settingsDirty = false;

	constructor(
		private auth: GoogleAuth,
		private downloader: DownloadManager,
		private settings: PluginSettings,
		private app: App,
		private manifest: SyncManifestStore,
		private companion: CompanionNoteManager,
		private automationEngine?: AutomationEngine,
		private transcriptionStore?: TranscriptionStore,
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

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
		this.transcriptionClient = null; // invalidate cached client on settings change
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
	 * Bootstraps the token on first use and advances it on every call. Conservative: any
	 * change at all (or a structural folder change) returns false and we fall back to a
	 * full scan, which is always correct.
	 */
	private async pairIsIdleViaChanges(pair: SyncPair): Promise<boolean> {
		const useChanges = pair.useChangesApi ?? this.settings.useChangesApi;
		if (!useChanges) return false;
		try {
			const client = this.getChangesClient();
			if (!pair.driveStartPageToken) {
				pair.driveStartPageToken = await client.getStartPageToken();
				this.settingsDirty = true;
				return false; // first run — must full-scan to populate the manifest
			}
			const res = await client.listChanges(pair.driveStartPageToken);
			pair.driveStartPageToken = res.newStartPageToken;
			this.settingsDirty = true;
			// Only skip when nothing changed account-wide since the token. Any change → full scan.
			return res.changedFileIds.size === 0;
		} catch (e) {
			console.warn(`${LOG} changes-API probe failed for "${pair.label}" — falling back to full scan:`, e);
			return false;
		}
	}

	private getTranscriptionClient(): GeminiClient | MistralClient | null {
		const hasTranscriptionAutomation = this.settings.automations.some(
			(a) =>
				a.enabled &&
				(a.action.type === "transcribe_to_companion" ||
					(a.action.type === "add_to_periodic_note" && a.action.runTranscription === true))
		);

		if (!this.settings.geminiEnabled && !hasTranscriptionAutomation) return null;

		if (!this.transcriptionClient) {
			const provider = this.settings.transcriptionProvider ?? "gemini";
			if (provider === "mistral") {
				if (!this.settings.mistralApiKey) return null;
				this.transcriptionClient = new MistralClient(this.settings.mistralApiKey);
			} else {
				if (!this.settings.geminiApiKey) return null;
				this.transcriptionClient = new GeminiClient(
					this.settings.geminiApiKey,
					this.settings.geminiModel || "gemini-2.0-flash",
					this.settings.geminiPrompt || "Transcribe all text visible in this PDF exactly as written, preserving structure. Return plain text only."
				);
			}
		}
		return this.transcriptionClient;
	}

	async sync(dryRun = false): Promise<SyncResult> {
		await this.manifest.load();
		this.changesClient?.resetRunCache();
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

		// Pre-collect Drive archive folder IDs (one API call, shared across all pairs)
		const archivedIds = this.settings.driveArchiveFolderId
			? await this.collectArchiveIds(token)
			: new Set<string>();
		if (archivedIds.size > 0) {
			console.log(`${LOG} Drive archive folder contains ${archivedIds.size} tracked file(s)`);
		}

		// ── Phase 1: process files for ALL pairs ─────────────────────────────
		// Must complete before any deletion pass so cross-pair moves update pairId
		// in the manifest before Pair 1's deletion pass runs.
		const pairSeenIds = new Map<string, Set<string>>();
		const pairTrashedIds = new Map<string, Set<string>>();
		const globalSeenIds = new Set<string>();

		for (const pair of activePairs) {
			console.log(`${LOG} [Phase 1] Processing pair "${pair.label}" → "${pair.vaultDestFolder}"`);
			try {
				const { pairResult, seenIds, trashedIds } = await this.syncPairFiles(pair, token, dryRun);
				pairSeenIds.set(pair.id, seenIds);
				pairTrashedIds.set(pair.id, trashedIds);
				seenIds.forEach((id) => globalSeenIds.add(id));
				result.downloaded += pairResult.downloaded;
				result.skipped += pairResult.skipped;
				result.moved! += pairResult.moved ?? 0;
				result.errors += pairResult.errors;
				if (pairResult.conflicts?.length) {
					result.conflicts = [...(result.conflicts ?? []), ...pairResult.conflicts];
				}
				result.pairs![pair.id] = pairResult;
				if (dryRun) {
					result.wouldDownload!.push(...(pairResult.wouldDownload ?? []));
				}
			} catch (e) {
				console.error(`${LOG} Pair "${pair.label}" file processing failed:`, e);
				result.errors++;
				result.pairs![pair.id] = { downloaded: 0, skipped: 0, errors: 1, removed: 0, moved: 0, archived: 0 };
			}
		}

		// ── Phase 2: deletion passes for ALL pairs ───────────────────────────
		if (!dryRun) {
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
				} catch (e) {
					console.error(`${LOG} Pair "${pair.label}" deletion pass failed:`, e);
					result.errors++;
				}
			}
		} else {
			// Dry-run deletion pass
			for (const pair of activePairs) {
				const seenIds = pairSeenIds.get(pair.id) ?? new Set<string>();
				const effectiveDeletionBehavior = pair.deletionBehavior ?? this.settings.deletionBehavior;
				if (effectiveDeletionBehavior !== "keep") {
					const trashedIds = pairTrashedIds.get(pair.id) ?? new Set<string>();
					const pairEntries = this.manifest.allForPair(pair.id);
					for (const [driveId, entry] of pairEntries) {
						if (
							!globalSeenIds.has(driveId) && !seenIds.has(driveId) &&
							!trashedIds.has(driveId) && !entry.deletedFromDriveAt
						) {
							result.wouldRemove!.push(entry.vaultPath);
						}
					}
				}
			}
		}

		if (!dryRun) {
			await this.manifest.save();
			await this.transcriptionStore?.save();
		}
		return result;
	}

	async syncSinglePair(pairId: string): Promise<SyncResult> {
		await this.manifest.load();
		this.changesClient?.resetRunCache();
		this.currentSyncRunId = newSyncRunId();
		this.pathClaims.clear();

		console.log(`${LOG} Fetching access token for single-pair sync`);
		const token = await this.auth.getValidAccessToken();

		const pair = this.settings.syncPairs.find((p) => p.id === pairId);
		if (!pair) throw new Error(`Sync pair not found: ${pairId}`);

		const archivedIds = this.settings.driveArchiveFolderId
			? await this.collectArchiveIds(token)
			: new Set<string>();

		console.log(`${LOG} Single-pair sync: "${pair.label}"`);
		const { pairResult, seenIds, trashedIds } = await this.syncPairFiles(pair, token);
		// For single-pair sync, globalSeenIds = seenIds (no cross-pair awareness)
		const delResult = await this.runDeletionPass(pair, seenIds, seenIds, archivedIds, trashedIds);

		const result: SyncResult = {
			...pairResult,
			removed: delResult.removed,
			archived: delResult.archived ?? 0,
			errors: pairResult.errors + delResult.errors,
			timestamp: Date.now(),
		};

		await this.manifest.save();
		await this.transcriptionStore?.save();
		return result;
	}

	/**
	 * Phase 12.5 — sandbox "test sync". Runs one sync round limited to a single subfolder
	 * of the pair, with no deletion pass, so a config can be proven on a small slice first.
	 */
	async testSync(pairId: string, subfolderPath: string): Promise<SyncResult> {
		await this.manifest.load();
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

		const companionEnabled = pair.companionNotesEnabled ?? this.settings.companionNotesEnabled;
		const result: SyncResult = { downloaded: 0, skipped: 0, errors: 0, removed: 0, moved: 0, archived: 0, timestamp: Date.now() };
		for (const entry of scoped) {
			const r = await this.processEntry(entry, pair, token, companionEnabled);
			result.downloaded += r.downloaded;
			result.skipped += r.skipped;
			result.moved! += r.moved ?? 0;
			result.errors += r.errors;
			if (r.conflicts?.length) result.conflicts = [...(result.conflicts ?? []), ...r.conflicts];
		}

		await this.manifest.save();
		await this.transcriptionStore?.save();
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
	 * Pull a single Drive file into the vault (Drive file picker). Runs the normal
	 * processEntry pipeline (download, companion, matching automations), then optionally
	 * a specific automation (forced) and/or moves the Drive copy to trash.
	 */
	async pullFile(
		pair: SyncPair,
		entry: DriveFileEntry,
		opts: { deleteFromDrive?: boolean; automationId?: string } = {}
	): Promise<{ vaultPath: string | null; downloaded: boolean; trashed: boolean; automationRan: boolean; error?: string }> {
		await this.manifest.load();
		this.pathClaims.clear();
		const token = await this.auth.getValidAccessToken();
		const companionEnabled = pair.companionNotesEnabled ?? this.settings.companionNotesEnabled;

		const r = await this.processEntry(entry, pair, token, companionEnabled);
		const vaultPath = this.manifest.get(entry.file.id)?.vaultPath ?? null;

		let error: string | undefined;
		let automationRan = false;
		let trashed = false;

		if (r.errors > 0 || !vaultPath) {
			error = `Sync failed for "${entry.file.name}" — see console for details.`;
		} else {
			if (opts.automationId && this.automationEngine) {
				try {
					const res = await this.automationEngine.runForFileAdHoc(vaultPath, opts.automationId, { force: true });
					automationRan = res.ran;
					if (!res.ran) console.log(`${LOG} pullFile: automation skipped — ${res.skippedReason}`);
				} catch (e) {
					error = `Automation failed: ${e instanceof Error ? e.message : String(e)}`;
				}
			}
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
		await this.transcriptionStore?.save();
		return { vaultPath, downloaded: r.downloaded > 0, trashed, automationRan, error };
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

	// ── Delete-after-transcription ─────────────────────────────────────────────

	/**
	 * An automation with "Delete file after transcription" enabled has just written the PDF's
	 * text into a note and asked for the source to be removed on both sides. Back up the bytes,
	 * trash the vault copy, then trash the Drive copy — only once Drive confirms the trash do we
	 * stop tracking it. If the Drive call throws, the vault's own delete listener has already
	 * marked the manifest entry userDeletedAt, so the next sync redownloads it (Drive is still
	 * the source of truth, unlike a real user deletion).
	 */
	private async deleteSourceAfterTranscription(
		vaultPath: string,
		driveFileId: string,
		pair: SyncPair,
		token: string,
		displayPath: string
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) return;

		if (this.recycle) {
			try {
				const bytes = await this.app.vault.adapter.readBinary(vaultPath);
				await this.recycle.backup(vaultPath, bytes, {
					driveFileId, pairId: pair.id, action: "delete-after-transcription", syncRunId: this.currentSyncRunId,
				});
			} catch (e) {
				console.error(`${LOG} delete-after-transcription: recycle backup failed for "${vaultPath}":`, e);
			}
		}

		console.log(`${LOG} delete-after-transcription: trashing vault file: ${vaultPath}`);
		await this.app.vault.trash(file, true);

		await this.trashDriveFile(driveFileId, token);
		this.manifest.delete(driveFileId);

		console.log(`${LOG} delete-after-transcription: removed "${displayPath}" from vault, Drive, and manifest`);
		this.bus?.emit("deleted-after-transcription", { vaultPath, pairId: pair.id, driveFileId });
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

	// ── Phase 1: collect + process files ──────────────────────────────────────

	private async syncPairFiles(
		pair: SyncPair,
		token: string,
		dryRun = false
	): Promise<{ pairResult: SyncResult; seenIds: Set<string>; trashedIds: Set<string> }> {
		const pairResult: SyncResult = {
			downloaded: 0,
			skipped: 0,
			errors: 0,
			removed: 0,
			moved: 0,
			archived: 0,
			...(dryRun ? { wouldDownload: [] } : {}),
		};

		const effectiveCompanionEnabled =
			pair.companionNotesEnabled ?? this.settings.companionNotesEnabled;

		// Phase 13.3 — per-pair rate cap. Mark all tracked files as "seen" so the deletion
		// pass never mistakes a skipped run for missing files.
		if (!dryRun && !this.withinRateLimit(pair.id)) {
			const tracked = this.manifest.allForPair(pair.id);
			pairResult.skipped = tracked.length;
			return { pairResult, seenIds: new Set(tracked.map(([id]) => id)), trashedIds: new Set<string>() };
		}

		// Phase 11.1 — skip the full folder walk when the changes feed shows the account
		// is idle since this pair's last sync. All tracked files are reported as "seen" so
		// the deletion pass does not mistake the shortcut for missing files.
		if (!dryRun && (await this.pairIsIdleViaChanges(pair))) {
			const tracked = this.manifest.allForPair(pair.id);
			console.log(`${LOG} Changes-API: pair "${pair.label}" idle — skipping full walk (${tracked.length} tracked)`);
			pairResult.skipped = tracked.length;
			const seenIds = new Set(tracked.map(([id]) => id));
			return { pairResult, seenIds, trashedIds: new Set<string>() };
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
				if (!existing || entry.file.modifiedTime !== existing.driveModifiedTime) {
					pairResult.wouldDownload!.push(`${pair.label}: ${displayPath}`);
				}
			}
			return { pairResult, seenIds, trashedIds };
		}

		// Phase 13.1 — disk-space pre-flight. Estimate the bytes for files that actually need
		// downloading and abort the pair before any write if 2× that won't fit.
		let expectedBytes = 0;
		for (const e of driveEntries) {
			const existing = this.manifest.get(e.file.id);
			const willDownload = !existing ||
				(e.file.md5Checksum && existing.driveMd5
					? e.file.md5Checksum !== existing.driveMd5
					: e.file.modifiedTime !== existing.driveModifiedTime);
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
			(entry) => this.processEntry(entry, pair, token, effectiveCompanionEnabled)
		);

		for (const r of entryResults) {
			pairResult.downloaded += r.downloaded;
			pairResult.skipped += r.skipped;
			pairResult.moved! += r.moved ?? 0;
			pairResult.errors += r.errors;
			if (r.conflicts?.length) {
				pairResult.conflicts = [...(pairResult.conflicts ?? []), ...r.conflicts];
			}
		}

		return { pairResult, seenIds, trashedIds };
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

		// Skip deletion pass entirely if nothing will be done
		if (effectiveDeletionBehavior === "keep" && !pair.driveArchiveBehavior) {
			return result;
		}

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
					continue;
				}
				console.log(
					`${LOG} Drive-archived (behavior=${archiveBehavior}): ${entry.vaultPath}`
				);
				try {
					await this.removeEntry(entry, pair, archiveBehavior, effectiveArchiveFolder);
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
			if (effectiveDeletionBehavior === "keep") continue;

			console.log(`${LOG} No longer in Drive — removing: ${entry.vaultPath}`);
			try {
				await this.removeEntry(entry, pair, effectiveDeletionBehavior, effectiveArchiveFolder);
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

	// ── Archive folder pre-collection ─────────────────────────────────────────

	private async collectArchiveIds(token: string): Promise<Set<string>> {
		const folderId = this.settings.driveArchiveFolderId;
		if (!folderId) return new Set();
		try {
			console.log(`${LOG} Listing Drive archive folder: ${folderId}`);
			const files = await this.listItems<DriveFile>(
				token,
				`'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
				"files(id)"
			);
			const ids = new Set(files.map((f) => f.id));
			console.log(`${LOG} Drive archive folder: ${ids.size} PDF(s) found`);
			return ids;
		} catch (e) {
			console.error(`${LOG} Failed to list Drive archive folder — skipping archive detection:`, e);
			return new Set();
		}
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
		token: string,
		companionEnabled: boolean
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
				this.computeVaultPath(pair.vaultDestFolder, effectiveRelPath, entry.file.name),
				"vault"
			);

			const existing = this.manifest.get(entry.file.id);
			if (existing && existing.vaultPath !== expectedVaultPath) {
				console.log(`${LOG} Move detected: "${existing.vaultPath}" → "${expectedVaultPath}"`);
				await this.handleRename(existing, entry, pair, expectedVaultPath, companionEnabled);
			}

			// 5.3: Skip re-download if user deleted the file from the vault
			if (existing?.userDeletedAt) {
				const driveChanged = entry.file.modifiedTime !== existing.driveModifiedTime;
				if (!driveChanged || !this.settings.redownloadUserDeleted) {
					if (driveChanged) {
						// Advance the stored modifiedTime so we don't flag this every sync
						this.manifest.set(entry.file.id, { ...existing, driveModifiedTime: entry.file.modifiedTime });
					}
					console.log(`${LOG} User-deleted — skipping: ${displayPath}`);
					r.skipped++;
					return r;
				}
				console.log(`${LOG} Drive version advanced past user deletion — re-downloading: ${displayPath}`);
				this.manifest.clearUserDeleted(entry.file.id);
			}

			// Phase 13.9 — prefer Drive's md5Checksum for change detection (skips wasted
			// re-downloads/Gemini calls when modifiedTime bumps but content is identical).
			// Fall back to modifiedTime when md5 is unavailable (e.g. Google-native types).
			const contentChanged =
				entry.file.md5Checksum && existing?.driveMd5
					? entry.file.md5Checksum !== existing.driveMd5
					: entry.file.modifiedTime !== existing?.driveModifiedTime;
			const needsDownload = !existing || contentChanged;

			if (needsDownload) {
				console.log(`${LOG} Downloading: ${displayPath}`);
				const { path: vaultPath, cacheHit } = await this.downloader.download(
					entry.file,
					token,
					pair.vaultDestFolder,
					effectiveRelPath,
					expectedVaultPath.split("/").pop()
				);

				// Attempt AI transcription (non-blocking on failure)
				let transcription: string | undefined;
				let pdfBytes: ArrayBuffer | null = null;
				// Resolve companion path: manifest takes priority, then property-declared companion
				const resolvedCompanionPath = existing?.companionPath
					?? this.companion.findCompanionByProperty(vaultPath)
					?? null;
				const gemini = this.getTranscriptionClient();
				const isAutoTxDisabled = existing?.transcriptionDisabled ?? false;
				if (gemini && !isAutoTxDisabled) {
					// Skip transcription if the companion already has a fresh transcription for this Drive version
					let alreadyTranscribed = false;
					if (resolvedCompanionPath) {
						const companionFile = this.app.vault.getAbstractFileByPath(resolvedCompanionPath);
						if (companionFile instanceof TFile) {
							const fm = this.app.metadataCache.getFileCache(companionFile)?.frontmatter;
							if (
								fm?.transcribed === true &&
								(fm?.sourceDriveModifiedTime ?? fm?.lastUpdate) === entry.file.modifiedTime
							) {
								alreadyTranscribed = true;
								console.log(`${LOG} Transcription skipped — already transcribed for this Drive version: ${vaultPath}`);
							}
						}
					}
					if (!alreadyTranscribed) {
						try {
							pdfBytes = await this.app.vault.adapter.readBinary(vaultPath);
							transcription = await gemini.transcribePdf(pdfBytes);
						} catch (e) {
							console.error(`${LOG} Gemini transcription failed for "${vaultPath}":`, e);
						}
					}
				} else if (this.transcriptionStore?.get(entry.file.id)) {
					// No transcription client active, but a prior transcription record exists.
					// Read bytes to detect page-count changes since the last transcription.
					try {
						pdfBytes = await this.app.vault.adapter.readBinary(vaultPath);
					} catch (e) {
						console.error(`${LOG} Failed to read PDF for page-count update:`, e);
					}
				}

				let companionPath: string | null = null;
				let companionMtime: number | undefined;
				if (companionEnabled) {
					if (resolvedCompanionPath) {
						const { conflictPath } = await this.companion.update(
							resolvedCompanionPath, entry.file, pair, vaultPath, transcription,
							existing?.companionMtime
						);
						if (conflictPath) r.conflicts = [...(r.conflicts ?? []), conflictPath];
						companionPath = resolvedCompanionPath;
					} else {
						// Companion name follows the (possibly deduped) vault filename, and the
						// note path itself is deduped against other files' companions.
						const companionTarget = await this.resolvePathCollision(
							entry.file.id,
							this.companion.companionPath(pair, entry.relPath, vaultPath.split("/").pop() ?? entry.file.name),
							"companion"
						);
						companionPath = await this.companion.create(
							entry.file,
							pair,
							entry.relPath,
							vaultPath,
							transcription,
							companionTarget
						);
					}
					// 5.4: Record mtime for concurrent-edit detection on the next sync
					if (companionPath) {
						const stat = await this.app.vault.adapter.stat(companionPath);
						if (stat) companionMtime = stat.mtime;
					}
				}

				// Phase 11.3/13.4 — record the content sha256 when we have the bytes in hand
				// (computed off-thread via the heavy worker when enabled).
				const info: PdfInfo | null = pdfBytes ? await this.analyzeBytes(pdfBytes) : null;
				const contentHash = info?.hash ?? existing?.contentHash;

				this.manifest.set(entry.file.id, {
					vaultPath,
					companionPath,
					driveModifiedTime: entry.file.modifiedTime,
					driveCreatedTime: entry.file.createdTime,
					pairId: pair.id,
					companionMtime,
					transcriptionDisabled: existing?.transcriptionDisabled,
					driveMd5: entry.file.md5Checksum,
					contentHash,
				});

				// Update transcription tracking store
				if (this.transcriptionStore && info) {
					if (transcription !== undefined) {
						// A fresh transcription ran — record full details
						const finalCompanionPath = companionPath ?? resolvedCompanionPath;
						const dest = finalCompanionPath
							? { type: "companion" as const, path: finalCompanionPath, transcribedAt: new Date().toISOString() }
							: { type: "note" as const, path: vaultPath, transcribedAt: new Date().toISOString() };
						this.transcriptionStore.recordTranscription(
							entry.file.id, vaultPath, info.hash, info.pageCount,
							entry.file.modifiedTime, dest
						);
					} else {
						// No transcription this run — update page count for change detection
						this.transcriptionStore.updateCurrentState(
							entry.file.id, info.pageCount, entry.file.modifiedTime
						);
					}
				}

				if (this.automationEngine) {
					// Fall back to manifest's stored companion path when companion notes are
					// currently disabled — lets transcribe_to_companion find an existing note.
					const automationCompanionPath = companionPath ?? resolvedCompanionPath ?? null;
					const automationResult = await this.automationEngine.runForFile({
						vaultPath,
						companionPath: automationCompanionPath,
						driveCreatedTime: entry.file.createdTime,
						transcription,
						driveFileId: entry.file.id,
						driveModifiedTime: entry.file.modifiedTime,
					});

					if (automationResult.deleteRequested) {
						try {
							await this.deleteSourceAfterTranscription(vaultPath, entry.file.id, pair, token, displayPath);
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							console.error(`${LOG} delete-after-transcription failed for "${displayPath}":`, e);
							this.bus?.emit("error", {
								message: `Delete-after-transcription failed for "${displayPath}": ${msg}`,
								context: "delete-after-transcription",
							});
						}
					}
				}

				console.log(`${LOG} Downloaded: ${displayPath}${cacheHit ? " (cache hit)" : ""}`);
				this.bus?.emit("downloaded", { vaultPath, pairId: pair.id, driveFileId: entry.file.id, cacheHit });
				if (r.conflicts?.length) {
					for (const cp of r.conflicts) {
						this.bus?.emit("conflict", { vaultPath, backupPath: cp });
					}
				}
				r.downloaded++;
			} else if (existing && existing.vaultPath !== expectedVaultPath) {
				// Pure move — no content change, just relocated
				this.bus?.emit("moved", { fromPath: existing.vaultPath, toPath: expectedVaultPath, pairId: pair.id });
				r.moved!++;
			} else {
				// Clear trash/vault-owned flags if file was previously trashed but is now active and unchanged
				if (existing?.driveTrashed || existing?.deletedFromDriveAt) {
					this.manifest.set(entry.file.id, { ...existing, driveTrashed: undefined, deletedFromDriveAt: undefined });
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
				}
			}
		} catch (e) {
			console.error(`${LOG} Failed to sync "${displayPath}":`, e);
			r.errors++;
		}

		return r;
	}

	private async handleRename(
		existing: ManifestEntry,
		entry: DriveFileEntry,
		pair: SyncPair,
		newVaultPath: string,
		companionEnabled: boolean
	): Promise<void> {
		// Rename the PDF — Obsidian updates all backlinks automatically
		const oldTFile = this.app.vault.getAbstractFileByPath(existing.vaultPath);
		if (oldTFile instanceof TFile) {
			await this.app.fileManager.renameFile(oldTFile, newVaultPath);
			console.log(`${LOG} PDF renamed in vault: ${existing.vaultPath} → ${newVaultPath}`);
		} else {
			console.warn(`${LOG} PDF not found in vault for rename: ${existing.vaultPath}`);
		}

		// Rename companion note if it exists
		if (existing.companionPath && companionEnabled) {
			const newCompanionPath = await this.resolvePathCollision(
				entry.file.id,
				this.companion.companionPath(
					pair,
					entry.relPath,
					newVaultPath.split("/").pop() ?? entry.file.name
				),
				"companion"
			);
			if (newCompanionPath !== existing.companionPath) {
				await this.companion.rename(existing.companionPath, newCompanionPath);
				// Update manifest immediately — pairId updated to current pair
				this.manifest.set(entry.file.id, {
					...existing,
					vaultPath: newVaultPath,
					companionPath: newCompanionPath,
					pairId: pair.id,
				});
				return;
			}
		}

		// Update vault path and pairId (covers both within-pair and cross-pair moves)
		this.manifest.set(entry.file.id, {
			...existing,
			vaultPath: newVaultPath,
			pairId: pair.id,
		});
	}

	private async removeEntry(
		entry: ManifestEntry,
		pair: SyncPair,
		deletionBehavior: DeletionBehavior,
		archiveFolder: string
	): Promise<void> {
		const keepCompanion =
			deletionBehavior === "delete_keep_companion" ||
			deletionBehavior === "archive_keep_companion";
		const onlyCompanion = deletionBehavior === "delete_only_companion";

		const effectivePdfBehavior: DeletionBehavior =
			deletionBehavior === "delete_keep_companion" ? "delete" :
			deletionBehavior === "archive_keep_companion" ? "archive" :
			deletionBehavior === "delete_only_companion" ? "keep" :
			deletionBehavior;

		// Remove (or keep) PDF
		if (!onlyCompanion) {
			const pdfFile = this.app.vault.getAbstractFileByPath(entry.vaultPath);
			if (pdfFile instanceof TFile) {
				await this.removeFile(pdfFile, entry.vaultPath, pair, effectivePdfBehavior, archiveFolder);
			} else {
				console.warn(`${LOG} File not found in vault — skipping remove: ${entry.vaultPath}`);
			}
		}

		// Remove companion note
		if (entry.companionPath && !keepCompanion) {
			const compFile = this.app.vault.getAbstractFileByPath(entry.companionPath);
			if (compFile instanceof TFile) {
				// For delete_only_companion, always delete (not archive) the companion
				const companionBehavior: DeletionBehavior =
					onlyCompanion ? "delete" : effectivePdfBehavior;
				await this.removeFile(compFile, entry.companionPath, pair, companionBehavior, archiveFolder);
			} else {
				console.warn(
					`${LOG} Companion note not found — skipping remove: ${entry.companionPath}`
				);
			}
		}
	}

	private async removeFile(
		file: TFile,
		filePath: string,
		pair: SyncPair,
		deletionBehavior: DeletionBehavior,
		archiveFolder: string
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
			await this.app.vault.trash(file, true);
		} else if (deletionBehavior === "archive") {
			const relToRoot = filePath.slice(pair.vaultDestFolder.length);
			const archivePath = `${archiveFolder}${relToRoot}`;
			const archiveDir = archivePath.substring(0, archivePath.lastIndexOf("/"));

			console.log(`${LOG} Archiving ${filePath} → ${archivePath}`);
			await this.ensureFolder(archiveDir);
			await this.app.fileManager.renameFile(file, archivePath);
		}
		// "keep" and "delete_only_companion" for PDF: do nothing
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
		desiredPath: string,
		kind: "vault" | "companion"
	): Promise<string> {
		const find = kind === "vault"
			? (p: string) => this.manifest.findByVaultPath(p)
			: (p: string) => this.manifest.findByCompanionPath(p);
		const taken = (p: string): boolean => {
			const claimant = this.pathClaims.get(p);
			if (claimant && claimant !== ownerId) return true;
			const found = find(p);
			return !!found && found[0] !== ownerId;
		};
		const claim = (p: string): string => {
			this.pathClaims.set(p, ownerId);
			return p;
		};

		if (!taken(desiredPath)) return claim(desiredPath);

		const dot = desiredPath.lastIndexOf(".");
		const slash = desiredPath.lastIndexOf("/");
		const hasExt = dot > slash;
		const base = hasExt ? desiredPath.slice(0, dot) : desiredPath;
		const ext = hasExt ? desiredPath.slice(dot) : "";

		// Prefer the numbered variant this file already owns — stable across syncs.
		const existing = this.manifest.get(ownerId);
		const current = kind === "vault" ? existing?.vaultPath : existing?.companionPath;
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
