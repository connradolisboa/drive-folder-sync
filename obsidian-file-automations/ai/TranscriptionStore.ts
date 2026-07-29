import { App, normalizePath, TFile } from "obsidian";
import { mapLegacyRunVersion } from "../migration/versionMapping";

const STORE_PATH = ".obsidian/file-automations-transcriptions.json";
const LEGACY_PATH = ".obsidian/drive-sync-transcriptions.json";

export interface TranscriptionDest {
	type: "companion" | "daily" | "note";
	path: string;
	transcribedAt: string;
}

export interface TranscriptionEntry {
	vaultPath: string;
	pdfHash: string;
	pageCount: number;
	lastTranscribedAt: string;
	lastSourceVersion: string;
	destinations: TranscriptionDest[];
	currentPageCount?: number;
	currentSourceVersion?: string;
	currentPdfHash?: string;
}

interface Envelope {
	schemaVersion: number;
	legacyImportedAt?: string;
	entries: Record<string, TranscriptionEntry>;
}

export class TranscriptionStore {
	private data: Record<string, TranscriptionEntry> = {};
	private legacyImportedAt: string | undefined;
	private saveChain: Promise<void> = Promise.resolve();

	constructor(private app: App) {}

	async load(): Promise<void> {
		await recoverAtomicBackup(this.app, STORE_PATH);
		if (!(await this.app.vault.adapter.exists(STORE_PATH))) return;
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(STORE_PATH));
			this.data = parsed?.entries ?? parsed ?? {};
			this.legacyImportedAt = parsed?.legacyImportedAt;
			const normalized: Record<string, TranscriptionEntry> = {};
			for (const entry of Object.values(this.data)) {
				if (!entry?.vaultPath) continue;
				const path = normalizePath(entry.vaultPath);
				normalized[path] = { ...entry, vaultPath: path };
			}
			this.data = normalized;
		} catch (error) {
			console.error("[FileAutomations/Transcriptions] Failed to load:", error);
			this.data = {};
		}
	}

	async importLegacyOnce(): Promise<number> {
		if (this.legacyImportedAt || !(await this.app.vault.adapter.exists(LEGACY_PATH))) return 0;
		let imported = 0;
		try {
			const legacy = JSON.parse(await this.app.vault.adapter.read(LEGACY_PATH)) ?? {};
			for (const value of Object.values(legacy) as Array<Record<string, any>>) {
				if (!value?.vaultPath) continue;
				const path = normalizePath(String(value.vaultPath));
				if (this.data[path]) continue;
				const file = this.app.vault.getAbstractFileByPath(path);
				const version = file instanceof TFile
					? `${file.stat.mtime}:${file.stat.size}`
					: String(value.currentDriveModifiedTime ?? value.lastTranscribedDriveModifiedTime ?? "");
				this.data[path] = {
					vaultPath: path,
					pdfHash: String(value.pdfHash ?? ""),
					pageCount: Number(value.pageCount ?? 0),
					lastTranscribedAt: String(value.lastTranscribedAt ?? new Date().toISOString()),
					lastSourceVersion: mapLegacyRunVersion(
						version,
						value.currentDriveModifiedTime,
						value.lastTranscribedDriveModifiedTime
					),
					destinations: Array.isArray(value.destinations) ? value.destinations : [],
					currentPageCount: typeof value.currentPageCount === "number" ? value.currentPageCount : undefined,
					currentSourceVersion: version
				};
				imported++;
			}
			this.legacyImportedAt = new Date().toISOString();
			await this.save();
		} catch (error) {
			console.error("[FileAutomations/Transcriptions] Legacy import failed:", error);
		}
		return imported;
	}

	get(vaultPath: string): TranscriptionEntry | undefined {
		return this.data[normalizePath(vaultPath)];
	}

	set(vaultPath: string, entry: TranscriptionEntry): void {
		const path = normalizePath(vaultPath);
		this.data[path] = { ...entry, vaultPath: path };
	}

	delete(vaultPath: string): void {
		delete this.data[normalizePath(vaultPath)];
	}

	entries(): [string, TranscriptionEntry][] {
		return Object.entries(this.data);
	}

	findByVaultPath(vaultPath: string): [string, TranscriptionEntry] | undefined {
		const path = normalizePath(vaultPath);
		const value = this.data[path];
		return value ? [path, value] : undefined;
	}

	rename(oldPath: string, newPath: string): void {
		const oldKey = normalizePath(oldPath);
		const entry = this.data[oldKey];
		if (!entry) return;
		const newKey = normalizePath(newPath);
		delete this.data[oldKey];
		this.data[newKey] = { ...entry, vaultPath: newKey };
	}

	recordTranscription(
		vaultPath: string,
		pdfHash: string,
		pageCount: number,
		sourceVersion: string,
		dest?: TranscriptionDest
	): void {
		const path = normalizePath(vaultPath);
		const now = new Date().toISOString();
		const existing = this.data[path];
		if (existing) {
			existing.pdfHash = pdfHash;
			existing.pageCount = pageCount;
			existing.lastTranscribedAt = now;
			existing.lastSourceVersion = sourceVersion;
			existing.currentPageCount = pageCount;
			existing.currentSourceVersion = sourceVersion;
			existing.currentPdfHash = pdfHash;
			if (dest) {
				const index = existing.destinations.findIndex((d) => d.type === dest.type && d.path === dest.path);
				if (index >= 0) existing.destinations[index] = dest;
				else existing.destinations.push(dest);
			}
		} else {
			this.data[path] = {
				vaultPath: path,
				pdfHash,
				pageCount,
				lastTranscribedAt: now,
				lastSourceVersion: sourceVersion,
				destinations: dest ? [dest] : [],
				currentPageCount: pageCount,
				currentSourceVersion: sourceVersion,
				currentPdfHash: pdfHash
			};
		}
	}

	updateCurrentState(
		vaultPath: string,
		sourceVersion: string,
		pageCount?: number,
		pdfHash?: string
	): void {
		const entry = this.get(vaultPath);
		if (!entry) return;
		entry.currentSourceVersion = sourceVersion;
		if (pageCount !== undefined) entry.currentPageCount = pageCount;
		if (pdfHash !== undefined) entry.currentPdfHash = pdfHash;
	}

	async save(): Promise<void> {
		const task = async () => {
			const envelope: Envelope = {
				schemaVersion: 1,
				legacyImportedAt: this.legacyImportedAt,
				entries: this.data
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
