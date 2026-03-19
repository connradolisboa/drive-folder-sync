import { App, Modal } from "obsidian";
import { SyncResult } from "../types";

export class DryRunModal extends Modal {
	constructor(app: App, private result: SyncResult) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Dry Run — what would happen" });

		const wouldDownload = this.result.wouldDownload ?? [];
		const wouldRemove = this.result.wouldRemove ?? [];

		if (wouldDownload.length === 0 && wouldRemove.length === 0) {
			contentEl.createEl("p", { text: "Nothing to do — all files are up to date." });
			this.addCloseButton();
			return;
		}

		if (wouldDownload.length > 0) {
			contentEl.createEl("h3", { text: `Would download (${wouldDownload.length})` });
			const ul = contentEl.createEl("ul");
			ul.style.cssText = "max-height: 300px; overflow-y: auto; margin: 4px 0 16px;";
			for (const path of wouldDownload) {
				ul.createEl("li", { text: path });
			}
		}

		if (wouldRemove.length > 0) {
			contentEl.createEl("h3", { text: `Would remove (${wouldRemove.length})` });
			const ul = contentEl.createEl("ul");
			ul.style.cssText = "max-height: 200px; overflow-y: auto; margin: 4px 0 16px;";
			for (const path of wouldRemove) {
				ul.createEl("li", { text: path });
			}
		}

		this.addCloseButton();
	}

	private addCloseButton(): void {
		const btnRow = this.contentEl.createDiv();
		btnRow.style.cssText = "display: flex; justify-content: flex-end; margin-top: 8px;";
		const btn = btnRow.createEl("button", { text: "Close" });
		btn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
