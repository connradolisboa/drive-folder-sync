export interface PdfInfo {
	/** SHA-256 hex digest of the full PDF binary. */
	hash: string;
	/** Estimated page count extracted from the PDF structure. 0 if detection fails. */
	pageCount: number;
}

/**
 * Hash the full PDF binary and estimate its page count without an external library.
 * Page count is extracted by scanning for PDF page-object markers in the raw binary.
 * This is a heuristic — accurate for well-formed PDFs, may undercount linearized or
 * encrypted documents.
 */
export async function analyzePdf(pdfBytes: ArrayBuffer): Promise<PdfInfo> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", pdfBytes);
	const hash = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const pageCount = extractPageCount(new Uint8Array(pdfBytes));
	return { hash, pageCount };
}

function extractPageCount(bytes: Uint8Array): number {
	// Convert binary to latin1 so ASCII PDF tokens are readable without corruption.
	const str = new TextDecoder("latin1").decode(bytes);

	// Count /Type /Page entries. The negative lookahead (?!\s*s) prevents
	// matching /Type /Pages (the container dictionary).
	const pageMatches = str.match(/\/Type\s*\/Page(?!\s*s)/g);
	if (pageMatches && pageMatches.length > 0) return pageMatches.length;

	// Fallback: find the largest /Count N in any Pages dictionary.
	// The root Pages dictionary has the total; nested dicts have subtotals.
	const countMatches = [...str.matchAll(/\/Count\s+(\d+)/g)];
	if (countMatches.length > 0) {
		return Math.max(...countMatches.map((m) => parseInt(m[1], 10)));
	}

	return 0;
}
