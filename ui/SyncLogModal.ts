import { App, Modal } from "obsidian";
import { SyncActivityLog, SyncLogEntry } from "../sync/SyncLog";

export class SyncLogModal extends Modal {
	constructor(app: App, private syncLog: SyncActivityLog) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Sync Activity Log" });

		const entries = await this.syncLog.readAll();

		if (entries.length === 0) {
			contentEl.createEl("p", { text: "No log entries yet. Enable the sync activity log in settings to start recording." });
			this.addClose();
			return;
		}

		const controls = contentEl.createDiv();
		controls.style.cssText = "display:flex;gap:8px;margin-bottom:12px;align-items:center;";

		const levelFilter = controls.createEl("select");
		levelFilter.style.cssText = "padding:4px 8px;border:1px solid var(--background-modifier-border);border-radius:4px;";
		for (const [val, label] of [["all","All levels"],["info","Info"],["warn","Warn"],["error","Error"]] as const) {
			levelFilter.createEl("option", { text: label, value: val });
		}

		const searchInput = controls.createEl("input");
		searchInput.type = "text";
		searchInput.placeholder = "Filter by file or action…";
		searchInput.style.cssText = "flex:1;padding:4px 8px;border:1px solid var(--background-modifier-border);border-radius:4px;";

		const countEl = controls.createSpan();
		countEl.style.cssText = "color:var(--text-muted);font-size:12px;white-space:nowrap;";

		const wrapper = contentEl.createDiv();
		wrapper.style.cssText = "overflow-y:auto;max-height:420px;border:1px solid var(--background-modifier-border);border-radius:4px;";

		const table = wrapper.createEl("table");
		table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;";
		const thead = table.createEl("thead");
		const hRow = thead.createEl("tr");
		for (const h of ["Time", "Lvl", "Action", "File", "Result"]) {
			const th = hRow.createEl("th", { text: h });
			th.style.cssText = "text-align:left;padding:5px 8px;border-bottom:2px solid var(--background-modifier-border);position:sticky;top:0;background:var(--background-primary);white-space:nowrap;";
		}
		const tbody = table.createEl("tbody");

		const render = () => {
			tbody.empty();
			const level = levelFilter.value;
			const search = searchInput.value.toLowerCase();
			const filtered = entries
				.slice()
				.reverse()
				.filter((e) => {
					if (level !== "all" && e.level !== level) return false;
					if (search && !e.file?.toLowerCase().includes(search) && !e.action.toLowerCase().includes(search) && !e.result.toLowerCase().includes(search)) return false;
					return true;
				});

			countEl.textContent = `${filtered.length} / ${entries.length} entries`;

			for (const entry of filtered) {
				const row = tbody.createEl("tr");
				row.style.cssText = "border-bottom:1px solid var(--background-modifier-border-hover);";
				const levelColor = entry.level === "error" ? "var(--text-error)" : entry.level === "warn" ? "var(--color-orange)" : "var(--text-muted)";

				const td = (text: string, color?: string, mono = false) => {
					const el = row.createEl("td");
					el.style.cssText = `padding:4px 8px;overflow:hidden;max-width:200px;${color ? `color:${color};` : ""}${mono ? "font-family:monospace;" : ""}`;
					el.title = text;
					el.textContent = text.length > 40 ? text.slice(0, 37) + "…" : text;
					return el;
				};

				td(new Date(entry.ts).toLocaleString());
				td(entry.level, levelColor);
				td(entry.action);
				td(entry.file ?? "—");
				const resultEl = td(entry.result);
				if (entry.details) resultEl.title = `${entry.result}\n\n${entry.details}`;
			}

			if (filtered.length === 0) {
				const row = tbody.createEl("tr");
				const td = row.createEl("td", { text: "No matching entries." });
				td.setAttribute("colspan", "5");
				td.style.cssText = "padding:12px;color:var(--text-muted);text-align:center;";
			}
		};

		levelFilter.addEventListener("change", render);
		searchInput.addEventListener("input", render);
		render();

		this.addClose();
	}

	private addClose(): void {
		const row = this.contentEl.createDiv();
		row.style.cssText = "display:flex;justify-content:flex-end;margin-top:12px;";
		const btn = row.createEl("button", { text: "Close" });
		btn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
