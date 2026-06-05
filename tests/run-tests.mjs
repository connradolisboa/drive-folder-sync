// Lightweight test runner — no extra npm dependencies.
// Compiles the pure modules + tests with the project's local TypeScript, then runs them
// through Node's built-in test runner. Pure logic only (no Obsidian imports).
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".test-build");
const tsc = join(root, "node_modules", ".bin", "tsc");

rmSync(outDir, { recursive: true, force: true });
try {
	execFileSync(
		tsc,
		[
			"tests/DateResolver.test.ts",
			"automation/DateResolver.ts",
			"sync/pathTokens.ts",
			"--module", "commonjs",
			"--target", "es2019",
			"--moduleResolution", "node",
			"--skipLibCheck",
			"--outDir", ".test-build",
		],
		{ cwd: root, stdio: "inherit" }
	);
	execFileSync(process.execPath, ["--test", join(outDir, "tests", "DateResolver.test.js")], { cwd: root, stdio: "inherit" });
} finally {
	rmSync(outDir, { recursive: true, force: true });
}
