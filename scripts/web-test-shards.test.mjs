import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { REDIS } from "./gated-tests.mjs";
import { GROUPS } from "./postgres-integration.mjs";
import {
	aggregateReports,
	artifactName,
	assertDiscovery,
	assertSourcePolicy,
	executeCommand,
	inventoryDigest,
	makeReceipt,
	readReceipts,
	requireSuccess,
	runShard,
	SHARD_COUNT,
	sourceIdentity,
} from "./web-test-shards.mjs";

const root = resolve(import.meta.dirname, "..");
const identity = {
	sha: "a".repeat(40),
	tree: "b".repeat(40),
	runId: "12345",
	runAttempt: "1",
};
const clone = (value) => structuredClone(value);
const allowed = [...GROUPS, REDIS.availability]
	.filter((group) => group.workspace === "@bitovp/web")
	.flatMap((group) =>
		Object.entries(group.files).map(([file, count]) => ({
			name: `${group.directory}/${file}`,
			status: "passed",
			assertionResults: Array.from({ length: count }, () => ({
				status: "skipped",
			})),
		})),
	);
const normal = Array.from({ length: 8 }, (_, index) => ({
	name: `apps/web/src/sample-${index}.test.ts`,
	status: "passed",
	assertionResults: [{ status: "passed" }],
}));
const files = [...allowed, ...normal];
const inventory = files.map((file) => file.name).sort();
function report(results) {
	const statuses = results.flatMap((file) => file.assertionResults);
	return {
		success: true,
		numTotalTestSuites: results.length,
		numPassedTestSuites: results.length,
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		numTotalTests: statuses.length,
		numPassedTests: statuses.filter((item) => item.status === "passed").length,
		numFailedTests: 0,
		numPendingTests: statuses.filter((item) => item.status === "skipped")
			.length,
		numTodoTests: 0,
		testResults: clone(results),
	};
}
function receipts() {
	return Array.from({ length: 4 }, (_, index) =>
		makeReceipt({
			report: report(files.filter((_, position) => position % 4 === index)),
			identity,
			inventory,
			index: index + 1,
			root,
		}),
	);
}
const aggregate = (items, options = {}) =>
	aggregateReports(items, {
		identity,
		inventory,
		needsResult: "success",
		root,
		...options,
	});
function temporary(t) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-web-shards-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("four complete shards preserve all 110 skipped tests and the full source inventory", () => {
	assert.equal(SHARD_COUNT, 4);
	const merged = aggregate(receipts());
	assert.equal(merged.testResults.length, files.length);
	assert.equal(merged.numPendingTests, 110);
	assert.equal(merged.numPassedTests, 8);
	assert.equal(merged.numTotalTests, 118);
});

test("receipt projection excludes diagnostics, test names, snapshots, metadata and environment", () => {
	const raw = report(files);
	raw.failureMessages = ["private-token-marker"];
	raw.snapshot = { private: "private-token-marker" };
	raw.testResults[0].message = "private-token-marker";
	raw.testResults[0].assertionResults[0].fullName = "private-token-marker";
	raw.testResults[0].assertionResults[0].meta = {
		token: "private-token-marker",
	};
	const receipt = makeReceipt({
		report: raw,
		identity,
		inventory,
		index: 1,
		root,
	});
	assert.doesNotMatch(
		JSON.stringify(receipt),
		/private-token-marker|failureMessages|fullName|snapshot|meta|environment/,
	);
});

test("missing, extra and duplicate shard identities cannot make the required check green", () => {
	const good = receipts();
	for (const length of [0, 1, 3, 5])
		assert.throws(() =>
			aggregate(Array.from({ length }, (_, i) => clone(good[i % 4]))),
		);
	for (const value of [0, 5, 1.5, "1", 2]) {
		const changed = receipts();
		changed[0].index = value;
		assert.throws(() => aggregate(changed));
	}
	for (const count of [0, 3, 5, "4"]) {
		const changed = receipts();
		changed[0].count = count;
		assert.throws(() => aggregate(changed));
	}
});

