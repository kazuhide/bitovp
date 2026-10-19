import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CASES,
	childEnvironment,
	cleanupFixture,
	composeOverride,
	inside,
	validateReport,
	workerReady,
} from "./installed-gui-smoke.mjs";

const id = "0123456789abcdef0123456789abcdef";
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

test("private state paths cannot use a dot-prefixed child or the checkout itself", () => {
	assert(inside("/checkout", "/checkout"));
	assert(inside("/checkout", "/checkout/..hidden/state"));
	assert(!inside("/checkout", "/private/state"));
	assert(!inside("/checkout", "/checkout-other/state"));
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
