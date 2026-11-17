import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	ALL_PROFILES,
	classifyPaths,
	RULES,
	safePath,
	WORKFLOWS,
} from "./change-verification-registry.mjs";
import { runFeature, sourceIdentity } from "./feature-verification.mjs";
import { FEATURES } from "./feature-verification-registry.mjs";
import { isEntryPoint } from "./gate-report.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const LIMIT = 120000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const registryBytes = () =>
	readFileSync(new URL("./feature-verification-registry.mjs", import.meta.url));
const policyBytes = () =>
	readFileSync(new URL("./change-verification-registry.mjs", import.meta.url));
const loadedPolicy = hash(Buffer.concat([policyBytes(), registryBytes()]));
function policyIdentity() {
	const current = hash(Buffer.concat([policyBytes(), registryBytes()]));
	if (current !== loadedPolicy) throw new Error("POLICY_CHANGED");
	return current;
}
const git = (root, ...args) =>
	execFileSync(
		"git",
		["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
			maxBuffer: 32 * 1024 * 1024,
		},
	);
const validBase = (base) =>
	typeof base === "string" &&
	base.length > 0 &&
	base.length <= 200 &&
	!base.startsWith("-") &&
	!/[\s\0]/.test(base);
const indexIdentity = (root) =>
	hash(git(root, "diff", "--cached", "HEAD", "--binary"));
