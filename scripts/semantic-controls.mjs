import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sourceIdentity } from "./feature-verification.mjs";
import { isEntryPoint } from "./gate-report.mjs";
import { command } from "./media-smoke.mjs";
import { childEnvironment, reportProblems } from "./postgres-integration.mjs";
import { CONTROLS } from "./semantic-controls-registry.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const digest = (bytes) =>
	createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error(code), { code });
const require = (condition, code) => {
	if (!condition) throw failure(code);
};

export function mutate(control, source) {
	require(source.split(control.anchor).length === 2, "SOURCE_ANCHOR_MISMATCH");
	require(control.anchor !== control.replacement, "EMPTY_MUTATION");
	return source.replace(control.anchor, control.replacement);
}

/** Vitest's JSON reporter does not retain unhandled or collection errors. */
export default class SemanticControlReporter {
	onTestRunEnd(modules, unhandledErrors, reason) {
		const path = process.env.BITOVP_SEMANTIC_REPORT;
		assert(path && isAbsolute(path));
		writeFileSync(
			path,
			JSON.stringify({
				reason,
				unhandled: unhandledErrors.length,
				collectionErrors: modules.reduce(
					(count, module) =>
						count +
						module.errors().length +
						[...module.children.allSuites()].reduce(
							(sum, suite) => sum + suite.errors().length,
							0,
						),
					0,
				),
			}),
			{ flag: "wx", mode: 0o600 },
		);
	}
}

export function assess(control, report, code, stage, checkout, meta) {
	const mutant = stage === "mutant";
	require(meta?.unhandled === 0 &&
		meta?.collectionErrors === 0, "NON_BEHAVIOR_FAILURE");
	if (mutant && code === 0 && report?.success === true)
		throw failure("MUTATION_NOT_DETECTED");
	require(meta.reason ===
		(mutant ? "failed" : "passed"), "RUN_REASON_MISMATCH");
	require(Array.isArray(report?.testResults), "REPORT_INVALID");
	const names = report.testResults.flatMap((suite) => {
		require(Array.isArray(suite.assertionResults), "REPORT_INVALID");
		require(suite.message === "", "NON_BEHAVIOR_FAILURE");
		return suite.assertionResults.map((entry) => entry.fullName);
	});
	require(JSON.stringify([...names].sort()) ===
		JSON.stringify([...control.cases].sort()), "TEST_INVENTORY_CHANGED");
	if (!mutant) {
		require(code === 0 &&
			reportProblems(report, control, checkout, "semantic").length ===
				0, "BASELINE_FAILURE");
		return;
	}
	const expected = control.failures;
	const failures = Object.keys(expected).length;
	const total = control.cases.length;
	require(code === 1 && report.success === false, "COMMAND_FAILED");
	for (const [key, value] of Object.entries({
		numTotalTests: total,
		numFailedTests: failures,
		numPassedTests: total - failures,
		numPendingTests: 0,
		numTodoTests: 0,
		numPendingTestSuites: 0,
	}))
		require(report[key] === value, "UNEXPECTED_FAILURE");
	require(report.numFailedTestSuites > 0, "REPORT_INVALID");
	require(report.testResults.length === 1, "TEST_INVENTORY_CHANGED");
	const [suite] = report.testResults;
	require(suite.name ===
		join(checkout, control.directory, Object.keys(control.files)[0]) &&
		suite.status === "failed", "TEST_INVENTORY_CHANGED");
	for (const entry of suite.assertionResults) {
		const message = expected[entry.fullName];
		require(entry.status ===
			(message ? "failed" : "passed"), "UNEXPECTED_FAILURE");
		require(Array.isArray(entry.failureMessages) &&
			entry.failureMessages.length ===
				(message ? 1 : 0), "NON_BEHAVIOR_FAILURE");
		if (message) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Vitest decorates assertion messages with ANSI escapes.
			const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
			const first = entry.failureMessages[0].split("\n")[0].replace(ansi, "");
			require(first === message, "UNEXPECTED_FAILURE");
		}
	}
}

