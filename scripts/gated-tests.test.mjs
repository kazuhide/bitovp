import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { failureLines, GateFailure } from "./gate-report.mjs";
import {
	auditSkips,
	NATIVE_MEDIA,
	runNativeMedia,
	scriptProblems,
	skipProblems,
	UNEXECUTED,
	WORKER_SCRIPTS,
} from "./gated-tests.mjs";
import { GROUPS } from "./postgres-integration.mjs";

const root = resolve(import.meta.dirname, "..");
const script = join(import.meta.dirname, "gated-tests.mjs");
const total = (groups) =>
	groups.reduce(
		(sum, group) => sum + Object.values(group.files).reduce((a, b) => a + b, 0),
		0,
	);
const paths = (groups) =>
	groups.flatMap((group) =>
		Object.keys(group.files).map((file) => join(group.directory, file)),
	);

// One file of a Vitest JSON report: `statuses` gives each test's status.
const fileResult = (name, statuses) => ({
	name: resolve(root, name),
	status: "passed",
	assertionResults: statuses.map((status, index) => ({
		status,
		fullName: `${name} > test ${index + 1}`,
	})),
});
const reportOf = (files) => {
	const count = (...statuses) =>
		files
			.flatMap((file) => file.assertionResults)
			.filter((result) => statuses.includes(result.status)).length;
	return {
		success: true,
		numTotalTests: files.flatMap((file) => file.assertionResults).length,
		numPassedTests: count("passed"),
		numFailedTests: count("failed"),
		numPendingTests: count("skipped", "pending"),
		numTodoTests: count("todo"),
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		testResults: files,
	};
};
// What a plain run of a workspace reports where nothing that is gated can run.
const plainRun = (workspace, change = (files) => files) =>
	reportOf(
		change([
			fileResult("src/always.test.ts", ["passed", "passed"]),
			...[...GROUPS, ...NATIVE_MEDIA, ...UNEXECUTED]
				.filter((group) => group.workspace === workspace)
				.flatMap((group) =>
					Object.entries(group.files).map(([file, tests]) =>
						fileResult(
							join(group.directory, file),
							Array.from({ length: tests }, () => "skipped"),
						),
					),
				),
		]),
	);

test("every listed file exists once, and every FFmpeg or script test file is listed", () => {
	const listed = paths([...GROUPS, ...NATIVE_MEDIA, ...UNEXECUTED]);
	assert.equal(new Set(listed).size, listed.length);
	for (const file of [
		...listed,
		...WORKER_SCRIPTS.files.map((file) => join(WORKER_SCRIPTS.directory, file)),
	])
		assert(existsSync(resolve(root, file)), `${file} is missing`);

	const found = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (/[.-]ffmpeg\.test\.ts$/.test(entry.name))
				found.push(relative(root, path));
		}
	};
	for (const source of ["packages", "apps"])
		for (const entry of readdirSync(resolve(root, source)))
			if (existsSync(resolve(root, source, entry, "src")))
				visit(resolve(root, source, entry, "src"));
	assert.deepEqual(found.sort(), paths(NATIVE_MEDIA).sort());
	assert.deepEqual(
		readdirSync(resolve(root, WORKER_SCRIPTS.directory, "scripts"))
			.filter((name) => name.endsWith(".test.mjs"))
			.sort(),
		WORKER_SCRIPTS.files.map((file) => file.slice("scripts/".length)).sort(),
	);
	// A changed count is a decision: it moves a test into or out of a job.
	assert.equal(total(NATIVE_MEDIA), 19);
	assert.equal(WORKER_SCRIPTS.tests, 43);
	assert.equal(total(UNEXECUTED), 12);
});

test("a plain run may skip the tests that another job runs or that are listed as run by no job", () => {
	for (const [workspace, skipped, unexecuted] of [
		["@bitovp/core", 11, 0],
		["@bitovp/db", 70, 0],
		["@bitovp/worker", 67, 3],
		["@bitovp/web", 81, 9],
	])
		assert.deepEqual(skipProblems(plainRun(workspace), workspace, root), {
			problems: [],
			skipped,
			unexecuted,
		});
	// A gated test that ran here after all is no problem.
	const ran = plainRun("@bitovp/core", (files) =>
		files.map((file) => ({
			...file,
			assertionResults: file.assertionResults.map((result) => ({
				...result,
				status: "passed",
			})),
		})),
	);
	assert.deepEqual(skipProblems(ran, "@bitovp/core", root), {
		problems: [],
		skipped: 0,
		unexecuted: 0,
	});
	assert.deepEqual(
		skipProblems(
			reportOf([fileResult("packages/storage/src/a.test.ts", ["passed"])]),
			"@bitovp/storage",
			root,
		),
		{ problems: [], skipped: 0, unexecuted: 0 },
	);
});

