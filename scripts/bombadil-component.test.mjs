import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import {
	acceptPositiveTrace,
	childEnvironment,
	fixtureSandboxArgs,
	requireCoverage,
	summarizeTrace,
	terminate,
	transitionCoverage,
} from "./bombadil-component.mjs";

test("only actual trace violations qualify; snapshot property names do not", () => {
	const trace = summarizeTrace([
		{
			action: null,
			snapshots: [{ name: "defaultCopySourceIsLast" }],
			violations: [],
		},
	]);
	assert.equal(trace.actions, 0);
	assert.deepEqual(trace.violationNames, []);
	assert.deepEqual(
		summarizeTrace([
			{
				action: { Custom: {} },
				violations: [{ name: "defaultCopySourceIsLast" }],
			},
		]).violationNames,
		["defaultCopySourceIsLast"],
	);
});

test("nonvacuity rejects an unready fixture, short traces and missing operations", () => {
	const evidence = {
		ready: true,
		counts: { select: 1, collision: 1, reorder: 1, add: 1, reset: 1 },
		receipts: [{}],
	};
	assert.throws(() => requireCoverage(undefined, { actions: 20 }), /readiness/);
	assert.throws(() => requireCoverage(evidence, { actions: 0 }), /20 actual/);
	assert.throws(
		() =>
			requireCoverage(
				{ ...evidence, counts: { ...evidence.counts, reorder: 0 } },
				{ actions: 20 },
			),
		/reorder/,
	);
	assert.throws(
		() => requireCoverage({ ...evidence, receipts: [] }, { actions: 20 }),
		/onAdd/,
	);
	requireCoverage(evidence, { actions: 20 });
});

test("the browser and tool receive an allowlisted environment", () => {
	const environment = childEnvironment("/owned/bombadil");
	assert.deepEqual(Object.keys(environment).sort(), [
		"LANG",
		"NO_COLOR",
		"PATH",
		"TMPDIR",
	]);
	assert.equal(environment.TMPDIR, "/owned/bombadil");
});

test("coverage distinguishes a repaired-key reorder from ambiguous positional reorders", () => {
	const state = (collision, select, reorder, add = 0, pristine = false) => ({
		collision,
		pristine,
		intent: { label: "Rendition 2" },
		counts: { select, reorder, add, reset: 0 },
	});
	assert.deepEqual(
		transitionCoverage([
			state(false, 1, 0),
			state(true, 1, 0),
			state(true, 1, 1),
			state(false, 1, 1),
			state(false, 1, 2),
			state(true, 1, 2),
			state(true, 1, 2, 1, true),
		]),
		{
			uniqueKeyReorders: 1,
			resolvedCollisionReorders: 1,
			ambiguousCountResets: 1,
		},
	);
	assert.equal(
		transitionCoverage([
			state(true, 1, 0),
			state(false, 1, 0),
			state(false, 2, 0),
			state(false, 2, 1),
		]).resolvedCollisionReorders,
		0,
		"a fresh user choice must not count as retained repaired-key identity",
	);
});

function adequateTrace() {
	const state = (collision, reorder, add, pristine = false) => ({
		ready: true,
		collision,
		pristine,
		intent: { label: "Rendition 2" },
		counts: { select: 1, collision: 1, reorder, add, reset: 1 },
		receipts: [{}],
	});
	const models = [
		state(true, 0, 0),
		state(false, 0, 0),
		state(false, 1, 0),
		state(true, 1, 0),
		state(true, 1, 1, true),
	];
	while (models.length < 21) models.push(models.at(-1));
	return models.map((value, index) => ({
		action: index === 0 ? null : { Custom: {} },
		snapshots: [{ name: "state", value }],
		violations: [],
	}));
}

test("positive acceptance allows an initial unready prefix and requires real coverage", () => {
	const entries = adequateTrace();
	assert.equal(
		acceptPositiveTrace([
			{ snapshots: [] },
			{ snapshots: [{ name: "state", value: null }] },
			...entries,
		]).trace.actions,
		20,
	);
	assert.throws(() => acceptPositiveTrace(entries.slice(0, 4)), /20 actual/);
	assert.throws(() =>
		acceptPositiveTrace([
			...entries,
			{ ...entries.at(-1), violations: [{ name: "defaultCopySourceIsLast" }] },
		]),
	);
});

for (const [name, snapshots] of Object.entries({
	null: [{ name: "state", value: null }],
	missing: [],
	absent: undefined,
	unready: [{ name: "state", value: { ready: false } }],
	duplicate: adequateTrace()
		.at(-1)
		.snapshots.concat(adequateTrace().at(-1).snapshots),
})) {
	test(`positive acceptance rejects ${name} state after readiness, even after recovery`, () => {
		const entries = adequateTrace();
		const lost = { action: null, snapshots, violations: [] };
		assert.throws(() => acceptPositiveTrace([...entries, lost]), /readiness/);
		assert.throws(
			() => acceptPositiveTrace([...entries, lost, entries.at(-1)]),
			/readiness/,
		);
	});
}

test("cleanup signals owned descendants after their detached group leader exits", {
	timeout: 5000,
}, async () => {
	const temporary = await mkdtemp(join(tmpdir(), "bombadil-cleanup-test-"));
	const marker = join(temporary, "terminated");
	const descendantCode = `
		process.on("SIGTERM", () => {
			require("node:fs").writeFileSync(${JSON.stringify(marker)}, "terminated");
			process.exit(0);
		});
		setInterval(() => {}, 1000);
		process.send("ready");
		process.disconnect();
	`;
	const leaderCode = `
		const child = require("node:child_process").spawn(process.execPath,
			["-e", ${JSON.stringify(descendantCode)}],
			{ stdio: ["ignore", "ignore", "ignore", "ipc"] });
		child.once("message", () => {
			process.stdout.write(String(child.pid), () => process.exit(0));
		});
	`;
	const leader = spawn(process.execPath, ["-e", leaderCode], {
		detached: true,
		stdio: ["ignore", "pipe", "inherit"],
	});
	let descendantPid = "";
	leader.stdout.on("data", (chunk) => {
		descendantPid += chunk;
	});
	try {
		await once(leader, "exit");
		assert.equal(leader.exitCode, 0);
		assert(Number(descendantPid) > 0);
		process.kill(Number(descendantPid), 0);
		terminate(leader, "SIGTERM");
		let receipt;
		for (let i = 0; i < 100; i++) {
			try {
				receipt = await readFile(marker, "utf8");
				break;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await pause(20);
		}
		assert.equal(
			receipt,
			"terminated",
			"owned descendant did not receive cleanup signal",
		);
	} finally {
		// Deliberately independent of the helper under test, including on RED.
		const cleanupGroup = () => {
			try {
				process.kill(-leader.pid, "SIGKILL");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
		};
		cleanupGroup();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("only the dedicated Linux fixture browser disables its unsupported sandbox", () => {
	assert.deepEqual(fixtureSandboxArgs("linux"), ["--no-sandbox"]);
	assert.deepEqual(fixtureSandboxArgs("darwin"), []);
});
