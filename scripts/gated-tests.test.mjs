import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { atStep, failureLines, GateFailure } from "./gate-report.mjs";
import {
	auditSkips,
	NATIVE_MEDIA,
	REDIS,
	runNativeMedia,
	runRedis,
	scriptProblems,
	skipProblems,
	startRedis,
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
			...[...GROUPS, ...NATIVE_MEDIA, REDIS.queues]
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

test("every listed file exists once, and every FFmpeg, Redis or script test file is listed", () => {
	const listed = paths([
		...GROUPS,
		...NATIVE_MEDIA,
		REDIS.queues,
		REDIS.leases,
	]);
	assert.equal(new Set(listed).size, listed.length);
	for (const file of [
		...listed,
		...WORKER_SCRIPTS.files.map((file) => join(WORKER_SCRIPTS.directory, file)),
	])
		assert(existsSync(resolve(root, file)), `${file} is missing`);

	const found = [];
	const redis = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (/[.-]ffmpeg\.test\.ts$/.test(entry.name))
				found.push(relative(root, path));
			else if (/(?:^|\.)redis\.integration(?:\.test)?\.ts$/.test(entry.name))
				redis.push(relative(root, path));
		}
	};
	for (const source of ["packages", "apps"])
		for (const entry of readdirSync(resolve(root, source)))
			if (existsSync(resolve(root, source, entry, "src")))
				visit(resolve(root, source, entry, "src"));
	assert.deepEqual(found.sort(), paths(NATIVE_MEDIA).sort());
	assert.deepEqual(redis.sort(), paths([REDIS.queues, REDIS.leases]).sort());
	// The lease tests have a configuration of their own, which names only them.
	assert.match(
		readFileSync(
			resolve(root, REDIS.leases.directory, REDIS.leases.config),
			"utf8",
		),
		/\tinclude: \["src\/vmaf\/resource-leases\.redis\.integration\.ts"\],\n/,
	);
	// Each queue test accepts one address; the run must start a server there.
	const addresses = Object.keys(REDIS.queues.files).map((file) => {
		const text = readFileSync(
			resolve(root, REDIS.queues.directory, file),
			"utf8",
		);
		const [, variable] = /process\.env\.([A-Z_]+_TEST_REDIS_URL)\b/.exec(text);
		const [, port] = /"redis:\/\/127\.0\.0\.1:(\d+)"/.exec(text);
		return [variable, Number(port)];
	});
	assert.deepEqual(
		Object.fromEntries(addresses.sort(([, a], [, b]) => a - b)),
		REDIS.servers,
	);
	assert.deepEqual(
		readdirSync(resolve(root, WORKER_SCRIPTS.directory, "scripts"))
			.filter((name) => name.endsWith(".test.mjs"))
			.sort(),
		WORKER_SCRIPTS.files.map((file) => file.slice("scripts/".length)).sort(),
	);
	// A changed count is a decision: it moves a test into or out of a job.
	assert.equal(total(NATIVE_MEDIA), 19);
	assert.equal(WORKER_SCRIPTS.tests, 43);
	assert.equal(total([REDIS.leases]), 29);
	assert.equal(total([REDIS.queues]), 3);
});

test("a plain run may skip the tests that another job runs", () => {
	for (const [workspace, skipped] of [
		["@bitovp/core", 11],
		["@bitovp/db", 70],
		["@bitovp/worker", 67],
		["@bitovp/web", 82],
	])
		assert.deepEqual(skipProblems(plainRun(workspace), workspace, root), {
			problems: [],
			skipped,
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
	});
	assert.deepEqual(
		skipProblems(
			reportOf([fileResult("packages/storage/src/a.test.ts", ["passed"])]),
			"@bitovp/storage",
			root,
		),
		{ problems: [], skipped: 0 },
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
		[` ${totals()}`, ["totals reported 0 times, required once"]],
		[totals({ skipped: "0" }), ['skipped: "0", required 0']],
		[totals({ failed: false }), ["failed: false, required 0"]],
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
	signal,
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
			{ root, env, signal, notify: (note) => notes.push(note) },
			execute,
		);
	} catch (error) {
		lines = failureLines(error);
	}
	return { calls, notes, lines, scratch };
}

