import { App, Modal } from "obsidian";
import type { AutomationManifestStore } from "../tracking/AutomationManifestStore";
import type { TranscriptionStore } from "../ai/TranscriptionStore";

export class AutomationStatusModal extends Modal {
	constructor(
		app: App,
		private tracking: AutomationManifestStore,
		private transcriptions: TranscriptionStore
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "File Automation Status" });
		const tracked = this.tracking.entries().sort(([a], [b]) => a.localeCompare(b));
		const transcribed = this.transcriptions.entries();
		const paths = Array.from(new Set([
			...tracked.map(([path]) => path),
			...transcribed.map(([path]) => path)
		])).sort((a, b) => a.localeCompare(b));
		const summary = this.contentEl.createEl("p", {
			text: `${tracked.length} tracked PDF${tracked.length === 1 ? "" : "s"} · ${transcribed.length} transcription record${transcribed.length === 1 ? "" : "s"}`
		});
		summary.style.color = "var(--text-muted)";
		if (!paths.length) {
			this.contentEl.createEl("p", { text: "No PDFs have been processed yet." });
			return;
		}

		const table = this.contentEl.createEl("table");
		table.style.cssText = "width:100%;border-collapse:collapse;font-size:13px;";
		const head = table.createEl("thead").createEl("tr");
		for (const label of ["PDF", "Companion", "Transcription", "Automation runs"]) {
			const cell = head.createEl("th", { text: label });
			cell.style.cssText = "text-align:left;padding:6px;border-bottom:1px solid var(--background-modifier-border);";
		}
		const body = table.createEl("tbody");
		for (const path of paths) {
			const entry = this.tracking.get(path);
			const row = body.createEl("tr");
			const transcription = this.transcriptions.get(path);
			const runs = Object.values(entry?.automationRuns ?? {});
			const failures = runs.filter((run) => run.result === "error").length;
			const sourceExists = !!this.app.vault.getAbstractFileByPath(path);
			const companionExists = entry?.companionPath
				? !!this.app.vault.getAbstractFileByPath(entry.companionPath)
				: false;
			const currentVersion = transcription?.currentSourceVersion ?? entry?.sourceVersion;
			const transcriptionStale = !!transcription && (
				(!!currentVersion && transcription.lastSourceVersion !== currentVersion) ||
				(!!transcription.currentPdfHash && transcription.currentPdfHash !== transcription.pdfHash)
			);
			const pageDelta = transcription &&
				transcription.currentPageCount !== undefined &&
				transcription.currentPageCount !== transcription.pageCount
				? ` · now ${transcription.currentPageCount} pages`
				: "";
			const companionStatus = entry?.companionPath
				? companionExists ? entry.companionPath : `Missing: ${entry.companionPath}`
				: entry?.detachedCompanionPath !== undefined
					? entry.detachedCompanionPath
						? `Detached: ${entry.detachedCompanionPath}`
						: "Detached/deleted"
					: "—";
			for (const text of [
				sourceExists ? path : `Missing: ${path}`,
				companionStatus,
				transcription
					? `${transcriptionStale ? "Stale · " : "Current · "}${transcription.pageCount} pages${pageDelta} · ${new Date(transcription.lastTranscribedAt).toLocaleString()}`
					: "Never transcribed",
				runs.length ? `${runs.length}${failures ? ` (${failures} failed)` : ""}` : "—"
			]) {
				const cell = row.createEl("td", { text });
				cell.style.cssText = "padding:6px;vertical-align:top;border-bottom:1px solid var(--background-modifier-border);word-break:break-word;";
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