test("each receipt must identify this exact source, workflow run, attempt and inventory", () => {
	for (const key of [
		"sha",
		"tree",
		"runId",
		"runAttempt",
		"workspace",
		"inventoryDigest",
		"version",
		"exitCode",
	]) {
		const changed = receipts();
		changed[1][key] = key === "exitCode" ? 1 : "different";
		assert.throws(() => aggregate(changed), key);
	}
	const extra = receipts();
	extra[0].failureMessages = ["private-token-marker"];
	assert.throws(() => aggregate(extra));
});

test("cancelled, failed, skipped and absent matrix results fail even with four successful reports", () => {
	for (const needsResult of [
		"failure",
		"cancelled",
		"skipped",
		"",
		undefined,
		"unknown",
	])
		assert.throws(() => aggregate(receipts(), { needsResult }));
	assert.doesNotThrow(() => requireSuccess("success"));
});

test("file union rejects omitted, duplicated, unknown and unsafe paths", () => {
	for (const mutate of [
		(items) => items[0].report.testResults.pop(),
		(items) =>
			items[0].report.testResults.push(clone(items[1].report.testResults[0])),
		(items) => {
			items[0].report.testResults[0].name = "apps/web/src/missing.test.ts";
		},
		(items) => {
			items[0].report.testResults[0].name = "/tmp/outside.test.ts";
		},
		(items) => {
			items[0].report.testResults[0].name = "apps/web/src/../outside.test.ts";
		},
		(items) => {
			items[0].report.testResults = [];
		},
		(items) => {
			items[0].report.testResults[0].assertionResults = [];
		},
	]) {
		const items = receipts();
		mutate(items);
		assert.throws(() => aggregate(items));
	}
	assert.throws(() => aggregate(receipts(), { inventory: [] }));
});

test("failed, pending, todo and unknown assertions and inconsistent totals are rejected", () => {
	for (const status of [
		"failed",
		"pending",
		"todo",
		"running",
		"unknown",
		null,
	]) {
		const raw = report(files);
		raw.testResults[0].assertionResults[0].status = status;
		assert.throws(() =>
			makeReceipt({ report: raw, identity, inventory, index: 1, root }),
		);
	}
	for (const value of [-1, 1.5, null, "118", 117, 119]) {
		const items = receipts();
		items[0].report.numTotalTests = value;
		assert.throws(() => aggregate(items));
	}
	for (const key of [
		"numFailedTests",
		"numFailedTestSuites",
		"numPendingTestSuites",
		"numTodoTests",
	]) {
		const items = receipts();
		items[0].report[key] = 1;
		assert.throws(() => aggregate(items));
	}
	const failed = receipts();
	failed[0].report.success = false;
	assert.throws(() => aggregate(failed));
});

test("the merged skip audit rejects new skips, excessive allowances and missing allowed files", () => {
	for (const change of [
		(results) => {
			results.find((file) =>
				file.name.includes("sample-"),
			).assertionResults[0].status = "skipped";
		},
		(results) => {
			results[0].assertionResults.push({ status: "skipped" });
		},
	]) {
		const changed = clone(files);
		change(changed);
		const items = Array.from({ length: 4 }, (_, index) =>
			makeReceipt({
				report: report(changed.filter((_, position) => position % 4 === index)),
				identity,
				inventory,
				index: index + 1,
				root,
			}),
		);
		assert.throws(() => aggregate(items));
	}
	const without = files.slice(1);
	const smaller = without.map((file) => file.name).sort();
	const items = Array.from({ length: 4 }, (_, index) =>
		makeReceipt({
			report: report(without.filter((_, position) => position % 4 === index)),
			identity,
			inventory: smaller,
			index: index + 1,
			root,
		}),
	);
	assert.throws(
		() => aggregate(items, { inventory: smaller }),
		/not part of it/,
	);
});

test("full Vitest discovery must exactly equal the independent tracked-file inventory", () => {
	const discovered = inventory.map((file) => ({ file: resolve(root, file) }));
	assert.doesNotThrow(() => assertDiscovery(discovered, inventory, root));
	for (const changed of [
		discovered.slice(1),
		[...discovered, discovered[0]],
		[],
		[{ file: "/tmp/outside.test.ts" }],
	])
		assert.throws(() => assertDiscovery(changed, inventory, root));
	assert.throws(() =>
		assertDiscovery(
			discovered.map((file) => ({ ...file, projectName: "hidden" })),
			inventory,
			root,
		),
	);
});

