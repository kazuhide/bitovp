import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	browserExecutionAllowed,
	CASES,
	childEnvironment,
	cleanupFixture,
	composeOverride,
	failureSummary,
	inside,
	validateExecutionMode,
	validateReport,
	workerReady,
} from "./installed-gui-smoke.mjs";

const id = "0123456789abcdef0123456789abcdef";
const root = resolve(import.meta.dirname, "..");
const report = () => ({
	stats: { unexpected: 0, skipped: 0, flaky: 0, expected: CASES.length },
	suites: [
		{
			specs: CASES.map((title) => ({
				title,
				tests: [{ status: "expected", results: [{ status: "passed" }] }],
			})),
		},
	],
});

test("all browser definitions load in collection-only mode without running a case", () => {
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), "bitovp-collect-")),
	);
	try {
		const fixture = join(directory, "fixture.json");
		const output = join(directory, "report.json");
		const config = join(directory, "collect.config.mjs");
		writeFileSync(fixture, "{}", { mode: 0o600 });
		writeFileSync(
			config,
			`export default ${JSON.stringify({
				testDir: join(root, "tests/browser"),
				testMatch: "installed-gui.test.ts",
				reporter: [["json", { outputFile: output }]],
				outputDir: join(directory, "output"),
			})};`,
			{ mode: 0o600 },
		);
		const result = spawnSync(
			process.execPath,
			[
				join(root, "node_modules/@playwright/test/cli.js"),
				"test",
				"--list",
				"--config",
				config,
			],
			{
				cwd: root,
				env: {
					...childEnvironment(process.env),
					TMPDIR: directory,
					TMP: directory,
					TEMP: directory,
					BITOVP_GUI_SMOKE_FIXTURE: fixture,
				},
				timeout: 30_000,
				maxBuffer: 2_000_000,
			},
		);
		assert.equal(result.status, 0, "Browser definition collection failed");
		const collected = JSON.parse(readFileSync(output, "utf8"));
		assert.deepEqual(collected.errors, []);
		const titles = [];
		const visit = (suite) => {
			for (const spec of suite.specs ?? []) {
				titles.push(spec.title);
				assert.equal(spec.tests.length, 1);
				assert.deepEqual(spec.tests[0].results, []);
			}
			for (const child of suite.suites ?? []) visit(child);
		};
		for (const suite of collected.suites) visit(suite);
		assert.deepEqual(titles, CASES);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("private state paths cannot use a dot-prefixed child or the checkout itself", () => {
	assert(inside("/checkout", "/checkout"));
	assert(inside("/checkout", "/checkout/..hidden/state"));
	assert(!inside("/checkout", "/private/state"));
	assert(!inside("/checkout", "/checkout-other/state"));
});

test("local browser execution and runtime-only CI completion fail closed", () => {
	const hosted = {
		GITHUB_ACTIONS: "true",
		RUNNER_ENVIRONMENT: "github-hosted",
		CI: "1",
	};
	assert(browserExecutionAllowed(hosted, "linux"));
	assert(!browserExecutionAllowed(hosted, "darwin"));
	assert(
		!browserExecutionAllowed(
			{ ...hosted, RUNNER_ENVIRONMENT: "self-hosted" },
			"linux",
		),
	);
	assert(!browserExecutionAllowed({}, "linux"));
	assert.throws(() => validateExecutionMode({}, false, "darwin"));
	assert.throws(() => validateExecutionMode(hosted, true, "linux"));
	assert.throws(() => validateExecutionMode({ CI: "1" }, true, "linux"));
	validateExecutionMode({}, true, "darwin");
});

test("does not forward application, cloud, Docker-context or authentication settings", () => {
	assert.deepEqual(
		childEnvironment({
			PATH: "/tools",
			DATABASE_URL: "private",
			AWS_SECRET_ACCESS_KEY: "private",
			BITMOVIN_API_KEY: "private",
			MASTER_KEY: "private",
			NODE_OPTIONS: "private",
		}),
		{
			PATH: "/tools",
			CI: "1",
			NEXT_TELEMETRY_DISABLED: "1",
			TURBO_TELEMETRY_DISABLED: "1",
		},
	);
	assert.throws(() => childEnvironment({ DOCKER_HOST: "tcp://remote:2375" }));
	assert.throws(() => childEnvironment({ DOCKER_CONTEXT: "remote" }));
});
test("overrides both root env files, all published ports and the media bind mount", () => {
	const text = composeOverride({ id, directory: "/private/smoke" });
	assert.equal((text.match(/env_file: !override/g) ?? []).length, 4);
	assert.equal((text.match(/ports: !override/g) ?? []).length, 3);
	assert.match(text, /volumes: !override \[\]/);
	assert.match(text, /pg_isready --host=127\.0\.0\.1/);
	assert.match(text, /networks:\n {2}default:\n {4}labels:/);
	assert(!text.includes("verify-runs"));
	assert(!text.includes("3330"));
	assert.throws(() =>
		composeOverride({ id: "main", directory: "/private/smoke" }),
	);
});
test("requires every named browser case to run and pass once without skipping or retrying", () => {
	validateReport(report());
	for (const key of ["skipped", "flaky", "unexpected"]) {
		const changed = report();
		changed.stats[key] = 1;
		assert.throws(() => validateReport(changed));
	}
	const missing = report();
	missing.suites[0].specs.pop();
	assert.throws(() => validateReport(missing));
	const retried = report();
	retried.suites[0].specs[0].tests[0].results.push({ status: "passed" });
	assert.throws(() => validateReport(retried));
});
test("failure summaries expose only known case names and safe statuses", () => {
	const changed = report();
	const specs = changed.suites[0].specs;
	specs[0].tests[0].results[0] = {
		status: "failed",
		error: { message: "private password, URL and cookie" },
		attachments: [{ body: "private attachment" }],
	};
	specs[1].tests[0].results[0].status = "timedOut";
	specs[2].tests[0].results[0].status = "skipped";
	specs[3].tests[0].results.push({ status: "passed" });
	specs[4].tests[0].results[0].status = "private-status";
	const summary = failureSummary(JSON.stringify(changed));
	assert.deepEqual(summary, [
		`Browser case: ${CASES[0]}; status=failed`,
		`Browser case: ${CASES[1]}; status=timedOut`,
		`Browser case: ${CASES[2]}; status=skipped`,
		`Browser case: ${CASES[3]}; status=retried`,
		`Browser case: ${CASES[4]}; status=unknown`,
		`Browser case: ${CASES[5]}; status=passed`,
	]);
	assert(!summary.join("\n").includes("private"));
});
test("failed browser cases expose only the last fixed submission stage", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[2].tests[0];
	browserTest.results[0].status = "failed";
	browserTest.annotations = [
		{ type: "smoke-stage", description: "submit-clicked" },
		{ type: "smoke-stage", description: "post-received" },
		{ type: "smoke-stage", description: "private URL and token" },
		{ type: "private", description: "post-fulfilled" },
		null,
	];
	assert.equal(
		failureSummary(JSON.stringify(changed))[2],
		`Browser case: ${CASES[2]}; status=failed; stage=post-received`,
	);
	browserTest.results[0].status = "passed";
	assert.equal(
		failureSummary(JSON.stringify(changed))[2],
		`Browser case: ${CASES[2]}; status=passed`,
	);
});
test("failure page observations expose only bounded fixed categories", () => {
	const changed = report();
	const browserTest = changed.suites[0].specs[5].tests[0];
	browserTest.results[0].status = "failed";
	browserTest.annotations = [
		{ type: "smoke-state", description: "route-vod-new" },
		{ type: "smoke-state", description: "session-admin" },
		{ type: "smoke-state", description: "session-anonymous" },
		{ type: "smoke-state", description: "private URL and cookie" },
		{ type: "private", description: "session-admin" },
		null,
	];
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=failed; state=route-vod-new,session-admin,session-anonymous`,
	);
	browserTest.annotations = Array.from({ length: 100 }, () => ({
		type: "smoke-state",
		description: "session-admin",
	}));
	assert.equal(
		failureSummary(JSON.stringify(changed))[5].split("session-admin").length -
			1,
		24,
	);
	browserTest.results[0].status = "passed";
	assert.equal(
		failureSummary(JSON.stringify(changed))[5],
		`Browser case: ${CASES[5]}; status=passed`,
	);
});
test("missing and malformed browser reports produce constant failure categories", () => {
	assert.deepEqual(failureSummary(), [
		"Browser diagnostic: report unavailable",
	]);
	for (const raw of ["private invalid JSON", "null", "{}", '"private"'])
		assert.deepEqual(failureSummary(raw), [
			"Browser diagnostic: invalid report",
		]);
	const changed = report();
	changed.suites[0].specs[0].title = "private case name";
	assert.deepEqual(failureSummary(JSON.stringify(changed)), [
		"Browser diagnostic: unrecognized report structure",
	]);
});
test("failure summaries show unstarted cases and bound report traversal", () => {
	const changed = report();
	changed.suites[0].specs.pop();
	assert.equal(
		failureSummary(JSON.stringify(changed)).at(-1),
		`Browser case: ${CASES.at(-1)}; status=not-run`,
	);
	const duplicate = report();
	duplicate.suites[0].specs.push(duplicate.suites[0].specs[0]);
	assert.deepEqual(failureSummary(JSON.stringify(duplicate)), [
		"Browser diagnostic: unrecognized report structure",
	]);
	assert.deepEqual(failureSummary(" ".repeat(2_000_001)), [
		"Browser diagnostic: invalid report",
	]);
	assert.deepEqual(
		failureSummary(
			JSON.stringify({ suites: Array.from({ length: 257 }, () => ({})) }),
		),
		["Browser diagnostic: unrecognized report structure"],
	);
});
test("discovery errors expose fixed categories without raw module paths or messages", () => {
	const changed = report();
	changed.errors = [
		{ message: "Error: Cannot find module '/private/credential-path'" },
		{
			message: "Playwright Test did not expect test.describe.configure() here",
		},
		{ message: "Error: No tests found. private filter" },
		{
			message: "browserType.launch: Executable doesn't exist at /private/path",
		},
		{ message: "SyntaxError: private source text" },
		{ message: "Run browser verification on a GitHub-hosted Linux runner" },
		{ message: "Only the dedicated loopback installation may be tested" },
		{ message: "private error, cookie and password" },
	];
	assert.deepEqual(failureSummary(JSON.stringify(changed)).slice(0, 8), [
		"Browser diagnostic: module resolution",
		"Browser diagnostic: test registration",
		"Browser diagnostic: test discovery",
		"Browser diagnostic: browser launch",
		"Browser diagnostic: module loading",
		"Browser diagnostic: hosted runner guard",
		"Browser diagnostic: fixture configuration",
		"Browser diagnostic: unclassified preflight error",
	]);
	assert(
		!failureSummary(JSON.stringify(changed)).join("\n").includes("private"),
	);
});
test("failed cases expose only bounded line numbers from the known browser test file", () => {
	const changed = report();
	const result = changed.suites[0].specs[0].tests[0].results[0];
	result.status = "failed";
	result.error = {
		message: "private password and cookie",
		location: { file: "/private/installed-gui.test.ts", line: 173 },
		stack: "private URL and token\n at /private/installed-gui.test.ts:202:3",
	};
	assert.equal(
		failureSummary(JSON.stringify(changed))[0],
		`Browser case: ${CASES[0]}; status=failed; lines=173,202`,
	);
	assert(
		!failureSummary(JSON.stringify(changed)).join("\n").includes("private"),
	);
	for (const line of [0, -1, 10001, "private", 2.5]) {
		result.error.location.line = line;
		result.error.stack = "private data";
		assert.equal(
			failureSummary(JSON.stringify(changed))[0],
			`Browser case: ${CASES[0]}; status=failed`,
		);
	}
	for (const name of [
		"other-installed-gui.test.ts",
		"xinstalled-gui.test.ts",
		"other installed-gui.test.ts",
	]) {
		result.error.stack = `at /private/${name}:202:3`;
		assert.equal(
			failureSummary(JSON.stringify(changed))[0],
			`Browser case: ${CASES[0]}; status=failed`,
		);
	}
});
test("a process being up is insufficient without all worker queue registrations", () => {
	const queues = [
		"usageStatistics",
		"orchestrator",
		"liveChannel",
		"vmafRunner",
		"feederManager",
		"storageInspect",
		"notify",
		"startupProbe",
		"slateNormalize",
	];
	const ready = queues
		.map((queue) => `[worker:${queue}] listening on synthetic`)
		.join("\n");
	assert(workerReady(ready));
	for (const queue of queues)
		assert(!workerReady(ready.replace(`[worker:${queue}] listening on `, "")));
});
test("cleanup checks directory and Docker labels before removing anything", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "bitovp-gui-")));
	writeFileSync(join(directory, ".owner"), id, { mode: 0o600 });
	const removed = [];
	const execute = async (_executable, args) => {
		assert.deepEqual(args.slice(0, 2), [
			"--host",
			"unix:///var/run/docker.sock",
		]);
		if (args.includes("--filter"))
			return args.includes("ps") ? "owned-container" : "";
		if (args.includes("inspect"))
			return JSON.stringify([
				{
					Config: {
						Labels: {
							"io.bitovp.gui-smoke": "wrong",
							"com.docker.compose.project": `bitovp-gui-${id}`,
						},
					},
				},
			]);
		removed.push(args);
		return "";
	};
	try {
		await assert.rejects(cleanupFixture({ id, directory }, execute, {}));
		assert.equal(removed.length, 0);
		assert.equal(readFileSync(join(directory, ".owner"), "utf8"), id);
		writeFileSync(join(directory, ".owner"), "wrong");
		await assert.rejects(cleanupFixture({ id, directory }, execute, {}));
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("cleanup removes both independent installations and their child temporary files", async () => {
	const create = (owner) => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "bitovp-gui-")));
		writeFileSync(join(directory, ".owner"), owner, { mode: 0o600 });
		writeFileSync(join(directory, "child-temp"), "synthetic private output", {
			mode: 0o600,
		});
		return { id: owner, directory };
	};
	const secondary = create("fedcba9876543210fedcba9876543210");
	const primary = { ...create(id), secondary };
	const images = [];
	const execute = async (_command, args) => {
		assert.deepEqual(args.slice(0, 2), [
			"--host",
			"unix:///var/run/docker.sock",
		]);
		if (args.includes("--filter")) {
			const owner = args
				.find((arg) => arg.startsWith("label=io.bitovp.gui-smoke="))
				?.split("=")
				.at(-1);
			assert(owner === primary.id || owner === secondary.id);
			assert(
				args.includes(`label=com.docker.compose.project=bitovp-gui-${owner}`),
			);
		} else if (args.includes("image")) images.push(args.at(-1));
		else throw new Error("Unexpected cleanup operation");
		return "";
	};
	try {
		await cleanupFixture(primary, execute, {});
		assert(!existsSync(primary.directory));
		assert(!existsSync(secondary.directory));
		assert.deepEqual(images, [
			`bitovp-gui-web:${secondary.id}`,
			`bitovp-gui-worker:${secondary.id}`,
			`bitovp-gui-web:${primary.id}`,
			`bitovp-gui-worker:${primary.id}`,
		]);
	} finally {
		for (const instance of [primary, secondary])
			rmSync(instance.directory, { recursive: true, force: true });
	}
});
