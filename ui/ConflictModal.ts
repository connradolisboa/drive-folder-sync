import { App, Modal } from "obsidian";

export type ConflictChoice = "keep-vault" | "take-drive" | "save-both";

export class ConflictModal extends Modal {
	private resolver: ((choice: ConflictChoice) => void) | null = null;

	static prompt(app: App, companionPath: string): Promise<ConflictChoice> {
		return new Promise<ConflictChoice>((resolve) => {
			const modal = new ConflictModal(app, companionPath, resolve);
			modal.open();
		});
	}

	constructor(
		app: App,
		private companionPath: string,
		resolver: (choice: ConflictChoice) => void
	) {
		super(app);
		this.resolver = resolver;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Sync Conflict" });

		const desc = contentEl.createEl("p");
		desc.textContent = `The companion note was edited locally since the last sync:`;
		const codePath = contentEl.createEl("code", { text: this.companionPath });
		codePath.style.cssText = "display:block;margin:8px 0 16px;word-break:break-all;";

		contentEl.createEl("p", {
			text: "How would you like to resolve this conflict?",
		}).style.cssText = "margin-bottom:12px;";

		const choose = (choice: ConflictChoice) => {
			this.resolver?.(choice);
			this.resolver = null;
			this.close();
		};

		const optionRow = (title: string, desc: string, choice: ConflictChoice, isCta = false) => {
			const row = contentEl.createDiv();
			row.style.cssText = "display:flex;align-items:flex-start;gap:12px;padding:10px;margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;cursor:pointer;";
			row.addEventListener("mouseenter", () => row.style.background = "var(--background-modifier-hover)");
			row.addEventListener("mouseleave", () => row.style.background = "");
			row.addEventListener("click", () => choose(choice));

			const text = row.createDiv();
			const titleEl = text.createEl("strong", { text: title });
			titleEl.style.cssText = "display:block;margin-bottom:2px;";
			text.createEl("small", { text: desc }).style.cssText = "color:var(--text-muted);";
		};

		optionRow(
			"Keep vault version",
			"Skip the Drive update and preserve your local edits.",
			"keep-vault"
		);
		optionRow(
			"Take Drive version",
			"Overwrite your local edits with the incoming Drive update.",
			"take-drive"
		);
		optionRow(
			"Save both (recommended)",
			"Create a .conflict backup of your edits, then apply the Drive version.",
			"save-both",
			true
		);
	}

	onClose(): void {
		// Default to save-both if user closes without choosing
		this.resolver?.("save-both");
		this.resolver = null;
		this.contentEl.empty();
	}
}
