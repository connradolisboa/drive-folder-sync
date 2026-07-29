/**
 * Pure date-resolution logic for the page-splitting automation.
 *
 * A multi-page PDF (e.g. a monthly journal) is OCR'd page by page. Each page may
 * carry a full date, a partial date ("June 5"), or just a bare day ("5"). The month
 * and year that a bare day belongs to are inferred from the PDF *filename*
 * (e.g. "July 2026 journal.pdf"). This module has no Obsidian/moment dependency so it
 * can be unit-tested in isolation.
 */

export interface DateContext {
	year?: number;
	month?: number; // 1-12
}

export type DateSource = "full" | "composed" | "unresolved";

export interface ResolvedDate {
	date: string | null; // normalized YYYY-MM-DD, or null when unresolved
	source: DateSource;
}

const MONTH_NAMES: Record<string, number> = {
	jan: 1, january: 1,
	feb: 2, february: 2,
	mar: 3, march: 3,
	apr: 4, april: 4,
	may: 5,
	jun: 6, june: 6,
	jul: 7, july: 7,
	aug: 8, august: 8,
	sep: 9, sept: 9, september: 9,
	oct: 10, october: 10,
	nov: 11, november: 11,
	dec: 12, december: 12,
};

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Validate a y/m/d triple and return a normalized YYYY-MM-DD, or null if invalid. */
function buildDate(year: number, month: number, day: number): string | null {
	if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
	if (!Number.isInteger(month) || month < 1 || month > 12) return null;
	if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
	// Reject Feb 29 in a common year.
	if (month === 2 && day === 29) {
		const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		if (!isLeap) return null;
	}
	return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Parse the month/year context from a PDF filename.
 *
 * Handles: "July 2026 journal.pdf" → {month:7, year:2026};
 *          "2026-06.pdf" / "2026_06.pdf" → {month:6, year:2026};
 *          "June 2026.pdf" → {month:6, year:2026}.
 */
export function parseContextFromFilename(fileName: string): DateContext {
	const stem = fileName.replace(/\.[^/.]+$/, "");
	const ctx: DateContext = {};

	// Year: first 19xx / 20xx token. Digit-boundary lookarounds (not \b) so underscores
	// around the year — e.g. "Jan_2025_diary" — still match.
	const yearMatch = stem.match(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/);
	if (yearMatch) ctx.year = parseInt(yearMatch[1], 10);

	// Month from a numeric YYYY-MM / YYYY_MM pattern (takes precedence — most explicit).
	const numericMonth = stem.match(/(?<!\d)(?:19\d{2}|20\d{2})[-_.](0[1-9]|1[0-2])(?!\d)/);
	if (numericMonth) {
		ctx.month = parseInt(numericMonth[1], 10);
		return ctx;
	}

	// Month from a name/abbreviation anywhere in the stem. Letter-boundary lookarounds (not \b)
	// so digits/underscores act as separators — e.g. "Jan_2025" or "jan2025".
	const wordMatch = stem
		.toLowerCase()
		.match(/(?<![a-z])(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)(?![a-z])/);
	if (wordMatch) ctx.month = MONTH_NAMES[wordMatch[1]];

	return ctx;
}

/**
 * Resolve the date for a single page given its OCR text and the filename context.
 *
 * Ladder:
 *   1. A full YYYY-MM-DD anywhere in the text wins → "full".
 *   2. Otherwise, when month+year context is known, try (in order):
 *        month-name + day → numeric day-first D/M → day-with-words → bare day → "composed".
 *   3. Otherwise → null / "unresolved".
 */
export function resolvePageDate(pageText: string, context: DateContext): ResolvedDate {
	const text = pageText ?? "";

	// 1. Full date — YYYY MM DD with any of -, /, ., or whitespace separators. Covers ISO
	//    (2026-06-06) and the Boox handwriting→text output "2026 06 06 Saturday" /
	//    "2026-06-06 Saturday". Trailing weekday words are ignored. buildDate validates the
	//    triple, so an arbitrary run of numbers that isn't a real date is rejected.
	const full = text.match(/\b(\d{4})[-/.\s](\d{1,2})[-/.\s](\d{1,2})\b/);
	if (full) {
		const date = buildDate(parseInt(full[1], 10), parseInt(full[2], 10), parseInt(full[3], 10));
		if (date) return { date, source: "full" };
	}

	// 2. Composed — requires both month and year context.
	if (context.month && context.year) {
		const composed = composeFromContext(text, context.month, context.year);
		if (composed) return { date: composed, source: "composed" };
	}

	return { date: null, source: "unresolved" };
}

/** Try each partial-date form against the page text. Returns a normalized date or null. */
function composeFromContext(text: string, ctxMonth: number, ctxYear: number): string | null {
	const lower = text.toLowerCase();

	// 2a. Month-name + day, in either order: "June 5", "5 June", "Jun 5", "5th of June".
	const monthAlt =
		"january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
	const nameDay = lower.match(new RegExp(`\\b(${monthAlt})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
	if (nameDay) {
		const d = buildDate(ctxYear, MONTH_NAMES[nameDay[1]], parseInt(nameDay[2], 10));
		if (d) return d;
	}
	const dayName = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})\\b`));
	if (dayName) {
		const d = buildDate(ctxYear, MONTH_NAMES[dayName[2]], parseInt(dayName[1], 10));
		if (d) return d;
	}

	// 2b. Numeric D/M or D-M, day-first ("5/6" = 5 June). Year stays from context.
	const numeric = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})\b/);
	if (numeric) {
		const d = buildDate(ctxYear, parseInt(numeric[2], 10), parseInt(numeric[1], 10));
		if (d) return d;
	}

	// 2c. Day-with-words: "Day 5", "the 5th", "5th".
	const dayWords = lower.match(/\b(?:day\s+|the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
	if (dayWords) {
		const d = buildDate(ctxYear, ctxMonth, parseInt(dayWords[1], 10));
		if (d) return d;
	}
	const dayLabeled = lower.match(/\bday\s+(\d{1,2})\b/);
	if (dayLabeled) {
		const d = buildDate(ctxYear, ctxMonth, parseInt(dayLabeled[1], 10));
		if (d) return d;
	}

	// 2d. Bare day number: first standalone 1-2 digit integer.
	const bare = text.match(/\b(\d{1,2})\b/);
	if (bare) {
		const d = buildDate(ctxYear, ctxMonth, parseInt(bare[1], 10));
		if (d) return d;
	}

	return null;
}
