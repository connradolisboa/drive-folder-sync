import { requestUrl } from "obsidian";
import type { PluginSettings } from "../types";

const LOG = "[DriveSync/Telemetry]";

export interface ErrorReport {
	errorClass: string;
	messageTemplate: string;
	stackFrames: string[];
	pluginVersion: string;
	at: string;
}

/**
 * Phase 13.6 — opt-in anonymous error reporting.
 *
 * Captures unhandled errors, strips anything identifying (vault paths, file names, any
 * string longer than 64 chars), and only sends error class + a redacted message template
 * + stack frames. Off by default; nothing is sent without an endpoint AND the toggle.
 */
export class ErrorReporter {
	private installed = false;
	private rejectionHandler?: (e: PromiseRejectionEvent) => void;
	private errorHandler?: (e: ErrorEvent) => void;

	constructor(private settings: PluginSettings, private version: string) {}

	updateSettings(settings: PluginSettings): void { this.settings = settings; }

	install(): void {
		if (this.installed) return;
		this.rejectionHandler = (e: PromiseRejectionEvent) => {
			if (this.isOurs(e.reason)) this.report(e.reason);
		};
		this.errorHandler = (e: ErrorEvent) => {
			if (this.isOurs(e.error)) this.report(e.error);
		};
		window.addEventListener("unhandledrejection", this.rejectionHandler);
		window.addEventListener("error", this.errorHandler);
		this.installed = true;
	}

	uninstall(): void {
		if (this.rejectionHandler) window.removeEventListener("unhandledrejection", this.rejectionHandler);
		if (this.errorHandler) window.removeEventListener("error", this.errorHandler);
		this.installed = false;
	}

	/** Heuristic: only report errors whose stack mentions this plugin. */
	private isOurs(err: unknown): boolean {
		const stack = err instanceof Error ? err.stack ?? "" : "";
		return /drive-folder-sync|drive-sync/i.test(stack);
	}

	/** Build the exact payload that would be sent (no network). Used by the preview button. */
	build(err: unknown): ErrorReport {
		const e = err instanceof Error ? err : new Error(String(err));
		return {
			errorClass: e.name || "Error",
			messageTemplate: this.redact(e.message || ""),
			stackFrames: (e.stack ?? "")
				.split("\n")
				.slice(1, 11)
				.map((l) => this.redact(l.trim())),
			pluginVersion: this.version,
			at: new Date().toISOString(),
		};
	}

	/** Strip paths, file names and long literals. */
	private redact(s: string): string {
		return s
			.replace(/([a-zA-Z]:)?[\\/][^\s)'"]+/g, "<path>")   // file paths
			.replace(/\b[\w.-]+\.(md|pdf|json|png|jpg)\b/gi, "<file>") // file names
			.replace(/\b\S{65,}\b/g, "<redacted>");              // anything > 64 chars
	}

	async report(err: unknown): Promise<void> {
		if (!this.settings.errorReportingEnabled || !this.settings.errorReportingEndpoint) return;
		try {
			const payload = this.build(err);
			await requestUrl({
				url: this.settings.errorReportingEndpoint,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify(payload),
			});
		} catch (e) {
			console.warn(`${LOG} Failed to send error report:`, e);
		}
	}
}
