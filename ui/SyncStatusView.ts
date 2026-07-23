import { ItemView, WorkspaceLeaf, setIcon, TFile } from "obsidian";
import type DriveFolderSyncPlugin from "../main";
import type { SyncResult } from "../types";
import type { BusRecord, EventName } from "../events/EventBus";

export const SYNC_STATUS_VIEW_TYPE = "drive-sync-status";

type Tab = "summary" | "live";

const EVENT_ICON: Record<EventName, string> = {
	downloaded: "download",
	uploaded: "upload",
	skipped: "minus",
	moved: "move",
	removed: "trash",
	"drive-trashed": "trash-2",
	"deleted-after-transcription": "file-x",
	conflict: "alert-triangle",
	"automation-run": "zap",
	"manifest-write": "save",
	"auth-failed": "shield-alert",
	"auth-restored": "shield-check",
	"recycle-write": "archive",
	"sync-complete": "check-circle",
	"quota-pause": "pause",
	error: "x-circle",
};

export class SyncStatusView extends ItemView {
	private result: SyncResult | null = null;
	private tab: Tab = "summary";
	private liveListEl: HTMLElement | null = null;
	private livePaused = false;

	constructor(leaf: WorkspaceLeaf, private plugin: DriveFolderSyncPlugin) {
		super(leaf);
	}

	getViewType(): string { return SYNC_STATUS_VIEW_TYPE; }
	getDisplayText(): string { return "PDF Manager Status"; }
	getIcon(): string { return "refresh-cw"; }

	async onOpen(): Promise<void> { this.render(); }

	updateResult(result: SyncResult): void {
		this.result = result;
		if (this.tab === "summary") this.render();
	}