test("a native media run passes only when every listed test ran and passed", async () => {
	const controller = new AbortController();
	const passed = await nativeRun({
		signal: controller.signal,
		env: {
			PATH: "/tools/bin",
			VMAF_MODEL_DIR: "/tools/model",
			FFMPEG_PATH: "/tools/bin/ffmpeg",
			FFPROBE_PATH: "/tools/bin/ffprobe",
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
	// Vitest gets exactly the listed files and writes a JSON report of its own.
	for (const [index, group] of NATIVE_MEDIA.entries()) {
		assert.deepEqual(passed.calls[index].args.slice(5), [
			...Object.keys(group.files),
			"--maxWorkers=2",
			"--reporter=json",
			`--outputFile=${join(passed.scratch, `results-${index}.json`)}`,
		]);
		assert.equal(passed.calls[index].options.cwd, root);
		assert.equal(passed.calls[index].options.timeout, 300_000);
	}
	assert.equal(passed.calls[2].options.timeout, 300_000);
	// A cancelled run stops the command that is running.
	for (const { options } of passed.calls)
		assert.equal(options.signal, controller.signal);
	assert.equal(passed.calls[2].options.cwd, resolve(root, "apps/worker"));
	for (const { options } of passed.calls) {
		assert.deepEqual(options.env, {
			PATH: "/tools/bin",
			CI: "1",
			TURBO_TELEMETRY_DISABLED: "1",
			NEXT_TELEMETRY_DISABLED: "1",
			VMAF_MODEL_DIR: "/tools/model",
			FFMPEG_PATH: "/tools/bin/ffmpeg",
			FFPROBE_PATH: "/tools/bin/ffprobe",
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
		[
			{
				vitest: (group) =>
					reportOf([
						...Object.entries(group.files).map(([file, tests]) =>
							fileResult(
								join(group.directory, file),
								Array.from({ length: tests }, () => "passed"),
							),
						),
						fileResult(join(group.directory, "src/other.test.ts"), ["passed"]),
					]),
			},
			[
				"Step: running @bitovp/core tests that need FFmpeg",
				"Reason: Native media tests must all run and pass",
				"  - tests discovered: 12, required 11",
				"  - tests passed: 12, required 11",
				"  - src/other.test.ts: not a required native media test file",
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

test("a failed command with an incomplete report or totals names what is lacking and the end of its output", async () => {
	const failing = (at) => {
		let calls = 0;
		return async (binary, args, options) => {
			calls += 1;
			if (binary === "pnpm") {
				const group = NATIVE_MEDIA.find((group) => group.workspace === args[1]);
				const files = Object.entries(group.files).map(
					([file, tests], position) =>
						fileResult(
							join(group.directory, file),
							Array.from({ length: tests }, (_, index) =>
								calls === at && position === 0 && index === 0
									? "failed"
									: "passed",
							),
						),
				);
				const report = reportOf(files);
				if (calls === at) {
					// What Vitest 4 writes for a run with one failed test.
					files[0].status = "failed";
					report.success = false;
					report.numFailedTestSuites = 1;
				}
				writeFileSync(
					args.at(-1).slice("--outputFile=".length),
					JSON.stringify(report),
				);
			} else
				options.diagnostics(
					calls === at ? totals({ failed: 1, passed: 42 }) : totals(),
				);
			if (calls === at)
				throw new GateFailure("Media validation command failed", {
					diagnostics: "the end of the command's output\n",
				});
			return "";
		};
	};
	const lines = async (at) => {
		try {
			await runNativeMedia({ root, env: {}, notify: () => {} }, failing(at));
		} catch (error) {
			return failureLines(error);
		}
	};
	const output = [
		"Last 1 lines of the failed command:",
		"  | the end of the command's output",
	];
	const [, worker] = NATIVE_MEDIA;
	const file = Object.keys(worker.files)[0];
	assert.deepEqual(await lines(2), [
		"Step: running @bitovp/worker tests that need FFmpeg",
		"Reason: Native media tests must all run and pass",
		"  - Vitest reported a failed run",
		"  - failed tests: 1, required 0",
		"  - failed suites: 1, required 0",
		"  - tests passed: 7, required 8",
		`  - ${file}: 2 of 3 tests passed, 3 required; file status "failed"`,
		`  - "failed": ${join(worker.directory, file)} > test 1`,
		...output,
	]);
	assert.deepEqual(await lines(3), [
		"Step: running the worker script tests",
		"Reason: Worker script tests must all run and pass",
		"  - passed: 42, required 43",
		"  - failed: 1, required 0",
		...output,
	]);
});

test("the audit keeps each allowance to its own file and list, and treats what it does not know as not run", () => {
	const workspace = "@bitovp/worker";
	const audit = (change, edit = () => {}) => {
		const report = plainRun(workspace, change);
		edit(report);
		return skipProblems(report, workspace, root);
	};
	const lists = [
		[GROUPS, "the PostgreSQL integration job runs them"],
		[NATIVE_MEDIA, "the native media job runs them"],
		[[REDIS.queues], "the Redis integration job runs them"],
	].map(([groups, where]) => {
		const group = groups.find((group) => group.workspace === workspace);
		const [file, count] = Object.entries(group.files)[0];
		return { file: join(group.directory, file), count, where };
	});
	for (const { file, count, where } of lists) {
		// A listed file that left the run would keep its allowance for ever.
		assert.deepEqual(
			audit((files) =>
				files.filter((entry) => entry.name !== resolve(root, file)),
			).problems,
			[`${file}: listed as skipped by this run but not part of it`],
		);
		// One skipped test more than its list allows.
		assert.equal(
			audit((files) =>
				files.map((entry) =>
					entry.name === resolve(root, file)
						? fileResult(
								file,
								Array.from({ length: count + 1 }, () => "skipped"),
							)
						: entry,
				),
			).problems[0],
			`${file}: ${count + 1} tests skipped, ${count} may be (${where})`,
		);
		// The allowance belongs to the path, not to the file name.
		const namesake = join("apps/worker/src/zz", file.split("/").at(-1));
		assert.equal(
			audit((files) => [...files, fileResult(namesake, ["skipped"])])
				.problems[0],
			`${namesake}: 1 tests skipped, none may be`,
		);
	}
	// A gated test that ran here after all is not counted as skipped.
	const gated = lists[2];
	assert.deepEqual(
		audit((files) =>
			files.map((entry) =>
				entry.name === resolve(root, gated.file)
					? fileResult(
							gated.file,
							Array.from({ length: gated.count }, () => "passed"),
						)
					: entry,
			),
		),
		{ problems: [], skipped: 67 - gated.count },
	);
	// The report of a failed run is refused: it lacks the tests of a file that
	// did not load.
	for (const success of [false, undefined])
		assert.deepEqual(
			audit(undefined, (report) => {
				report.success = success;
			}),
			{
				problems: [
					"the test run failed; its report cannot show every skipped test",
				],
				skipped: 0,
			},
		);
	// A file reported twice would use its allowance twice.
	assert.equal(
		audit((files) => [
			...files,
			files.find((entry) => entry.name === resolve(root, gated.file)),
		]).problems[0],
		`${gated.file}: reported more than once`,
	);
	// A status this check does not know is not a test that ran.
	assert.deepEqual(
		audit((files) => [
			...files,
			fileResult("apps/worker/src/new.test.ts", ["disabled"]),
		]).problems.slice(0, 2),
		[
			"apps/worker/src/new.test.ts: 1 tests skipped, none may be",
			'"disabled": apps/worker/src/new.test.ts > test 1',
		],
	);
	// At most 20 tests of a file are named.
	assert.equal(
		audit((files) => [
			...files,
			fileResult(
				"apps/worker/src/new.test.ts",
				Array.from({ length: 25 }, () => "skipped"),
			),
		]).problems.length,
		21,
	);
	// Totals below the list, or no totals, disagree with it too.
	assert.deepEqual(
		audit(undefined, (report) => {
			report.numPendingTests -= 2;
		}).problems,
		["the report counts 65 skipped tests but lists 67"],
	);
	assert.deepEqual(
		audit(undefined, (report) => {
			delete report.numPendingTests;
		}).problems,
		["the report counts undefined skipped tests but lists 67"],
	);
	assert.equal(
		audit(undefined, (report) => {
			delete report.numTodoTests;
		}).problems[0],
		"todo tests: undefined, required 0",
	);
});

const allPassed = (group) =>
	reportOf(
		Object.entries(group.files).map(([file, tests]) =>
			fileResult(
				join(group.directory, file),
				Array.from({ length: tests }, () => "passed"),
			),
		),
	);
const ADMIN_URL =
	"postgresql://bitovp_fixture_admin:admin-secret@127.0.0.1:54329/bitovp_integration_0123456789abcdef0123456789abcdef?schema=public";
const APP_URL =
	"postgresql://bitovp_app:app-secret@127.0.0.1:54329/bitovp_integration_0123456789abcdef0123456789abcdef?schema=public";

// A stand-in for the commands, the PostgreSQL fixture and the servers of a
// Redis run. `vitest` gives the report of a group; `during` looks at the
// fixture's private directory while the queue tests run.
async function redisRun({
	version = async () =>
		"Redis server v=8.10.3 sha=00000000:1 malloc=jemalloc-5.3.0 bits=64 build=747a5ed3aa01506f",
	vitest = allPassed,
	during = () => {},
	start,
	fixture,
	database = {
		BITOVP_TENANT_TEST_ADMIN_URL: ADMIN_URL,
		BITOVP_TENANT_TEST_APP_URL: APP_URL,
	},
	env = { PATH: "/tools/bin" },
	signal,
} = {}) {
	const calls = [];
	const notes = [];
	const servers = [];
	const scratch = {};
	const execute = async (binary, args, options) => {
		calls.push({ binary, args, options });
		if (binary !== "pnpm") return version();
		const output = args.at(-1).slice("--outputFile=".length);
		const group = args.includes("--config") ? REDIS.leases : REDIS.queues;
		scratch[group === REDIS.leases ? "leases" : "queues"] = dirname(output);
		if (group === REDIS.queues) during(dirname(output), options);
		const report = await vitest(group);
		if (report !== undefined) writeFileSync(output, JSON.stringify(report));
		return "";
	};
	// What the fixture gives its run step: a private directory, a private
	// temporary directory in the child environment, and both database URLs.
	const prepared = async ({
		run,
		notify,
		root: checkout,
		env: given,
		signal: cancel,
	}) => {
		scratch.cancel = cancel;
		const directory = mkdtempSync(join(tmpdir(), "gated-redis-fixture-"));
		try {
			await run(
				{
					root: checkout,
					directory,
					notify,
					env: {
						PATH: given.PATH,
						TMPDIR: join(directory, "tmp"),
						...database,
					},
				},
				execute,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	};
	const started = async (options) => {
		const server = {
			...options,
			mode: statSync(options.directory).mode & 0o777,
			stopped: false,
		};
		servers.push(server);
		return {
			stop: async () => {
				server.stopped = true;
			},
		};
	};
	let lines;
	try {
		await runRedis(
			{ root, env, signal, notify: (note) => notes.push(note) },
			{ execute, fixture: fixture ?? prepared, start: start ?? started },
		);
	} catch (error) {
		lines = failureLines(error);
	}
	return { calls, notes, servers, scratch, lines };
}

test("a Redis run passes only when every lease and queue test ran and passed", async () => {
	const controller = new AbortController();
	const seen = {};
	const passed = await redisRun({
		signal: controller.signal,
		env: {
			PATH: "/tools/bin",
			GITHUB_TOKEN: "not for a child",
			// The lease tests start a server of their own.
			VMAF_RESOURCE_LEASE_TEST_REDIS_URL: "redis://127.0.0.1:16381",
		},
		during: (directory, options) => {
			seen.directory = directory;
			seen.database = readFileSync(options.env.TENANT_TEST_DB_FILE, "utf8");
			seen.mode = statSync(options.env.TENANT_TEST_DB_FILE).mode & 0o777;
		},
	});
	assert.equal(passed.lines, undefined);
	assert.deepEqual(passed.notes, [
		"Redis server 8.10.3",
		"@bitovp/worker: 29 resource lease tests passed, 0 skipped",
		"@bitovp/worker: 3 queue tests passed against Redis and PostgreSQL, 0 skipped",
	]);
	const child = {
		PATH: "/tools/bin",
		CI: "1",
		TURBO_TELEMETRY_DISABLED: "1",
		NEXT_TELEMETRY_DISABLED: "1",
	};
	assert.deepEqual(
		passed.calls.map(({ binary, args }) => [binary, ...args.slice(0, -1)]),
		[
			["redis-server"],
			[
				"pnpm",
				"--filter",
				"@bitovp/worker",
				"exec",
				"vitest",
				"run",
				"--config",
				"vitest.resource-leases.config.ts",
				"--maxWorkers=2",
				"--reporter=json",
			],
			[
				"pnpm",
				"--filter",
				"@bitovp/worker",
				"exec",
				"vitest",
				"run",
				"src/handlers.redis.integration.test.ts",
				"src/live-capacity.redis.integration.test.ts",
				"src/tenant/redis.integration.test.ts",
				"--maxWorkers=2",
				"--reporter=json",
			],
		],
	);
	assert.deepEqual(passed.calls[0].args, ["--version"]);
	assert.deepEqual(passed.calls[0].options, {
		env: child,
		signal: controller.signal,
	});
	assert.deepEqual(passed.calls[1].options, {
		cwd: root,
		env: child,
		signal: controller.signal,
		timeout: 300_000,
	});
	// The queue tests get the three addresses and the credentials file, and no
	// database URL or token in their environment.
	assert.deepEqual(passed.calls[2].options, {
		cwd: root,
		env: {
			...child,
			TMPDIR: join(seen.directory, "tmp"),
			TENANT_TEST_DB_FILE: join(seen.directory, "tenant-redis.json"),
			TENANT_TEST_REDIS_URL: "redis://127.0.0.1:16379",
			VOD_REDELIVERY_TEST_REDIS_URL: "redis://127.0.0.1:16380",
			LIVE_CAPACITY_TEST_REDIS_URL: "redis://127.0.0.1:16381",
		},
	});
	assert.deepEqual(JSON.parse(seen.database), {
		adminUrl: ADMIN_URL,
		runtimeUrl: APP_URL,
	});
	assert.equal(seen.mode, 0o600);
	// The fixture stops at its next command when the run is cancelled.
	assert.equal(passed.scratch.cancel, controller.signal);
	// One private server per address, each stopped after the tests.
	assert.deepEqual(
		passed.servers.map(({ program, port, directory, env, mode, stopped }) => ({
			program,
			port,
			directory,
			env,
			mode,
			stopped,
		})),
		[16379, 16380, 16381].map((port) => ({
			program: "redis-server",
			port,
			directory: join(seen.directory, `redis-${port}`),
			env: { ...child, TMPDIR: join(seen.directory, "tmp") },
			mode: 0o700,
			stopped: true,
		})),
	);
	assert.equal(existsSync(passed.scratch.leases), false);

	// A program named for the lease tests is the one every part uses.
	const named = await redisRun({
		env: {
			PATH: "/tools/bin",
			VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER: "/redis/bin/redis-server",
		},
	});
	assert.equal(named.lines, undefined);
	assert.equal(named.calls[0].binary, "/redis/bin/redis-server");
	assert.equal(
		named.calls[1].options.env.VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER,
		"/redis/bin/redis-server",
	);
	assert.deepEqual(
		named.servers.map(({ program }) => program),
		Array.from({ length: 3 }, () => "/redis/bin/redis-server"),
	);
});

test("a Redis run names the part that did not run, and stops the servers it started", async () => {
	// No program, or a program that is not Redis: nothing else starts.
	const absent = await redisRun({
		version: async () => {
			throw new GateFailure("Media validation command failed", {
				diagnostics: "sh: redis-server: not found\n",
			});
		},
	});
	assert.deepEqual(absent.lines, [
		"Step: checking the Redis server program",
		"Reason: redis-server could not be run; put it on PATH or name it in VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER",
		"Last 1 lines of the failed command:",
		"  | sh: redis-server: not found",
	]);
	assert.equal(absent.calls.length, 1);
	// A run that was cancelled during the check is reported as cancelled.
	const controller = new AbortController();
	controller.abort();
	const cancelled = await redisRun({
		signal: controller.signal,
		version: async () => {
			throw new GateFailure("Media validation command cancelled");
		},
	});
	assert.deepEqual(cancelled.lines, [
		"Step: checking the Redis server program",
		"Reason: Media validation command cancelled",
	]);
	for (const version of [
		"Valkey server v=8.0.1 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64",
		"note\nRedis server v=8.10.3 sha=00000000:1",
		"Redis server v=8.10 sha=00000000:1",
		"",
	]) {
		const other = await redisRun({ version: async () => version });
		assert.deepEqual(other.lines, [
			"Step: checking the Redis server program",
			"Reason: redis-server did not report a Redis version",
		]);
		assert.deepEqual(other.notes, []);
		assert.equal(other.calls.length, 1);
	}

	// A lease test that did not run: the queue part does not start.
	const skippedLease = await redisRun({
		vitest: (group) => {
			const report = allPassed(group);
			if (group !== REDIS.leases) return report;
			report.testResults[0].assertionResults[3].status = "skipped";
			report.numPassedTests -= 1;
			report.numPendingTests += 1;
			return report;
		},
	});
	const lease = "src/vmaf/resource-leases.redis.integration.ts";
	assert.deepEqual(skippedLease.lines, [
		"Step: running the resource lease tests",
		"Reason: Redis tests must all run and pass",
		"  - skipped tests: 1, required 0",
		"  - tests passed: 28, required 29",
		`  - ${lease}: 28 of 29 tests passed, 29 required`,
		`  - "skipped": apps/worker/${lease} > test 4`,
	]);
	assert.deepEqual(skippedLease.notes, ["Redis server 8.10.3"]);
	assert.deepEqual(skippedLease.servers, []);
	assert.equal(existsSync(skippedLease.scratch.leases), false);
	// A file that the lease configuration gained is not a listed one.
	const extra = await redisRun({
		vitest: (group) =>
			group === REDIS.leases
				? reportOf([
						...allPassed(group).testResults,
						fileResult("apps/worker/src/vmaf/more.redis.integration.ts", [
							"passed",
						]),
					])
				: allPassed(group),
	});
	assert.deepEqual(extra.lines.slice(0, 5), [
		"Step: running the resource lease tests",
		"Reason: Redis tests must all run and pass",
		"  - tests discovered: 30, required 29",
		"  - tests passed: 30, required 29",
		"  - src/vmaf/more.redis.integration.ts: not a required Redis test file",
	]);

	// A queue test that skipped itself, as each does without its variable.
	const skippedQueue = await redisRun({
		vitest: (group) => {
			const report = allPassed(group);
			if (group !== REDIS.queues) return report;
			report.testResults[2].assertionResults[0].status = "skipped";
			report.numPassedTests -= 1;
			report.numPendingTests += 1;
			return report;
		},
	});
	assert.deepEqual(skippedQueue.lines, [
		"Step: running the queue tests that need Redis",
		"Reason: Redis tests must all run and pass",
		"  - skipped tests: 1, required 0",
		"  - tests passed: 2, required 3",
		"  - src/tenant/redis.integration.test.ts: 0 of 1 tests passed, 1 required",
		'  - "skipped": apps/worker/src/tenant/redis.integration.test.ts > test 1',
	]);
	assert.deepEqual(skippedQueue.notes, [
		"Redis server 8.10.3",
		"@bitovp/worker: 29 resource lease tests passed, 0 skipped",
	]);
	assert.deepEqual(
		skippedQueue.servers.map(({ stopped }) => stopped),
		[true, true, true],
	);
	// No report at all, with and without a failed command.
	const silent = await redisRun({
		vitest: (group) => (group === REDIS.queues ? undefined : allPassed(group)),
	});
	assert.deepEqual(silent.lines, [
		"Step: running the queue tests that need Redis",
		"Reason: Vitest did not write a readable report",
	]);
	assert.deepEqual(
		silent.servers.map(({ stopped }) => stopped),
		[true, true, true],
	);
	const failed = await redisRun({
		vitest: (group) => {
			if (group === REDIS.queues)
				throw new GateFailure("PostgreSQL integration command failed", {
					diagnostics: `connect ECONNREFUSED ${ADMIN_URL}\n`,
				});
			return allPassed(group);
		},
	});
	assert.deepEqual(failed.lines.slice(0, 2), [
		"Step: running the queue tests that need Redis",
		"Reason: PostgreSQL integration command failed",
	]);
	assert.deepEqual(
		failed.servers.map(({ stopped }) => stopped),
		[true, true, true],
	);

	// A server that does not start: the ones before it are stopped, no test runs.
	const taken = [];
	const blocked = await redisRun({
		start: async (options) => {
			if (options.port === 16380)
				throw new GateFailure(
					"127.0.0.1:16380 already accepts connections; the Redis tests need that port for a server of their own",
				);
			const server = { port: options.port, stopped: false };
			taken.push(server);
			return {
				stop: async () => {
					server.stopped = true;
				},
			};
		},
	});
	assert.deepEqual(blocked.lines, [
		"Step: starting the Redis servers of the queue tests",
		"Reason: 127.0.0.1:16380 already accepts connections; the Redis tests need that port for a server of their own",
	]);
	assert.deepEqual(taken, [{ port: 16379, stopped: true }]);
	assert.equal(blocked.calls.length, 2);

	// Database URLs that are not the fixture's own are refused before a
	// credentials file or a server exists.
	for (const [database, reason] of [
		[{}, "Required PostgreSQL test URLs are missing"],
		[
			{
				BITOVP_TENANT_TEST_ADMIN_URL: ADMIN_URL.replace("127.0.0.1", "db"),
				BITOVP_TENANT_TEST_APP_URL: APP_URL.replace("127.0.0.1", "db"),
			},
			"Test database must use dedicated IPv4 loopback",
		],
		[
			{
				BITOVP_TENANT_TEST_ADMIN_URL: ADMIN_URL.replace(
					/bitovp_integration_[a-f0-9]+/,
					"bitovp",
				),
				BITOVP_TENANT_TEST_APP_URL: APP_URL.replace(
					/bitovp_integration_[a-f0-9]+/,
					"bitovp",
				),
			},
			"A dedicated integration database is required",
		],
	]) {
		const refused = await redisRun({ database });
		assert.equal(
			refused.lines[0],
			"Step: running the queue tests in the PostgreSQL fixture",
		);
		assert.match(refused.lines[1], new RegExp(`^Reason: .*${reason}`));
		assert.deepEqual(refused.servers, []);
		assert.equal(refused.calls.length, 2);
	}

	// The fixture's own failure keeps the step it names.
	const noDocker = await redisRun({
		fixture: async () => {
			throw atStep(
				new GateFailure("PostgreSQL integration command could not start"),
				"starting the PostgreSQL container",
			);
		},
	});
	assert.deepEqual(noDocker.lines, [
		"Step: starting the PostgreSQL container",
		"Reason: PostgreSQL integration command could not start",
	]);
	// A rejection without an error is still a failure with its step.
	const bare = await redisRun({
		fixture: async () => {
			throw undefined;
		},
	});
	assert.deepEqual(bare.lines, [
		"Step: running the queue tests in the PostgreSQL fixture",
		"Reason: A step failed without an error",
	]);
});

// A program that takes redis-server's place: `FAKE_REDIS` chooses whether it
// serves its port, stops at once, neither serves nor ends when asked, or stays
// and starts another process that serves and holds its output open, as a
// script does that starts the server without exec, or serves but only sends
// a byte now and then. Every start is listed in `pids`, and none lasts longer
// than 90 seconds. A server answers INFO with its process id, as Redis does,
// and leaves the file `asked` when it is asked to end.
const FAKE_REDIS = `#!${process.execPath}
const { spawn } = require("node:child_process");
const { appendFileSync, renameSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const args = process.argv.slice(2);
const directory = args[args.indexOf("--dir") + 1];
const mode = process.env.FAKE_REDIS;
appendFileSync(join(directory, "pids"), process.pid + "\\n");
setTimeout(() => process.exit(0), 90_000);
if (mode === "delegates")
	spawn(process.execPath, [__filename, ...args], {
		stdio: "inherit",
		env: { ...process.env, FAKE_REDIS: "serves" },
	});
else {
	writeFileSync(join(directory, "started.tmp"), JSON.stringify({ args, pid: process.pid, env: Object.keys(process.env).sort() }));
	renameSync(join(directory, "started.tmp"), join(directory, "started.json"));
	if (mode === "stops") {
		console.log("Could not create server TCP listening socket: bind: Address already in use");
		process.exit(1);
	}
	if (mode === "deaf") {
		console.error("Error loading shared library libssl.so.3: No such file or directory");
		process.on("SIGTERM", () => {});
	} else {
		process.on("SIGTERM", () => {
			writeFileSync(join(directory, "asked"), "");
			process.exit(0);
		});
		createServer((socket) => {
			socket.on("error", () => {});
			if (mode === "drips") {
				const drip = setInterval(() => socket.write("-"), 200);
				socket.on("close", () => clearInterval(drip));
				return;
			}
			socket.on("data", (data) => {
				if (String(data) !== "INFO server\\r\\n") return socket.end("-ERR unknown command\\r\\n");
				const info = "# Server\\r\\nprocess_id:" + process.pid + "\\r\\n";
				socket.end("$" + info.length + "\\r\\n" + info + "\\r\\n");
			});
		}).listen(
			Number(args[args.indexOf("--port") + 1]),
			args[args.indexOf("--bind") + 1],
		);
	}
}
`;
const freePort = () =>
	new Promise((accept) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => accept(port));
		});
	});
const reachable = (port) =>
	new Promise((accept) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			accept(true);
		});
		socket.once("error", () => accept(false));
	});
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a Redis server of the run serves a port of its own until it is stopped", {
	timeout: 60_000,
}, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "gated-redis-server-"));
	// Ends whatever a failed check left running, so that this file ends too.
	t.after(() => {
		const list = join(directory, "pids");
		const pids = existsSync(list) ? readFileSync(list, "utf8").split("\n") : [];
		for (const pid of pids.filter(Boolean))
			try {
				process.kill(Number(pid), "SIGKILL");
			} catch {
				// Ended already.
			}
		rmSync(directory, { recursive: true, force: true });
	});
	const program = join(directory, "redis-server");
	writeFileSync(program, FAKE_REDIS);
	chmodSync(program, 0o700);
	const env = (mode) => ({ PATH: process.env.PATH, FAKE_REDIS: mode });
	const record = () =>
		JSON.parse(readFileSync(join(directory, "started.json"), "utf8"));
	const port = await freePort();
	const server = await startRedis({
		program,
		port,
		directory,
		env: env("serves"),
	});
	assert.equal(await reachable(port), true);
	const started = record();
	assert.deepEqual(started.args, [
		"--port",
		String(port),
		"--bind",
		"127.0.0.1",
		"--save",
		"",
		"--appendonly",
		"no",
		"--dir",
		directory,
		"--loglevel",
		"warning",
	]);
	// Only the environment it was given.
	assert.deepEqual(
		started.env.filter((key) => !key.startsWith("__")),
		["FAKE_REDIS", "PATH"],
	);
	assert.equal(alive(started.pid), true);

	// A port that something serves already is refused, and nothing is started.
	rmSync(join(directory, "started.json"));
	await assert.rejects(
		startRedis({ program, port, directory, env: env("serves") }),
		(error) => {
			assert(error instanceof GateFailure);
			assert.equal(
				error.message,
				`127.0.0.1:${port} already accepts connections; the Redis tests need that port for a server of their own`,
			);
			return true;
		},
	);
	assert.equal(existsSync(join(directory, "started.json")), false);

	// A server is asked to end before it is killed, and ends.
	await server.stop();
	assert.equal(existsSync(join(directory, "asked")), true);
	assert.equal(await reachable(port), false);
	assert.equal(alive(started.pid), false);
	// Stopping twice is harmless.
	await server.stop();

	// A server that stops before it serves is not waited for, and is reported
	// with what it printed.
	const since = Date.now();
	await assert.rejects(
		startRedis({ program, port, directory, env: env("stops"), wait: 30_000 }),
		(error) => {
			assert.deepEqual(failureLines(error), [
				`Reason: The Redis server for 127.0.0.1:${port} did not answer`,
				"Last 1 lines of the failed command:",
				"  | Could not create server TCP listening socket: bind: Address already in use",
			]);
			return true;
		},
	);
	assert(Date.now() - since < 15_000, "a program that ended was waited for");
	// A program that does not exist.
	await assert.rejects(
		startRedis({
			program: join(directory, "absent"),
			port,
			directory,
			env: env("serves"),
		}),
		(error) => {
			assert.deepEqual(failureLines(error), [
				`Reason: The Redis server for 127.0.0.1:${port} did not answer`,
			]);
			return true;
		},
	);
	// A program that starts the server as another process is refused, and that
	// server is stopped with it.
	rmSync(join(directory, "started.json"));
	await assert.rejects(
		startRedis({ program, port, directory, env: env("delegates") }),
		(error) => {
			assert(error instanceof GateFailure);
			assert.equal(
				error.message,
				`127.0.0.1:${port} is served by process ${record().pid}, not by the server that this run started`,
			);
			return true;
		},
	);
	assert.equal(await reachable(port), false);
	for (let attempt = 0; alive(record().pid) && attempt < 100; attempt++)
		await new Promise((accept) => setTimeout(accept, 50));
	assert.equal(alive(record().pid), false);
	// A server that keeps sending but never answers the question is given up
	// when the wait is over.
	await assert.rejects(
		startRedis({ program, port, directory, env: env("drips"), wait: 1_500 }),
		(error) => {
			assert.deepEqual(failureLines(error), [
				`Reason: The Redis server for 127.0.0.1:${port} did not answer`,
			]);
			return true;
		},
	);
	assert.equal(alive(record().pid), false);
	// A server that neither serves nor ends when asked is killed, and what it
	// printed as an error is reported.
	const begun = Date.now();
	await assert.rejects(
		startRedis({ program, port, directory, env: env("deaf"), wait: 1_000 }),
		(error) => {
			assert.deepEqual(failureLines(error), [
				`Reason: The Redis server for 127.0.0.1:${port} did not answer`,
				"Last 1 lines of the failed command:",
				"  | Error loading shared library libssl.so.3: No such file or directory",
			]);
			return true;
		},
	);
	assert(Date.now() - begun >= 2_000, "the server was not given its 2 s");
	assert.equal(alive(record().pid), false);
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
			"@bitovp/core: 11 tests skipped by the plain run; another job runs each of them\n",
		);
		const worker = run(
			"--audit",
			"@bitovp/worker",
			write("worker.json", plainRun("@bitovp/worker")),
		);
		assert.equal(worker.status, 0, worker.stderr);
		assert.equal(
			worker.stdout,
			"@bitovp/worker: 67 tests skipped by the plain run; another job runs each of them\n",
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
				"Reason: Usage: gated-tests.mjs --native-media | --redis | --audit <workspace> <Vitest JSON report>",
			],
			[
				["--audit", "@bitovp/core"],
				"Reason: Usage: gated-tests.mjs --native-media | --redis | --audit <workspace> <Vitest JSON report>",
			],
			[
				["--redis", "extra"],
				"Reason: Usage: gated-tests.mjs --native-media | --redis | --audit <workspace> <Vitest JSON report>",
			],
			[
				["--native-media", "extra"],
				"Reason: Usage: gated-tests.mjs --native-media | --redis | --audit <workspace> <Vitest JSON report>",
			],
			[
				["--audit", "@bitovp/core", join(directory, "clean.json"), "extra"],
				"Reason: Usage: gated-tests.mjs --native-media | --redis | --audit <workspace> <Vitest JSON report>",
			],
			[
				["--audit", "@bitovp/core!", join(directory, "clean.json")],
				"Reason: A workspace name is required",
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

// Stand-ins on PATH for a run of the real command: a redis-server that reports
// its version, Vitest for the lease tests, docker, and a database preparation
// that does what `prepare` says.
function standIns(parent, prepare) {
	const program = (name, body) =>
		writeFileSync(join(parent, name), `#!/usr/bin/env node\n${body}`, {
			mode: 0o700,
		});
	program(
		"redis-server",
		'console.log("Redis server v=8.10.3 sha=00000000:1 malloc=jemalloc-5.3.0 bits=64 build=0");',
	);
	writeFileSync(
		join(parent, "leases.json"),
		JSON.stringify(allPassed(REDIS.leases)),
	);
	program(
		"pnpm",
		`const { copyFileSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const a = process.argv.slice(2);
const output = a.find((arg) => arg.startsWith("--outputFile="));
if (output) copyFileSync(__dirname + "/leases.json", output.slice("--outputFile=".length));
else if (a.includes("db:runtime:prepare")) {
${prepare}
}
`,
	);
	program(
		"docker",
		`const a = process.argv.slice(4);
if (a[0] === "port") console.log("127.0.0.1:15432");
else if (a[0] === "inspect")
	console.log(JSON.stringify({ "io.bitovp.postgres-test": a.at(-1).slice("bitovp-postgres-".length) }));
`,
	);
}

test("the Redis command reaches the fixture, and a failure there is reported without the fixture's credentials", () => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "gated-redis-cli-")));
	const run = (path) =>
		spawnSync(process.execPath, [script, "--redis"], {
			encoding: "utf8",
			timeout: 60_000,
			env: { PATH: path },
		});
	try {
		// No program at all: the first step says so.
		const absent = run(parent);
		assert.equal(absent.status, 1);
		assert.equal(absent.stdout, "");
		assert.deepEqual(absent.stderr.trimEnd().split("\n"), [
			"Gated tests failed; a required test did not run and pass.",
			"Step: checking the Redis server program",
			"Reason: redis-server could not be run; put it on PATH or name it in VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER",
		]);

		// The database preparation fails and prints the administrator URL it
		// was given.
		standIns(
			parent,
			`	const file = readFileSync(a[a.indexOf("--admin-env") + 1], "utf8");
	console.error("cannot prepare a role at " + /^DATABASE_URL=(.+)$/m.exec(file)[1]);
	process.exit(1);`,
		);
		const failed = run(`${parent}:${process.env.PATH}`);
		assert.equal(failed.status, 1);
		assert.deepEqual(failed.stdout.trimEnd().split("\n"), [
			"Redis server 8.10.3",
			"@bitovp/worker: 29 resource lease tests passed, 0 skipped",
			"Preparing dedicated PostgreSQL runtime role and migrations",
			"Dedicated PostgreSQL fixture and private files removed",
		]);
		assert.deepEqual(failed.stderr.trimEnd().split("\n"), [
			"Gated tests failed; a required test did not run and pass.",
			"Step: preparing the runtime database role",
			"Reason: PostgreSQL integration command failed",
			"Last 1 lines of the failed command:",
			"  | cannot prepare a role at [private]",
		]);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("a signal stops the command that is running, and the fixture is removed all the same", {
	timeout: 60_000,
}, async (t) => {
	const parent = realpathSync(
		mkdtempSync(join(tmpdir(), "gated-redis-signal-")),
	);
	const pid = join(parent, "hanging.pid");
	// The database preparation does not end by itself.
	standIns(
		parent,
		`	writeFileSync(__dirname + "/hanging.tmp", String(process.pid));
	renameSync(__dirname + "/hanging.tmp", __dirname + "/hanging.pid");
	setTimeout(() => process.exit(0), 90_000);`,
	);
	const child = spawn(process.execPath, [script, "--redis"], {
		env: { PATH: `${parent}:${process.env.PATH}` },
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Ends whatever a failed check left running, so that this file ends too.
	t.after(() => {
		child.kill("SIGKILL");
		if (existsSync(pid))
			try {
				process.kill(Number(readFileSync(pid, "utf8")), "SIGKILL");
			} catch {
				// Ended already.
			}
		rmSync(parent, { recursive: true, force: true });
	});
	const printed = { stdout: "", stderr: "" };
	for (const stream of ["stdout", "stderr"])
		child[stream].on("data", (chunk) => {
			printed[stream] += chunk;
		});
	let closed = false;
	const ended = new Promise((accept) =>
		child.once("close", (code, signal) => {
			closed = true;
			accept({ code, signal });
		}),
	);
	while (!closed && !existsSync(pid))
		await new Promise((accept) => setTimeout(accept, 50));
	assert.equal(closed, false, printed.stderr);
	const hanging = Number(readFileSync(pid, "utf8"));
	child.kill("SIGTERM");
	assert.deepEqual(await ended, { code: 1, signal: null });
	assert.equal(alive(hanging), false);
	assert.deepEqual(printed.stdout.trimEnd().split("\n"), [
		"Redis server 8.10.3",
		"@bitovp/worker: 29 resource lease tests passed, 0 skipped",
		"Preparing dedicated PostgreSQL runtime role and migrations",
		"Dedicated PostgreSQL fixture and private files removed",
	]);
	assert.deepEqual(printed.stderr.trimEnd().split("\n"), [
		"Gated tests failed; a required test did not run and pass.",
		"Step: preparing the runtime database role",
		"Reason: PostgreSQL integration command failed",
		"  - The command was cancelled",
	]);
});

// Stand-ins for the installer's tools. docker lists its calls in the file
// `CALLS`, and its copy of the image's /lib leaves a loader under each name in
// `LOADERS`: a script that reports `REPORTED` as its version and how it was
// called.
const FAKE_DOCKER = `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, args.join(" ") + "\\n");
if (args[0] === "create") console.log("c0ffee");
if (args[0] === "cp" && args.at(-2).endsWith(":/usr/local/bin/redis-server")) writeFileSync(args.at(-1), "");
if (args[0] === "cp" && args.at(-2).endsWith(":/lib/."))
	for (const name of JSON.parse(process.env.LOADERS))
		writeFileSync(args.at(-1) + name, '#!/bin/sh\\necho "Redis server v=' + process.env.REPORTED + ' called with $*"\\n', { mode: 0o755 });
`;

test("the installer takes only the pinned Redis image, into a new directory with a plain path", () => {
	const parent = realpathSync(
		mkdtempSync(join(tmpdir(), "gated-redis-tools-")),
	);
	try {
		// The installer refuses any other character in the path of its target.
		assert.match(
			parent,
			/^[A-Za-z0-9/._-]+$/,
			"this test needs a temporary directory with a plain path",
		);
		const tools = join(parent, "tools");
		mkdirSync(tools);
		writeFileSync(join(tools, "docker"), FAKE_DOCKER, { mode: 0o700 });
		writeFileSync(
			join(tools, "uname"),
			"#!/bin/sh\nprintf '%s\\n' \"$FAKE_UNAME\"\n",
			{ mode: 0o700 },
		);
		const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
		const [, image, version] =
			/^ +image: (redis:([0-9.]+)-alpine@sha256:[a-f0-9]{64})$/m.exec(compose);
		const pin = (value) =>
			compose.replace(/^( +image: )redis:.*$/m, `$1${value}`);
		const digest = "a".repeat(64);
		let count = 0;
		// One run of the installer, in a checkout of its own.
		const install = ({
			shell,
			file = compose,
			name = "redis",
			before = () => {},
			loaders = ["ld-musl-x86_64.so.1"],
			reported = version,
			host = "Linux",
		}) => {
			count += 1;
			const checkout = join(parent, `checkout-${count}`);
			mkdirSync(join(checkout, "scripts"), { recursive: true });
			copyFileSync(
				resolve(root, "scripts/redis-server-tools.sh"),
				join(checkout, "scripts/redis-server-tools.sh"),
			);
			writeFileSync(join(checkout, "docker-compose.yml"), file);
			const calls = join(checkout, "calls");
			writeFileSync(calls, "");
			const target = join(checkout, name);
			before(target);
			const result = spawnSync(
				shell,
				[join(checkout, "scripts/redis-server-tools.sh"), target],
				{
					encoding: "utf8",
					env: {
						PATH: `${tools}:/usr/bin:/bin`,
						CALLS: calls,
						LOADERS: JSON.stringify(loaders),
						REPORTED: reported,
						FAKE_UNAME: host,
					},
				},
			);
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				target,
				calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
			};
		};
		const PIN =
			"docker-compose.yml does not pin one Redis image by version and digest\n";
		const PATH =
			"The directory's path may hold only letters, digits and / . _ -\n";
		const LOADER = "The image holds no single musl loader with a plain name\n";
		// CI runs it with sh, which is dash there.
		const shells = ["sh", "dash"].filter(
			(shell) => spawnSync(shell, ["-c", ":"]).status === 0,
		);
		assert(shells.includes("sh"));
		for (const shell of shells) {
			const done = install({ shell });
			assert.equal(done.status, 0, done.stderr);
			const { target } = done;
			// The program is started through the image's loader and libraries.
			assert.equal(
				done.stdout,
				`Redis server v=${version} called with --library-path ${target}/lib ${target}/libexec/redis-server --version\n`,
			);
			assert.equal(
				readFileSync(join(target, "bin/redis-server"), "utf8"),
				`#!/bin/sh\nexec "${target}/lib/ld-musl-x86_64.so.1" --library-path "${target}/lib" "${target}/libexec/redis-server" "$@"\n`,
			);
			// The container is removed with its volume.
			assert.deepEqual(done.calls, [
				`create ${image}`,
				`cp --follow-link c0ffee:/usr/local/bin/redis-server ${target}/libexec/redis-server`,
				`cp c0ffee:/lib/. ${target}/lib/`,
				`cp c0ffee:/usr/lib/. ${target}/lib/`,
				"rm --force --volumes c0ffee",
			]);

			// Refused before Docker is asked for anything.
			for (const [options, stderr] of [
				[{ file: compose.replace(/^ +image: redis:.*\n/m, "") }, PIN],
				[{ file: `${compose}\n    image: ${image}\n` }, PIN],
				[{ file: pin(`redis:${version}-alpine`) }, PIN],
				[{ file: pin(`redis:${version}@sha256:${digest}`) }, PIN],
				[{ file: pin(`redis:latest-alpine@sha256:${digest}`) }, PIN],
				[{ file: pin(`${image} # pinned`) }, PIN],
				[{ file: pin(`"${image}"`) }, PIN],
				[
					{ file: pin(`ghcr.io/x/redis:${version}-alpine@sha256:${digest}`) },
					PIN,
				],
				[{ name: "with space" }, PATH],
				[{ name: "$(id)" }, PATH],
				[{ host: "Darwin" }, "The image's redis-server runs on Linux only\n"],
				// The shell's own message, in one line: the script went no further.
				[{ name: "absent/redis" }, /^[^\n]*\bcd\b[^\n]*\n$/],
				[{ before: (path) => mkdirSync(path) }, /^[^\n]*\bmkdir\b[^\n]*\n$/],
			]) {
				const refused = install({ shell, ...options });
				assert.notEqual(refused.status, 0);
				assert.equal(refused.stdout, "");
				if (typeof stderr === "string") assert.equal(refused.stderr, stderr);
				else assert.match(refused.stderr, stderr);
				assert.deepEqual(refused.calls, []);
			}

			// Refused after the copy: no program is left to start, and the
			// container is removed.
			for (const [options, stderr] of [
				[{ loaders: [] }, LOADER],
				[{ loaders: ["ld-musl-x86_64.so.1", "ld-musl-aarch64.so.1"] }, LOADER],
				[{ loaders: ["ld-musl-$(id).so.1"] }, LOADER],
				[
					{ reported: `${version}1` },
					"The image's redis-server reports another version than its tag\n",
				],
			]) {
				const refused = install({ shell, ...options });
				assert.equal(refused.status, 1);
				assert.equal(refused.stdout, "");
				assert.equal(refused.stderr, stderr);
				assert.equal(refused.calls.at(-1), "rm --force --volumes c0ffee");
			}
		}
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("the VMAF proof passes only when FFmpeg ends without an error and scores two identical pictures as 100", () => {
	// A space in the path: each path the proof uses must stay one word.
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "gated vmaf proof-")));
	try {
		const proof = resolve(root, "docker/vmaf-build-proof.sh");
		const ffmpeg = join(parent, "ffmpeg");
		// FFmpeg writes its log to the error output. The stand-in records each
		// argument on a line of its own, and the files that the temporary
		// directory holds while it runs.
		writeFileSync(
			ffmpeg,
			'#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$CALLS"\nls "$TMPDIR" >> "$KEPT"\nprintf \'%s\\n\' "$FAKE_OUTPUT" >&2\nexit "$FAKE_STATUS"\n',
			{ mode: 0o700 },
		);
		const models = join(parent, "model");
		const model = `${models}/vmaf_v1.0.16_3d0h.json`;
		const calls = join(parent, "calls");
		const kept = join(parent, "kept");
		const temporary = join(parent, "tmp");
		mkdirSync(temporary);
		const prove = (shell, output, status, args = [ffmpeg, models]) => {
			writeFileSync(calls, "");
			writeFileSync(kept, "");
			const result = spawnSync(shell, [proof, ...args], {
				encoding: "utf8",
				env: {
					PATH: "/usr/bin:/bin",
					CALLS: calls,
					KEPT: kept,
					FAKE_OUTPUT: output,
					FAKE_STATUS: String(status),
					TMPDIR: temporary,
				},
			});
			// The log that the proof keeps while FFmpeg runs is removed again.
			assert.deepEqual(readdirSync(temporary), []);
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
				kept: readFileSync(kept, "utf8"),
			};
		};
		const score = (value) => `[Parsed_libvmaf_0 @ 0x1] VMAF score: ${value}`;
		const picture = "testsrc=size=640x360:rate=5:duration=0.4";
		const FAILED = (status) =>
			`FFmpeg ended with status ${status} while scoring with ${model}\n`;
		const SCORE = `FFmpeg did not score two identical pictures as 100 with ${model}\n`;
		const ARGUMENTS = [
			"-hide_banner",
			"-nostdin",
			"-f",
			"lavfi",
			"-i",
			picture,
			"-f",
			"lavfi",
			"-i",
			picture,
			"-lavfi",
			`[0:v][1:v]libvmaf=model=path=${model}`,
			"-f",
			"null",
			"-",
		];
		// While FFmpeg runs, the temporary directory holds the proof's log and
		// nothing else, under a name of the run's own.
		const LOG = /^vmaf-build-proof\.[A-Za-z0-9]{6}\n$/;
		// CI runs it with sh, which is dash there, and so does the image build.
		const shells = ["sh", "dash"].filter(
			(shell) =>
				spawnSync(shell, ["-c", ":"], { env: { PATH: "/usr/bin:/bin" } })
					.status === 0,
		);
		assert(shells.includes("sh"));
		for (const shell of shells) {
			const passed = prove(shell, score("100.000000"), 0);
			assert.deepEqual(passed, {
				status: 0,
				stdout: "",
				stderr: "",
				calls: ARGUMENTS,
				kept: passed.kept,
			});
			assert.match(passed.kept, LOG);

			// What the 64x64 pictures of the earlier check produced: libvmaf fails,
			// FFmpeg fails, and the log still holds a score line.
			const earlier = `libvmaf ERROR vmaf_predict_score_at_index(): no feature 'cambi_hrs_1080_cmxv_17_vlt_0.06' at index 0\n${score("0.000000")}\nConversion failed!`;
			for (const [output, status, ending] of [
				[earlier, 234, FAILED(234)],
				// A score of 100 does not excuse an error.
				[score("100.000000"), 1, FAILED(1)],
				[score("0.000000"), 0, SCORE],
				[score("99.999999"), 0, SCORE],
				[score("100.0000001"), 0, SCORE],
				[`${score("100.000000")} of 200`, 0, SCORE],
				["frame=    2 fps=0.0", 0, SCORE],
				// Only a VMAF score counts, in these very words.
				["[Parsed_other_0 @ 0x1] score: 100.000000", 0, SCORE],
				["[Parsed_libvmaf_0 @ 0x1] vmaf score: 100.000000", 0, SCORE],
			]) {
				const refused = prove(shell, output, status);
				assert.equal(refused.status, 1, output);
				assert.equal(refused.stdout, "");
				// FFmpeg's log, then what was wrong.
				assert.equal(refused.stderr, `${output}\n${ending}`);
				assert.deepEqual(refused.calls, ARGUMENTS);
				assert.match(refused.kept, LOG);
			}

			// A long log is repeated whole: its first lines name the first error.
			const long = Array.from(
				{ length: 30 },
				(_, index) => `line ${index + 1}`,
			);
			for (const [status, ending] of [
				[1, FAILED(1)],
				[0, SCORE],
			]) {
				const refused = prove(shell, long.join("\n"), status);
				assert.equal(refused.status, 1);
				assert.equal(refused.stdout, "");
				assert.equal(refused.stderr, `${long.join("\n")}\n${ending}`);
			}

			// An FFmpeg that cannot be started is an FFmpeg that failed.
			const absent = prove(shell, "", 0, [join(parent, "absent"), models]);
			assert.equal(absent.status, 1);
			assert.equal(absent.stdout, "");
			// The shell's own line, then the proof's. The status is the shell's:
			// 127 in dash, 1 in the bash 3.2 that macOS runs as sh.
			assert.match(
				absent.stderr,
				/^[^\n]+\nFFmpeg ended with status (?:127|1) while scoring with [^\n]+\n$/,
			);
			assert(absent.stderr.endsWith(` while scoring with ${model}\n`));
			assert.deepEqual(absent.calls, []);

			// Without both arguments FFmpeg is not started.
			for (const args of [[], [ffmpeg], ["", models], [ffmpeg, ""]]) {
				const refused = prove(shell, score("100.000000"), 0, args);
				assert.notEqual(refused.status, 0);
				assert.equal(refused.stdout, "");
				assert.match(
					refused.stderr,
					/usage: vmaf-build-proof\.sh <ffmpeg> <model directory>\n$/,
				);
				assert.deepEqual(refused.calls, []);
				assert.equal(refused.kept, "");
			}
		}

		// The image build and the installer both run this proof, and neither
		// looks for the words of a score line by itself.
		const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
		assert(
			dockerfile.includes(
				"\nRUN --mount=type=bind,source=docker/vmaf-build-proof.sh,target=/tmp/vmaf-build-proof.sh \\\n",
			),
		);
		// The proof is one link of the chain that ends its RUN: after the
		// checksums, and nothing after it excuses a failure.
		assert(
			dockerfile.includes(
				'\n\t&& (cd "$VMAF_MODEL_DIR" && sha256sum -c --strict vmaf-models.sha256) \\\n' +
					'\t&& sh /tmp/vmaf-build-proof.sh ffmpeg "$VMAF_MODEL_DIR" \\\n' +
					"\t&& apt-get purge -y --auto-remove curl \\\n" +
					"\t&& rm -rf /var/lib/apt/lists/*\n\n",
			),
		);
		const installer = readFileSync(
			resolve(root, "scripts/native-media-tools.sh"),
			"utf8",
		);
		assert(
			installer.includes(
				'\nsh "$root/docker/vmaf-build-proof.sh" "$target/bin/ffmpeg" "$target/model"\n',
			),
		);
		// The installer stops at the first command that fails: it says so once,
		// before the proof, and does not end by itself before the proof.
		const lines = installer.split("\n");
		const at = lines.indexOf(
			'sh "$root/docker/vmaf-build-proof.sh" "$target/bin/ffmpeg" "$target/model"',
		);
		assert.deepEqual(
			lines.filter((line) => /^\s*set\b/.test(line)),
			["set -eu"],
		);
		assert(lines.indexOf("set -eu") < at);
		assert.doesNotMatch(lines.slice(0, at).join("\n"), /^exit\b/m);
		// No command of either file looks for the words itself; a comment may
		// hold them.
		for (const text of [dockerfile, installer])
			assert.doesNotMatch(text, /^(?!\s*#).*VMAF score/m);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("the worker image compiles FFmpeg from sources pinned by commit or release and by checksum, without network access", () => {
	const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
	// Docker's own frontend reads the file, and a backslash continues a line.
	assert.match(
		dockerfile,
		/^# syntax=docker\/dockerfile:1(?:\.[0-9]+){0,2}(?:@sha256:[a-f0-9]{64})?\n/,
	);
	assert.doesNotMatch(dockerfile, /^#\s*escape\s*=/im);
	const written = dockerfile.split("\n").filter((line) => !/^\s*#/.test(line));
	// Docker also continues a line whose backslash is followed by spaces, does
	// not continue one that ends with two backslashes, and reads a line that
	// holds only a backslash as the start of the next instruction. None of
	// these is written here, so the few rules below read the file as Docker
	// does.
	for (const line of written)
		assert.doesNotMatch(line, /\\\s+$|\\\\$|^\s*\\$/, line);
	// Each instruction on one line, without comments.
	const instructions = written
		.join("\n")
		.replace(/\s*\\\n\s*/g, " ")
		.split("\n")
		.filter(Boolean);
	const stages = [];
	for (const line of instructions) {
		if (/^from\s/i.test(line)) {
			// Docker reads FROM and AS in any letter case and lowers a stage's
			// name. Here each stage is written in the one form.
			const from =
				/^FROM (?:--platform=(\S+) )?(\S+)(?: AS ([a-z0-9][a-z0-9._-]*))?$/.exec(
					line,
				);
			assert(from, line);
			stages.push({
				platform: from[1],
				base: from[2],
				name: from[3] ?? "",
				lines: [],
			});
		} else {
			assert(stages.length > 0, line);
			stages.at(-1).lines.push(line);
		}
	}
	// Each name once: Docker takes the last stage of a name, without an error.
	const names = stages.map((stage) => stage.name).filter(Boolean);
	assert.deepEqual(names, [...new Set(names)]);
	const named = new Map(stages.map((stage) => [stage.name, stage]));
	// Every stage that the "ffmpeg" stage is made from.
	const made = new Set();
	const visit = (name) => {
		if (made.has(name)) return;
		const stage = named.get(name);
		assert(stage, `stage ${name} is missing`);
		made.add(name);
		if (named.has(stage.base)) visit(stage.base);
		for (const line of stage.lines) {
			const copied = /^COPY --from=(\S+) /.exec(line);
			if (copied) visit(copied[1]);
		}
	};
	visit("ffmpeg");
	assert(made.size > 2);

	const sources = [];
	const open = [];
	for (const name of made) {
		const { platform, base, lines } = named.get(name);
		// It is built for the platform of the build, and starts from another
		// of these stages, from nothing, or from the Node image by its digest.
		assert.equal(platform, undefined, `${name}: --platform=${platform}`);
		assert(
			made.has(base) ||
				base === "scratch" ||
				/^node:[0-9.]+-bookworm-slim@sha256:[a-f0-9]{64}$/.test(base),
			`${name}: ${base}`,
		);
		const commits = new Map();
		const downloaded = new Set();
		for (const line of lines) {
			const [instruction] = line.split(" ");
			if (instruction === "ARG") {
				// A value of the file's own, in quotes.
				const argument = /^ARG ([A-Z0-9_]+)="([^"]*)"$/.exec(line);
				assert(argument, `${name}: ${line}`);
				const [, key, value] = argument;
				commits.set(key, value);
				if (key.endsWith("_COMMIT")) assert.match(value, /^[a-f0-9]{40}$/, key);
			} else if (instruction === "ADD") {
				// A source: its bytes are fixed by the checksum, its place in the
				// project's history by the commit or the release.
				const added = /^ADD --checksum=sha256:[a-f0-9]{64} (\S+) \S+$/.exec(
					line,
				);
				assert(added, line);
				const url = added[1].replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
					assert(commits.has(key), `${name}: ${key}`);
					downloaded.add(key);
					return commits.get(key);
				});
				const source =
					/^https:\/\/codeload\.github\.com\/([\w.-]+\/[\w.-]+)\/tar\.gz\/[a-f0-9]{40}$/.exec(
						url,
					) ??
					/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/[\w.-]+\/[\w.-]+\.tar\.gz$/.exec(
						url,
					) ??
					// x264's project keeps no repository on GitHub.
					/^https:\/\/(code\.videolan\.org\/videolan\/x264)\/-\/archive\/([a-f0-9]{40})\/x264-\2\.tar\.gz$/.exec(
						url,
					);
				assert(source, url);
				sources.push(source[1]);
			} else if (instruction === "RUN") {
				if (!line.startsWith("RUN --network=none ")) open.push(line);
				// No other flag: a mount brings in the checkout, another image, a
				// stage that is not followed here, or a cache that outlives the
				// build, and none of them needs a network.
				assert.match(line, /^RUN (?:--network=none )?[^-]/, line);
				// Meson builds nothing that it would have to download.
				assert.equal(
					line.split("meson setup ").length,
					line.split("--wrap-mode=nodownload ").length,
					line,
				);
				assert.doesNotMatch(line, /\b(?:curl|wget|git|pip|npm|pnpm)\b/, line);
			} else if (instruction === "COPY") {
				// Nothing comes from the checkout or from another image.
				const copied = /^COPY --from=(\S+) \S+ \S+$/.exec(line);
				assert(copied && made.has(copied[1]), line);
			} else {
				assert(["ENV", "WORKDIR"].includes(instruction), line);
			}
		}
		// A commit that the file names is the commit that is downloaded: the
		// steps tell FFmpeg, libvmaf, SVT-AV1 and dav1d their revision from it.
		for (const key of commits.keys())
			if (key.endsWith("_COMMIT"))
				assert(downloaded.has(key), `${name}: ${key} names no source`);
	}
	// What goes into the two programs, and the one build tool that Debian's
	// packages do not provide: repositories on GitHub, and x264 on VideoLAN's
	// server. A name does not show that a commit is the project's own, because
	// GitHub also serves a commit that only a fork holds. docs/OPERATIONS.md
	// says how to check a new commit.
	assert.deepEqual(sources.sort(), [
		"AOMediaCodec/SVT-AV1",
		"FFmpeg/FFmpeg",
		"FFmpeg/nv-codec-headers",
		"GNOME/libxml2",
		"Haivision/srt",
		"Netflix/vmaf",
		"adah1972/libunibreak",
		"code.videolan.org/videolan/x264",
		"fontconfig/fontconfig",
		"freetype/freetype",
		"fribidi/fribidi",
		"harfbuzz/harfbuzz",
		"libass/libass",
		"madler/zlib",
		"mesonbuild/meson",
		"nyorain/dlg",
		"openssl/openssl",
		"videolan/dav1d",
	]);
	// Only the step that installs Debian's compiler and build tools has a
	// network. It names packages, each with its version if that is pinned, and
	// no option of apt-get.
	assert.equal(open.length, 1, open.join("\n"));
	assert.match(
		open[0],
		/^RUN apt-get update && apt-get install -y --no-install-recommends (?:[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)? )+&& rm -rf \/var\/lib\/apt\/lists\/\*$/,
	);
	// Tools only: the headers of a development package would let a library of
	// Debian's be compiled in.
	assert.doesNotMatch(open[0], /-dev[ =]/, open[0]);

	// FFmpeg reports the revision that is compiled. Each is named once.
	for (const key of ["FFMPEG_VER", "FFMPEG_COMMIT"])
		assert.equal(dockerfile.split(`\nARG ${key}=`).length, 2, key);
	const version = /^ARG FFMPEG_VER="(n[0-9.]+-[0-9]+-g([a-f0-9]{10}))"$/m.exec(
		dockerfile,
	);
	const commit = /^ARG FFMPEG_COMMIT="([a-f0-9]{40})"$/m.exec(dockerfile);
	assert(version && commit);
	assert.equal(version[2], commit[1].slice(0, 10));
	// An archive of a commit holds no history to read a version from. FFmpeg
	// is told its version, which the installer prints, and libvmaf its
	// revision, which bitovp records with every measurement.
	const steps = [...made].flatMap((name) => named.get(name).lines);
	for (const told of [
		` && printf '%s\\n' "$FFMPEG_VER" > VERSION && ./configure `,
		` && revision=$(printf '%.7s' "$LIBVMAF_COMMIT") && sed -i "s/@VCS_TAG@/$revision/" libvmaf/include/vcs_version.h.in && grep -q "\\"$revision\\"" libvmaf/include/vcs_version.h.in && `,
	])
		assert(
			steps.some(
				(line) => line.startsWith("RUN --network=none ") && line.includes(told),
			),
			told,
		);

	// What is built in besides FFmpeg's own parts: nothing that its configure
	// finds among Debian's packages, nothing that may not be redistributed,
	// and each library and NVIDIA interface that bitovp uses, whether or not a
	// test of CI reaches it.
	const configure = steps.find((line) =>
		line.includes(" && ./configure --prefix=/opt/ffmpeg "),
	);
	assert(configure, "FFmpeg's configure step");
	assert.deepEqual(
		configure
			.slice(configure.indexOf(" && ./configure "))
			.match(/--(?:enable|disable)-[a-z0-9-]+/g)
			.sort(),
		[
			"--disable-autodetect",
			"--disable-debug",
			"--disable-doc",
			"--disable-ffplay",
			"--enable-gpl",
			"--enable-version3",
			"--enable-zlib",
			"--enable-iconv",
			"--enable-openssl",
			"--enable-libxml2",
			"--enable-libfreetype",
			"--enable-libharfbuzz",
			"--enable-libfribidi",
			"--enable-fontconfig",
			"--enable-libass",
			"--enable-libvmaf",
			"--enable-libx264",
			"--enable-libsvtav1",
			"--enable-libdav1d",
			"--enable-libsrt",
			"--enable-ffnvcodec",
			"--enable-cuda",
			"--enable-cuvid",
			"--enable-nvdec",
			"--enable-nvenc",
		].sort(),
	);

	// The image takes the two programs from that stage and from nowhere else,
	// and still requires what bitovp needs of them.
	const image = stages.at(-1);
	assert.equal(image.name, "");
	for (const line of [
		"COPY --from=ffmpeg /bin/ffmpeg /bin/ffprobe /usr/local/bin/",
		"COPY --from=ffmpeg /share/licenses/ /usr/local/share/licenses/",
	])
		assert(image.lines.includes(line), line);
	const checks = image.lines.find((line) => line.includes("-filters"));
	for (const check of [
		" && /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libvmaf' &&",
		" && /usr/local/bin/ffmpeg -hide_banner -version | grep -q -- '--enable-libsrt' &&",
		" && /usr/local/bin/ffmpeg -hide_banner -filters | grep -q ' libvmaf ' &&",
	])
		assert(checks.includes(check), check);
	// The checks are links of one chain, on the image's own files: nothing
	// excuses a failure, and no mount puts other programs in their place.
	assert.match(checks, /^RUN [^-]/, checks);
	assert.doesNotMatch(checks, /;|\|\||(?<!&)&(?!&)/, checks);
	assert.doesNotMatch(
		image.lines.join("\n"),
		/FFMPEG|ffmpeg[^\n]*\.tar|releases\/download/,
	);
	// No other instruction of the image names the two programs: no second
	// copy, package, download or mount. These four, in this order: the
	// programs and the licences arrive, then the checks, then the proof.
	assert.deepEqual(
		image.lines.filter((line) => /ffmpeg|ffprobe/i.test(line)),
		[
			"COPY --from=ffmpeg /bin/ffmpeg /bin/ffprobe /usr/local/bin/",
			"COPY --from=ffmpeg /share/licenses/ /usr/local/share/licenses/",
			checks,
			image.lines.find((line) =>
				line.startsWith(
					"RUN --mount=type=bind,source=docker/vmaf-build-proof.sh,target=/tmp/vmaf-build-proof.sh ",
				),
			),
		],
	);
});

// Stands in for Docker's build: records its arguments and, unless it is to
// fail, writes the programs that the "ffmpeg" stage holds into the output
// directory. It writes below the test's own directory `SANDBOX` only: a call
// that names no output directory, or another one, must not reach the
// system's /bin. Like every stand-in of this test it records the number of
// its arguments too: a path with a space that fell apart would raise it.
const FAKE_BUILD = `#!/bin/sh
printf 'docker[%s] %s\\n' "$#" "$*" >> "$CALLS"
[ "$FAKE_DOCKER" = 0 ] || exit "$FAKE_DOCKER"
dest=
for argument in "$@"; do
	case "$argument" in type=local,dest=*) dest=\${argument#type=local,dest=} ;; esac
done
case "$dest" in
	"$SANDBOX"/*) ;;
	*) echo "stand-in docker: no output directory of this test" >&2; exit 64 ;;
esac
mkdir -p "$dest/bin" "$dest/share/licenses/ffmpeg"
for program in $FAKE_PROGRAMS; do
	cat > "$dest/bin/$program" <<'PROGRAM'
#!/bin/sh
name=\${0##*/}
printf '%s[%s] %s\\n' "$name" "$#" "$*" >> "$CALLS"
case "$*" in
	*-version) printf '%s version stand-in\\nbuilt with a compiler\\n' "$name" ;;
	*) printf '%s\\n' "$FAKE_SCORE" >&2 ;;
esac
PROGRAM
	chmod +x "$dest/bin/$program"
done
`;

test("the installer builds the Dockerfile's own FFmpeg stage into a new directory with a plain path, and proves it with the pinned models", () => {
	const parent = realpathSync(
		mkdtempSync(join(tmpdir(), "gated-media-tools-")),
	);
	try {
		// The installer refuses any other character in the path of its target.
		assert.match(
			parent,
			/^[A-Za-z0-9/._-]+$/,
			"this test needs a temporary directory whose path holds only letters, digits and / . _ -; set TMPDIR to one",
		);
		const tools = join(parent, "tools");
		mkdirSync(tools);
		writeFileSync(join(tools, "docker"), FAKE_BUILD, { mode: 0o700 });
		// Answers the one question that the installer asks: the system's name.
		writeFileSync(
			join(tools, "uname"),
			'#!/bin/sh\n[ "$*" = -s ] || exit 64\nprintf \'%s\\n\' "$FAKE_UNAME"\n',
			{ mode: 0o700 },
		);
		// The argument after -o is the file to write, below this test's
		// directory only.
		writeFileSync(
			join(tools, "curl"),
			'#!/bin/sh\nprintf \'curl[%s] %s\\n\' "$#" "$*" >> "$CALLS"\n[ "$FAKE_CURL" = 0 ] || exit "$FAKE_CURL"\nfile=\nwhile [ "$#" -gt 1 ]; do\n\t[ "$1" != -o ] || file=$2\n\tshift\ndone\ncase "$file" in\n\t"$SANDBOX"/*) echo model > "$file" ;;\n\t*) echo "stand-in curl: no file of this test" >&2; exit 64 ;;\nesac\n',
			{ mode: 0o700 },
		);
		writeFileSync(
			join(tools, "sha256sum"),
			'#!/bin/sh\nprintf \'sha256sum[%s] %s in %s\\n\' "$#" "$*" "$(pwd)" >> "$CALLS"\nexit "$FAKE_SUM"\n',
			{ mode: 0o700 },
		);
		const reference = "c".repeat(40);
		const pinned = `FROM scratch\nARG VMAF_MODEL_REF="${reference}"\n`;
		const digest = "d".repeat(64);
		const listed = [
			"vmaf_v0.6.1.json",
			"vmaf_v1.0.16_3d0h.json",
			"vmaf_v1.0.16_hfr_3d0h.json",
		];
		const list = (names) =>
			`# model checksums\n${names.map((name) => `${digest}  ${name}\n`).join("")}`;
		const perfect = "[Parsed_libvmaf_0 @ 0x1] VMAF score: 100.000000";
		let count = 0;
		// One run of the installer, in a checkout of its own whose path holds a
		// space: each path the installer builds from it must stay one word. The
		// target is given by its whole path and the installer runs in an empty
		// directory; with `at`, it runs in the directory of that name and is
		// given the target's name alone.
		const install = ({
			shell,
			file = pinned,
			models = list(listed),
			name = "media",
			at,
			before = () => {},
			host = "Linux",
			docker = 0,
			programs = "ffmpeg ffprobe",
			curl = 0,
			sum = 0,
			score = perfect,
		}) => {
			count += 1;
			const run = join(parent, `run-${count}`);
			const checkout = join(run, "check out");
			const place = join(run, at ?? "place");
			const elsewhere = join(run, "elsewhere");
			const temporary = join(run, "tmp");
			for (const directory of [
				join(checkout, "scripts"),
				join(checkout, "docker"),
				place,
				elsewhere,
				temporary,
			])
				mkdirSync(directory, { recursive: true });
			copyFileSync(
				resolve(root, "scripts/native-media-tools.sh"),
				join(checkout, "scripts/native-media-tools.sh"),
			);
			copyFileSync(
				resolve(root, "docker/vmaf-build-proof.sh"),
				join(checkout, "docker/vmaf-build-proof.sh"),
			);
			writeFileSync(join(checkout, "Dockerfile"), file);
			// With `models: null` the checkout has no list of models.
			if (models !== null)
				writeFileSync(join(checkout, "docker/vmaf-models.sha256"), models);
			const calls = join(run, "calls");
			writeFileSync(calls, "");
			const target = join(place, name);
			before(target);
			const result = spawnSync(
				shell,
				[join(checkout, "scripts/native-media-tools.sh"), at ? name : target],
				{
					cwd: at ? place : elsewhere,
					encoding: "utf8",
					env: {
						PATH: `${tools}:/usr/bin:/bin`,
						TMPDIR: temporary,
						CALLS: calls,
						SANDBOX: parent,
						FAKE_UNAME: host,
						FAKE_DOCKER: String(docker),
						FAKE_PROGRAMS: programs,
						FAKE_CURL: String(curl),
						FAKE_SUM: String(sum),
						FAKE_SCORE: score,
					},
				},
			);
			// Whatever the run came to, it wrote into its target only: nothing
			// into the checkout or the directory it ran in, and the proof's log
			// is gone.
			assert.deepEqual(readdirSync(checkout).sort(), [
				"Dockerfile",
				"docker",
				"scripts",
			]);
			assert.deepEqual(
				readdirSync(join(checkout, "docker")).sort(),
				models === null
					? ["vmaf-build-proof.sh"]
					: ["vmaf-build-proof.sh", "vmaf-models.sha256"],
			);
			assert.deepEqual(readdirSync(join(checkout, "scripts")), [
				"native-media-tools.sh",
			]);
			assert.deepEqual(readdirSync(elsewhere), []);
			assert.deepEqual(readdirSync(temporary), []);
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				checkout,
				target,
				calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
			};
		};
		// Each call with the number of its arguments.
		const BUILD = ({ checkout, target }) =>
			`docker[8] build --file ${checkout}/Dockerfile --target ffmpeg --output type=local,dest=${target} ${checkout}`;
		const FETCH = ({ target }, path, model) =>
			`curl[12] -fsSL --proto =https --proto-redir =https --retry 3 --max-time 120 https://raw.githubusercontent.com/Netflix/vmaf/${reference}/model/${path} -o ${target}/model/${model}`;
		const SUM = ({ checkout, target }) =>
			`sha256sum[3] -c --strict ${checkout}/docker/vmaf-models.sha256 in ${target}/model`;
		const PIN =
			"The Dockerfile does not pin VMAF_MODEL_REF once as a plain value\n";
		const PATH =
			"The directory's path may hold only letters, digits and / . _ -\n";
		const MODEL = "docker/vmaf-models.sha256 holds an unexpected model name\n";
		const EMPTY = "docker/vmaf-models.sha256 names no model\n";
		// CI runs it with sh, which is dash there.
		const shells = ["sh", "dash"].filter(
			(shell) =>
				spawnSync(shell, ["-c", ":"], { env: { PATH: "/usr/bin:/bin" } })
					.status === 0,
		);
		assert(shells.includes("sh"));
		for (const shell of shells) {
			const done = install({ shell });
			assert.equal(done.status, 0, done.stderr);
			assert.equal(
				done.stdout,
				"ffmpeg version stand-in\nVMAF models: 3 files verified\n",
			);
			assert.equal(done.stderr, "");
			// The stage of this checkout's Dockerfile and nothing else is built;
			// each model comes from its own directory of the pinned revision.
			assert.deepEqual(done.calls.slice(0, 5), [
				BUILD(done),
				FETCH(done, "vmaf_v0.6.1.json", "vmaf_v0.6.1.json"),
				FETCH(
					done,
					"vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json",
					"vmaf_v1.0.16_3d0h.json",
				),
				FETCH(
					done,
					"vmaf_v1.0.16_hfr/vmaf_v1.0.16_hfr_3d0h.json",
					"vmaf_v1.0.16_hfr_3d0h.json",
				),
				SUM(done),
			]);
			// Then the proof with the built program, and its version.
			assert.equal(done.calls.length, 7);
			assert.match(
				done.calls[5],
				/^ffmpeg\[15\] -hide_banner -nostdin .* -lavfi \[0:v\]\[1:v\]libvmaf=model=path=\S+\/media\/model\/vmaf_v1\.0\.16_3d0h\.json -f null -$/,
			);
			assert.equal(done.calls[6], "ffmpeg[2] -hide_banner -version");
			assert.deepEqual(readdirSync(done.target).sort(), [
				"bin",
				"model",
				"share",
			]);

			// Refused before Docker is asked for anything.
			for (const [options, stderr] of [
				[{ file: "FROM scratch\n" }, PIN],
				[{ file: `${pinned}ARG VMAF_MODEL_REF="${reference}"\n` }, PIN],
				[{ file: `FROM scratch\nARG VMAF_MODEL_REF="main/../x"\n` }, PIN],
				[{ file: `FROM scratch\nARG VMAF_MODEL_REF=${reference}\n` }, PIN],
				[{ models: list(["../vmaf_v0.6.1.json"]) }, MODEL],
				[{ models: list(["sub/vmaf_v0.6.1.json"]) }, MODEL],
				[{ models: list([".hidden.json"]) }, MODEL],
				[{ models: `${digest}\n` }, MODEL],
				// A name becomes a part of a URL, where these characters mean
				// something to curl or to the server.
				[{ models: list(["vmaf_v0.6.1.json?x"]) }, MODEL],
				[{ models: list(["vmaf_v[0-1].json"]) }, MODEL],
				[{ models: list(["vmaf v0.6.1.json"]) }, MODEL],
				// A list without a model, or no list: nothing would be proven.
				[{ models: "# model checksums\n" }, EMPTY],
				[{ models: "" }, EMPTY],
				[
					{ models: null },
					/^grep: [^\n]*\/docker\/vmaf-models\.sha256: [^\n]*\ndocker\/vmaf-models\.sha256 names no model\n$/,
				],
				[{ name: "with space" }, PATH],
				[{ name: "a,b=c" }, PATH],
				[{ name: "a,b" }, PATH],
				[{ name: "a=b" }, PATH],
				[{ name: "$(id)" }, PATH],
				// The whole path counts, also when only a name is given.
				[{ at: "a,b=c" }, PATH],
				[{ host: "Darwin" }, "The image's FFmpeg runs on Linux only\n"],
				// The shell's own message, in one line: the script went no further.
				[{ name: "absent/media" }, /^[^\n]*\bcd\b[^\n]*\n$/],
				[{ before: (path) => mkdirSync(path) }, /^[^\n]*\bmkdir\b[^\n]*\n$/],
			]) {
				const refused = install({ shell, ...options });
				assert.notEqual(refused.status, 0);
				assert.equal(refused.stdout, "");
				if (typeof stderr === "string") assert.equal(refused.stderr, stderr);
				else assert.match(refused.stderr, stderr);
				assert.deepEqual(refused.calls, []);
				// And before a directory is made: the next run finds none in its way.
				if (options.before) assert.deepEqual(readdirSync(refused.target), []);
				else assert.equal(existsSync(refused.target), false);
			}

			// A build that fails, or that lacks a program, ends the installer
			// before a model is fetched.
			const failed = install({ shell, docker: 3 });
			assert.equal(failed.status, 3);
			assert.equal(failed.stdout, "");
			assert.deepEqual(failed.calls, [BUILD(failed)]);
			// It leaves no empty directory in the way of the next run.
			assert.equal(existsSync(failed.target), false);
			for (const [programs, missing] of [
				["ffmpeg", "ffprobe"],
				["ffprobe", "ffmpeg"],
				["", "ffmpeg"],
			]) {
				const lacking = install({ shell, programs });
				assert.equal(lacking.status, 1);
				assert.equal(lacking.stdout, "");
				assert.equal(
					lacking.stderr,
					`The Dockerfile's ffmpeg stage did not provide bin/${missing}\n`,
				);
				assert.deepEqual(lacking.calls, [BUILD(lacking)]);
			}

			// A model that cannot be fetched, or whose bytes are not the pinned
			// ones, ends it before FFmpeg is started.
			const unfetched = install({ shell, curl: 22 });
			assert.notEqual(unfetched.status, 0);
			assert.equal(unfetched.stdout, "");
			assert.equal(unfetched.calls.length, 2);
			const altered = install({ shell, sum: 1 });
			assert.notEqual(altered.status, 0);
			assert.equal(altered.stdout, "");
			assert.equal(altered.calls.at(-1), SUM(altered));

			// A program that does not score ends it before it is announced.
			const wrong = install({
				shell,
				score: "[Parsed_libvmaf_0 @ 0x1] VMAF score: 0.000000",
			});
			assert.equal(wrong.status, 1);
			assert.equal(wrong.stdout, "");
			assert(
				wrong.stderr.endsWith(
					`FFmpeg did not score two identical pictures as 100 with ${wrong.target}/model/vmaf_v1.0.16_3d0h.json\n`,
				),
			);
			assert.equal(wrong.calls.length, 6);
		}
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("CI audits every package's skipped tests and runs the native media and Redis tests with the pinned tools", () => {
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
			`\\n {6}- run: pnpm --filter @bitovp/\\$\\{\\{ matrix\\.package \\}\\} test --maxWorkers=2 --reporter=default --reporter=github-actions --reporter=json --outputFile\\.json=${report}\\n` +
				"      - name: Require every skipped test to run in another job\\n" +
				`        run: pnpm test:skip-audit "@bitovp/\\$\\{\\{ matrix\\.package \\}\\}" ${report}\\n$`,
		),
	);
	// Nothing may switch the job or a step off, or let a failure pass: the only
	// condition is the one that prepares the web package.
	assert.match(
		ci,
		/\non:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/,
	);
	assert.doesNotMatch(tests, /continue-on-error|needs:|exclude:|include:/);
	assert.deepEqual(tests.match(/^\s*(?:- )?if:.*$/gm), [
		"        if: matrix.package == 'web'",
	]);
	// This suite also runs in a job that does not depend on the jobs it guards.
	const quality = job("quality");
	assert(quality.includes("\n      - run: pnpm test:gated-runner\n"));
	assert.doesNotMatch(quality, /continue-on-error|^\s*(?:- )?(?:if|needs):/m);
	// A job that installs pinned tools and then runs gated tests: its commands in
	// this order, each a whole line, and the test command last.
	const gatedJob = (name, lines, ending) => {
		const text = job(name);
		const order = lines.map((line) => text.indexOf(line));
		assert(
			order.every((at) => at !== -1),
			`${name}: ${JSON.stringify(order)}`,
		);
		assert.deepEqual(
			order,
			[...order].sort((a, b) => a - b),
		);
		// The job must not start on a condition that could skip it.
		assert.doesNotMatch(text, /continue-on-error|^\s*(?:- )?(?:if|needs):/m);
		// No `|| true`, no comment, nothing appended.
		const commands = text.split("\n").map((line) => line.trim());
		for (const line of lines)
			assert(
				commands.includes(line) || commands.includes(`- ${line}`),
				`${name}: ${line}`,
			);
		assert(text.endsWith(ending), name);
	};
	gatedJob(
		"native-media",
		[
			"run: pnpm install --frozen-lockfile",
			"run: pnpm test:gated-runner",
			'sh scripts/native-media-tools.sh "$RUNNER_TEMP/native-media"',
			`printf '%s\\n' "$RUNNER_TEMP/native-media/bin" >> "$GITHUB_PATH"`,
			`printf 'VMAF_MODEL_DIR=%s\\n' "$RUNNER_TEMP/native-media/model" >> "$GITHUB_ENV"`,
			"run: pnpm test:native-media",
		],
		"      - name: Run every test that drives real FFmpeg\n        run: pnpm test:native-media\n",
	);
	gatedJob(
		"redis-integration",
		[
			"run: pnpm install --frozen-lockfile",
			"run: pnpm test:gated-runner",
			"run: pnpm --filter @bitovp/db build",
			'sh scripts/redis-server-tools.sh "$RUNNER_TEMP/redis"',
			`printf '%s\\n' "$RUNNER_TEMP/redis/bin" >> "$GITHUB_PATH"`,
			"run: pnpm test:redis",
		],
		"      - name: Run every test that needs Redis\n        run: pnpm test:redis\n",
	);

	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	assert.equal(
		pkg.scripts["test:native-media"],
		"node scripts/gated-tests.mjs --native-media",
	);
	assert.equal(
		pkg.scripts["test:redis"],
		"node scripts/gated-tests.mjs --redis",
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
