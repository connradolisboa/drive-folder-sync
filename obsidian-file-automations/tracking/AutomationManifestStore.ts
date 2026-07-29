import { App, normalizePath, TFile } from "obsidian";
import { AutomationRunRecord } from "../types";
import { mapLegacyRunVersion } from "../migration/versionMapping";

const STORE_PATH = ".obsidian/file-automations-manifest.json";
const LEGACY_PATHS = [
	".obsidian/drive-sync-manifest.legacy-automation.json",
	".obsidian/drive-sync-manifest.json"
];
const SCHEMA_VERSION = 1;

export interface AutomationTrackingEntry {
	vaultPath: string;
	sourceVersion: string;
	companionPath?: string | null;
	companionMtime?: number;
	ruleId?: string | null;
	transcriptionDisabled?: boolean;
	automationRuns?: Record<string, AutomationRunRecord>;
	automationHistory?: Record<string, AutomationRunRecord[]>;
	sourceDisconnectedAt?: string;
	sourceDisconnectedReason?: "drive-removed" | "drive-archived";
	disconnectedSourceVersion?: string;
	detachedCompanionPath?: string | null;
}

interface StoreEnvelope {
	schemaVersion: number;
	legacyImportedAt?: string;
	entries: Record<string, AutomationTrackingEntry>;
	processedSourceEvents?: Record<string, string>;
}

function sourceVersion(file: TFile | null): string {
	return file ? `${file.stat.mtime}:${file.stat.size}` : "";
}

export class AutomationManifestStore {
	private data: Record<string, AutomationTrackingEntry> = {};
	private legacyImportedAt: string | undefined;
	private processedSourceEvents: Record<string, string> = {};
	private saveChain: Promise<void> = Promise.resolve();

	constructor(private app: App) {}

	async load(): Promise<void> {
		await recoverAtomicBackup(this.app, STORE_PATH);
		if (!(await this.app.vault.adapter.exists(STORE_PATH))) return;
		try {
			const raw = JSON.parse(await this.app.vault.adapter.read(STORE_PATH)) as StoreEnvelope | Record<string, AutomationTrackingEntry>;
			if ("entries" in raw && typeof raw.entries === "object") {
				const envelope = raw as StoreEnvelope;
				this.data = envelope.entries;
				this.legacyImportedAt = envelope.legacyImportedAt;
				this.processedSourceEvents = envelope.processedSourceEvents ?? {};
			} else {
				this.data = raw as Record<string, AutomationTrackingEntry>;
			}
			this.normalizeEntries();
		} catch (error) {
			console.error("[FileAutomations/Tracking] Failed to load tracking store:", error);
			this.data = {};
		}
	}

	private normalizeEntries(): void {
		const normalized: Record<string, AutomationTrackingEntry> = {};
		for (const entry of Object.values(this.data)) {
			if (!entry?.vaultPath) continue;
			const path = normalizePath(entry.vaultPath);
			normalized[path] = { ...entry, vaultPath: path };
		}
		this.data = normalized;
	}