/** Shared with the PostgreSQL control: baseline first, immutable tests, exact restoration. */
export async function qualifyMutation({
	target,
	tests,
	mutate: change,
	run,
	assess: check,
	signal,
}) {
	const original = readFileSync(target, "utf8");
	const changed = change(original);
	const testHashes = tests.map((path) => digest(readFileSync(path)));
	const stages = [];
	async function stage(name, source) {
		const identity = () => {
			require(digest(readFileSync(target)) ===
				digest(source), "SOURCE_CHANGED");
			for (const [index, path] of tests.entries())
				require(digest(readFileSync(path)) ===
					testHashes[index], "TESTS_CHANGED");
		};
		signal?.throwIfAborted();
		identity();
		const started = performance.now();
		let result;
		try {
			result = await run(name);
			signal?.throwIfAborted();
			await check(result, name);
			identity();
		} catch (error) {
			error.stage = name;
			throw error;
		}
		stages.push({
			name,
			sourceSha256: digest(source),
			reportSha256: result.reportSha256,
			exitCode: Number(result.code),
			passed: result.report.numPassedTests,
			failed: result.report.numFailedTests,
			elapsedMs: Math.round(performance.now() - started),
		});
	}
	await stage("baseline", original);
	let problem;
	try {
		signal?.throwIfAborted();
		writeFileSync(target, changed);
		await stage("mutant", changed);
	} catch (error) {
		problem = error;
	} finally {
		try {
			writeFileSync(target, original);
			require(digest(readFileSync(target)) ===
				digest(original), "RESTORATION_FAILED");
		} catch (error) {
			problem = Object.assign(failure("RESTORATION_FAILED"), {
				cause: problem ?? error,
			});
		}
	}
	if (problem) throw problem;
	await stage("restored", original);
	return { testSha256: testHashes, stages };
}

/** The child and Vitest share one group; parent death kills that entire group. */
export const OWNER_GUARD = `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [owner, output, binary, ...args] = process.argv.slice(1);
function identity() {
  try {
    if (process.platform !== 'linux') { process.kill(Number(owner), 0); return 'alive'; }
    const stat = readFileSync('/proc/' + owner + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch { return null; }
}
const original = identity();
if (!original) process.exit(2);
const monitor = setInterval(() => {
  if (identity() !== original) process.kill(-process.pid, 'SIGKILL');
}, 50);
const child = spawn(binary, args, { stdio: 'inherit', detached: false });
child.once('error', () => { clearInterval(monitor); process.exitCode = 2; });
child.once('close', (code, signal) => {
  clearInterval(monitor);
  writeFileSync(output, JSON.stringify({ code, signal }), { flag: 'wx', mode: 0o600 });
});
`;

export function groupExists(pid) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

export async function guardedCommand(binary, args, options) {
	let pid;
	let problem;
	try {
		await command(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				OWNER_GUARD,
				String(process.pid),
				options.exitPath,
				binary,
				...args,
			],
			{
				...options,
				capture: false,
				onSpawn: (owned) => {
					pid = owned;
					options.onSpawn?.(owned);
				},
			},
		);
	} catch (error) {
		problem = error.details?.some((detail) => /second limit/.test(detail))
			? Object.assign(failure("COMMAND_TIMEOUT"), { cause: error })
			: error;
	} finally {
		try {
			if (pid && groupExists(pid)) {
				process.kill(-pid, "SIGKILL");
				const limit = Date.now() + 1000;
				while (groupExists(pid) && Date.now() < limit)
					await new Promise((resolve) => setTimeout(resolve, 20));
				problem = Object.assign(failure("PROCESS_GROUP_REMAINED"), {
					cause: problem,
				});
				if (groupExists(pid)) problem = failure("PROCESS_CLEANUP_FAILED");
			}
		} catch (error) {
			problem = Object.assign(failure("PROCESS_CLEANUP_FAILED"), {
				cause: problem ?? error,
			});
		}
	}
	if (problem) throw problem;
	const result = JSON.parse(readFileSync(options.exitPath));
	require(result.signal === null, "COMMAND_SIGNALLED");
	return result.code;
}

export async function runStage(root, control, stage, scratch, signal) {
	const reportPath = join(scratch, `${control.id}-${stage}.json`);
	const metaPath = `${reportPath}.meta`;
	const code = await guardedCommand(
		process.execPath,
		[
			join(root, control.directory, "node_modules/vitest/vitest.mjs"),
			"run",
			...Object.keys(control.files),
			"--maxWorkers=2",
			"--allowOnly=false",
			"--reporter=json",
			`--reporter=${join(ROOT, "scripts/semantic-controls.mjs")}`,
			`--outputFile=${reportPath}`,
		],
		{
			cwd: join(root, control.directory),
			env: {
				...childEnvironment(process.env),
				COREPACK_ENABLE_NETWORK: "0",
				BITOVP_SEMANTIC_REPORT: metaPath,
				TMPDIR: scratch,
				TMP: scratch,
				TEMP: scratch,
			},
			timeout: control.timeoutMs,
			signal,
			exitPath: `${reportPath}.exit`,
		},
	);
	require(existsSync(reportPath) && existsSync(metaPath), "REPORT_MISSING");
	const bytes = readFileSync(reportPath);
	return {
		report: JSON.parse(bytes),
		code,
		reportSha256: digest(bytes),
		meta: JSON.parse(readFileSync(metaPath)),
	};
}

