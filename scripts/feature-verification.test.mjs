import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctor, runFeature } from "./feature-verification.mjs";
import { FEATURES, feature } from "./feature-verification-registry.mjs";

test("registry exposes exactly three bounded unit contracts and rejects arbitrary selection", () => {
	assert.deepEqual(
		FEATURES.map((f) => f.id),
		["qc-resource-allocation", "qc-measurement-validity", "qc-runtime-safety"],
	);
	for (const f of FEATURES) {
		assert.equal(f.scope, "unit-contract");
		assert.equal(f.timeoutMs, 120000);
		assert(Object.values(f.files).every((n) => Number.isInteger(n) && n > 0));
	}
	for (const id of [
		"",
		"all",
		"../x",
		"qc-resource-allocation --passWithNoTests",
	])
		assert.throws(() => feature(id), /UNKNOWN_FEATURE/);
});

test("doctor reports missing prerequisites without creating files", async () => {
	const root = mkdtempSync(join(tmpdir(), "feature-doctor-"));
	try {
		const result = await doctor(feature("qc-resource-allocation"), { root });
		assert.equal(result.ready, false);
		assert(
			result.checks.some(
				(c) => !c.ok && c.id === "suite:src/vmaf/resource-plan.test.ts",
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function passingReport(f, root) {
	const count = Object.values(f.files).reduce((a, b) => a + b, 0);
	return {
		success: true,
		numFailedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		numTotalTests: count,
		numPassedTests: count,
		testResults: Object.entries(f.files).map(([file, n]) => ({
			name: join(root, f.directory, file),
			status: "passed",
			assertionResults: Array.from({ length: n }, (_, i) => ({
				status: "passed",
				fullName: `contract ${i}`,
			})),
		})),
	};
}
const identity = () => ({ sha: "a".repeat(40), dirtyDigest: "b".repeat(64) });
async function scenario(t, change, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "feature-run-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const selected = feature("qc-resource-allocation");
	const output = join(root, "receipt");
	const source = join(root, "source");
	mkdirSync(source);
	const execute = async (_bin, args, options) => {
		options.onSpawn(2147483647);
		const report = passingReport(selected, source);
		if (change) change(report);
		const path = args.find((a) => a.startsWith("--outputFile=")).slice(13);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, JSON.stringify(report));
	};
	const result = await runFeature(selected.id, {
		root: source,
		output,
		execute: async (...args) => {
			args[2].onSpawn(2147483647);
			return (options.execute ?? execute)(...args);
		},
		inspect: async () => ({ ready: true, checks: [] }),
		sourceIdentity: identity,
		...Object.fromEntries(
			Object.entries(options).filter(([key]) => key !== "execute"),
		),
	});
	return { result, output, root: source };
}

test("successful execution retains receipt and sanitized report and cannot overwrite another run", async (t) => {
	const { result, output, root } = await scenario(t);
	assert.equal(result.status, "passed");
	assert.equal(result.cleanup, "complete");
	assert.equal(
		JSON.parse(readFileSync(join(output, "receipt.json"))).status,
		"passed",
	);
	assert.equal(result.actual.tests, 257);
	await assert.rejects(
		runFeature("qc-resource-allocation", { output, root }),
		/OUTPUT_EXISTS/,
	);
});
for (const [name, change] of [
	["missing", (r) => r.testResults.pop()],
	["duplicate", (r) => r.testResults.push(r.testResults[0])],
	[
		"skip",
		(r) => {
			r.testResults[0].assertionResults[0].status = "skipped";
		},
	],
	[
		"todo",
		(r) => {
			r.numTodoTests = 1;
		},
	],
	[
		"empty",
		(r) => {
			r.testResults = [];
			r.numTotalTests = 0;
		},
	],
	[
		"actual incorrect behavior",
		(r) => {
			r.success = false;
			r.numFailedTests = 1;
			r.testResults[0].assertionResults[0].status = "failed";
		},
	],
])
	test(`${name} never becomes a passing receipt`, async (t) => {
		const { result } = await scenario(t, change);
		assert.equal(result.status, "failed");
		assert.equal(result.reason, "REPORT_INVALID");
	});
test("missing report, command failure, capability failure and changed source stay distinct", async (t) => {
	for (const [options, reason] of [
		[{ execute: async () => {} }, "REPORT_MISSING"],
		[
			{
				execute: async () => {
					throw new Error("secret child details");
				},
			},
			"COMMAND_FAILED",
		],
		[
			{
				inspect: async () => ({
					ready: false,
					checks: [{ id: "missing", ok: false }],
				}),
			},
			"PREREQUISITE_MISSING",
		],
		[
			{
				sourceIdentity: (() => {
					let n = 0;
					return () => ({ ...identity(), sha: String(n++).repeat(40) });
				})(),
			},
			"SOURCE_CHANGED",
		],
	]) {
		const { result, output } = await scenario(t, undefined, options);
		assert.notEqual(result.status, "passed");
		assert.equal(result.reason, reason);
		assert(
			!readFileSync(join(output, "receipt.json"), "utf8").includes(
				"secret child details",
			),
		);
	}
});

test("malformed report shapes are rejected as report faults", async (t) => {
	for (const change of [
		(r) => {
			r.testResults = {};
		},
		(r) => {
			r.testResults[0].assertionResults = {};
		},
	]) {
		const { result } = await scenario(t, change);
		assert.equal(result.reason, "REPORT_INVALID");
	}
});
test("already cancelled execution never starts a command", async (t) => {
	const controller = new AbortController();
	controller.abort();
	const { result } = await scenario(t, undefined, {
		signal: controller.signal,
		execute: () => assert.fail("must not spawn"),
	});
	assert.equal(result.reason, "CANCELLED");
});
test("a successful report cannot excuse child failure", async (t) => {
	const { result } = await scenario(t, undefined, {
		execute: async (_bin, args, options) => {
			const { writeFileSync } = await import("node:fs");
			writeFileSync(
				args.at(-1).slice(13),
				JSON.stringify(
					passingReport(feature("qc-resource-allocation"), options.cwd),
				),
			);
			throw new Error("failed command");
		},
	});
	assert.equal(result.reason, "COMMAND_FAILED");
});

test("real CLI rejects empty, unknown and extra arguments without launching tests", async () => {
	const { spawnSync } = await import("node:child_process");
	for (const args of [
		[],
		["doctor", "unknown"],
		["run", "qc-resource-allocation", "--passWithNoTests"],
	]) {
		const result = spawnSync(
			process.execPath,
			[join(import.meta.dirname, "feature-verification.mjs"), ...args],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /UNKNOWN_FEATURE|USAGE/);
	}
});

test("registered entry points remain in the unconditional quality job", () => {
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url)),
	);
	assert.equal(
		pkg.scripts["verify:feature"],
		"node scripts/feature-verification.mjs",
	);
	assert.equal(
		pkg.scripts["test:feature-verification"],
		"node --test scripts/feature-verification.test.mjs",
	);
	assert(pkg.scripts.test.includes("pnpm test:feature-verification"));
	const ci = readFileSync(
		new URL("../.github/workflows/ci.yml", import.meta.url),
		"utf8",
	);
	const quality = ci.slice(
		ci.indexOf("\n  quality:\n"),
		ci.indexOf("\n  tests:\n"),
	);
	assert(quality.includes("\n      - run: pnpm test:feature-verification\n"));
	for (const { id } of FEATURES) {
		assert(
			quality.includes(
				`          pnpm verify:feature run ${id} --output "$RUNNER_TEMP/feature-${id}"\n`,
			),
			`quality must execute the registered ${id} contract`,
		);
	}
	assert.doesNotMatch(quality, /continue-on-error|^\s*(?:- )?(?:if|needs):/m);
});

test("timeout and cancellation await a real owned child close and preserve unrelated files", async (t) => {
	const { command } = await import("./media-smoke.mjs");
	for (const mode of ["timeout", "cancel"]) {
		let pid;
		const controller = new AbortController();
		let timer;
		try {
			const { result, output } = await scenario(t, undefined, {
				timeoutMs: mode === "timeout" ? 250 : 2000,
				signal: controller.signal,
				execute: (_binary, _args, options) =>
					command(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
						...options,
						env: {},
						onSpawn(value) {
							pid = value;
							options.onSpawn(value);
							if (mode === "cancel")
								timer = setTimeout(() => controller.abort(), 100);
						},
					}),
			});
			assert.equal(result.reason, mode === "timeout" ? "TIMEOUT" : "CANCELLED");
			assert.equal(result.cleanup, "complete");
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
			assert.equal(
				JSON.parse(readFileSync(join(output, "receipt.json"))).reason,
				result.reason,
			);
		} finally {
			clearTimeout(timer);
			if (pid) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {}
			}
		}
	}
});

