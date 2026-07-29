import type { SyncResult } from "../types";

export interface EventMap {
	downloaded: { vaultPath: string; pairId: string; driveFileId: string; cacheHit?: boolean };
	skipped: { vaultPath: string; pairId: string; reason: string };
	moved: { fromPath: string; toPath: string; pairId: string; cacheHit?: boolean };
	removed: { vaultPath: string; pairId: string; behavior: string };
	"drive-trashed": { vaultPath: string; pairId: string; driveFileId: string };
	"manifest-write": { entryCount: number };
	"auth-failed": { reason: string };
	"auth-restored": Record<string, never>;
	"recycle-write": { originalPath: string; recyclePath: string; action: string };
	"sync-complete": { result: SyncResult };
	error: { message: string; context?: string };
}

export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (payload: EventMap[E]) => void;

export interface BusRecord<E extends EventName = EventName> {
	event: E;
	payload: EventMap[E];
	at: number;
}

type AnyHandler = (payload: unknown) => void;

export class EventBus {
	private handlers = new Map<EventName, Set<AnyHandler>>();
	private wildcard = new Set<(record: BusRecord) => void>();

	on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
		let handlers = this.handlers.get(event);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(event, handlers);
		}
		handlers.add(handler as AnyHandler);
		return () => handlers!.delete(handler as AnyHandler);
	}

	onAny(handler: (record: BusRecord) => void): () => void {
		this.wildcard.add(handler);
		return () => this.wildcard.delete(handler);
	}

	emit<E extends EventName>(event: E, payload: EventMap[E]): void {
		const record: BusRecord<E> = { event, payload, at: Date.now() };
		for (const handler of this.handlers.get(event) ?? []) {
			try {
				handler(payload);
			} catch (error) {
				console.error(`[DriveDownloader/EventBus] handler for "${event}" failed:`, error);
			}
		}
		for (const handler of this.wildcard) {
			try {
				handler(record as BusRecord);
			} catch (error) {
				console.error("[DriveDownloader/EventBus] wildcard handler failed:", error);
			}
		}
	}

	clear(): void {
		this.handlers.clear();
		this.wildcard.clear();
	}
}
