import { App } from "obsidian";

const STORE_PATH = ".obsidian/drive-sync-transcriptions.json";
const LOG = "[DriveSync/TranscriptionStore]";

export interface TranscriptionDest {
	/** Where the transcription was written. */
	type: "companion" | "daily" | "note";
	path: string;
	transcribedAt: string; // ISO
}

export interface TranscriptionEntry {
	driveFileId: string;
	vaultPath: string;
	/** SHA-256 hex of the PDF at last transcription. */
	pdfHash: string;
	/** Page count of the PDF at last transcription. */
	pageCount: number;
	lastTranscribedAt: string; // ISO
	/** Drive modifiedTime value when transcription last ran. */
	lastTranscribedDriveModifiedTime: string;
	destinations: TranscriptionDest[];
	/** Page count from the most recent re-download (may differ from pageCount if Drive updated). */
	currentPageCount?: number;
	/** Drive modifiedTime from the most recent download. Same as lastTranscribedDriveModifiedTime when up to date. */
	currentDriveModifiedTime?: string;
}

type StoreData = Record<string, TranscriptionEntry>;

export class TranscriptionStore {
	private data: StoreData = {};

	constructor(private app: App) {}

	async load(): Promise<void> {
		try {
			const exists = await this.app.vault.adapter.exists(STORE_PATH);
			if (!exists) {
				this.data = {};
				return;
			}
			const raw = await this.app.vault.adapter.read(STORE_PATH);
			this.data = JSON.parse(raw) as StoreData;
			console.log(`${LOG} Loaded ${Object.keys(this.data).length} entries`);
		} catch (e) {
			console.error(`${LOG} Failed to load — starting fresh:`, e);
			this.data = {};
		}
	}

	async save(): Promise<void> {
		try {
			await this.app.vault.adapter.write(STORE_PATH, JSON.stringify(this.data, null, 2));
		} catch (e) {
			console.error(`${LOG} Failed to save:`, e);
		}
	}

	get(driveFileId: string): TranscriptionEntry | undefined {
		return this.data[driveFileId];
	}

	set(driveFileId: string, entry: TranscriptionEntry): void {
		this.data[driveFileId] = entry;
	}

	delete(driveFileId: string): void {
		delete this.data[driveFileId];
	}

	entries(): [string, TranscriptionEntry][] {
		return Object.entries(this.data);
	}

	/**
	 * Record a completed transcription. Creates or updates the entry.
	 * Called after transcription text is written to a destination note.
	 */
	recordTranscription(
		driveFileId: string,
		vaultPath: string,
		pdfHash: string,
		pageCount: number,
		driveModifiedTime: string,
		dest: TranscriptionDest
	): void {
		const now = new Date().toISOString();
		const existing = this.data[driveFileId];

		if (existing) {
			existing.pdfHash = pdfHash;
			existing.pageCount = pageCount;
			existing.lastTranscribedAt = now;
			existing.lastTranscribedDriveModifiedTime = driveModifiedTime;
			existing.vaultPath = vaultPath;
			existing.currentPageCount = pageCount;
			existing.currentDriveModifiedTime = driveModifiedTime;
			// Add or refresh the destination record
			const idx = existing.destinations.findIndex(
				(d) => d.type === dest.type && d.path === dest.path
			);
			if (idx >= 0) {
				existing.destinations[idx] = dest;
			} else {
				existing.destinations.push(dest);
			}
		} else {
			this.data[driveFileId] = {
				driveFileId,
				vaultPath,
				pdfHash,
				pageCount,
				lastTranscribedAt: now,
				lastTranscribedDriveModifiedTime: driveModifiedTime,
				destinations: [dest],
				currentPageCount: pageCount,
				currentDriveModifiedTime: driveModifiedTime,
			};
		}
	}

	/**
	 * Update the current page count and Drive modified time after a re-download
	 * without re-transcription. Only updates if an entry already exists.
	 */
	updateCurrentState(
		driveFileId: string,
		pageCount: number,
		driveModifiedTime: string
	): void {
		const entry = this.data[driveFileId];
		if (!entry) return;
		entry.currentPageCount = pageCount;
		entry.currentDriveModifiedTime = driveModifiedTime;
	}

	/**
	 * Find a store entry by vault path.
	 */
	findByVaultPath(vaultPath: string): [string, TranscriptionEntry] | undefined {
		return this.entries().find(([, e]) => e.vaultPath === vaultPath);
	}
}
