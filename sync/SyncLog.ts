import { App } from "obsidian";
import { PluginSettings } from "../types";

const LOG_PATH = ".obsidian/drive-sync.log";
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 3;

export type LogLevel = "info" | "warn" | "error";

export interface SyncLogEntry {
	ts: string;
	level: LogLevel;
	syncId: string;
	file?: string;
	action: string;
	result: string;
	details?: string;
}

export class SyncActivityLog {
	constructor(private app: App, private settings: PluginSettings) {}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	async log(entry: Omit<SyncLogEntry, "ts">): Promise<void> {
		if (!this.settings.syncActivityLogEnabled) return;
		const minLevel = this.settings.syncActivityLogLevel ?? "info";
		if (!this.levelPasses(entry.level, minLevel)) return;

		const full: SyncLogEntry = { ts: new Date().toISOString(), ...entry };
		const line = JSON.stringify(full) + "\n";
		await this.rotate();
		await this.app.vault.adapter.append(LOG_PATH, line);
	}

	async readAll(): Promise<SyncLogEntry[]> {
		const exists = await this.app.vault.adapter.exists(LOG_PATH);
		if (!exists) return [];
		const content = await this.app.vault.adapter.read(LOG_PATH);
		return content
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try { return JSON.parse(line) as SyncLogEntry; }
				catch { return null; }
			})
			.filter(Boolean) as SyncLogEntry[];
	}

	private async rotate(): Promise<void> {
		const exists = await this.app.vault.adapter.exists(LOG_PATH);
		if (!exists) return;
		const stat = await this.app.vault.adapter.stat(LOG_PATH);
		if (!stat || stat.size < MAX_SIZE_BYTES) return;
		for (let i = MAX_ROTATIONS; i >= 1; i--) {
			const oldPath = `${LOG_PATH}.${i}`;
			const newPath = `${LOG_PATH}.${i + 1}`;
			if (await this.app.vault.adapter.exists(oldPath)) {
				if (i === MAX_ROTATIONS) {
					await this.app.vault.adapter.remove(oldPath);
				} else {
					await this.app.vault.adapter.rename(oldPath, newPath);
				}
			}
		}
		await this.app.vault.adapter.rename(LOG_PATH, `${LOG_PATH}.1`);
	}

	private levelPasses(level: LogLevel, minLevel: LogLevel): boolean {
		const order: LogLevel[] = ["info", "warn", "error"];
		return order.indexOf(level) >= order.indexOf(minLevel);
	}
}