test("a group member remaining after the direct child exits cannot produce a clean receipt", async (t) => {
	const { command } = await import("./media-smoke.mjs");
	let group;
	try {
		const { result } = await scenario(t, undefined, {
			execute: (_binary, _args, options) =>
				command(
					process.execPath,
					[
						"-e",
						`
   const {spawn}=require('node:child_process');
   const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
   child.on('message',()=>{ child.disconnect(); process.exit(0); });
  `,
					],
					{
						...options,
						env: {},
						onSpawn(pid) {
							group = pid;
							options.onSpawn(pid);
						},
					},
				),
		});
		assert.equal(result.reason, "CLEANUP_UNCONFIRMED");
		assert.equal(result.cleanup, "unconfirmed");
		assert.equal(result.failureBeforeCleanup, "REPORT_MISSING");
	} finally {
		if (group) {
			try {
				process.kill(-group, "SIGKILL");
			} catch {}
		}
	}
});

test("a symlinked CLI invocation still executes its validation", async (t) => {
	const { symlinkSync } = await import("node:fs");
	const { spawnSync } = await import("node:child_process");
	const dir = mkdtempSync(join(tmpdir(), "feature-entrypoint-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const entry = join(dir, "verify.mjs");
	symlinkSync(join(import.meta.dirname, "feature-verification.mjs"), entry);
	const result = spawnSync(process.execPath, [entry, "doctor", "unknown"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /UNKNOWN_FEATURE/);
});

test("output containment rejects dot-prefixed child directories and symlink aliases", async (t) => {
	const { symlinkSync } = await import("node:fs");
	const root = mkdtempSync(join(tmpdir(), "feature-containment-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "source");
	mkdirSync(source);
	const alias = join(root, "alias");
	symlinkSync(source, alias);
	for (const output of [join(source, "..evidence"), join(alias, "evidence")]) {
		await assert.rejects(
			runFeature("qc-resource-allocation", { root: source, output }),
			/OUTPUT_MUST_BE_OUTSIDE_SOURCE/,
		);
	}
});