test("a skipped test that no other job runs is named", () => {
	const gated = join(
		NATIVE_MEDIA[0].directory,
		Object.keys(NATIVE_MEDIA[0].files)[0],
	);
	for (const [change, expected] of [
		[
			(files) => [
				...files,
				fileResult("packages/core/src/new.test.ts", ["passed", "skipped"]),
			],
			[
				"packages/core/src/new.test.ts: 1 tests skipped, none may be",
				'"skipped": packages/core/src/new.test.ts > test 2',
			],
		],
		[
			(files) => [
				...files,
				fileResult("packages/core/src/new.test.ts", ["pending"]),
			],
			[
				"packages/core/src/new.test.ts: 1 tests skipped, none may be",
				'"pending": packages/core/src/new.test.ts > test 1',
			],
		],
		// A test added to a gated file is not yet counted by the job that runs it.
		[
			(files) =>
				files.map((file) =>
					file.name === resolve(root, gated)
						? fileResult(
								gated,
								Array.from({ length: 12 }, () => "skipped"),
							)
						: file,
				),
			[
				`${gated}: 12 tests skipped, 11 may be (the native media job runs them)`,
				...Array.from(
					{ length: 12 },
					(_, index) => `"skipped": ${gated} > test ${index + 1}`,
				),
			],
		],
		[
			(files) => [
				...files,
				fileResult("packages/core/src/later.test.ts", ["todo"]),
			],
			[
				"packages/core/src/later.test.ts: 1 tests skipped, none may be",
				'"todo": packages/core/src/later.test.ts > test 1',
				"todo tests: 1, required 0",
			],
		],
		// A listed file that left the run would keep its allowance for ever.
		[
			(files) => files.filter((file) => file.name !== resolve(root, gated)),
			[`${gated}: listed as skipped by this run but not part of it`],
		],
	])
		assert.deepEqual(
			skipProblems(plainRun("@bitovp/core", change), "@bitovp/core", root)
				.problems,
			expected,
		);

	// The totals must agree with the tests the report lists.
	const hidden = plainRun("@bitovp/core");
	hidden.numPendingTests += 1;
	assert.deepEqual(skipProblems(hidden, "@bitovp/core", root).problems, [
		"the report counts 12 skipped tests but lists 11",
	]);
	for (const empty of [undefined, {}, { testResults: [] }, { testResults: 1 }])
		assert.deepEqual(skipProblems(empty, "@bitovp/core", root).problems, [
			"the report lists no test files",
		]);
	// Another workspace's allowance does not apply.
	assert.equal(
		skipProblems(plainRun("@bitovp/core"), "@bitovp/db", root).problems[0],
		`${gated}: 11 tests skipped, none may be`,
	);
});

const totals = (change = {}) =>
	`media fixture totals: ${JSON.stringify({
		tests: 43,
		failed: 0,
		passed: 43,
		cancelled: 0,
		skipped: 0,
		todo: 0,
		emptyFiles: 0,
		...change,
	})}\n`;

test("the worker script tests must report their totals once, all passed", () => {
	assert.deepEqual(scriptProblems(`✔ a test\n${totals()}`), []);
	for (const [log, expected] of [
		["✔ a test\n", ["totals reported 0 times, required once"]],
		[totals() + totals(), ["totals reported 2 times, required once"]],
		["media fixture totals: {\n", ["the totals are unreadable"]],
		[
			"media fixture totals: null\n",
			[
				"tests: undefined, required 43",
				"passed: undefined, required 43",
				"failed: undefined, required 0",
				"cancelled: undefined, required 0",
				"skipped: undefined, required 0",
				"todo: undefined, required 0",
				"emptyFiles: undefined, required 0",
			],
		],
		[
			totals({ passed: 40, skipped: 3 }),
			["passed: 40, required 43", "skipped: 3, required 0"],
		],
		[
			totals({ tests: 44, passed: 44 }),
			["tests: 44, required 43", "passed: 44, required 43"],
		],
		[
			totals({ failed: 1, passed: 42 }),
			["passed: 42, required 43", "failed: 1, required 0"],
		],
		[totals({ cancelled: 1 }), ["cancelled: 1, required 0"]],
		[totals({ todo: 1 }), ["todo: 1, required 0"]],
		[totals({ emptyFiles: 1 }), ["emptyFiles: 1, required 0"]],
		[totals({ emptyFiles: undefined }), ["emptyFiles: undefined, required 0"]],
		// A line that only contains the marker later is not the reporter's.
		[`note media fixture totals: {}\n${totals()}`, []],
	])
		assert.deepEqual(scriptProblems(log), expected);
});

