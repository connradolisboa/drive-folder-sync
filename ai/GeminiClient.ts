import { requestUrl } from "obsidian";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const LOG = "[DriveSync/Gemini]";

export class GeminiClient {
	constructor(
		private apiKey: string,
		private model: string,
		private prompt: string
	) {}

	async transcribePdf(pdfBytes: ArrayBuffer): Promise<string> {
		const sizeKB = Math.round(pdfBytes.byteLength / 1024);
		console.log(`${LOG} Transcribing PDF — size: ${sizeKB} KB, model: ${this.model}`);

		const base64Data = Buffer.from(pdfBytes).toString("base64");

		const response = await requestUrl({
			url: `${API_BASE}/models/${this.model}:generateContent?key=${this.apiKey}`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{ text: this.prompt },
							{
								inline_data: {
									mime_type: "application/pdf",
									data: base64Data,
								},
							},
						],
					},
				],
			}),
		});

		if (response.status !== 200) {
			const errBody =
				typeof response.json?.error?.message === "string"
					? response.json.error.message
					: response.text.slice(0, 200);
			throw new Error(`Gemini API error ${response.status}: ${errBody}`);
		}

		const text: string | undefined =
			response.json?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) {
			throw new Error("Gemini returned no transcription text");
		}

		console.log(`${LOG} Transcription complete — ${text.length} chars`);
		return text;
	}
}
