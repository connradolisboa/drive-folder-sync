import type { SyncResult } from "../types";

/**
 * Phase 11.5 — internal typed pub/sub event bus.
 *
 * Decouples DriveSync / AutomationEngine / CompanionNoteManager from the status
 * view, activity log and notice handlers. Subscribers attach via {@link EventBus.on}
 * and producers fire via {@link EventBus.emit}; adding a new subscriber requires
 * zero changes in the producers.
 */

/** Payloads for every event the plugin can emit. Keep these JSON-serializable. */
export interface EventMap {
	/** A file was downloaded from Drive into the vault. */
	downloaded: { vaultPath: string; pairId: string; driveFileId: string; cacheHit?: boolean };
	/** A file was pushed to Drive (Phase 10). */
	uploaded: { vaultPath: string; pairId: string; driveFileId: string };
	/** A file was up to date and skipped. */
	skipped: { vaultPath: string; pairId: string; reason: string };
	/** A move/rename was applied without re-downloading bytes. */
	moved: { fromPath: string; toPath: string; pairId: string; cacheHit?: boolean };
	/** A file was removed/archived from the vault. */
	removed: { vaultPath: string; pairId: string; behavior: string };
	/** The plugin moved a synced file's Drive copy to Drive trash (delete-after-sync). */
	"drive-trashed": { vaultPath: string; pairId: string; driveFileId: string };
	/** An automation's "delete file after transcription" removed the source PDF from vault + Drive. */
	"deleted-after-transcription": { vaultPath: string; pairId: string; driveFileId: string };
	/** A companion-note (or sync) conflict was detected. */
	conflict: { vaultPath: string; backupPath?: string; resolution?: string };
	/** An automation ran (or was skipped) for a file. */
	"automation-run": { vaultPath: string; automationId: string; automationName: string; result: "success" | "skipped" | "error"; error?: string };
	/** The manifest was persisted to disk. */
	"manifest-write": { entryCount: number };
	/** Drive auth failed / went stale. */
	"auth-failed": { reason: string };
	/** Auth was restored after being stale. */
	"auth-restored": Record<string, never>;
	/** A file's bytes were written to the recycle bin before a destructive op. */
	"recycle-write": { originalPath: string; recyclePath: string; action: string };
	/** A whole sync run finished (carries the aggregate result). */
	"sync-complete": { result: SyncResult };
	/** Drive API quota guard paused uploads. */
	"quota-pause": { until: number };
	/** Free-form error worth surfacing in the activity ticker. */
	error: { message: string; context?: string };
}

export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (payload: EventMap[E]) => void;

/** A bus event with metadata, as stored for the live ticker (Phase 12.1). */
export interface BusRecord<E extends EventName = EventName> {
	event: E;
	payload: EventMap[E];
	at: number;
}

type AnyHandler = (payload: unknown) => void;

export class EventBus {
	// Internally untyped for storage; the public on/emit signatures enforce types.
	private handlers = new Map<EventName, Set<AnyHandler>>();
	/** Subscribers that receive *every* event (e.g. the live ticker). */
	private wildcard = new Set<(rec: BusRecord) => void>();

	on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
		let set = this.handlers.get(event);
		if (!set) {
			set = new Set();
			this.handlers.set(event, set);
		}
		set.add(handler as AnyHandler);
		return () => set!.delete(handler as AnyHandler);
	}

	/** Subscribe to all events. Returns an unsubscribe function. */
	onAny(handler: (rec: BusRecord) => void): () => void {
		this.wildcard.add(handler);
		return () => this.wildcard.delete(handler);
	}

	emit<E extends EventName>(event: E, payload: EventMap[E]): void {
		const rec: BusRecord<E> = { event, payload, at: Date.now() };
		const set = this.handlers.get(event);
		if (set) {
			for (const handler of set) {
				try { handler(payload); }
				catch (e) { console.error(`[DriveSync/EventBus] handler for "${event}" threw:`, e); }
			}
		}
		for (const handler of this.wildcard) {
			try { handler(rec as BusRecord); }
			catch (e) { console.error(`[DriveSync/EventBus] wildcard handler threw:`, e); }
		}
	}

	/** Drop every subscriber. Call on plugin unload. */
	clear(): void {
		this.handlers.clear();
		this.wildcard.clear();
	}
}
