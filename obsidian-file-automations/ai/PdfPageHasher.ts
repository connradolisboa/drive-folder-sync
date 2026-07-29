export interface PdfInfo {
	hash: string;
	pageCount: number;
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractPageCount(bytes: Uint8Array): number {
	const text = new TextDecoder("latin1").decode(bytes);
	const pages = text.match(/\/Type\s*\/Page(?!\s*s)/g);
	if (pages?.length) return pages.length;
	const counts = Array.from(text.matchAll(/\/Count\s+(\d+)/g), (match) => Number(match[1]));
	return counts.length ? Math.max(...counts) : 0;
}

export async function analyzePdf(pdfBytes: ArrayBuffer): Promise<PdfInfo> {
	if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable on this device.");
	const digest = await globalThis.crypto.subtle.digest("SHA-256", pdfBytes);
	return {
		hash: toHex(digest),
		pageCount: extractPageCount(new Uint8Array(pdfBytes))
	};
}