function validateRegistry(root) {
	try {
		assert.deepEqual(
			FEATURES.map((item) => item.id).sort(),
			[...ALL_PROFILES].sort(),
		);
		assert(
			RULES.every(
				(rule) =>
					rule.profiles.length &&
					rule.profiles.every((id) => ALL_PROFILES.includes(id)),
			),
		);
		const tracked = new Set(git(root, "ls-files", "-z").split("\0"));
		const files = [...WORKFLOWS];
		for (const selected of FEATURES) {
			assert(safePath(selected.directory));
			assert(Object.keys(selected.files).length > 0);
			for (const [file, count] of Object.entries(selected.files)) {
				assert(safePath(file) && Number.isSafeInteger(count) && count > 0);
				files.push(`${selected.directory}/${file}`);
			}
		}
		for (const file of files) {
			assert(tracked.has(file) && lstatSync(join(root, file)).isFile());
			assert.equal(
				realpathSync(join(root, file)),
				join(realpathSync(root), file),
			);
		}
	} catch {
		throw new Error("REGISTRY_INVALID");
	}
}
export function planChanges({
	root = ROOT,
	base,
	identify = sourceIdentity,
	policy = policyIdentity,
} = {}) {
	if (!validBase(base)) throw new Error("INVALID_BASE");
	const before = identify(root);
	const indexDigest = indexIdentity(root);
	const policyDigest = policy();
	let sha;
	try {
		sha = git(
			root,
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${base}^{commit}`,
		).trim();
	} catch {
		throw new Error("INVALID_BASE");
	}
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("INVALID_BASE");
	try {
		git(root, "merge-base", "--is-ancestor", sha, "HEAD");
	} catch {
		throw new Error("BASE_NOT_ANCESTOR");
	}
	validateRegistry(root);
	const changes = [
		git(root, "diff", sha, "--no-renames", "--name-only", "-z", "--"),
		git(
			root,
			"diff",
			"--cached",
			sha,
			"--no-renames",
			"--name-only",
			"-z",
			"--",
		),
		git(root, "ls-files", "--others", "--exclude-standard", "-z"),
	].flatMap((value) => value.split("\0").filter(Boolean));
	const selection = classifyPaths(changes);
	const result = {
		schemaVersion: 1,
		base: {
			ref: base,
			sha,
			tree: git(root, "rev-parse", `${sha}^{tree}`).trim(),
		},
		source: before,
		indexDigest,
		headTree: git(root, "rev-parse", "HEAD^{tree}").trim(),
		policyDigest,
		featureRegistryDigest: hash(registryBytes()),
		...selection,
		requiredWorkflows: WORKFLOWS.map((file) => ({ file, status: "pending" })),
		deliveryReady: false,
		scope:
			"Fixed local source contracts only; full CI and review remain separate. Path-filtered workflows may need explicit scheduling.",
	};
	if (!same(before, identify(root))) throw new Error("SOURCE_CHANGED");
	if (indexDigest !== indexIdentity(root)) throw new Error("INDEX_CHANGED");
	if (policyDigest !== policy()) throw new Error("POLICY_CHANGED");
	return result;
}
function createOutput(root, output) {
	if (!isAbsolute(output ?? "")) throw new Error("OUTPUT_MUST_BE_ABSOLUTE");
	const target = resolve(realpathSync(dirname(output)), basename(output));
	const path = relative(realpathSync(root), target);
	if (
		!path ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	)
		throw new Error("OUTPUT_MUST_BE_OUTSIDE_SOURCE");
	try {
		mkdirSync(target, { mode: 0o700 });
	} catch {
		throw new Error("OUTPUT_EXISTS_OR_UNAVAILABLE");
	}
	return target;
}
function inspectReceipt(id, directory, returned, plan) {
	const bytes = readFileSync(join(directory, "receipt.json"));
	const receipt = JSON.parse(bytes);
	assert(same(receipt, returned));
	assert.equal(receipt.featureId, id);
	assert(["passed", "failed", "blocked"].includes(receipt.status));
	if (receipt.status === "passed") {
		const selected = FEATURES.find((item) => item.id === id);
		assert.equal(receipt.cleanup, "complete");
		assert.equal(receipt.scope, selected.scope);
		assert.equal(receipt.registryDigest, plan.featureRegistryDigest);
		assert.match(receipt.reportDigest, /^[a-f0-9]{64}$/);
		assert(
			same(receipt.source, plan.source) &&
				same(receipt.sourceAfter, plan.source),
		);
		assert.deepEqual(receipt.expected, selected.files);
		const total = Object.values(selected.files).reduce((a, b) => a + b, 0);
		assert.equal(receipt.actual.tests, total);
		assert.equal(receipt.actual.passed, total);
		assert.deepEqual(
			receipt.actual.files
				.map((entry) => [entry.file, entry.assertions, entry.passed])
				.sort(),
			Object.entries(selected.files)
				.map(([file, count]) => [file, count, count])
				.sort(),
		);
	}
	return {
		id,
		status: receipt.status,
		reason: receipt.reason,
		receipt: `${id}/receipt.json`,
		receiptDigest: hash(bytes),
	};
}
export async function runChanges({
	root = ROOT,
	base,
	output,
	signal,
	timeoutMs = LIMIT,
	executeFeature = runFeature,
	identify = sourceIdentity,
	policy = policyIdentity,
} = {}) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMIT)
		throw new Error("INVALID_TIMEOUT");
	const target = createOutput(root, output);
	const started = Date.now();
	const result = {
		schemaVersion: 1,
		runId: randomUUID(),
		status: "incomplete",
		reason: "NOT_FINISHED",
		expectedProfiles: [],
		actualProfiles: [],
		results: [],
		deliveryReady: false,
		requiredWorkflows: WORKFLOWS.map((file) => ({ file, status: "pending" })),
		timeoutMs,
		maxConcurrentProfiles: 2,
		startedAt: new Date(started).toISOString(),
	};
	const save = () => {
		writeFileSync(
			join(target, "receipt.pending"),
			`${JSON.stringify(result, null, 2)}\n`,
			{ mode: 0o600 },
		);
		renameSync(join(target, "receipt.pending"), join(target, "receipt.json"));
	};
	save();
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	let timedOut = false;
	let timer;
	try {
		const plan = planChanges({ root, base, identify, policy });
		Object.assign(result, { plan, expectedProfiles: plan.profiles });
		save();
		if (controller.signal.aborted) throw new Error("CANCELLED");
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		let next = 0;
		const worker = async () => {
			while (next < plan.profiles.length && !controller.signal.aborted) {
				const id = plan.profiles[next++];
				let row;
				try {
					const directory = join(target, id);
					const receipt = await executeFeature(id, {
						root,
						output: directory,
						signal: controller.signal,
						timeoutMs,
					});
					try {
						row = inspectReceipt(id, directory, receipt, plan);
					} catch {
						row = { id, status: "failed", reason: "PROFILE_RECEIPT_INVALID" };
					}
				} catch {
					row = { id, status: "failed", reason: "PROFILE_REFUSED" };
				}
				result.results.push(row);
				result.actualProfiles.push(id);
				save();
			}
		};
		const settled = await Promise.allSettled([worker(), worker()]);
		if (settled.some((entry) => entry.status === "rejected"))
			throw new Error("PROFILE_RECORDING_FAILED");
		result.actualProfiles.sort();
		result.results.sort((a, b) => a.id.localeCompare(b.id));
		result.sourceAfter = identify(root);
		if (!same(result.sourceAfter, plan.source))
			throw new Error("SOURCE_CHANGED");
		if (indexIdentity(root) !== plan.indexDigest)
			throw new Error("INDEX_CHANGED");
		if (policy() !== plan.policyDigest) throw new Error("POLICY_CHANGED");
		if (timedOut) throw new Error("TIMEOUT");
		if (controller.signal.aborted) throw new Error("CANCELLED");
		if (!same(result.actualProfiles, plan.profiles))
			throw new Error("PROFILE_SET_INCOMPLETE");
		result.status = result.results.some((row) => row.status === "failed")
			? "failed"
			: result.results.some((row) => row.status === "blocked")
				? "blocked"
				: plan.profiles.length
					? "fast-checks-passed"
					: "not-required";
		result.reason =
			result.status === "failed"
				? "PROFILE_FAILED"
				: result.status === "blocked"
					? "PREREQUISITE_MISSING"
					: plan.profiles.length
						? "ALL_SELECTED_CONTRACTS_PASSED"
						: plan.reason;
	} catch (error) {
		result.status = "failed";
		result.reason = [
			"INVALID_BASE",
			"BASE_NOT_ANCESTOR",
			"REGISTRY_INVALID",
			"UNSAFE_CHANGE_PATH",
			"SOURCE_CHANGED",
			"INDEX_CHANGED",
			"POLICY_CHANGED",
			"TIMEOUT",
			"CANCELLED",
			"PROFILE_SET_INCOMPLETE",
			"PROFILE_RECORDING_FAILED",
		].includes(error.message)
			? error.message
			: "VERIFICATION_ERROR";
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		result.finishedAt = new Date().toISOString();
		result.durationMs = Date.now() - started;
		save();
	}
	return result;
}
export function parseArgs(args) {
	if (
		args.length === 3 &&
		args[0] === "plan" &&
		args[1] === "--base" &&
		validBase(args[2])
	)
		return { mode: "plan", base: args[2] };
	if (
		args.length === 5 &&
		args[0] === "run" &&
		args[1] === "--base" &&
		validBase(args[2]) &&
		args[3] === "--output" &&
		isAbsolute(args[4])
	)
		return { mode: "run", base: args[2], output: args[4] };
	throw new Error(
		"USAGE: change-verification.mjs plan --base <ref> | run --base <ref> --output <new-absolute-directory-outside-repo>",
	);
}
if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => controller.abort());
	try {
		const { mode, ...options } = parseArgs(process.argv.slice(2));
		const result =
			mode === "plan"
				? planChanges(options)
				: await runChanges({ ...options, signal: controller.signal });
		console.log(JSON.stringify(result));
		if (result.status === "failed" || result.status === "blocked")
			process.exitCode = 1;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
