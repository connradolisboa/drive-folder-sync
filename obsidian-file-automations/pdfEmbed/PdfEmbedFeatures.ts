import type { FileAutomationSettings } from "../types";

const STYLE_ID = "file-automations-pdf-embed-style";
const BAR_CLASS = "file-automations-pdf-bar";
const COLLAPSED_CLASS = "file-automations-pdf-collapsed";

export class PdfEmbedFeatures {
	private observer: MutationObserver | null = null;
	private sweepScheduled = false;

	constructor(private settings: FileAutomationSettings) {}

	updateSettings(settings: FileAutomationSettings): void {
		this.settings = settings;
		this.refresh();
	}

	refresh(): void {
		this.applyStyle();
		if (this.settings.pdfEmbedCollapsible) {
			this.startObserver();
			this.enhanceAll();
		} else {
			this.stopObserver();
			this.removeAllBars();
		}
	}

	unload(): void {
		this.stopObserver();
		this.removeAllBars();
		document.getElementById(STYLE_ID)?.remove();
	}

	private applyStyle(): void {
		document.getElementById(STYLE_ID)?.remove();
		const parts: string[] = [];
		if (this.settings.pdfEmbedWindowed) {
			const height = Math.max(100, Math.round(this.settings.pdfEmbedWindowHeight) || 400);
			parts.push(
				`.internal-embed.pdf-embed:not(.${COLLAPSED_CLASS}){height:${height}px!important}`,
				`.internal-embed.pdf-embed:not(.${COLLAPSED_CLASS}) .pdf-viewer-container,.internal-embed.pdf-embed:not(.${COLLAPSED_CLASS}) .pdf-container{height:100%!important;max-height:${height}px!important;overflow:auto!important}`
			);
		}
		if (this.settings.pdfEmbedCollapsible) {
			parts.push(
				`.${BAR_CLASS}{display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;user-select:none;position:relative;z-index:1;background:var(--background-secondary);border-bottom:1px solid var(--background-modifier-border);font-size:var(--font-ui-small)}`,
				`.${BAR_CLASS}:hover{background:var(--background-modifier-hover)}`,
				`.file-automations-pdf-chevron{display:inline-block;width:1em;text-align:center;color:var(--text-muted)}`,
				`.file-automations-pdf-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}`,
				`.internal-embed.pdf-embed.${COLLAPSED_CLASS}{height:auto!important}`,
				`.internal-embed.pdf-embed.${COLLAPSED_CLASS}>*:not(.${BAR_CLASS}){display:none!important}`
			);
		}
		if (!parts.length) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = parts.join("\n");
		document.head.appendChild(style);
	}

	private startObserver(): void {
		if (this.observer || !document.body) return;
		this.observer = new MutationObserver((mutations) => {
			const relevant = mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) =>
				node instanceof HTMLElement &&
				(node.matches(".internal-embed,.pdf-embed,.pdf-container") || !!node.querySelector(".internal-embed,.pdf-embed"))
			));
			if (!relevant || this.sweepScheduled) return;
			this.sweepScheduled = true;
			window.requestAnimationFrame(() => {
				this.sweepScheduled = false;
				this.enhanceAll();
			});
		});
		this.observer.observe(document.body, { childList: true, subtree: true });
	}

	private stopObserver(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	private enhanceAll(): void {
		if (!this.settings.pdfEmbedCollapsible) return;
		document.querySelectorAll<HTMLElement>('.pdf-embed,.internal-embed[src*=".pdf"]').forEach((element) => {
			if (!element.classList.contains("internal-embed") || element.querySelector(`:scope>.${BAR_CLASS}`)) return;
			if (this.settings.pdfEmbedCollapsedByDefault) element.classList.add(COLLAPSED_CLASS);
			const src = element.getAttribute("src") ?? element.getAttribute("alt") ?? "PDF";
			let raw = src.split("/").pop() ?? src;
			try { raw = decodeURIComponent(raw); } catch {}
			const page = raw.match(/#page=(\d+)/i)?.[1];
			const name = raw.replace(/#.*$/, "");
			const bar = element.createDiv({ cls: BAR_CLASS });
			element.prepend(bar);
			const collapsed = element.classList.contains(COLLAPSED_CLASS);
			const chevron = bar.createSpan({ cls: "file-automations-pdf-chevron", text: collapsed ? "▸" : "▾" });
			bar.createSpan({ cls: "file-automations-pdf-title", text: page ? `${name} (p. ${page})` : name });
			bar.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				chevron.textContent = element.classList.toggle(COLLAPSED_CLASS) ? "▸" : "▾";
			});
		});
	}

	private removeAllBars(): void {
		document.querySelectorAll(`.${BAR_CLASS}`).forEach((bar) => bar.remove());
		document.querySelectorAll(`.${COLLAPSED_CLASS}`).forEach((element) => element.classList.remove(COLLAPSED_CLASS));
	}
}
