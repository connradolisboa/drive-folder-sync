import { analyzePdf, PdfInfo } from "../ai/PdfPageHasher";

const LOG = "[DriveSync/Worker]";

/**
 * Phase 11.4 — off-thread heavy work.
 *
 * PDF hashing + page-count scanning run on a Web Worker so large files don't freeze the
 * Obsidian UI. The worker source is self-contained and inlined as a string (instantiated
 * via a Blob URL), so there is no separate esbuild entry to maintain — see IMPROVEMENTS.md
 * Phase 11.4 decisions. If a Worker can't be created (or a task throws), every call
 * transparently falls back to the synchronous {@link analyzePdf}, so functionality is
 * never lost — only the off-thread benefit.
 */

/** Self-contained worker body. Uses Web Crypto (available in workers) for sha256. */
const WORKER_SOURCE = `
function extractPageCount(str) {
	var pageMatches = str.match(/\\/Type\\s*\\/Page(?!\\s*s)/g);
	if (pageMatches && pageMatches.length > 0) return pageMatches.length;
	var countMatches = str.match(/\\/Count\\s+(\\d+)/g);
	if (countMatches && countMatches.length > 0) {
		var max = 0;
		for (var i = 0; i < countMatches.length; i++) {
			var n = parseInt(countMatches[i].replace(/\\/Count\\s+/, ''), 10);
			if (n > max) max = n;
		}
		return max;
	}
	return 0;
}

function toHex(buffer) {
	var bytes = new Uint8Array(buffer);
	var hex = '';
	for (var i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0');
	}
	return hex;
}

self.onmessage = async function (e) {
	var id = e.data.id;
	var bytes = e.data.bytes;
	try {
		var digest = await self.crypto.subtle.digest('SHA-256', bytes);
		var hash = toHex(digest);
		// latin1 decode so ASCII PDF tokens are readable.
		var str = new TextDecoder('latin1').decode(new Uint8Array(bytes));
		var pageCount = extractPageCount(str);
		self.postMessage({ id: id, hash: hash, pageCount: pageCount });
	} catch (err) {
		self.postMessage({ id: id, error: String(err) });
	}
};
`;

interface Pending {
	resolve: (info: PdfInfo) => void;
	reject: (err: unknown) => void;
}

export class HeavyWorkerClient {
	private worker: Worker | null = null;
	private url: string | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private unavailable = false;
	private maxConcurrent: number;
	private inFlight = 0;
	private queue: Array<() => void> = [];

	constructor(maxConcurrent?: number) {
		const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
		this.maxConcurrent = Math.max(1, maxConcurrent ?? cores - 1);
	}

	private ensureWorker(): Worker | null {
		if (this.unavailable) return null;
		if (this.worker) return this.worker;
		try {
			const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
			this.url = URL.createObjectURL(blob);
			this.worker = new Worker(this.url);
			this.worker.onmessage = (e: MessageEvent) => this.onMessage(e);
			this.worker.onerror = (e) => {
				console.error(`${LOG} Worker error — falling back to sync:`, e.message);
				this.unavailable = true;
				this.worker?.terminate();
				this.worker = null;
				if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
				this.failAll(e.message);
			};
			return this.worker;
		} catch (e) {
			console.warn(`${LOG} Worker unavailable — using synchronous hashing:`, e);
			this.unavailable = true;
			return null;
		}
	}

	private onMessage(e: MessageEvent): void {
		const { id, hash, pageCount, error } = e.data as { id: number; hash?: string; pageCount?: number; error?: string };
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		if (error) {
			// analyze() owns the failure-path release in its catch block.
			p.reject(new Error(error));
		} else {
			this.release();
			p.resolve({ hash: hash!, pageCount: pageCount! });
		}
	}

	private failAll(reason: string): void {
		for (const [, p] of this.pending) p.reject(new Error(reason));
		this.pending.clear();
	}

	private release(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		const next = this.queue.shift();
		if (next) next();
	}

	/** Analyze a PDF off-thread, falling back to synchronous analysis on any failure. */
	async analyze(bytes: ArrayBuffer): Promise<PdfInfo> {
		// Concurrency gate.
		if (this.inFlight >= this.maxConcurrent) {
			await new Promise<void>((r) => this.queue.push(r));
		}
		this.inFlight++;
		const worker = this.ensureWorker();
		if (!worker) {
			this.release();
			return analyzePdf(bytes);
		}

		const id = this.nextId++;
		try {
			// Clone (no transfer) so the caller can keep using the buffer afterwards.
			return await new Promise<PdfInfo>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				worker.postMessage({ id, bytes });
			});
		} catch (e) {
			console.warn(`${LOG} Off-thread analyze failed — using sync fallback:`, e);
			this.pending.delete(id);
			this.release();
			return analyzePdf(bytes);
		}
	}

	terminate(): void {
		this.failAll("worker terminated");
		this.worker?.terminate();
		this.worker = null;
		if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
	}
}
