import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMANDS = Object.freeze(
	[
		["pnpm", "install", "--frozen-lockfile"],
		["pnpm", "audit", "--audit-level", "high"],
		["pnpm", "typecheck"],
		["pnpm", "check"],
		["pnpm", "test"],
		["pnpm", "build"],
		["pnpm", "--filter", "@bitovp/worker", "smoke"],
	].map(Object.freeze),
);
const workspaces = [
	"",
	"apps/web",
	"apps/worker",
	"packages/core",
	"packages/db",
	"packages/storage",
];
const inside = (root, path) =>
	path === root ||
	(!relative(root, path).startsWith(`..${sep}`) &&
		relative(root, path) !== ".." &&
		!isAbsolute(relative(root, path)));
const git = (root, ...args) =>
	execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

export function preflight(root, sha) {
	root = realpathSync(root);
	assert(
		lstatSync(resolve(root, ".git")).isDirectory(),
		"Use a standalone checkout, not a linked worktree",
	);
	assert.match(sha, /^[a-f0-9]{40}$/);
	assert.equal(git(root, "rev-parse", "HEAD"), sha, "HEAD mismatch");
	assert.equal(
		git(root, "status", "--porcelain", "--untracked-files=all"),
		"",
		"Use a clean committed checkout",
	);
	for (const workspace of workspaces) {
		const dir = resolve(root, workspace, "node_modules");
		if (!existsSync(dir)) continue;
		const check = (path) =>
			assert(
				inside(root, realpathSync(path)),
				"External linked dependencies are unsupported",
			);
		check(dir);
		for (const entry of readdirSync(dir)) {
			const path = resolve(dir, entry);
			check(path);
			if (entry.startsWith("@"))
				for (const name of readdirSync(path)) check(resolve(path, name));
		}
	}
	return sha;
}

export function childEnvironment(env) {
	const clean = {};
	for (const key of [
		"PATH",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"COREPACK_HOME",
		"PNPM_HOME",
	]) {
		if (env[key]) clean[key] = env[key];
	}
	return { ...clean, CI: "1", TURBO_FORCE: "true" };
}
const digest = (value) => {
	const bytes = Buffer.from(value ?? "");
	return {
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
};

export function runGates(
	{ root, sha, output },
	execute = spawnSync,
	notify = () => {},
) {
	preflight(root, sha);
	assert(isAbsolute(output), "Output must be an absolute path");
	const target = resolve(
		realpathSync(dirname(output)),
		output.split(sep).at(-1),
	);
	assert(
		!inside(realpathSync(root), target),
		"Output must be outside the source checkout",
	);
	mkdirSync(target, { mode: 0o700 });
	const log = resolve(target, "gates.jsonl");
	writeFileSync(log, "", { flag: "wx", mode: 0o600 });
	const report = {
		sha,
		state: "INCOMPLETE",
		gates: [],
		boundary:
			"Local source gates only; not review approval, manual validation, deployment or provider evidence. Raw child output is not retained.",
	};
	const record = (row) => {
		appendFileSync(log, `${JSON.stringify({ sha, ...row })}\n`);
		notify(row);
	};
	for (const command of COMMANDS) {
		try {
			preflight(root, sha);
		} catch {
			report.state = "SOURCE_CHANGED";
			break;
		}
		const start = Date.now();
		record({ event: "started", command, at: new Date(start).toISOString() });
		let result;
		try {
			result = execute(command[0], command.slice(1), {
				cwd: root,
				env: childEnvironment(process.env),
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 30 * 60_000,
				maxBuffer: 32 * 1024 * 1024,
				killSignal: "SIGKILL",
			});
		} catch {
			result = { status: null, error: true };
		}
		const row = {
			event: "finished",
			command,
			at: new Date().toISOString(),
			durationMs: Date.now() - start,
			exitCode: result.status ?? null,
			signal: result.signal ?? null,
			executionError: Boolean(result.error),
			stdout: digest(result.stdout),
			stderr: digest(result.stderr),
		};
		record(row);
		report.gates.push(row);
		if (row.executionError || row.exitCode !== 0 || row.signal) {
			report.state = "FAILED";
			break;
		}
		try {
			preflight(root, sha);
		} catch {
			report.state = "SOURCE_CHANGED";
			break;
		}
	}
	if (report.state === "INCOMPLETE" && report.gates.length === COMMANDS.length)
		report.state = "LOCAL_GATES_PASSED";
	writeFileSync(
		resolve(target, "result.json"),
		`${JSON.stringify(report, null, 2)}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	return report;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	if (process.argv.length === 2)
		console.log(
			"Preparation only. In a clean standalone checkout: node scripts/release-gates.mjs --run --sha <full-HEAD> --output <new-absolute-directory-outside-repo>. No paid/deploy actions.",
		);
	else {
		try {
			const args = process.argv.slice(2);
			assert(
				args.length === 5 &&
					args[0] === "--run" &&
					args[1] === "--sha" &&
					args[3] === "--output",
			);
			const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
			const report = runGates(
				{ root, sha: args[2], output: args[4] },
				(cmd, argv, options) => spawnSync(cmd, argv, options),
				(row) => console.log(JSON.stringify(row)),
			);
			console.log(
				JSON.stringify({
					state: report.state,
					sha: report.sha,
					boundary: report.boundary,
				}),
			);
			if (report.state !== "LOCAL_GATES_PASSED") {
				console.log(
					"Re-run the failed fixed command separately in the isolated checkout for private diagnostics; audit access failure is ENV-BLOCKED, never green.",
				);
				process.exitCode = 1;
			}
		} catch {
			console.error(
				"RELEASE_GATES_REFUSED: verify exact HEAD, clean standalone dependencies and a new outside output directory. No automatic retry.",
			);
			process.exitCode = 1;
		}
	}
}
