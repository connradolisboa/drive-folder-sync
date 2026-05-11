import * as crypto from "crypto";

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
export function analyzePdf(pdfBytes: ArrayBuffer): PdfInfo {
	const buf = Buffer.from(pdfBytes);
	const hash = crypto.createHash("sha256").update(buf).digest("hex");
	const pageCount = extractPageCount(buf);
	return { hash, pageCount };
}

function extractPageCount(buf: Buffer): number {
	// Convert binary to latin1 so ASCII PDF tokens are readable without corruption.
	const str = buf.toString("latin1");

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
