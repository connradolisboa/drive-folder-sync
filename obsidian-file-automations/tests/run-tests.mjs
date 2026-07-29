import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".test-build");
const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";

rmSync(outDir, { recursive: true, force: true });
try {
	execFileSync(tsc, [
		"tests/pure.test.ts",
		"automation/DateResolver.ts",
		"companion/pathTokens.ts",
		"companion/rules.ts",
		"migration/legacy.ts",
		"migration/versionMapping.ts",
		"companion/policies.ts",
		"ai/binary.ts",
		"events/workspaceEvents.ts",
		"types.ts",
		"--module", "commonjs",
		"--target", "es2019",
		"--moduleResolution", "node",
		"--skipLibCheck",
		"--outDir", ".test-build"
	], { cwd: root, stdio: "inherit" });
	execFileSync(process.execPath, ["--test", join(outDir, "tests", "pure.test.js")], {
		cwd: root,
		stdio: "inherit"
	});
} finally {
	rmSync(outDir, { recursive: true, force: true });
}