export async function main(args, signal) {
	const [flag, output, ...extra] = args;
	require(flag === "--output" &&
		isAbsolute(output ?? "") &&
		extra.length === 0, "INVALID_ARGUMENTS");
	require(process.platform === "linux" &&
		process.env.GITHUB_ACTIONS === "true" &&
		process.env.RUNNER_ENVIRONMENT ===
			"github-hosted", "OWNED_HOSTED_CHECKOUT_REQUIRED");
	require(realpathSync(process.env.GITHUB_WORKSPACE) ===
		ROOT, "WORKSPACE_MISMATCH");
	require(realpathSync(dirname(output)) ===
		realpathSync(process.env.RUNNER_TEMP), "OUTPUT_OUTSIDE_RUNNER_TEMP");
	const git = (...argv) =>
		execFileSync("git", argv, { cwd: ROOT, encoding: "utf8" }).trim();
	require(git("status", "--porcelain", "--untracked-files=all") ===
		"", "CLEAN_CHECKOUT_REQUIRED");
	require(git("rev-parse", "HEAD") ===
		process.env.GITHUB_SHA, "SOURCE_IDENTITY_MISMATCH");
	for (const control of CONTROLS)
		git(
			"--literal-pathspecs",
			"ls-files",
			"--error-unmatch",
			"--",
			control.source,
			...Object.keys(control.files).map((file) =>
				join(control.directory, file),
			),
		);
	mkdirSync(output, { mode: 0o700 });
	const scratch = join(output, ".private");
	mkdirSync(scratch, { mode: 0o700 });
	const receipt = {
		schemaVersion: 1,
		status: "incomplete",
		source: sourceIdentity(ROOT),
		registrySha256: digest(
			readFileSync(
				new URL("./semantic-controls-registry.mjs", import.meta.url),
			),
		),
		controls: [],
		cleanup: "pending",
	};
	const save = () => {
		writeFileSync(
			join(output, "summary.pending"),
			`${JSON.stringify(receipt, null, 2)}\n`,
			{ mode: 0o600 },
		);
		renameSync(join(output, "summary.pending"), join(output, "summary.json"));
	};
	save();
	const controller = new AbortController();
	const cancel = () => controller.abort();
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, 180_000);
	try {
		for (const control of CONTROLS) {
			receipt.activeControl = control.id;
			save();
			const result = await qualifyMutation({
				target: join(ROOT, control.source),
				tests: Object.keys(control.files).map((file) =>
					join(ROOT, control.directory, file),
				),
				mutate: (source) => mutate(control, source),
				run: (stage) =>
					runStage(ROOT, control, stage, scratch, controller.signal),
				assess: (result, stage) =>
					assess(control, result.report, result.code, stage, ROOT, result.meta),
				signal: controller.signal,
			});
			receipt.controls.push({
				id: control.id,
				files: control.files,
				detectedBy: Object.keys(control.failures),
				...result,
			});
			save();
		}
		controller.signal.throwIfAborted();
		require(JSON.stringify(sourceIdentity(ROOT)) ===
			JSON.stringify(receipt.source), "SOURCE_CHANGED");
		receipt.status = "passed";
		delete receipt.activeControl;
	} catch (error) {
		receipt.status = "failed";
		receipt.reason = timedOut
			? "TIMEOUT"
			: signal?.aborted
				? "CANCELLED"
				: /^[A-Z_]+$/.test(error.code ?? "")
					? error.code
					: "CONTROL_FAILED";
		if (["baseline", "mutant", "restored"].includes(error.stage))
			receipt.stage = error.stage;
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", cancel);
		try {
			receipt.sourceRestored =
				JSON.stringify(sourceIdentity(ROOT)) === JSON.stringify(receipt.source);
			if (!receipt.sourceRestored) {
				receipt.failureBeforeRestoration = receipt.reason;
				receipt.reason = "SOURCE_CHANGED";
				receipt.status = "failed";
			}
		} catch {
			receipt.sourceRestored = false;
			receipt.reason = "RESTORATION_UNCONFIRMED";
			receipt.status = "failed";
		}
		try {
			rmSync(scratch, { recursive: true, force: true });
			receipt.cleanup = "complete";
		} catch {
			receipt.cleanup = "failed";
			receipt.status = "failed";
			receipt.reason = "CLEANUP_FAILED";
		}
		save();
	}
	return receipt;
}

if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => controller.abort());
	main(process.argv.slice(2), controller.signal)
		.then((receipt) => {
			console.log(JSON.stringify(receipt));
			if (receipt.status !== "passed") process.exitCode = 1;
		})
		.catch(() => {
			console.error("Semantic controls failed validation or cleanup.");
			process.exitCode = 1;
		});
}
