// Lightweight pure-logic tests: compile only modules that do not import Obsidian,
// then execute them with Node's built-in test runner.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".test-build");
const candidates = [
	join(root, "node_modules", ".bin", "tsc"),
	join(root, "..", "node_modules", ".bin", "tsc"),
];
const tsc = candidates.find(existsSync);

if (!tsc) {
	throw new Error("TypeScript compiler not found in the plugin or repository node_modules.");
}

rmSync(outDir, { recursive: true, force: true });
try {
	execFileSync(
		tsc,
		[
			"tests/migration.test.ts",
			"migration.ts",
			"types.ts",
			"--module", "commonjs",
			"--target", "es2019",
			"--moduleResolution", "node",
			"--strict",
			"--skipLibCheck",
			"--noEmitOnError",
			"--outDir", ".test-build",
		],
		{ cwd: root, stdio: "inherit" },
	);
	execFileSync(
		process.execPath,
		["--test", join(outDir, "tests", "migration.test.js")],
		{ cwd: root, stdio: "inherit" },
	);
} finally {
	rmSync(outDir, { recursive: true, force: true });
}