	/** Phase 12.1 — append a single bus event to the live ticker when that tab is open. */
	onBusEvent(rec: BusRecord): void {
		if (this.tab !== "live" || !this.liveListEl || this.livePaused) return;
		this.prependLiveRow(rec);
		// Trim DOM to the buffer cap.
		while (this.liveListEl.childElementCount > 50) {
			this.liveListEl.lastElementChild?.remove();
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h4", { text: "PDF Manager Status" });

		// Tab bar
		const tabs = contentEl.createDiv({ cls: "drive-sync-tabs" });
		tabs.style.cssText = "display:flex; gap:4px; margin-bottom:8px;";
		const mkTab = (id: Tab, label: string) => {
			const b = tabs.createEl("button", { text: label });
			b.style.cssText = `flex:1; padding:4px; cursor:pointer;${this.tab === id ? " font-weight:bold; border-bottom:2px solid var(--interactive-accent);" : ""}`;
			b.onclick = () => { this.tab = id; this.render(); };
		};
		mkTab("summary", "Summary");
		mkTab("live", "Live");

		const body = contentEl.createDiv();
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

		const r = this.result;
		const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : "unknown";
		root.createEl("p", { text: `Last sync: ${ts}` });

		const summaryParts = [
			`${r.downloaded} downloaded`,
			`${r.skipped} up to date`,
			...((r.moved ?? 0) > 0 ? [`${r.moved} moved`] : []),
			`${r.removed} removed`,
			...((r.archived ?? 0) > 0 ? [`${r.archived} archived`] : []),
			`${r.errors} errors`,
		];
		root.createEl("p").textContent = `Total — ${summaryParts.join(", ")}`;

		if (r.pairs && Object.keys(r.pairs).length > 0) {
			root.createEl("h5", { text: "Per-pair breakdown" });
			const showMoved = Object.values(r.pairs).some((pr) => (pr.moved ?? 0) > 0);
			const showArchived = Object.values(r.pairs).some((pr) => (pr.archived ?? 0) > 0);

			const table = root.createEl("table");
			table.style.cssText = "width: 100%; border-collapse: collapse;";
			const headerRow = table.createEl("thead").createEl("tr");
			const headers = ["Pair", "Downloaded", "Up to date"];
			if (showMoved) headers.push("Moved");
			headers.push("Removed");
			if (showArchived) headers.push("Archived");
			headers.push("Errors");
			headers.forEach((h) => {
				const th = headerRow.createEl("th", { text: h });
				th.style.cssText =
					"text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--background-modifier-border);";
			});

			const tbody = table.createEl("tbody");
			const pairLabelMap = Object.fromEntries(
				this.plugin.settings.syncPairs.map((p) => [p.id, p.label])
			);
			for (const [pairId, pr] of Object.entries(r.pairs)) {
				const tr = tbody.createEl("tr");
				const cells = [pairLabelMap[pairId] ?? pairId, String(pr.downloaded), String(pr.skipped)];
				if (showMoved) cells.push(String(pr.moved ?? 0));
				cells.push(String(pr.removed));
				if (showArchived) cells.push(String(pr.archived ?? 0));
				cells.push(String(pr.errors));
				cells.forEach((val) => {
					const td = tr.createEl("td", { text: val });
					td.style.cssText = "padding: 4px 8px;";
				});
			}
		}

		if (r.conflicts?.length) {
			root.createEl("h5", { text: "Companion note conflicts" });
			root.createEl("p", {
				text: `${r.conflicts.length} companion note${r.conflicts.length !== 1 ? "s were" : " was"} edited locally since the last sync. Conflict backups were created:`,
				cls: "setting-item-description",
			});
			const list = root.createEl("ul");
			for (const conflictPath of r.conflicts) list.createEl("li", { text: conflictPath });
		}
	}

	/** Phase 12.2 — colored health dot per pair, computed by the plugin. */
	private renderHealth(root: HTMLElement): void {
		const pairs = this.plugin.settings.syncPairs;
		if (pairs.length === 0) return;
		root.createEl("h5", { text: "Pair health" });
		const wrap = root.createDiv();
		for (const pair of pairs) {
			const h = this.plugin.getPairHealth(pair.id);
			const row = wrap.createDiv();
			row.style.cssText = "display:flex; align-items:center; gap:6px; padding:2px 0;";
			const dot = row.createSpan();
			dot.style.cssText = `width:10px; height:10px; border-radius:50%; background:${h.color}; flex:0 0 auto;`;
			dot.setAttr("aria-label", h.tooltip);
			dot.setAttr("title", h.tooltip);
			row.createSpan({ text: pair.label });
		}
	}

	private renderLive(root: HTMLElement): void {
		const controls = root.createDiv();
		controls.style.cssText = "display:flex; gap:6px; margin-bottom:6px;";
		const pauseBtn = controls.createEl("button", { text: this.livePaused ? "Resume" : "Pause" });
		pauseBtn.onclick = () => { this.livePaused = !this.livePaused; this.render(); };
		const clearBtn = controls.createEl("button", { text: "Clear" });
		clearBtn.onclick = () => { this.plugin.recentEvents.length = 0; this.render(); };

		this.liveListEl = root.createDiv({ cls: "drive-sync-live" });
		this.liveListEl.style.cssText = "max-height: 60vh; overflow:auto;";

		const events = this.plugin.recentEvents;
		if (events.length === 0) {
			this.liveListEl.createEl("p", { text: "No events yet.", cls: "setting-item-description" });
			return;
		}
		// Reverse-chronological.
		for (let i = events.length - 1; i >= 0; i--) this.appendLiveRow(events[i]);
	}

	private prependLiveRow(rec: BusRecord): void {
		if (!this.liveListEl) return;
		const placeholder = this.liveListEl.querySelector(".setting-item-description");
		placeholder?.remove();
		const row = this.makeLiveRow(rec);
		this.liveListEl.prepend(row);
	}

	private appendLiveRow(rec: BusRecord): void {
		this.liveListEl?.appendChild(this.makeLiveRow(rec));
	}

	private makeLiveRow(rec: BusRecord): HTMLElement {
		const row = createDiv();
		row.style.cssText = "display:flex; gap:6px; align-items:baseline; padding:2px 0; font-size:12px; border-bottom:1px solid var(--background-modifier-border);";
		const time = row.createSpan({ text: new Date(rec.at).toLocaleTimeString() });
		time.style.cssText = "color: var(--text-muted); flex:0 0 auto;";
		const icon = row.createSpan();
		icon.style.cssText = "flex:0 0 auto;";
		setIcon(icon, EVENT_ICON[rec.event] ?? "circle");
		const summary = this.summarize(rec);
		const text = row.createSpan({ text: summary.text });
		if (summary.path) {
			text.style.cssText = "cursor:pointer; text-decoration:underline dotted;";
			text.onclick = () => {
				const f = this.app.vault.getAbstractFileByPath(summary.path!);
				if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
			};
		}
		return row;
	}

	private summarize(rec: BusRecord): { text: string; path?: string } {
		const p = rec.payload as Record<string, unknown>;
		switch (rec.event) {
			case "downloaded": return { text: `Downloaded ${p.vaultPath}`, path: p.vaultPath as string };
			case "uploaded": return { text: `Uploaded ${p.vaultPath}`, path: p.vaultPath as string };
			case "skipped": return { text: `Skipped ${p.vaultPath} (${p.reason})`, path: p.vaultPath as string };
			case "moved": return { text: `Moved → ${p.toPath}`, path: p.toPath as string };
			case "removed": return { text: `Removed ${p.vaultPath} (${p.behavior})`, path: p.vaultPath as string };
			case "conflict": return { text: `Conflict: ${p.vaultPath}`, path: p.vaultPath as string };
			case "deleted-after-transcription": return { text: `Deleted after transcription: ${p.vaultPath}`, path: p.vaultPath as string };
			case "automation-run": return { text: `${p.automationName}: ${p.result} on ${p.vaultPath}`, path: p.vaultPath as string };
			case "manifest-write": return { text: `Manifest saved (${p.entryCount} entries)` };
			case "auth-failed": return { text: `Auth failed: ${p.reason}` };
			case "auth-restored": return { text: `Auth restored` };
			case "recycle-write": return { text: `Recycled ${p.originalPath}`, path: p.recyclePath as string };
			case "sync-complete": return { text: `Sync complete` };
			case "quota-pause": return { text: `Quota guard paused uploads` };
			case "error": return { text: `Error: ${p.message}` };
			default: return { text: rec.event };
		}
	}
}
