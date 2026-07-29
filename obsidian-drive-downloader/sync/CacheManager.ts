import { App, TFile } from "obsidian";

const CACHE_DIR = ".obsidian/drive-sync-cache";
const LOG = "[DriveSync/Cache]";

/**
 * Phase 11.3 — content-addressed download cache.
 *
 * Drive moves/renames/duplicates never re-download bytes we already have. The cache is
 * keyed by Drive's own `md5Checksum` (available *before* download, so a hit costs zero
 * bytes) rather than a post-download sha256 — see IMPROVEMENTS.md Phase 11.3 decisions.
 * The sha256 of the content is still recorded as the manifest `contentHash` for the
 * integrity command (Phase 13.4).
 */
export class CacheManager {
	constructor(private app: App, private maxBytes: number) {}

	setMaxBytes(maxBytes: number): void { this.maxBytes = maxBytes; }

	private keyPath(key: string): string {
		// md5 hex is filesystem-safe; guard against anything unexpected.
		const safe = key.replace(/[^a-zA-Z0-9_-]/g, "");
		return `${CACHE_DIR}/${safe}`;
	}

	async has(key: string): Promise<boolean> {
		if (!key) return false;
		return this.app.vault.adapter.exists(this.keyPath(key));
	}

	/** Restore cached bytes to a vault path. Returns true on a cache hit. */
	async restore(key: string, destPath: string): Promise<boolean> {
		if (!(await this.has(key))) return false;
		try {
			const bytes = await this.app.vault.adapter.readBinary(this.keyPath(key));
			const exists = await this.app.vault.adapter.exists(destPath);
			if (exists) {
				const file = this.app.vault.getAbstractFileByPath(destPath);
				if (!(file instanceof TFile)) {
					throw new Error(`Vault index could not resolve existing cache destination: ${destPath}`);
				}
				// Use Vault APIs so automation plugins reliably observe the restored modification.
				await this.app.vault.modifyBinary(file, bytes);
			} else {
				await this.app.vault.createBinary(destPath, bytes);
			}
			// Touch for LRU by rewriting (adapter has no utime); rewrite is cheap vs a network fetch.
			console.log(`${LOG} Cache hit — restored ${destPath} from ${key.slice(0, 8)}…`);
			return true;
		} catch (e) {
			console.error(`${LOG} Failed to restore from cache (${key}):`, e);
			return false;
		}
	}

	async store(key: string, bytes: ArrayBuffer): Promise<void> {
		if (!key) return;
		try {
			if (!(await this.app.vault.adapter.exists(CACHE_DIR))) {
				await this.app.vault.adapter.mkdir(CACHE_DIR);
			}
			const path = this.keyPath(key);
			if (!(await this.app.vault.adapter.exists(path))) {
				await this.app.vault.adapter.writeBinary(path, bytes);
			}
		} catch (e) {
			console.error(`${LOG} Failed to write cache (${key}):`, e);
		}
	}

	/**
	 * LRU eviction. Evicts entries whose key is not in `referenced` first (oldest first),
	 * then continues by oldest mtime until total size is under the cap.
	 */
	async gc(referenced: Set<string>): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(CACHE_DIR))) return;
			const listing = await this.app.vault.adapter.list(CACHE_DIR);
			const entries: Array<{ path: string; key: string; size: number; mtime: number }> = [];
			for (const path of listing.files) {
				const stat = await this.app.vault.adapter.stat(path);
				if (!stat) continue;
				entries.push({ path, key: path.split("/").pop() ?? path, size: stat.size, mtime: stat.mtime });
			}
			let total = entries.reduce((s, e) => s + e.size, 0);
			if (total <= this.maxBytes) return;

			// Unreferenced first (oldest first), then referenced oldest.
			entries.sort((a, b) => {
				const ar = referenced.has(a.key) ? 1 : 0;
				const br = referenced.has(b.key) ? 1 : 0;
				if (ar !== br) return ar - br;
				return a.mtime - b.mtime;
			});

			for (const e of entries) {
				if (total <= this.maxBytes) break;
				await this.app.vault.adapter.remove(e.path).catch(() => undefined);
				total -= e.size;
				console.log(`${LOG} Evicted ${e.key.slice(0, 8)}… (${e.size} bytes)`);
			}
		} catch (e) {
			console.error(`${LOG} Cache GC failed:`, e);
		}
	}
}
