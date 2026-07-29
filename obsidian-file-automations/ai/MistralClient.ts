import { requestUrl } from "obsidian";
import { arrayBufferToBase64 } from "./binary";

const OCR_API = "https://api.mistral.ai/v1/ocr";
const LOG = "[FileAutomations/Mistral]";

export class MistralClient {
	constructor(private apiKey: string) {}

	async transcribePdf(pdfBytes: ArrayBuffer): Promise<string> {
		const sizeKB = Math.round(pdfBytes.byteLength / 1024);
		console.log(`${LOG} Transcribing PDF via Mistral OCR — size: ${sizeKB} KB`);

		const base64Data = arrayBufferToBase64(pdfBytes);

		const response = await requestUrl({
			url: OCR_API,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: "mistral-ocr-latest",
				document: {
					type: "document_url",
					document_url: `data:application/pdf;base64,${base64Data}`,
				},
			}),
		});

		if (response.status !== 200) {
			const errBody =
				typeof response.json?.message === "string"
					? response.json.message
					: response.text.slice(0, 300);
			throw new Error(`Mistral OCR error ${response.status}: ${errBody}`);
		}

		const pages: Array<{ index: number; markdown: string }> = response.json?.pages ?? [];
		if (pages.length === 0) {
			throw new Error("Mistral OCR returned no pages");
		}

		const text = pages.map((p) => p.markdown).join("\n\n");
		console.log(`${LOG} OCR complete — ${pages.length} pages, ${text.length} chars`);
		return text;
	}

	/**
	 * OCR a PDF and return its text split by page, preserving page boundaries.
	 * Mistral's `index` is 0-based, so the returned `page` is `index + 1` to match
	 * Obsidian/human page numbering (used by `![[file.pdf#page=N]]` embeds).
	 */
	async transcribePdfByPage(pdfBytes: ArrayBuffer): Promise<{ page: number; text: string }[]> {
		const sizeKB = Math.round(pdfBytes.byteLength / 1024);
		console.log(`${LOG} Per-page OCR via Mistral — size: ${sizeKB} KB`);

		const base64Data = arrayBufferToBase64(pdfBytes);

		const response = await requestUrl({
			url: OCR_API,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: "mistral-ocr-latest",
				document: {
					type: "document_url",
					document_url: `data:application/pdf;base64,${base64Data}`,
				},
			}),
		});

		if (response.status !== 200) {
			const errBody =
				typeof response.json?.message === "string"
					? response.json.message
					: response.text.slice(0, 300);
			throw new Error(`Mistral OCR error ${response.status}: ${errBody}`);
		}

		const pages: Array<{ index: number; markdown: string }> = response.json?.pages ?? [];
		if (pages.length === 0) {
			throw new Error("Mistral OCR returned no pages");
		}

		console.log(`${LOG} Per-page OCR complete — ${pages.length} pages`);
		return pages.map((p) => ({ page: p.index + 1, text: p.markdown }));
	}
}
