import { ItemView, WorkspaceLeaf, setIcon, TFile } from "obsidian";
import type DriveDownloaderPlugin from "../main";
import type { SyncResult } from "../types";
import type { BusRecord, EventName } from "../events/EventBus";

export const SYNC_STATUS_VIEW_TYPE = "drive-downloader-status";

type Tab = "summary" | "live";

const EVENT_ICON: Record<EventName, string> = {
	downloaded: "download",
	skipped: "minus",
	moved: "move",
	removed: "trash",
	"drive-trashed": "trash-2",
	"manifest-write": "save",
	"auth-failed": "shield-alert",
	"auth-restored": "shield-check",
	"recycle-write": "archive",
	"sync-complete": "check-circle",
	error: "x-circle",
};

export class SyncStatusView extends ItemView {
	private result: SyncResult | null = null;
	private tab: Tab = "summary";
	private liveListEl: HTMLElement | null = null;
	private livePaused = false;

	constructor(leaf: WorkspaceLeaf, private plugin: DriveDownloaderPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return SYNC_STATUS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Drive Downloader Status";
	}

	getIcon(): string {
		return "download-cloud";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	updateResult(result: SyncResult): void {
		this.result = result;
		if (this.tab === "summary") this.render();
	}

	onBusEvent(record: BusRecord): void {
		if (this.tab !== "live" || !this.liveListEl || this.livePaused) return;
		this.liveListEl.querySelector(".setting-item-description")?.remove();
		this.liveListEl.prepend(this.makeLiveRow(record));
		while (this.liveListEl.childElementCount > 50) {
			this.liveListEl.lastElementChild?.remove();
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h4", { text: "Drive Downloader Status" });

		const tabs = this.contentEl.createDiv();
		tabs.style.cssText = "display:flex;gap:4px;margin-bottom:8px;";
		for (const [id, label] of [["summary", "Summary"], ["live", "Live"]] as const) {
			const button = tabs.createEl("button", { text: label });
			button.style.cssText =
				`flex:1;padding:4px;cursor:pointer;${this.tab === id
					? "font-weight:bold;border-bottom:2px solid var(--interactive-accent);"
					: ""}`;
			button.addEventListener("click", () => {
				this.tab = id;
				this.render();
			});
		}

		const body = this.contentEl.createDiv();
		if (this.tab === "summary") this.renderSummary(body);
		else this.renderLive(body);
	}

	private renderSummary(root: HTMLElement): void {
		this.renderHealth(root);
		if (!this.result) {
			root.createEl("p", {
				text: "No sync has run yet in this session.",
				cls: "setting-item-description",
			});
			return;
		}

		const result = this.result;
		root.createEl("p", {
			text: `Last sync: ${new Date(result.timestamp ?? Date.now()).toLocaleString()}`,
		});
		root.createEl("p", {
			text:
				`${result.downloaded} downloaded, ${result.skipped} up to date, ` +
				`${result.moved ?? 0} moved, ${result.removed} removed, ` +
				`${result.archived ?? 0} archived, ${result.errors} errors`,
		});

		if (!result.pairs || Object.keys(result.pairs).length === 0) return;
		root.createEl("h5", { text: "Per-folder results" });
		const labels = new Map(this.plugin.settings.syncPairs.map((pair) => [pair.id, pair.label]));
		const table = root.createEl("table");
		table.style.cssText = "width:100%;border-collapse:collapse;";
		const header = table.createEl("thead").createEl("tr");
		for (const name of ["Folder", "Downloaded", "Skipped", "Moved", "Removed", "Archived", "Errors"]) {
			const cell = header.createEl("th", { text: name });
			cell.style.cssText =
				"text-align:left;padding:4px 8px;border-bottom:1px solid var(--background-modifier-border);";
		}
		const body = table.createEl("tbody");
		for (const [pairId, pairResult] of Object.entries(result.pairs)) {
			const row = body.createEl("tr");
			const values = [
				labels.get(pairId) ?? pairId,
				String(pairResult.downloaded),
				String(pairResult.skipped),
				String(pairResult.moved ?? 0),
				String(pairResult.removed),
				String(pairResult.archived ?? 0),
				String(pairResult.errors),
			];
			for (const value of values) {
				row.createEl("td", { text: value }).style.cssText = "padding:4px 8px;";
			}
		}
	}

	private renderHealth(root: HTMLElement): void {
		if (this.plugin.settings.syncPairs.length === 0) return;
		root.createEl("h5", { text: "Folder health" });
		for (const pair of this.plugin.settings.syncPairs) {
			const health = this.plugin.getPairHealth(pair.id);
			const row = root.createDiv();
			row.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0;";
			const dot = row.createSpan();
			dot.style.cssText =
				`width:10px;height:10px;border-radius:50%;background:${health.color};flex:0 0 auto;`;
			dot.setAttr("title", health.tooltip);
			row.createSpan({ text: pair.label });
		}
	}

	private renderLive(root: HTMLElement): void {
		const controls = root.createDiv();
		controls.style.cssText = "display:flex;gap:6px;margin-bottom:6px;";
		const pause = controls.createEl("button", { text: this.livePaused ? "Resume" : "Pause" });
		pause.addEventListener("click", () => {
			this.livePaused = !this.livePaused;
			this.render();
		});
		const clear = controls.createEl("button", { text: "Clear" });
		clear.addEventListener("click", () => {
			this.plugin.recentEvents.length = 0;
			this.render();
		});

		this.liveListEl = root.createDiv();
		this.liveListEl.style.cssText = "max-height:60vh;overflow:auto;";
		if (this.plugin.recentEvents.length === 0) {
			this.liveListEl.createEl("p", {
				text: "No events yet.",
				cls: "setting-item-description",
			});
			return;
		}
		for (let index = this.plugin.recentEvents.length - 1; index >= 0; index--) {
			this.liveListEl.appendChild(this.makeLiveRow(this.plugin.recentEvents[index]));
		}
	}

	private makeLiveRow(record: BusRecord): HTMLElement {
		const row = createDiv();
		row.style.cssText =
			"display:flex;gap:6px;align-items:baseline;padding:2px 0;font-size:12px;" +
			"border-bottom:1px solid var(--background-modifier-border);";
		const time = row.createSpan({ text: new Date(record.at).toLocaleTimeString() });
		time.style.cssText = "color:var(--text-muted);flex:0 0 auto;";
		const icon = row.createSpan();
		setIcon(icon, EVENT_ICON[record.event]);
		const summary = this.summarize(record);
		const text = row.createSpan({ text: summary.text });
		if (summary.path) {
			text.style.cssText = "cursor:pointer;text-decoration:underline dotted;";
			text.addEventListener("click", () => {
				const file = this.app.vault.getAbstractFileByPath(summary.path!);
				if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
			});
		}
		return row;
	}

	private summarize(record: BusRecord): { text: string; path?: string } {
		const payload = record.payload as Record<string, unknown>;
		switch (record.event) {
			case "downloaded":
				return { text: `Downloaded ${payload.vaultPath}`, path: payload.vaultPath as string };
			case "skipped":
				return { text: `Skipped ${payload.vaultPath} (${payload.reason})`, path: payload.vaultPath as string };
			case "moved":
				return { text: `Moved to ${payload.toPath}`, path: payload.toPath as string };
			case "removed":
				return { text: `Removed ${payload.vaultPath} (${payload.behavior})`, path: payload.vaultPath as string };
			case "drive-trashed":
				return { text: `Moved Drive copy to trash for ${payload.vaultPath}`, path: payload.vaultPath as string };
			case "manifest-write":
				return { text: `Manifest saved (${payload.entryCount} entries)` };
			case "auth-failed":
				return { text: `Authorization failed: ${payload.reason}` };
			case "auth-restored":
				return { text: "Authorization restored" };
			case "recycle-write":
				return { text: `Recycled ${payload.originalPath}`, path: payload.recyclePath as string };
			case "sync-complete":
				return { text: "Sync complete" };
			case "error":
				return { text: `Error: ${payload.message}` };
		}
	}
}
