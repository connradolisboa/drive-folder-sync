import { App } from "obsidian";
import * as crypto from "crypto";
import type { EventBus } from "../events/EventBus";

const RECYCLE_DIR = ".obsidian/drive-sync-recycle";
const LOG = "[DriveSync/Recycle]";

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;   // per-file cap (Phase 10.8)
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;         // keep last 7 days
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;         // 500MB cap

export interface RecycleSidecar {
	originalPath: string;
	driveFileId: string | null;
	pairId: string;
	action: string;
	timestamp: string;
	sha256: string;
	syncRunId: string;
	restoreInstructions: string;
}

/**
 * Phase 13.5 (extends 10.8) — crash-safe recycle bin.
 *
 * Before any destructive op (overwrite / delete / archive), the bytes about to be lost are
 * copied here with a JSON sidecar describing how to restore them. `undo-last-sync` restores
 * everything written under one `syncRunId`.
 */
export class Recycle {
	constructor(private app: App, private bus?: EventBus, private maxFileBytes = DEFAULT_MAX_FILE_BYTES) {}

	private sanitize(p: string): string {
		return p.replace(/[/\\:*?"<>|]/g, "_");
	}

	/** Back up `bytes` for `originalPath` before it is overwritten/deleted. */
	async backup(originalPath: string, bytes: ArrayBuffer, meta: { driveFileId: string | null; pairId: string; action: string; syncRunId: string }): Promise<string | null> {
		if (bytes.byteLength > this.maxFileBytes) {
			console.warn(`${LOG} Skipping recycle backup (>${this.maxFileBytes} bytes): ${originalPath}`);
			return null;
		}
		try {
			const pairDir = `${RECYCLE_DIR}/${this.sanitize(meta.pairId || "default")}`;
			await this.ensureDir(pairDir);
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			const base = `${ts}-${this.sanitize(originalPath)}`;
			const dataPath = `${pairDir}/${base}`;
			const sha256 = crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");

			await this.app.vault.adapter.writeBinary(dataPath, bytes);
			const sidecar: RecycleSidecar = {
				originalPath,
				driveFileId: meta.driveFileId,
				pairId: meta.pairId,
				action: meta.action,
				timestamp: new Date().toISOString(),
				sha256,
				syncRunId: meta.syncRunId,
				restoreInstructions: `Copy "${dataPath}" back to "${originalPath}" to restore.`,
			};
			await this.app.vault.adapter.write(`${dataPath}.json`, JSON.stringify(sidecar, null, 2));
			this.bus?.emit("recycle-write", { originalPath, recyclePath: dataPath, action: meta.action });
			await this.gc();
			return dataPath;
		} catch (e) {
			console.error(`${LOG} Recycle backup failed for "${originalPath}":`, e);
			return null;
		}
	}

	get folderPath(): string { return RECYCLE_DIR; }

	/** Distinct sync run ids present in the recycle bin, newest first. */
	async listRunIds(): Promise<Array<{ syncRunId: string; at: string; count: number }>> {
		const sidecars = await this.readSidecars();
		const byRun = new Map<string, { at: string; count: number }>();
		for (const s of sidecars) {
			const cur = byRun.get(s.syncRunId);
			if (cur) { cur.count++; if (s.timestamp > cur.at) cur.at = s.timestamp; }
			else byRun.set(s.syncRunId, { at: s.timestamp, count: 1 });
		}
		return [...byRun.entries()]
			.map(([syncRunId, v]) => ({ syncRunId, ...v }))
			.sort((a, b) => b.at.localeCompare(a.at));
	}

	/** Restore every file recycled under `syncRunId`. Returns count restored. */
	async restoreRun(syncRunId: string): Promise<number> {
		const sidecars = await this.readSidecars();
		let restored = 0;
		for (const { sidecar, dataPath } of sidecars.map((s) => ({ sidecar: s, dataPath: this.dataPathFor(s) }))) {
			if (sidecar.syncRunId !== syncRunId) continue;
			try {
				const bytes = await this.app.vault.adapter.readBinary(dataPath);
				await this.ensureDir(sidecar.originalPath.substring(0, sidecar.originalPath.lastIndexOf("/")));
				const exists = await this.app.vault.adapter.exists(sidecar.originalPath);
				if (exists) await this.app.vault.adapter.writeBinary(sidecar.originalPath, bytes);
				else await this.app.vault.createBinary(sidecar.originalPath, bytes);
				restored++;
			} catch (e) {
				console.error(`${LOG} Failed to restore "${sidecar.originalPath}":`, e);
			}
		}
		return restored;
	}

	private dataPathFor(s: RecycleSidecar): string {
		// Reconstruct the data path from the sidecar's restore instructions is fragile;
		// instead we re-derive by listing. Stored alongside as "<data>.json", so the data
		// path is the sidecar path minus ".json" — resolved in readSidecars().
		return (s as RecycleSidecar & { __dataPath?: string }).__dataPath ?? s.originalPath;
	}

	private async readSidecars(): Promise<Array<RecycleSidecar & { __dataPath: string }>> {
		const out: Array<RecycleSidecar & { __dataPath: string }> = [];
		if (!(await this.app.vault.adapter.exists(RECYCLE_DIR))) return out;
		const stack = [RECYCLE_DIR];
		while (stack.length) {
			const dir = stack.pop()!;
			const listing = await this.app.vault.adapter.list(dir);
			stack.push(...listing.folders);
			for (const f of listing.files) {
				if (!f.endsWith(".json")) continue;
				try {
					const raw = await this.app.vault.adapter.read(f);
					const sidecar = JSON.parse(raw) as RecycleSidecar;
					out.push({ ...sidecar, __dataPath: f.slice(0, -".json".length) });
				} catch { /* ignore malformed sidecar */ }
			}
		}
		return out;
	}

	private async gc(): Promise<void> {
		try {
			const sidecars = await this.readSidecars();
			const now = Date.now();
			const files: Array<{ data: string; json: string; size: number; at: number }> = [];
			for (const s of sidecars) {
				const stat = await this.app.vault.adapter.stat(s.__dataPath);
				files.push({ data: s.__dataPath, json: `${s.__dataPath}.json`, size: stat?.size ?? 0, at: new Date(s.timestamp).getTime() });
			}
			// Age out beyond retention.
			for (const f of files) {
				if (now - f.at > RETAIN_MS) {
					await this.app.vault.adapter.remove(f.data).catch(() => undefined);
					await this.app.vault.adapter.remove(f.json).catch(() => undefined);
				}
			}
			// Size cap (oldest first).
			const remaining = files.filter((f) => now - f.at <= RETAIN_MS).sort((a, b) => a.at - b.at);
			let total = remaining.reduce((s, f) => s + f.size, 0);
			for (const f of remaining) {
				if (total <= MAX_TOTAL_BYTES) break;
				await this.app.vault.adapter.remove(f.data).catch(() => undefined);
				await this.app.vault.adapter.remove(f.json).catch(() => undefined);
				total -= f.size;
			}
		} catch (e) {
			console.error(`${LOG} Recycle GC failed:`, e);
		}
	}

	private async ensureDir(dir: string): Promise<void> {
		if (!dir) return;
		const segments = dir.split("/").filter(Boolean);
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.adapter.mkdir(current);
			}
		}
	}
}

/** Generate a sync-run id (used to group recycle entries for undo). */
export function newSyncRunId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
}
