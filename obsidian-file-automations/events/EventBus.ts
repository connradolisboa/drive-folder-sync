export interface AutomationEventMap {
	"pipeline-start": { vaultPath: string };
	"pipeline-complete": { vaultPath: string; sourceDeleted: boolean };
	"pipeline-error": { vaultPath: string; error: string };
	"source-delete-start": { vaultPath: string };
	"source-delete-complete": { vaultPath: string; sourceDeleted: boolean };
	"automation-run": {
		vaultPath: string;
		automationId: string;
		automationName: string;
		result: "success" | "skipped" | "error";
		error?: string;
	};
	"companion-updated": { vaultPath: string; companionPath: string };
}

type EventName = keyof AutomationEventMap;
type Listener<K extends EventName> = (payload: AutomationEventMap[K]) => void;

export class EventBus {
	private listeners = new Map<EventName, Set<(payload: never) => void>>();

	on<K extends EventName>(name: K, listener: Listener<K>): () => void {
		const listeners = this.listeners.get(name) ?? new Set();
		listeners.add(listener as (payload: never) => void);
		this.listeners.set(name, listeners);
		return () => listeners.delete(listener as (payload: never) => void);
	}

	emit<K extends EventName>(name: K, payload: AutomationEventMap[K]): void {
		for (const listener of this.listeners.get(name) ?? []) {
			listener(payload as never);
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}