	async importLegacyOnce(): Promise<number> {
		if (this.legacyImportedAt) return 0;
		const legacyPath = await this.firstExistingLegacyPath();
		if (!legacyPath) return 0;
		let imported = 0;
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(legacyPath));
			const legacy = parsed?.entries ?? parsed ?? {};
			for (const value of Object.values(legacy) as Array<Record<string, any>>) {
				if (!value?.vaultPath) continue;
				const path = normalizePath(String(value.vaultPath));
				if (this.data[path]) continue;
				const file = this.app.vault.getAbstractFileByPath(path);
				const version = sourceVersion(file instanceof TFile ? file : null) || String(value.driveModifiedTime ?? "");
				const runs: Record<string, AutomationRunRecord> = {};
				for (const [id, run] of Object.entries(value.automationRuns ?? {}) as Array<[string, any]>) {
					runs[id] = {
						lastRunAt: String(run.lastRunAt ?? new Date().toISOString()),
						sourceVersion: mapLegacyRunVersion(
							version,
							value.driveModifiedTime,
							run.lastRunDriveModifiedTime
						),
						result: run.result === "error" || run.result === "skipped" ? run.result : "success",
						outputs: Array.isArray(run.outputs) ? run.outputs : undefined,
						errorMessage: typeof run.errorMessage === "string" ? run.errorMessage : undefined
					};
				}
				this.data[path] = {
					vaultPath: path,
					sourceVersion: version,
					companionPath: value.companionPath ? normalizePath(String(value.companionPath)) : null,
					companionMtime: typeof value.companionMtime === "number" ? value.companionMtime : undefined,
					transcriptionDisabled: value.transcriptionDisabled === true,
					automationRuns: runs,
					automationHistory: Object.fromEntries(
						Object.entries(runs).map(([id, run]) => [id, [run]])
					)
				};
				imported++;
			}
			this.legacyImportedAt = new Date().toISOString();
			await this.save();
		} catch (error) {
			console.error("[FileAutomations/Tracking] Legacy manifest import failed:", error);
		}
		return imported;
	}

	private async firstExistingLegacyPath(): Promise<string | null> {
		for (const path of LEGACY_PATHS) {
			if (await this.app.vault.adapter.exists(path)) return path;
		}
		return null;
	}

	entries(): [string, AutomationTrackingEntry][] {
		return Object.entries(this.data);
	}

	get(vaultPath: string): AutomationTrackingEntry | undefined {
		return this.data[normalizePath(vaultPath)];
	}

	ensure(vaultPath: string, version = ""): AutomationTrackingEntry {
		const path = normalizePath(vaultPath);
		return (this.data[path] ??= { vaultPath: path, sourceVersion: version });
	}

	set(vaultPath: string, entry: AutomationTrackingEntry): void {
		const path = normalizePath(vaultPath);
		this.data[path] = { ...entry, vaultPath: path };
	}

	delete(vaultPath: string): void {
		delete this.data[normalizePath(vaultPath)];
	}

	clear(): void {
		this.data = {};
	}

	findByVaultPath(vaultPath: string): [string, AutomationTrackingEntry] | undefined {
		const path = normalizePath(vaultPath);
		const entry = this.data[path];
		return entry ? [path, entry] : undefined;
	}

	findByCompanionPath(companionPath: string): [string, AutomationTrackingEntry] | undefined {
		const path = normalizePath(companionPath);
		return this.entries().find(([, entry]) => entry.companionPath === path);
	}

	renameSource(oldPath: string, newPath: string): AutomationTrackingEntry | undefined {
		const oldKey = normalizePath(oldPath);
		const entry = this.data[oldKey];
		if (!entry) return;
		const newKey = normalizePath(newPath);
		delete this.data[oldKey];
		this.data[newKey] = { ...entry, vaultPath: newKey };
		return this.data[newKey];
	}

	renameCompanion(oldPath: string, newPath: string): AutomationTrackingEntry | undefined {
		const found = this.findByCompanionPath(oldPath);
		if (!found) return;
		found[1].companionPath = normalizePath(newPath);
		return found[1];
	}

	recordAutomationRun(vaultPath: string, automationId: string, run: AutomationRunRecord): void {
		const entry = this.ensure(vaultPath);
		(entry.automationRuns ??= {})[automationId] = run;
		const history = (entry.automationHistory ??= {});
		(history[automationId] ??= []).push(run);
		if (history[automationId].length > 25) history[automationId].splice(0, history[automationId].length - 25);
	}

	getAutomationRun(vaultPath: string, automationId: string): AutomationRunRecord | undefined {
		return this.get(vaultPath)?.automationRuns?.[automationId];
	}

	hasProcessedSourceEvent(id: string): boolean {
		return id in this.processedSourceEvents;
	}

	markSourceEventProcessed(id: string, at: string): void {
		this.processedSourceEvents[id] = at;
		const ids = Object.keys(this.processedSourceEvents);
		if (ids.length > 1500) {
			ids.sort((a, b) => this.processedSourceEvents[a].localeCompare(this.processedSourceEvents[b]));
			for (const stale of ids.slice(0, ids.length - 1000)) delete this.processedSourceEvents[stale];
		}
	}

	async save(): Promise<void> {
		const task = async () => {
			const envelope: StoreEnvelope = {
				schemaVersion: SCHEMA_VERSION,
				legacyImportedAt: this.legacyImportedAt,
				entries: this.data,
				processedSourceEvents: this.processedSourceEvents
			};
			const content = JSON.stringify(envelope, null, 2);
			await atomicWrite(this.app, STORE_PATH, content);
		};
		this.saveChain = this.saveChain.then(task, task);
		return this.saveChain;
	}
}

async function recoverAtomicBackup(app: App, path: string): Promise<void> {
	const backup = `${path}.bak`;
	if (!(await app.vault.adapter.exists(path)) && await app.vault.adapter.exists(backup)) {
		await app.vault.adapter.rename(backup, path);
	}
}

async function atomicWrite(app: App, path: string, content: string): Promise<void> {
	const adapter = app.vault.adapter;
	const temp = `${path}.tmp`;
	const backup = `${path}.bak`;
	if (await adapter.exists(temp)) await adapter.remove(temp);
	await adapter.write(temp, content);
	let movedCurrent = false;
	try {
		if (await adapter.exists(path)) {
			if (await adapter.exists(backup)) await adapter.remove(backup);
			await adapter.rename(path, backup);
			movedCurrent = true;
		}
		await adapter.rename(temp, path);
		if (movedCurrent && await adapter.exists(backup)) await adapter.remove(backup);
	} catch (error) {
		if (!(await adapter.exists(path)) && movedCurrent && await adapter.exists(backup)) {
			await adapter.rename(backup, path);
		}
		if (await adapter.exists(temp)) await adapter.remove(temp);
		throw error;
	}
}
