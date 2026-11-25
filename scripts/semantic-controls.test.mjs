import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import SemanticControlReporter, {
	assess,
	digest,
	groupExists,
	guardedCommand,
	mutate,
	qualifyMutation,
} from "./semantic-controls.mjs";
import { CONTROLS } from "./semantic-controls-registry.mjs";

const root = resolve(import.meta.dirname, "..");
const meta = (mutant) => ({
	reason: mutant ? "failed" : "passed",
	unhandled: 0,
	collectionErrors: 0,
});
function report(control, mutant, checkout = root) {
	const cases = control.cases.map((fullName) => ({
		fullName,
		status: mutant && control.failures[fullName] ? "failed" : "passed",
		failureMessages:
			mutant && control.failures[fullName]
				? [`${control.failures[fullName]}\n at fixture.ts:1`]
				: [],
	}));
	const failed = cases.filter((entry) => entry.status === "failed").length;
	return {
		success: !mutant,
		numTotalTests: cases.length,
		numPassedTests: cases.length - failed,
		numFailedTests: failed,
		numPendingTests: 0,
		numTodoTests: 0,
		numFailedTestSuites: mutant ? 2 : 0,
		numPendingTestSuites: 0,
		testResults: [
			{
				name: join(checkout, control.directory, Object.keys(control.files)[0]),
				status: mutant ? "failed" : "passed",
				message: "",
				assertionResults: cases,
			},
		],
	};
}

test("four fixed product faults retain complete, distinct 96-case inventories and 22 semantic witnesses", () => {
	assert.deepEqual(
		CONTROLS.map((control) => control.id),
		[
			"tenant-dispatch-ownership",
			"paid-start-single-send",
			"hdr-result-segregation",
			"abort-retains-process-ownership",
		],
	);
	assert.equal(
		CONTROLS.reduce((sum, control) => sum + control.cases.length, 0),
		96,
	);
	assert.equal(
		CONTROLS.reduce(
			(sum, control) => sum + Object.keys(control.failures).length,
			0,
		),
		22,
	);
	for (const control of CONTROLS) {
		assert.equal(Object.keys(control.files).length, 1);
		assert.equal(Object.values(control.files)[0], control.cases.length);
		assert.equal(new Set(control.cases).size, control.cases.length);
		for (const name of Object.keys(control.failures))
			assert(control.cases.includes(name));
		const source = readFileSync(join(root, control.source), "utf8");
		assert.notEqual(mutate(control, source), source);
		assert.throws(() => mutate(control, "no anchor"), /SOURCE_ANCHOR_MISMATCH/);
		assert.throws(
			() => mutate(control, source + source),
			/SOURCE_ANCHOR_MISMATCH/,
		);
	}
});

test("only the full observed semantic failure inventory qualifies as detection", () => {
	for (const control of CONTROLS) {
		assess(control, report(control, false), 0, "baseline", root, meta(false));
		assess(control, report(control, true), 1, "mutant", root, meta(true));
		assess(control, report(control, false), 0, "restored", root, meta(false));
		const changes = [
			(r) => {
				r.testResults = [];
			},
			(r) => {
				r.testResults.push(r.testResults[0]);
			},
			(r) => {
				r.testResults[0].name += ".other";
			},
			(r) => {
				r.testResults[0].message = "beforeAll failed";
			},
			(r) => {
				r.testResults[0].assertionResults.pop();
			},
			(r) => {
				r.testResults[0].assertionResults[0].fullName = "unrelated assertion";
			},
			(r) => {
				r.numPendingTests = 1;
			},
			(r) => {
				r.numTodoTests = 1;
			},
			(r) => {
				r.numPendingTestSuites = 1;
			},
			(r) => {
				r.numPassedTests++;
			},
			(r) => {
				r.numFailedTests--;
			},
			(r) => {
				r.testResults[0].assertionResults.find(
					(entry) => entry.status === "failed",
				).failureMessages = ["Error: timed out after 20000ms"];
			},
			(r) => {
				r.testResults[0].assertionResults
					.find((entry) => entry.status === "failed")
					.failureMessages.push("afterEach failed");
			},
			(r) => {
				r.testResults[0].assertionResults.find(
					(entry) => entry.status === "passed",
				).status = "skipped";
			},
		];
		for (const change of changes) {
			const altered = report(control, true);
			change(altered);
			assert.throws(() =>
				assess(control, altered, 1, "mutant", root, meta(true)),
			);
		}
		for (const code of [0, 2, 124, 137, null])
			assert.throws(() =>
				assess(
					control,
					report(control, true),
					code,
					"mutant",
					root,
					meta(true),
				),
			);
		for (const extra of [
			{ unhandled: 1 },
			{ collectionErrors: 1 },
			{ reason: "interrupted" },
		])
			assert.throws(() =>
				assess(control, report(control, true), 1, "mutant", root, {
					...meta(true),
					...extra,
				}),
			);
		assert.throws(
			() =>
				assess(control, report(control, false), 0, "mutant", root, meta(false)),
			/MUTATION_NOT_DETECTED/,
		);
	}
});

