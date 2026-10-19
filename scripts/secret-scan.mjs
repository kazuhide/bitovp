import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanner = process.env.GITLEAKS_BIN ?? "gitleaks";
const version = spawnSync(scanner, ["version"], {
	encoding: "utf8",
	timeout: 10_000,
});
if (version.status !== 0 || version.stdout.trim() !== "8.30.1") {
	console.error("Secret scanner 8.30.1 is required; the scan did not run.");
	process.exit(2);
}

const directory = mkdtempSync(join(tmpdir(), "bitovp-secret-scan-"));
let exitCode = 2;
try {
	// Gitleaks also reads the source tree's .gitleaksignore even when another
	// ignore path is supplied. A temporary bare mirror has no such working file.
	const mirror = join(directory, "history.git");
	const clone = spawnSync(
		"git",
		[
			"clone",
			"--mirror",
			"--no-hardlinks",
			"--quiet",
			"--",
			resolve(process.argv[2] ?? root),
			mirror,
		],
		{ encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
	);
	if (clone.status !== 0) throw new Error("Could not isolate public history.");
	const shallow = spawnSync(
		"git",
		["-C", mirror, "rev-parse", "--is-shallow-repository"],
		{ encoding: "utf8", timeout: 10_000 },
	);
	if (shallow.status !== 0 || shallow.stdout.trim() !== "false") {
		throw new Error("Complete public history is required.");
	}
	const report = join(directory, "report.json");
	const result = spawnSync(
		scanner,
		[
			"git",
			"--config",
			join(root, ".gitleaks.toml"),
			"--redact=100",
			"--no-banner",
			"--ignore-gitleaks-allow",
			"--gitleaks-ignore-path",
			directory,
			"--report-format=json",
			"--report-path",
			report,
			"--log-opts=--all",
			"--timeout=120",
			mirror,
		],
		{ encoding: "utf8", timeout: 150_000, maxBuffer: 4 * 1024 * 1024 },
	);
	if (result.status !== 0 && result.status !== 1) {
		throw new Error("Scanner could not complete.");
	}
	chmodSync(report, 0o600);
	const rows = JSON.parse(readFileSync(report, "utf8"));
	if (!Array.isArray(rows)) throw new Error("Invalid scanner report.");
	if (result.status === 0 && rows.length === 0) {
		console.log("Secret scan passed: full public Git history.");
		exitCode = 0;
	} else if (result.status === 1 && rows.length > 0) {
		console.error(
			`Secret scan rejected ${rows.length} finding(s). Values are redacted.`,
		);
		for (const row of rows.slice(0, 20)) {
			const path = String(row.File ?? "unknown")
				.replace(/[\r\n\x00-\x1f\x7f]/g, "?")
				.slice(0, 500);
			const rule = String(row.RuleID ?? "unknown")
				.replace(/[^a-zA-Z0-9_-]/g, "?")
				.slice(0, 100);
			const line = Number.isSafeInteger(row.StartLine) ? row.StartLine : 0;
			console.error(`${path}:${line} (${rule})`);
		}
		exitCode = 1;
	} else {
		throw new Error("Inconsistent scanner result.");
	}
} catch {
	console.error(
		"Secret scanner could not complete. Check its installation, configuration and complete Git history.",
	);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
process.exitCode = exitCode;
