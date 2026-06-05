/**
 * Resolve {{RootFolder}}, {{folderL1}}, {{folderL2}} … tokens in a path template
 * using the segments of a file's vault path (directory part only).
 *
 * Given vaultFilePath = "Boox/Books/Active/file.pdf":
 *   dirs = ["Boox", "Books", "Active"]
 *   {{RootFolder}} → "Boox"   (dirs[0])
 *   {{folderL1}}   → "Active" (dirs[dirs.length - 1], direct parent)
 *   {{folderL2}}   → "Books"  (dirs[dirs.length - 2])
 *
 * Unrecognised tokens are left as-is so callers can do further substitution.
 */
export function resolveFolderTokens(template: string, vaultFilePath: string): string {
	const parts = vaultFilePath.split("/");
	parts.pop(); // strip filename
	const dirs = parts.filter(Boolean);

	return template.replace(/\{\{([^}]+)\}\}/g, (match, token: string) => {
		if (token === "RootFolder") return dirs[0] ?? "";
		const lm = token.match(/^folderL(\d+)$/);
		if (lm) {
			const level = parseInt(lm[1], 10);
			return dirs[dirs.length - level] ?? "";
		}
		return match; // leave unrecognised tokens as-is
	});
}