// A stand-in for the commands of a native media run. `vitest` gives the
// report of a group and `scripts` the diagnostics of the worker script run.
async function nativeRun({
	vitest = (group) =>
		reportOf(
			Object.entries(group.files).map(([file, tests]) =>
				fileResult(
					join(group.directory, file),
					Array.from({ length: tests }, () => "passed"),
				),
			),
		),
	scripts = () => totals(),
	env = {},
} = {}) {
	const calls = [];
	const notes = [];
	let scratch;
	const execute = async (binary, args, options) => {
		calls.push({ binary, args, options });
		if (binary === "pnpm") {
			const output = args.at(-1).slice("--outputFile=".length);
			scratch = dirname(output);
			const report = await vitest(
				NATIVE_MEDIA.find((group) => group.workspace === args[1]),
			);
			if (report !== undefined) writeFileSync(output, JSON.stringify(report));
			return "";
		}
		options.diagnostics(await scripts());
		return "";
	};
	let lines;
	try {
		await runNativeMedia(
			{ root, env, notify: (note) => notes.push(note) },
			execute,
		);
	} catch (error) {
		lines = failureLines(error);
	}
	return { calls, notes, lines, scratch };
}

test("a native media run passes only when every listed test ran and passed", async () => {
	const passed = await nativeRun({
		env: {
			PATH: "/tools/bin",
			VMAF_MODEL_DIR: "/tools/model",
			FFMPEG_PATH: "/tools/bin/ffmpeg",
			GITHUB_TOKEN: "not for a child",
		},
	});
	assert.equal(passed.lines, undefined);
	assert.deepEqual(passed.notes, [
		"@bitovp/core: 11 tests that need FFmpeg passed, 0 skipped",
		"@bitovp/worker: 8 tests that need FFmpeg passed, 0 skipped",
		"Worker scripts: 43 tests in 3 files passed, 0 skipped",
	]);
	assert.deepEqual(
		passed.calls.map(({ binary, args }) => [binary, ...args.slice(0, 5)]),
		[
			["pnpm", "--filter", "@bitovp/core", "exec", "vitest", "run"],
			["pnpm", "--filter", "@bitovp/worker", "exec", "vitest", "run"],
			[
				process.execPath,
				"--test",
				"--test-reporter=spec",
				"--test-reporter-destination=stderr",
				passed.calls[2].args[3],
				"--test-reporter-destination=stderr",
			],
		],
	);
	assert.match(
		passed.calls[2].args[3],
		/\/scripts\/media-smoke-reporter\.mjs$/,
	);
	assert.deepEqual(passed.calls[2].args.slice(5), WORKER_SCRIPTS.files);
	assert.equal(passed.calls[2].options.cwd, resolve(root, "apps/worker"));
	for (const { options } of passed.calls) {
		assert.deepEqual(options.env, {
			PATH: "/tools/bin",
			CI: "1",
			TURBO_TELEMETRY_DISABLED: "1",
			NEXT_TELEMETRY_DISABLED: "1",
			VMAF_MODEL_DIR: "/tools/model",
			FFMPEG_PATH: "/tools/bin/ffmpeg",
		});
	}
	// The reports are private scratch and do not outlive the run.
	assert.equal(existsSync(passed.scratch), false);

	const [core, worker] = NATIVE_MEDIA;
	const skipOne = (group) =>
		reportOf(
			Object.entries(group.files).map(([file, tests], index) =>
				fileResult(
					join(group.directory, file),
					Array.from({ length: tests }, (_, at) =>
						index === 0 && at === 0 ? "skipped" : "passed",
					),
				),
			),
		);
	const first = (group) => join(group.directory, Object.keys(group.files)[0]);
	for (const [change, expected] of [
		[
			{ vitest: skipOne },
			[
				"Step: running @bitovp/core tests that need FFmpeg",
				"Reason: Native media tests must all run and pass",
				"  - skipped tests: 1, required 0",
				"  - tests passed: 10, required 11",
				"  - src/vmaf/command.ffmpeg.test.ts: 10 of 11 tests passed, 11 required",
				`  - "skipped": ${first(core)} > test 1`,
			],
		],
		[
			{ vitest: (group) => (group === worker ? skipOne(group) : undefined) },
			[
				"Step: running @bitovp/core tests that need FFmpeg",
				"Reason: Vitest did not write a readable report",
			],
		],
		[
			{
				vitest: (group) => {
					if (group === worker)
						throw new GateFailure("Media validation command failed", {
							diagnostics: "ffmpeg: not found\n",
						});
					return reportOf(
						Object.entries(group.files).map(([file, tests]) =>
							fileResult(
								join(group.directory, file),
								Array.from({ length: tests }, () => "passed"),
							),
						),
					);
				},
			},
			[
				"Step: running @bitovp/worker tests that need FFmpeg",
				"Reason: Media validation command failed",
				"Last 1 lines of the failed command:",
				"  | ffmpeg: not found",
			],
		],
		[
			{ vitest: () => Promise.reject() },
			[
				"Step: running @bitovp/core tests that need FFmpeg",
				"Reason: A step failed without an error",
			],
		],
		[
			{ scripts: () => totals({ passed: 40, skipped: 3 }) },
			[
				"Step: running the worker script tests",
				"Reason: Worker script tests must all run and pass",
				"  - passed: 40, required 43",
				"  - skipped: 3, required 0",
			],
		],
		[
			{ scripts: () => "✔ a test\n" },
			[
				"Step: running the worker script tests",
				"Reason: Worker script tests must all run and pass",
				"  - totals reported 0 times, required once",
			],
		],
		[
			{
				scripts: () => {
					throw new GateFailure("Media validation command failed", {
						details: ["The command was stopped at its 900 second limit"],
					});
				},
			},
			[
				"Step: running the worker script tests",
				"Reason: Media validation command failed",
				"  - The command was stopped at its 900 second limit",
			],
		],
		[
			{ scripts: () => Promise.reject() },
			[
				"Step: running the worker script tests",
				"Reason: A step failed without an error",
			],
		],
	]) {
		const { lines, scratch } = await nativeRun(change);
		assert.deepEqual(lines?.slice(0, expected.length), expected);
		assert.equal(existsSync(scratch), false);
	}
});