test("qualification never mutates a failed baseline and always restores after failures or cancellation", async () => {
	const control = CONTROLS[0];
	for (const mode of [
		"success",
		"baseline failure",
		"command failure",
		"wrong failure",
		"test drift",
		"source drift",
		"cancelled",
	]) {
		const directory = mkdtempSync(join(tmpdir(), "semantic-contract-"));
		const target = join(directory, "source.ts"),
			testPath = join(directory, "case.ts");
		writeFileSync(target, control.anchor);
		writeFileSync(testPath, "unchanged assertion");
		const stages = [];
		const controller = new AbortController();
		try {
			const run = qualifyMutation({
				target,
				tests: [testPath],
				mutate: (source) => mutate(control, source),
				signal: controller.signal,
				run: async (stage) => {
					stages.push(stage);
					assert.equal(
						readFileSync(target, "utf8"),
						stage === "mutant" ? control.replacement : control.anchor,
					);
					if (
						mode === "baseline failure" ||
						(stage === "mutant" && mode === "command failure")
					)
						throw new Error(mode);
					if (stage === "mutant") {
						if (mode === "test drift")
							writeFileSync(testPath, "changed assertion");
						if (mode === "source drift")
							writeFileSync(target, "unowned change");
						if (mode === "cancelled") controller.abort();
					}
					const r = report(control, stage === "mutant");
					return {
						report: r,
						code: stage === "mutant" ? 1 : 0,
						reportSha256: digest(JSON.stringify(r)),
					};
				},
				assess: (result, stage) => {
					if (stage === "mutant" && mode === "wrong failure")
						throw new Error("wrong assertion");
					assess(
						control,
						result.report,
						result.code,
						stage,
						root,
						meta(stage === "mutant"),
					);
				},
			});
			if (mode === "success") {
				const result = await run;
				assert.deepEqual(
					result.stages.map((stage) => stage.name),
					["baseline", "mutant", "restored"],
				);
				assert.equal(
					result.stages[0].sourceSha256,
					result.stages[2].sourceSha256,
				);
			} else await assert.rejects(run);
			assert.equal(readFileSync(target, "utf8"), control.anchor);
			assert.deepEqual(
				stages,
				mode === "success"
					? ["baseline", "mutant", "restored"]
					: mode === "baseline failure"
						? ["baseline"]
						: ["baseline", "mutant"],
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test("reporter retains unhandled and collection error counts without private messages", () => {
	const directory = mkdtempSync(join(tmpdir(), "semantic-reporter-"));
	const previous = process.env.BITOVP_SEMANTIC_REPORT;
	try {
		process.env.BITOVP_SEMANTIC_REPORT = join(directory, "meta.json");
		new SemanticControlReporter().onTestRunEnd(
			[
				{
					errors: () => ["private collection error"],
					children: {
						allSuites: () => [{ errors: () => ["private hook error"] }],
					},
				},
			],
			["private unhandled error"],
			"failed",
		);
		assert.deepEqual(
			JSON.parse(readFileSync(process.env.BITOVP_SEMANTIC_REPORT)),
			{ reason: "failed", unhandled: 1, collectionErrors: 2 },
		);
	} finally {
		if (previous === undefined) delete process.env.BITOVP_SEMANTIC_REPORT;
		else process.env.BITOVP_SEMANTIC_REPORT = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("failed restoration remains a failure even when the mutant produced its intended result", async () => {
	const directory = mkdtempSync(join(tmpdir(), "semantic-restore-"));
	const target = join(directory, "source.ts");
	writeFileSync(target, "original");
	try {
		await assert.rejects(
			qualifyMutation({
				target,
				tests: [],
				mutate: () => "changed",
				run: async (stage) => {
					if (stage === "mutant") {
						rmSync(target);
						mkdirSync(target);
					}
					return {
						report: { numPassedTests: 1, numFailedTests: 0 },
						code: 0,
						reportSha256: "fixture",
					};
				},
				assess: () => {},
			}),
			{ code: "RESTORATION_FAILED" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function until(check, timeout = 5000) {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeout)
			throw new Error("Owned child observation timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("owned test processes stop when their actual runner parent dies", {
	timeout: 10000,
}, async () => {
	const directory = mkdtempSync(join(tmpdir(), "semantic-owner-"));
	const ready = join(directory, "ready"),
		groupPath = join(directory, "group"),
		exitPath = join(directory, "exit");
	const module = pathToFileURL(
		join(root, "scripts/semantic-controls.mjs"),
	).href;
	const ownerCode = `import {guardedCommand} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; await guardedCommand(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`)}], {cwd:${JSON.stringify(directory)},exitPath:${JSON.stringify(exitPath)},timeout:8000,onSpawn:(pid)=>writeFileSync(${JSON.stringify(groupPath)},String(pid))});`;
	const owner = spawn(
		process.execPath,
		["--input-type=module", "-e", ownerCode],
		{ stdio: "ignore" },
	);
	const closed = once(owner, "close");
	let group;
	try {
		await until(() => existsSync(ready) && existsSync(groupPath));
		group = Number(readFileSync(groupPath, "utf8"));
		assert(groupExists(group));
		owner.kill("SIGKILL");
		await closed;
		await until(() => !groupExists(group));
		assert(
			!existsSync(exitPath),
			"Parent death must not become a completed test result",
		);
	} finally {
		owner.kill("SIGKILL");
		if (group && groupExists(group)) process.kill(-group, "SIGKILL");
		await closed;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("guarded command preserves the actual child exit and bounds a stuck child", {
	timeout: 10000,
}, async () => {
	const directory = mkdtempSync(join(tmpdir(), "semantic-command-"));
	let group;
	try {
		assert.equal(
			await guardedCommand(process.execPath, ["-e", "process.exit(1)"], {
				cwd: directory,
				exitPath: join(directory, "exit"),
				timeout: 1000,
			}),
			1,
		);
		await assert.rejects(
			guardedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				cwd: directory,
				exitPath: join(directory, "timeout"),
				timeout: 100,
				onSpawn: (pid) => {
					group = pid;
				},
			}),
		);
		assert(!groupExists(group));
	} finally {
		if (group && groupExists(group)) process.kill(-group, "SIGKILL");
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a timed out command keeps its timeout after the last owned descendant is killed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "semantic-timeout-"));
	const ready = join(directory, "descendant-ready");
	let group;
	// An inherited output pipe would keep the supervisor's close event pending.
	// The background worker has no such pipe and outlives the first group TERM.
	const descendant = `
		process.on("SIGTERM", () => {});
		require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
		setInterval(() => {}, 1000);`;
	const driver = `
		require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"});
		setInterval(() => {}, 1000);`;
	try {
		await assert.rejects(
			guardedCommand(process.execPath, ["-e", driver], {
				cwd: directory,
				exitPath: join(directory, "exit"),
				timeout: 1200,
				onSpawn: (pid) => {
					group = pid;
				},
			}),
			{ code: "COMMAND_TIMEOUT" },
		);
		assert(existsSync(ready), "the survivor was running at the timeout");
		assert(!groupExists(group), "the owned process group must be gone");
	} finally {
		if (group && groupExists(group)) process.kill(-group, "SIGKILL");
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an exited command cannot leave its owned child running in the same group", {
	timeout: 5000,
}, async () => {
	const directory = mkdtempSync(join(tmpdir(), "semantic-descendant-"));
	let group;
	try {
		await assert.rejects(
			guardedCommand(
				process.execPath,
				[
					"-e",
					"require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:false}).unref()",
				],
				{
					cwd: directory,
					exitPath: join(directory, "exit"),
					timeout: 2000,
					onSpawn: (pid) => {
						group = pid;
					},
				},
			),
			{ code: "PROCESS_GROUP_REMAINED" },
		);
		assert(!groupExists(group));
	} finally {
		if (group && groupExists(group)) process.kill(-group, "SIGKILL");
		rmSync(directory, { recursive: true, force: true });
	}
});

test("direct and symbolic-link CLI entry points reject unsupported arguments without running a mutation", () => {
	const directory = mkdtempSync(join(tmpdir(), "semantic-cli-"));
	try {
		const source = join(root, "scripts/semantic-controls.mjs");
		const link = join(directory, "control.mjs");
		symlinkSync(source, link);
		for (const entry of [source, link]) {
			const result = spawnSync(process.execPath, [entry, "--unknown"], {
				encoding: "utf8",
				timeout: 5000,
			});
			assert.equal(result.status, 1);
			assert.match(result.stderr, /failed validation/);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("CI always runs all fixed semantic controls and the package keeps its runner contract", () => {
	const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
	const block = workflow
		.split("\n  semantic-controls:\n")[1]
		?.split(/\n {2}[A-Za-z][^\n]*:\n/)[0];
	assert(block, "Missing semantic-controls job");
	assert(
		!/^\s+(if|continue-on-error):/m.test(block) && !/^ {4}needs:/m.test(block),
		"Semantic control job must run independently and unconditionally",
	);
	assert.match(block, /runs-on: ubuntu-latest/);
	assert.match(block, /pnpm install --frozen-lockfile/);
	assert.match(block, /pnpm --filter @bitovp\/db build/);
	assert.match(block, /pnpm test:semantic-controls/);
	assert.match(
		block,
		/node scripts\/semantic-controls\.mjs --output "\$RUNNER_TEMP\/semantic-controls"/,
	);
	const pkg = JSON.parse(readFileSync(join(root, "package.json")));
	assert.equal(
		pkg.scripts["test:semantic-controls"],
		"node --test scripts/semantic-controls.test.mjs",
	);
});
