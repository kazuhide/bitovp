#!/usr/bin/env node
/**
 * A test that needs PostgreSQL, FFmpeg or Redis skips itself where that is
 * missing, and a run with skipped tests still passes. Two commands keep such a
 * test from never running:
 *
 *   node scripts/gated-tests.mjs --native-media
 *     Runs the tests that drive real FFmpeg and requires each one to run and
 *     pass. FFmpeg with libvmaf, libx264 and libsvtav1 must be on PATH and
 *     VMAF_MODEL_DIR must hold the models; scripts/native-media-tools.sh
 *     installs the builds that the worker image pins.
 *
 *   node scripts/gated-tests.mjs --audit <workspace> <Vitest JSON report>
 *     Checks a package's plain test run: it may skip only tests that another
 *     job runs, or that UNEXECUTED lists.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	asFailure,
	atStep,
	failureLines,
	GateFailure,
	isEntryPoint,
} from "./gate-report.mjs";
import { command } from "./media-smoke.mjs";
import {
	childEnvironment,
	GROUPS,
	reportProblems,
} from "./postgres-integration.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** Vitest files that drive real FFmpeg, with their number of tests. */
export const NATIVE_MEDIA = [
	{
		workspace: "@bitovp/core",
		directory: "packages/core",
		files: { "src/vmaf/command.ffmpeg.test.ts": 11 },
	},
	{
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/feeder/normalize-ffmpeg.test.ts": 3,
			"src/vmaf/live-capture-ffmpeg.test.ts": 1,
			"src/vmaf/live-loop-period-ffmpeg.test.ts": 1,
			"src/vmaf/live-two-loop-ffmpeg.test.ts": 3,
		},
	},
];

/**
 * The node:test files of the worker's operator scripts, which no package test
 * command collects. Three of their tests score real video with libvmaf.
 */
export const WORKER_SCRIPTS = {
	directory: "apps/worker",
	files: [
		"scripts/download-asr-model.test.mjs",
		"scripts/download-caption-alignment-model.test.mjs",
		"scripts/vmaf-cloud-worker.test.mjs",
	],
	tests: 43,
};

/**
 * Tests that no job runs yet, with the number a plain run skips. Every entry
 * is a debt: give the file a job that runs it, then remove it here.
 */
export const UNEXECUTED = [
	{
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/handlers.redis.integration.test.ts": 1,
			"src/live-capacity.redis.integration.test.ts": 1,
			"src/tenant/redis.integration.test.ts": 1,
		},
	},
	{
		workspace: "@bitovp/web",
		directory: "apps/web",
		files: {
			"src/lib/server/library-scene-search.integration.test.ts": 7,
			"src/lib/server/latest-runs.test.ts": 2,
		},
	},
];

const sum = (files) =>
	Object.values(files).reduce((total, count) => total + count, 0);

/** Which tests a plain run of `workspace` may skip, and where each one runs. */
function allowances(workspace, root) {
	const allowed = new Map();
	for (const [groups, where] of [
		[GROUPS, "the PostgreSQL integration job runs them"],
		[NATIVE_MEDIA, "the native media job runs them"],
		[UNEXECUTED, "listed as run by no job"],
	])
		for (const group of groups)
			if (group.workspace === workspace)
				for (const [file, count] of Object.entries(group.files))
					allowed.set(resolve(root, group.directory, file), {
						count,
						where,
						debt: groups === UNEXECUTED,
					});
	return allowed;
}

/**
 * Why a package's plain test run hides a test: it skipped one that no other
 * job runs. Also counts the skipped tests, and those of them no job runs.
 * Only the report of a run that passed can be checked: a file that failed to
 * load is reported without its tests.
 */
