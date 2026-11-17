#!/usr/bin/env node
/**
 * Keep the required "tests (web)" check while distributing its complete suite.
 * Receipts contain identities and statuses only; raw Vitest diagnostics stay local.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isEntryPoint } from "./gate-report.mjs";
import { skipProblems } from "./gated-tests.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const SHARD_COUNT = 4;
const WORKSPACE = "@bitovp/web";
// This version supports exactly the present include/default-exclude policy.
// A config change requires a deliberate inventory-policy update and its tests.
const CONFIG_SHA256 =
	"1d47a2b0859a133a4bbc54d2137b0a2415dc8c8da8e06888e1635eca25561e0f";
const TOTALS = [
	"numTotalTestSuites",
	"numPassedTestSuites",
	"numFailedTestSuites",
	"numPendingTestSuites",
	"numTotalTests",
	"numPassedTests",
	"numFailedTests",
	"numPendingTests",
	"numTodoTests",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const exactKeys = (object, keys) => {
	assert(
		object && typeof object === "object" && !Array.isArray(object),
		"Expected an object",
	);
	assert.deepEqual(
		Object.keys(object).sort(),
		[...keys].sort(),
		"Unexpected receipt fields",
	);
};
const shardIndex = (index) =>
	assert(
		Number.isInteger(index) && index >= 1 && index <= SHARD_COUNT,
		"Expected shard index 1..4",
	);
const positiveId = (value) =>
	assert(
		typeof value === "string" && /^[1-9][0-9]*$/.test(value),
		"Invalid workflow run identity",
	);
export function webTestResources(parallelism, processors) {
	assert(
		Number.isSafeInteger(parallelism) && parallelism > 0,
		"Invalid available parallelism",
	);
	assert(Array.isArray(processors), "Invalid CPU observations");
	return {
		availableParallelism: parallelism,
		logicalCpuCount: processors.length,
		cpuModels: [
			...new Set(
				processors.map((cpu) =>
					(typeof cpu?.model === "string" ? cpu.model : "unknown")
						.replace(/[^\x20-\x7e]/g, "?")
						.slice(0, 160),
				),
			),
		]
			.sort()
			.slice(0, 8),
		// Keep one CPU available for the parent on four-core and larger runners.
		chosenWorkers: parallelism >= 4 ? 3 : Math.min(2, parallelism),
	};
}
function validateIdentity(identity) {
	exactKeys(identity, ["sha", "tree", "runId", "runAttempt"]);
	for (const key of ["sha", "tree"])
		assert.match(identity[key], /^[0-9a-f]{40}$/, "Invalid source identity");
	positiveId(identity.runId);
	positiveId(identity.runAttempt);
}
function validateInventory(inventory) {
	assert(
		Array.isArray(inventory) && inventory.length > 0,
		"Empty test inventory",
	);
	assert.equal(
		new Set(inventory).size,
		inventory.length,
		"Duplicate inventory files",
	);
	for (const file of inventory)
		assert(
			typeof file === "string" &&
				/^apps\/web\/src\/.+\.test\.tsx?$/.test(file) &&
				!file.includes("\\") &&
				!file.split("/").some((part) => part === "." || part === "..") &&
				!/[\r\n\0]/.test(file),
			"Invalid test inventory path",
		);
}
export function inventoryDigest(inventory) {
	validateInventory(inventory);
	return sha256(`${[...inventory].sort().join("\n")}\n`);
}
export function assertSourcePolicy(config, pkg, workspace) {
	assert.equal(
		sha256(config),
		CONFIG_SHA256,
		"Unsupported Web Vitest config: review its full include/exclude policy",
	);
	assert.equal(
		pkg?.scripts?.test,
		"vitest run",
		"Web test command must run the full suite",
	);
	assert.deepEqual(
		workspace.match(/^ {2}vitest: .*$/gm),
		["  vitest: 4.1.12"],
		"Review sharding when changing Vitest",
	);
}
export function sourceIdentity(root = ROOT, env = process.env) {
	const git = (...args) =>
		execFileSync(
			"git",
			["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
			{ cwd: root, encoding: "utf8" },
		).trimEnd();
	const identity = {
		sha: git("rev-parse", "HEAD"),
		tree: git("rev-parse", "HEAD^{tree}"),
		runId: env.GITHUB_RUN_ID,
		runAttempt: env.GITHUB_RUN_ATTEMPT,
	};
	validateIdentity(identity);
	assert.equal(
		identity.sha,
		env.GITHUB_SHA,
		"Checkout differs from workflow source",
	);
	git("diff", "--exit-code", "HEAD", "--");
	assertSourcePolicy(
		readFileSync(join(root, "apps/web/vitest.config.ts"), "utf8"),
		readJson(join(root, "apps/web/package.json")),
		readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
	);
	const inventory = [];
	for (const entry of git("ls-files", "--stage", "-z", "--", "apps/web/src")
		.split("\0")
		.filter(Boolean)) {
		const [metadata, file] = entry.split("\t");
		if (!/\.test\.tsx?$/.test(file)) continue;
		assert.match(
			metadata,
			/^100(?:644|755) [0-9a-f]{40} 0$/,
			"Test inventory must contain regular, merged files",
		);
		assert(
			lstatSync(resolve(root, file)).isFile(),
			"A tracked test is not a regular file",
		);
		inventory.push(file);
	}
	validateInventory(inventory);
	return { identity, inventory: inventory.sort() };
}
function reportPath(name, root) {
	assert(typeof name === "string", "Missing test file name");
	return isAbsolute(name) ? relative(root, name).split(sep).join("/") : name;
}
export function assertDiscovery(discovered, inventory, root = ROOT) {
	validateInventory(inventory);
	assert(Array.isArray(discovered), "Missing Vitest full discovery");
	const actual = discovered.map((entry) => {
		exactKeys(entry, ["file"]);
		return reportPath(entry.file, root);
	});
	assert.deepEqual(
		actual.sort(),
		[...inventory].sort(),
		"Full Vitest discovery differs from tracked source inventory",
	);
}
function projectReport(raw, inventory, root, strict = false) {
	if (strict) exactKeys(raw, ["success", ...TOTALS, "testResults"]);
	assert.equal(raw?.success, true, "Vitest did not report success");
	for (const key of TOTALS)
		assert(Number.isSafeInteger(raw[key]) && raw[key] >= 0, `Invalid ${key}`);
	for (const key of [
		"numFailedTests",
		"numFailedTestSuites",
		"numPendingTestSuites",
		"numTodoTests",
	])
		assert.equal(raw[key], 0, `Nonzero ${key}`);
	assert.equal(
		raw.numPassedTestSuites,
		raw.numTotalTestSuites,
		"Incomplete suites",
	);
	assert(
		Array.isArray(raw.testResults) && raw.testResults.length > 0,
		"Empty test report",
	);
	assert(raw.numTotalTestSuites >= raw.testResults.length, "Missing suites");
	const expected = new Set(inventory);
	const seen = new Set();
	let passed = 0;
	let skipped = 0;
	const testResults = raw.testResults.map((file) => {
		if (strict) exactKeys(file, ["name", "status", "assertionResults"]);
		const name = reportPath(file.name, root);
		if (strict)
			assert.equal(
				name,
				file.name,
				"Receipt paths must be repository relative",
			);
		assert(expected.has(name), "Reported file is outside the source inventory");
		assert(!seen.has(name), "Reported file appears more than once");
		seen.add(name);
		assert.equal(file.status, "passed", "Test file failed");
		assert(
			Array.isArray(file.assertionResults) && file.assertionResults.length > 0,
			"Test file has no assertions",
		);
		const assertionResults = file.assertionResults.map((item) => {
			if (strict) exactKeys(item, ["status"]);
			assert(
				item?.status === "passed" || item?.status === "skipped",
				"Incomplete or failed assertion",
			);
			if (item.status === "passed") passed += 1;
			else skipped += 1;
			return { status: item.status };
		});
		return { name, status: "passed", assertionResults };
	});
	assert(passed > 0, "Shard ran no passing tests");
	assert.equal(
		raw.numPassedTests,
		passed,
		"Passed total differs from assertions",
	);
	assert.equal(
		raw.numPendingTests,
		skipped,
		"Skipped total differs from assertions",
	);
	assert.equal(
		raw.numTotalTests,
		passed + skipped,
		"Total differs from assertions",
	);
	return {
		success: true,
		...Object.fromEntries(TOTALS.map((key) => [key, raw[key]])),
		testResults,
	};
}
export function makeReceipt({
	report,
	identity,
	inventory,
	index,
	root = ROOT,
}) {
	validateIdentity(identity);
	shardIndex(index);
	return {
		version: 1,
		workspace: WORKSPACE,
		...identity,
		index,
		count: SHARD_COUNT,
		inventoryDigest: inventoryDigest(inventory),
		exitCode: 0,
		report: projectReport(report, inventory, root),
	};
}
export function requireSuccess(result) {
	assert.equal(result, "success", "All four Web shard jobs must succeed");
}
export function aggregateReports(
	receipts,
	{ identity, inventory, needsResult, root = ROOT },
) {
	requireSuccess(needsResult);
	validateIdentity(identity);
	const digest = inventoryDigest(inventory);
	assert(
		Array.isArray(receipts) && receipts.length === SHARD_COUNT,
		"Expected exactly four shard receipts",
	);
	const indexes = new Set();
	const merged = {
		success: true,
		...Object.fromEntries(TOTALS.map((key) => [key, 0])),
		testResults: [],
	};
	for (const receipt of receipts) {
		exactKeys(receipt, [
			"version",
			"workspace",
			"sha",
			"tree",
			"runId",
			"runAttempt",
			"index",
			"count",
			"inventoryDigest",
			"exitCode",
			"report",
		]);
		for (const [key, expected] of Object.entries({
			version: 1,
			workspace: WORKSPACE,
			...identity,
			count: SHARD_COUNT,
			inventoryDigest: digest,
			exitCode: 0,
		}))
			assert.equal(receipt[key], expected, `Shard ${key} mismatch`);
		shardIndex(receipt.index);
		assert(!indexes.has(receipt.index), "Duplicate shard index");
		indexes.add(receipt.index);
		const report = projectReport(receipt.report, inventory, root, true);
		for (const key of TOTALS) merged[key] += report[key];
		merged.testResults.push(...report.testResults);
	}
	assert.deepEqual([...indexes].sort(), [1, 2, 3, 4]);
	assert.deepEqual(
		merged.testResults.map((file) => file.name).sort(),
		[...inventory].sort(),
		"Shard union differs from complete source inventory",
	);
	// The existing auditor requires every allowed file, not a partial shard.
	const audit = skipProblems(
		{
			...merged,
			testResults: merged.testResults.map((file) => ({
				...file,
				name: resolve(root, file.name),
			})),
		},
		WORKSPACE,
		root,
	);
	assert.deepEqual(audit.problems, [], audit.problems.join("\n"));
	return merged;
}
export function artifactName(identity, index) {
	validateIdentity(identity);
	shardIndex(index);
	return `web-tests-${identity.runId}-${identity.runAttempt}-${index}`;
}
export function readReceipts(directory, identity) {
	const expected = Array.from({ length: SHARD_COUNT }, (_, index) =>
		artifactName(identity, index + 1),
	);
	assert.deepEqual(
		readdirSync(directory).sort(),
		expected.sort(),
		"Missing or extra shard artifact",
	);
	return expected.map((name, index) => {
		const sub = join(directory, name);
		assert(
			lstatSync(sub).isDirectory() && !lstatSync(sub).isSymbolicLink(),
			"Invalid artifact directory",
		);
		assert.deepEqual(
			readdirSync(sub),
			["receipt.json"],
			"Only the sanitized receipt may be downloaded",
		);
		const file = join(sub, "receipt.json");
		assert(
			lstatSync(file).isFile() &&
				!lstatSync(file).isSymbolicLink() &&
				lstatSync(file).size <= 16 * 1024 * 1024,
			"Invalid receipt file",
		);
		const receipt = readJson(file);
		assert.equal(
			receipt.index,
			index + 1,
			"Artifact name and shard index differ",
		);
		return receipt;
	});
}
export async function executeCommand(binary, args, { cwd, env }) {
	await new Promise((accept, reject) => {
		const child = spawn(binary, args, {
			cwd,
			env,
			stdio: "inherit",
			detached: true,
		});
		let interrupted = false;
		let timer;
		const stop = (signal) => {
			interrupted = true;
			try {
				process.kill(-child.pid, signal);
			} catch {
				child.kill(signal);
			}
			timer ??= setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 5_000);
		};
		const term = () => stop("SIGTERM");
		const interrupt = () => stop("SIGINT");
		process.on("SIGTERM", term);
		process.on("SIGINT", interrupt);
		const cleanup = () => {
			clearTimeout(timer);
			process.off("SIGTERM", term);
			process.off("SIGINT", interrupt);
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (code, signal) => {
			cleanup();
			if (code === 0 && signal === null && !interrupted) accept();
			else
				reject(
					new Error(`Web test command failed (exit ${code}, signal ${signal})`),
				);
		});
	});
}
export async function runShard({
	index,
	directory,
	root = ROOT,
	env = process.env,
	execute = executeCommand,
	source = sourceIdentity,
	system = { availableParallelism, cpus },
	log = console.log,
}) {
	shardIndex(index);
	assert(isAbsolute(directory), "Receipt output must be absolute");
	const current = source(root, env);
	const resources = webTestResources(
		system.availableParallelism(),
		system.cpus(),
	);
	log(`Web test resources: ${JSON.stringify(resources)}`);
	mkdirSync(directory); // Never reuse a receipt directory from another attempt.
	const scratch = mkdtempSync(join(tmpdir(), "bitovp-web-tests-"));
	try {
		const discovered = join(scratch, "inventory.json");
		const output = join(scratch, "vitest-report.json");
		const options = { cwd: root, env: { ...env, CI: "1" } };
		await execute(
			"pnpm",
			[
				"--filter",
				WORKSPACE,
				"exec",
				"vitest",
				"list",
				"--filesOnly",
				`--json=${discovered}`,
			],
			options,
		);
		assertDiscovery(readJson(discovered), current.inventory, root);
		await execute(
			"pnpm",
			[
				"--filter",
				WORKSPACE,
				"test",
				`--maxWorkers=${resources.chosenWorkers}`,
				"--reporter=default",
				"--reporter=github-actions",
				"--reporter=json",
				`--outputFile.json=${output}`,
				`--shard=${index}/${SHARD_COUNT}`,
			],
			options,
		);
		assert.deepEqual(
			source(root, env),
			current,
			"Source changed while tests ran",
		);
		const receipt = makeReceipt({
			report: readJson(output),
			...current,
			index,
			root,
		});
		writeFileSync(
			join(directory, "receipt.json"),
			`${JSON.stringify(receipt)}\n`,
			{ flag: "wx" },
		);
		log(
			`Web shard ${index}/${SHARD_COUNT}: ${receipt.report.testResults.length} files, ${receipt.report.numTotalTests} tests, ${receipt.report.numPendingTests} skipped`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
export async function main(args = process.argv.slice(2), env = process.env) {
	if (args[0] === "require-success" && args.length === 1) {
		requireSuccess(env.WEB_SHARDS_RESULT);
	} else if (args[0] === "run" && args.length === 3) {
		assert(/^[1-4]$/.test(args[1]), "Expected shard index 1..4");
		await runShard({ index: Number(args[1]), directory: args[2], env });
	} else if (args[0] === "aggregate" && args.length === 2) {
		requireSuccess(env.WEB_SHARDS_RESULT);
		const current = sourceIdentity(ROOT, env);
		const report = aggregateReports(readReceipts(args[1], current.identity), {
			...current,
			needsResult: env.WEB_SHARDS_RESULT,
		});
		console.log(
			`@bitovp/web: ${report.testResults.length} files, ${report.numTotalTests} tests; ${report.numPassedTests} passed, ${report.numPendingTests} skipped; all four shards and the full skip audit passed`,
		);
	} else
		throw new Error(
			"Usage: web-test-shards.mjs run <1..4> <new receipt directory> | aggregate <artifact directory> | require-success",
		);
}
if (isEntryPoint(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
