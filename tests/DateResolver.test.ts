import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseContextFromFilename, resolvePageDate } from "../automation/DateResolver";
import { resolveFolderTokens } from "../sync/pathTokens";

test("parseContextFromFilename", () => {
	assert.deepEqual(parseContextFromFilename("July 2026 journal.pdf"), { year: 2026, month: 7 });
	assert.deepEqual(parseContextFromFilename("2026-06.pdf"), { year: 2026, month: 6 });
	assert.deepEqual(parseContextFromFilename("June 2026.pdf"), { year: 2026, month: 6 });
	assert.deepEqual(parseContextFromFilename("notes.pdf"), {});
	// Underscores around the year/month name must still parse.
	assert.deepEqual(parseContextFromFilename("Jan_2025_diary.pdf"), { year: 2025, month: 1 });
	assert.deepEqual(parseContextFromFilename("2026_06_book.pdf"), { year: 2026, month: 6 });
});

const ctx = { year: 2026, month: 7 };

test("resolvePageDate — full date wins, ignoring surrounding words", () => {
	assert.deepEqual(resolvePageDate("Tuesday 2026-06-07 morning", ctx), { date: "2026-06-07", source: "full" });
});

test("resolvePageDate — bare day composed from filename context", () => {
	assert.deepEqual(resolvePageDate("5", ctx), { date: "2026-07-05", source: "composed" });
	assert.deepEqual(resolvePageDate("05 Tuesday", ctx), { date: "2026-07-05", source: "composed" });
});

test("resolvePageDate — day-with-words", () => {
	assert.deepEqual(resolvePageDate("Day 16 entry", ctx), { date: "2026-07-16", source: "composed" });
	assert.deepEqual(resolvePageDate("the 5th", ctx), { date: "2026-07-05", source: "composed" });
});

test("resolvePageDate — month name + day uses context year", () => {
	assert.deepEqual(resolvePageDate("June 5 notes", ctx), { date: "2026-06-05", source: "composed" });
	assert.deepEqual(resolvePageDate("5 June", ctx), { date: "2026-06-05", source: "composed" });
});

test("resolvePageDate — numeric is day-first", () => {
	assert.deepEqual(resolvePageDate("5/6", ctx), { date: "2026-06-05", source: "composed" });
});

test("resolvePageDate — Boox handwriting→text forms (YYYY MM DD dddd / YYYY-MM-DD dddd)", () => {
	// Space-separated full date with trailing weekday (the main Boox output).
	assert.deepEqual(resolvePageDate("2026 06 06 Saturday", {}), { date: "2026-06-06", source: "full" });
	// Hyphenated full date with trailing weekday.
	assert.deepEqual(resolvePageDate("2026-06-06 Saturday", {}), { date: "2026-06-06", source: "full" });
	// Single-digit month/day variants still resolve.
	assert.deepEqual(resolvePageDate("2026 6 6 Sat", {}), { date: "2026-06-06", source: "full" });
	// Dot separator (some exports use it).
	assert.deepEqual(resolvePageDate("2026.06.06", {}), { date: "2026-06-06", source: "full" });
	// An invalid month/day run is rejected (no context here → unresolved, not a wrong date).
	assert.deepEqual(resolvePageDate("2026 99 99 Funday", {}), { date: null, source: "unresolved" });
});

test("resolvePageDate — unresolved cases", () => {
	assert.deepEqual(resolvePageDate("32", ctx), { date: null, source: "unresolved" });
	assert.deepEqual(resolvePageDate("5", {}), { date: null, source: "unresolved" });
	assert.deepEqual(resolvePageDate("hello world", ctx), { date: null, source: "unresolved" });
});

test("resolvePageDate — leap-year validation", () => {
	assert.deepEqual(resolvePageDate("2025-02-29", {}), { date: null, source: "unresolved" });
	assert.deepEqual(resolvePageDate("2024-02-29", {}), { date: "2024-02-29", source: "full" });
});

test("resolveFolderTokens", () => {
	const p = "Boox/Books/Active/file.pdf";
	assert.equal(resolveFolderTokens("{{RootFolder}}/index.md", p), "Boox/index.md");
	assert.equal(resolveFolderTokens("{{folderL1}}/x.md", p), "Active/x.md");
	assert.equal(resolveFolderTokens("{{folderL2}}/x.md", p), "Books/x.md");
	// Unrecognised tokens are left for the caller to substitute.
	assert.equal(resolveFolderTokens("{{title}}.md", "A/file.pdf"), "{{title}}.md");
});