export function skipProblems(report, workspace, root = ROOT) {
	const allowed = allowances(workspace, root);
	const results = Array.isArray(report?.testResults) ? report.testResults : [];
	if (results.length === 0)
		return {
			problems: ["the report lists no test files"],
			skipped: 0,
			unexecuted: 0,
		};
	if (report?.success !== true)
		return {
			problems: [
				"the test run failed; its report cannot show every skipped test",
			],
			skipped: 0,
			unexecuted: 0,
		};
	const problems = [];
	const seen = new Set();
	let skipped = 0;
	let unexecuted = 0;
	for (const result of results) {
		const file = resolve(String(result?.name));
		// Each entry would otherwise get the file's whole allowance.
		if (seen.has(file))
			problems.push(`${relative(root, file)}: reported more than once`);
		seen.add(file);
		const unrun = (
			Array.isArray(result?.assertionResults) ? result.assertionResults : []
		).filter((test) => !["passed", "failed"].includes(test?.status));
		skipped += unrun.length;
		const allowance = allowed.get(file);
		if (allowance?.debt) unexecuted += unrun.length;
		if (unrun.length <= (allowance?.count ?? 0)) continue;
		problems.push(
			`${relative(root, file)}: ${unrun.length} tests skipped, ${allowance ? `${allowance.count} may be (${allowance.where})` : "none may be"}`,
		);
		for (const test of unrun.slice(0, 20))
			problems.push(
				`${JSON.stringify(test?.status)}: ${test?.fullName ?? test?.title ?? "unnamed test"}`,
			);
	}
	// The totals must agree with the tests the report lists one by one.
	const pending = report?.numPendingTests;
	const todo = report?.numTodoTests;
	if (todo !== 0)
		problems.push(`todo tests: ${JSON.stringify(todo)}, required 0`);
	if (pending + todo !== skipped)
		problems.push(
			`the report counts ${JSON.stringify(pending)} skipped tests but lists ${skipped}`,
		);
	for (const file of allowed.keys())
		if (!seen.has(file))
			problems.push(
				`${relative(root, file)}: listed as skipped by this run but not part of it`,
			);
	return { problems, skipped, unexecuted };
}

const TOTALS = "media fixture totals: ";
// One command of the native media run. The three together stay below the CI
// job's 20 minutes, so a command that hangs is reported with its step.
const LIMIT = 300_000;

/** Why the worker script tests did not all run and pass, from the reporter's totals. */
export function scriptProblems(log, required = WORKER_SCRIPTS.tests) {
	const lines = String(log)
		.split(/\r?\n/)
		.filter((line) => line.startsWith(TOTALS));
	if (lines.length !== 1)
		return [`totals reported ${lines.length} times, required once`];
	let totals;
	try {
		totals = JSON.parse(lines[0].slice(TOTALS.length));
	} catch {
		return ["the totals are unreadable"];
	}
	const problems = [];
	for (const [key, count] of [
		["tests", required],
		["passed", required],
		["failed", 0],
		["cancelled", 0],
		["skipped", 0],
		["todo", 0],
		["emptyFiles", 0],
	])
		if (totals?.[key] !== count)
			problems.push(
				`${key}: ${JSON.stringify(totals?.[key])}, required ${count}`,
			);
	return problems;
}

