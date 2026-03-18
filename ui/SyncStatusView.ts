import { ItemView, WorkspaceLeaf } from "obsidian";
import type DriveFolderSyncPlugin from "../main";
import type { SyncResult } from "../types";

export const SYNC_STATUS_VIEW_TYPE = "drive-sync-status";

export class SyncStatusView extends ItemView {
	private result: SyncResult | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: DriveFolderSyncPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return SYNC_STATUS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Drive Sync Status";
	}

	getIcon(): string {
		return "refresh-cw";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	updateResult(result: SyncResult): void {
		this.result = result;
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h4", { text: "Drive Sync Status" });

		if (!this.result) {
			contentEl.createEl("p", {
				text: "No sync has run yet in this session.",
				cls: "setting-item-description",
			});
			return;
		}

		const r = this.result;
		const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : "unknown";
		contentEl.createEl("p", { text: `Last sync: ${ts}` });

		const summary = contentEl.createEl("p");
		summary.textContent =
			`Total — ${r.downloaded} downloaded, ${r.skipped} up to date, ` +
			`${r.removed} removed, ${r.errors} errors`;

		if (r.pairs && Object.keys(r.pairs).length > 0) {
			contentEl.createEl("h5", { text: "Per-pair breakdown" });

			const table = contentEl.createEl("table");
			table.style.cssText = "width: 100%; border-collapse: collapse;";

			const thead = table.createEl("thead");
			const headerRow = thead.createEl("tr");
			["Pair", "Downloaded", "Up to date", "Removed", "Errors"].forEach((h) => {
				const th = headerRow.createEl("th", { text: h });
				th.style.cssText =
					"text-align: left; padding: 4px 8px; " +
					"border-bottom: 1px solid var(--background-modifier-border);";
			});

			const tbody = table.createEl("tbody");
			const pairLabelMap = Object.fromEntries(
				this.plugin.settings.syncPairs.map((p) => [p.id, p.label])
			);
			for (const [pairId, pr] of Object.entries(r.pairs)) {
				const label = pairLabelMap[pairId] ?? pairId;
				const tr = tbody.createEl("tr");
				[label, String(pr.downloaded), String(pr.skipped), String(pr.removed), String(pr.errors)].forEach(
					(val) => {
						const td = tr.createEl("td", { text: val });
						td.style.cssText = "padding: 4px 8px;";
					}
				);
			}
		}
	}
}
