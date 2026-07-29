import { App, Modal } from "obsidian";

export interface AutomationDryRunEntry {
	vaultPath: string;
	willRun: boolean;
	skipReason?: string;
}

export class AutomationDryRunModal extends Modal {
	constructor(
		app: App,
		private automationName: string,
		private entries: AutomationDryRunEntry[]
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: `Dry Run — "${this.automationName}"` });

		const wouldRun = this.entries.filter((e) => e.willRun);
		const wouldSkip = this.entries.filter((e) => !e.willRun);

		if (this.entries.length === 0) {
			contentEl.createEl("p", { text: "No matching files found for this automation." });
			this.addClose();
			return;
		}

		const summary = contentEl.createEl("p");
		summary.style.cssText = "color:var(--text-muted);margin-bottom:12px;";
		summary.textContent = `${this.entries.length} matching file${this.entries.length !== 1 ? "s" : ""} — ${wouldRun.length} would run, ${wouldSkip.length} would skip.`;

		if (wouldRun.length > 0) {
			contentEl.createEl("h3", { text: `Would run (${wouldRun.length})` });
			const ul = contentEl.createEl("ul");
			ul.style.cssText = "max-height:220px;overflow-y:auto;margin:4px 0 16px;font-size:13px;";
			for (const e of wouldRun) ul.createEl("li", { text: e.vaultPath });
		}

		if (wouldSkip.length > 0) {
			contentEl.createEl("h3", { text: `Would skip (${wouldSkip.length})` });
			const ul = contentEl.createEl("ul");
			ul.style.cssText = "max-height:180px;overflow-y:auto;margin:4px 0 16px;font-size:13px;";
			for (const e of wouldSkip) {
				const li = ul.createEl("li");
				li.createSpan({ text: e.vaultPath });
				if (e.skipReason) {
					li.createSpan({ text: ` — ${e.skipReason}` }).style.cssText = "color:var(--text-muted);";
				}
			}
		}

		this.addClose();
	}

	private addClose(): void {
		const row = this.contentEl.createDiv();
		row.style.cssText = "display:flex;justify-content:flex-end;margin-top:8px;";
		const btn = row.createEl("button", { text: "Close" });
		btn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