test("source policy fails closed for unsupported config, test command and Vitest version changes", () => {
	const config = readFileSync(
		resolve(root, "apps/web/vitest.config.ts"),
		"utf8",
	);
	const pkg = JSON.parse(
		readFileSync(resolve(root, "apps/web/package.json"), "utf8"),
	);
	const workspace = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
	assert.doesNotThrow(() => assertSourcePolicy(config, pkg, workspace));
	for (const changed of [
		config.replace(
			'include: ["src/**/*.test.{ts,tsx}"]',
			'include: ["src/**/*.test.ts"]',
		),
		config.replace("globals: true", 'exclude: ["src/app/**"], globals: true'),
		config.replace("globals: true", "projects: [], globals: true"),
		config.replace("globals: true", "passWithNoTests: true, globals: true"),
	])
		assert.throws(() => assertSourcePolicy(changed, pkg, workspace));
	assert.throws(() =>
		assertSourcePolicy(
			config,
			{ ...pkg, scripts: { test: "vitest run src/subset" } },
			workspace,
		),
	);
	assert.throws(() =>
		assertSourcePolicy(
			config,
			pkg,
			workspace.replace("vitest: 4.1.12", "vitest: 5.0.0"),
		),
	);
});

test("artifact reader requires exactly four current-attempt directories and one regular receipt each", (t) => {
	const directory = temporary(t);
	for (const receipt of receipts()) {
		const sub = join(directory, artifactName(identity, receipt.index));
		mkdirSync(sub);
		writeFileSync(join(sub, "receipt.json"), JSON.stringify(receipt));
	}
	assert.equal(readReceipts(directory, identity).length, 4);
	const first = join(directory, artifactName(identity, 1));
	writeFileSync(join(first, "raw-report.json"), "{}");
	assert.throws(() => readReceipts(directory, identity));
	rmSync(join(first, "raw-report.json"));
	writeFileSync(join(first, "receipt.json"), "{");
	assert.throws(() => readReceipts(directory, identity));
});

test("a failed child cannot produce a successful receipt even after writing a green JSON report", async (t) => {
	const directory = join(temporary(t), "output");
	const execute = async (_binary, args) => {
		const list = args.find((arg) => arg.startsWith("--json="));
		if (list) {
			writeFileSync(
				list.slice("--json=".length),
				JSON.stringify(
					inventory.map((file) => ({ file: resolve(root, file) })),
				),
			);
			return;
		}
		const output = args
			.find((arg) => arg.startsWith("--outputFile.json="))
			.slice("--outputFile.json=".length);
		writeFileSync(output, JSON.stringify(report(files)));
		throw new Error("count-green exit-nonzero");
	};
	await assert.rejects(
		runShard({
			index: 1,
			directory,
			root,
			execute,
			source: () => ({ identity, inventory }),
		}),
		/count-green/,
	);
	assert.throws(() => readFileSync(join(directory, "receipt.json")));
});

test("runner uses full discovery and the original test command plus only the fixed shard selection", async (t) => {
	const directory = join(temporary(t), "output");
	const calls = [];
	const execute = async (binary, args) => {
		calls.push([binary, args]);
		const list = args.find((arg) => arg.startsWith("--json="));
		if (list)
			writeFileSync(
				list.slice(7),
				JSON.stringify(
					inventory.map((file) => ({ file: resolve(root, file) })),
				),
			);
		else {
			const output = args
				.find((arg) => arg.startsWith("--outputFile.json="))
				.slice("--outputFile.json=".length);
			writeFileSync(output, JSON.stringify(report(files)));
		}
	};
	await runShard({
		index: 1,
		directory,
		root,
		execute,
		source: () => ({ identity, inventory }),
	});
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0][1].slice(0, 6), [
		"--filter",
		"@bitovp/web",
		"exec",
		"vitest",
		"list",
		"--filesOnly",
	]);
	assert.deepEqual(
		calls[1][1].filter((arg) => !arg.startsWith("--outputFile.json=")),
		[
			"--filter",
			"@bitovp/web",
			"test",
			"--maxWorkers=2",
			"--reporter=default",
			"--reporter=github-actions",
			"--reporter=json",
			"--shard=1/4",
		],
	);
	assert.equal(
		JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"))
			.inventoryDigest,
		inventoryDigest(inventory),
	);
});