test("a failed command is not excused by a complete report or by complete totals", async () => {
	// The report or the totals are complete, and the command still failed.
	const calls = [];
	const failing = (at) => async (binary, args, options) => {
		calls.push(binary);
		if (binary === "pnpm") {
			const group = NATIVE_MEDIA.find((group) => group.workspace === args[1]);
			writeFileSync(
				args.at(-1).slice("--outputFile=".length),
				JSON.stringify(
					reportOf(
						Object.entries(group.files).map(([file, tests]) =>
							fileResult(
								join(group.directory, file),
								Array.from({ length: tests }, () => "passed"),
							),
						),
					),
				),
			);
		} else options.diagnostics(totals());
		if (calls.length === at)
			throw new GateFailure("Media validation command failed");
		return "";
	};
	for (const [at, step] of [
		[1, "Step: running @bitovp/core tests that need FFmpeg"],
		[3, "Step: running the worker script tests"],
	]) {
		calls.length = 0;
		await assert.rejects(
			runNativeMedia({ root, env: {}, notify: () => {} }, failing(at)),
			(error) => {
				assert.deepEqual(failureLines(error), [
					step,
					"Reason: Media validation command failed",
				]);
				return true;
			},
		);
		assert.equal(calls.length, at);
	}
});

test("the command reports through its exit status", () => {
	const directory = mkdtempSync(join(tmpdir(), "gated-tests-cli-"));
	try {
		const run = (...args) =>
			spawnSync(process.execPath, [script, ...args], {
				encoding: "utf8",
				env: { PATH: process.env.PATH },
			});
		const write = (name, report) => {
			const path = join(directory, name);
			writeFileSync(path, JSON.stringify(report));
			return path;
		};
		const clean = run(
			"--audit",
			"@bitovp/core",
			write("clean.json", plainRun("@bitovp/core")),
		);
		assert.equal(clean.status, 0, clean.stderr);
		assert.equal(
			clean.stdout,
			"@bitovp/core: 11 tests skipped by the plain run; 11 run in another job, 0 are listed as run by no job\n",
		);
		const debt = run(
			"--audit",
			"@bitovp/web",
			write("web.json", plainRun("@bitovp/web")),
		);
		assert.equal(debt.status, 0, debt.stderr);
		assert.equal(
			debt.stdout,
			"@bitovp/web: 81 tests skipped by the plain run; 72 run in another job, 9 are listed as run by no job\n",
		);

		const hiding = run(
			"--audit",
			"@bitovp/storage",
			write(
				"hiding.json",
				reportOf([
					fileResult("packages/storage/src/a.test.ts", ["passed", "skipped"]),
				]),
			),
		);
		assert.equal(hiding.status, 1);
		assert.equal(hiding.stdout, "");
		assert.equal(
			hiding.stderr,
			[
				"Gated tests failed; a required test did not run and pass.",
				"Reason: A plain test run may skip only tests that another job runs",
				"  - packages/storage/src/a.test.ts: 1 tests skipped, none may be",
				'  - "skipped": packages/storage/src/a.test.ts > test 2',
				"",
			].join("\n"),
		);
		for (const [args, reason] of [
			[
				["--audit", "@bitovp/core", join(directory, "absent.json")],
				"Reason: The Vitest JSON report is missing or unreadable",
			],
			[
				["--audit", "core", join(directory, "clean.json")],
				"Reason: A workspace name is required",
			],
			[
				[],
				"Reason: Usage: gated-tests.mjs --native-media | --audit <workspace> <Vitest JSON report>",
			],
			[
				["--audit", "@bitovp/core"],
				"Reason: Usage: gated-tests.mjs --native-media | --audit <workspace> <Vitest JSON report>",
			],
			[
				["--native-media", "extra"],
				"Reason: Usage: gated-tests.mjs --native-media | --audit <workspace> <Vitest JSON report>",
			],
		]) {
			const result = run(...args);
			assert.equal(result.status, 1);
			assert.equal(result.stderr.split("\n")[1], reason);
		}
		assert.throws(
			() => auditSkips("@bitovp/core", join(directory, "absent.json")),
			GateFailure,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("CI audits every package's skipped tests and runs the native media tests with the image's tools", () => {
	const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
	const job = (name) => {
		const start = ci.indexOf(`\n  ${name}:\n`);
		assert.notEqual(start, -1, `${name} job is missing`);
		const end = ci.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
		return end === -1 ? ci.slice(start) : ci.slice(start, start + 1 + end);
	};
	const tests = job("tests");
	assert.match(tests, /package: \[core, db, storage, worker, web\]/);
	const report = '"\\$RUNNER_TEMP/vitest-report.json"';
	assert.match(
		tests,
		new RegExp(
			`run: pnpm --filter @bitovp/\\$\\{\\{ matrix\\.package \\}\\} test --maxWorkers=2 --reporter=default --reporter=github-actions --reporter=json --outputFile\\.json=${report}\\n` +
				"      - name: Require every skipped test to run in another job\\n" +
				`        run: pnpm test:skip-audit "@bitovp/\\$\\{\\{ matrix\\.package \\}\\}" ${report}\\n`,
		),
	);
	const native = job("native-media");
	const order = [
		"run: pnpm install --frozen-lockfile",
		"run: pnpm test:gated-runner",
		'sh scripts/native-media-tools.sh "$RUNNER_TEMP/native-media"',
		`printf '%s\\n' "$RUNNER_TEMP/native-media/bin" >> "$GITHUB_PATH"`,
		`printf 'VMAF_MODEL_DIR=%s\\n' "$RUNNER_TEMP/native-media/model" >> "$GITHUB_ENV"`,
		"run: pnpm test:native-media",
	].map((text) => native.indexOf(text));
	assert(
		order.every((at) => at !== -1),
		JSON.stringify(order),
	);
	assert.deepEqual(
		order,
		[...order].sort((a, b) => a - b),
	);
	// The job must not start on a condition that could skip it.
	assert.doesNotMatch(native, /\n {4}if:|continue-on-error/);

	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	assert.equal(
		pkg.scripts["test:native-media"],
		"node scripts/gated-tests.mjs --native-media",
	);
	assert.equal(
		pkg.scripts["test:skip-audit"],
		"node scripts/gated-tests.mjs --audit",
	);
	assert.equal(
		pkg.scripts["test:gated-runner"],
		"node --test scripts/gated-tests.test.mjs",
	);
});