/** Runs every test that drives real FFmpeg; none may fail or be skipped. */
export async function runNativeMedia(
	{ root = ROOT, env = process.env, notify = console.log, signal } = {},
	execute = command,
) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-native-media-"));
	const clean = childEnvironment(env);
	for (const key of ["VMAF_MODEL_DIR", "FFMPEG_PATH", "FFPROBE_PATH"])
		if (env[key]) clean[key] = env[key];
	// Names the part that failed in the final report.
	let step = "starting the native media tests";
	try {
		for (const [index, group] of NATIVE_MEDIA.entries()) {
			step = `running ${group.workspace} tests that need FFmpeg`;
			const output = join(directory, `results-${index}.json`);
			// A rejection without an error is still a failure.
			let failure;
			try {
				await execute(
					"pnpm",
					[
						"--filter",
						group.workspace,
						"exec",
						"vitest",
						"run",
						...Object.keys(group.files),
						"--maxWorkers=2",
						"--reporter=json",
						`--outputFile=${output}`,
					],
					{ cwd: root, env: clean, signal, timeout: LIMIT },
				);
			} catch (error) {
				failure = asFailure(error);
			}
			// Vitest writes its report for a failed run too; it names what failed.
			let report;
			try {
				report = JSON.parse(readFileSync(output, "utf8"));
			} catch {
				throw (
					failure ?? new GateFailure("Vitest did not write a readable report")
				);
			}
			const problems = reportProblems(report, group, root, "native media");
			if (problems.length)
				throw new GateFailure("Native media tests must all run and pass", {
					details: problems,
					diagnostics:
						failure instanceof GateFailure ? failure.diagnostics : "",
				});
			// A complete report does not excuse a command that failed.
			if (failure) throw failure;
			notify(
				`${group.workspace}: ${sum(group.files)} tests that need FFmpeg passed, 0 skipped`,
			);
		}
		step = "running the worker script tests";
		let log = "";
		let failure;
		try {
			await execute(
				process.execPath,
				[
					"--test",
					"--test-reporter=spec",
					"--test-reporter-destination=stderr",
					`--test-reporter=${pathToFileURL(resolve(import.meta.dirname, "media-smoke-reporter.mjs")).href}`,
					"--test-reporter-destination=stderr",
					...WORKER_SCRIPTS.files,
				],
				{
					cwd: resolve(root, WORKER_SCRIPTS.directory),
					env: clean,
					signal,
					timeout: LIMIT,
					diagnostics: (text) => {
						log += text;
					},
				},
			);
		} catch (error) {
			failure = asFailure(error);
		}
		// A command that stopped before it reported totals explains itself.
		if (failure && !log.includes(TOTALS)) throw failure;
		const problems = scriptProblems(log);
		if (problems.length)
			throw new GateFailure("Worker script tests must all run and pass", {
				details: problems,
				diagnostics: failure instanceof GateFailure ? failure.diagnostics : "",
			});
		if (failure) throw failure;
		notify(
			`Worker scripts: ${WORKER_SCRIPTS.tests} tests in ${WORKER_SCRIPTS.files.length} files passed, 0 skipped`,
		);
	} catch (error) {
		throw atStep(asFailure(error), step);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Checks one package's plain test run from its Vitest JSON report. */
export function auditSkips(workspace, reportPath, { root = ROOT } = {}) {
	assert(/^@bitovp\/[a-z-]+$/.test(workspace), "A workspace name is required");
	let report;
	try {
		report = JSON.parse(readFileSync(reportPath, "utf8"));
	} catch {
		throw new GateFailure("The Vitest JSON report is missing or unreadable");
	}
	const { problems, skipped, unexecuted } = skipProblems(
		report,
		workspace,
		root,
	);
	if (problems.length)
		throw new GateFailure(
			"A plain test run may skip only tests that another job runs",
			{ details: problems },
		);
	return `${workspace}: ${skipped} tests skipped by the plain run; ${skipped - unexecuted} run in another job, ${unexecuted} are listed as run by no job`;
}

async function main(signal) {
	const [mode, ...rest] = process.argv.slice(2);
	if (mode === "--native-media" && rest.length === 0)
		return runNativeMedia({ signal });
	if (mode === "--audit" && rest.length === 2)
		return console.log(auditSkips(rest[0], rest[1]));
	throw new GateFailure(
		"Usage: gated-tests.mjs --native-media | --audit <workspace> <Vitest JSON report>",
	);
}

if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			controller.abort();
			process.exitCode = 1;
		});
	main(controller.signal).catch((error) => {
		console.error("Gated tests failed; a required test did not run and pass.");
		for (const line of failureLines(error)) console.error(line);
		process.exitCode = 1;
	});
}