test("CLI rejects unknown modes, invalid shard selection and non-success upstream before invoking tools", () => {
	for (const args of [
		[],
		["unknown"],
		["run", "0", "/tmp/unused"],
		["run", "1.5", "/tmp/unused"],
		["require-success"],
	]) {
		const result = spawnSync(
			process.execPath,
			[resolve(root, "scripts/web-test-shards.mjs"), ...args],
			{
				cwd: root,
				env: { ...process.env, WEB_SHARDS_RESULT: "cancelled" },
				encoding: "utf8",
			},
		);
		assert.notEqual(result.status, 0);
	}
});

test("otherwise valid shard totals cannot hide a missing file or overlap between shards", () => {
	const omitted = receipts();
	omitted[0].report = report(omitted[0].report.testResults.slice(1));
	assert.throws(() => aggregate(omitted), /Shard union/);
	const duplicate = receipts();
	const results = duplicate[0].report.testResults;
	results[0] = clone(duplicate[1].report.testResults[0]);
	duplicate[0].report = report(results);
	assert.throws(() => aggregate(duplicate), /Shard union/);
});

test("changed source or incomplete discovery prevents publishing a receipt", async (t) => {
	for (const kind of ["discovery", "source"]) {
		const directory = join(temporary(t), "output");
		let reads = 0;
		let commands = 0;
		const source = () => {
			reads += 1;
			return {
				identity: reads > 1 ? { ...identity, tree: "c".repeat(40) } : identity,
				inventory,
			};
		};
		const execute = async (_binary, args) => {
			commands += 1;
			const list = args.find((arg) => arg.startsWith("--json="));
			if (list)
				writeFileSync(
					list.slice(7),
					JSON.stringify(
						(kind === "discovery" ? inventory.slice(1) : inventory).map(
							(file) => ({ file: resolve(root, file) }),
						),
					),
				);
			else
				writeFileSync(
					args.find((arg) => arg.startsWith("--outputFile.json=")).slice(18),
					JSON.stringify(report(files)),
				);
		};
		await assert.rejects(
			runShard({ index: 1, directory, root, execute, source }),
		);
		assert.equal(commands, kind === "discovery" ? 1 : 2);
		assert.throws(() => readFileSync(join(directory, "receipt.json")));
	}
});

test("the real command wrapper rejects nonzero, signalled and unstartable children", async () => {
	for (const code of [
		"process.exit(7)",
		"process.kill(process.pid, 'SIGTERM')",
	])
		await assert.rejects(
			executeCommand(process.execPath, ["-e", code], {
				cwd: root,
				env: process.env,
			}),
			/Web test command failed/,
		);
	await assert.rejects(
		executeCommand("/missing-web-test-command", [], {
			cwd: root,
			env: process.env,
		}),
	);
});

test("source gate binds real tracked regular files to an unchanged checkout and workflow SHA", (t) => {
	const directory = temporary(t);
	for (const file of [
		"apps/web/vitest.config.ts",
		"apps/web/package.json",
		"pnpm-workspace.yaml",
	]) {
		mkdirSync(resolve(directory, file, ".."), { recursive: true });
		writeFileSync(resolve(directory, file), readFileSync(resolve(root, file)));
	}
	mkdirSync(join(directory, "apps/web/src"));
	writeFileSync(
		join(directory, "apps/web/src/example.test.ts"),
		"test source\n",
	);
	const git = (...args) => {
		const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("init", "--quiet");
	git("add", ".");
	git(
		"-c",
		"user.name=CI fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-m",
		"fixture",
	);
	const env = {
		GITHUB_SHA: git("rev-parse", "HEAD"),
		GITHUB_RUN_ID: "12345",
		GITHUB_RUN_ATTEMPT: "1",
	};
	const source = sourceIdentity(directory, env);
	assert.deepEqual(source.inventory, ["apps/web/src/example.test.ts"]);
	assert.equal(source.identity.sha, env.GITHUB_SHA);
	assert.throws(
		() => sourceIdentity(directory, { ...env, GITHUB_SHA: "c".repeat(40) }),
		/workflow source/,
	);
	writeFileSync(
		join(directory, "apps/web/src/example.test.ts"),
		"changed test source\n",
	);
	assert.throws(() => sourceIdentity(directory, env));
});
