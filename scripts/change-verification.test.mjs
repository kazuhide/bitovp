import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parseArgs, planChanges, runChanges } from "./change-verification.mjs";
import {
	ALL_PROFILES,
	classifyPaths,
	RULES,
	WORKFLOWS,
} from "./change-verification-registry.mjs";
import { sourceIdentity } from "./feature-verification.mjs";
import { FEATURES, feature } from "./feature-verification-registry.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const write = (path, text = "fixture\n") => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};
function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-change-tests-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = join(directory, "repo");
	mkdirSync(root);
	const git = (...args) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-q");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	for (const selected of FEATURES)
		for (const file of Object.keys(selected.files))
			write(join(root, selected.directory, file));
	for (const file of WORKFLOWS) write(join(root, file));
	for (const file of [
		"README.md",
		"apps/web/src/lib/auth/example.ts",
		"apps/worker/src/live/example.ts",
		"apps/web/src/app/vod/new/example.ts",
	])
		write(join(root, file));
	git("add", ".");
	git("commit", "-qm", "fixture baseline");
	return {
		root,
		directory,
		git,
		base: git("rev-parse", "HEAD"),
		output: join(directory, "output"),
	};
}
async function success(id, { root, output }) {
	const selected = feature(id);
	const source = sourceIdentity(root);
	const total = Object.values(selected.files).reduce((a, b) => a + b, 0);
	const receipt = {
		featureId: id,
		scope: selected.scope,
		status: "passed",
		reason: "ALL_REQUIRED_TESTS_PASSED",
		cleanup: "complete",
		source,
		sourceAfter: source,
		expected: selected.files,
		registryDigest: digest(
			readFileSync(
				new URL("./feature-verification-registry.mjs", import.meta.url),
			),
		),
		reportDigest: "a".repeat(64),
		actual: {
			tests: total,
			passed: total,
			files: Object.entries(selected.files).map(([file, count]) => ({
				file,
				assertions: count,
				passed: count,
			})),
		},
	};
	mkdirSync(output);
	write(join(output, "receipt.json"), JSON.stringify(receipt));
	return receipt;
}
const ids = (...values) => values.sort();

test("known documentation does not select source contracts from domain words", () => {
	const actual = classifyPaths([
		"docs/verification/qc-guide.md",
		"tasks/vod-followup.md",
	]);
	assert.equal(actual.classification, "not-required");
	assert.equal(actual.reason, "DOCUMENTATION_ONLY");
	assert.deepEqual(actual.profiles, []);
	assert(actual.paths.every((entry) => entry.rules.join() === "documentation"));
});

test("independent path examples preserve exact classifications, reasons and overlapping impact", () => {
	for (const [path, classification, reasons, profiles] of [
		[
			"apps/web/src/lib/auth/new-session.ts",
			"mapped",
			["access"],
			["access-isolation"],
		],
		[
			"apps/web/src/app/api/live-channels/route.ts",
			"mapped",
			["api-access", "live", "submission"],
			["access-isolation", "live-lifecycle", "submission-idempotency"],
		],
		[
			"apps/web/src/app/vod/new/input-timeline/new-control.tsx",
			"mapped",
			["vod"],
			["submission-idempotency", "vod-timeline"],
		],
		[
			"apps/worker/src/library-editing/new-render.ts",
			"mapped",
			["library"],
			["library-render-recovery"],
		],
		[
			"apps/web/src/app/qc/[id]/new-panel.tsx",
			"mapped",
			["qc", "qc-access"],
			[
				"access-isolation",
				"qc-measurement-validity",
				"qc-resource-allocation",
				"qc-runtime-safety",
			],
		],
		["packages/db/prisma/schema.prisma", "broad", ["shared"], ALL_PROFILES],
		["scripts/new-harness.mjs", "broad", ["shared"], ALL_PROFILES],
		[
			"apps/new-service/source.ts",
			"unclassified",
			["unclassified"],
			ALL_PROFILES,
		],
		[
			"apps/web/src/app/api/new-business/route.ts",
			"unclassified",
			["api-access", "unclassified"],
			ALL_PROFILES,
		],
	]) {
		const actual = classifyPaths([path]);
		assert.equal(actual.classification, classification, path);
		assert.deepEqual(actual.paths[0].rules, [...reasons].sort(), path);
		assert.deepEqual(actual.profiles, [...profiles].sort(), path);
	}
	const mutated = classifyPaths(
		["apps/web/src/lib/auth/new-session.ts"],
		RULES.filter((rule) => rule.id !== "access"),
	);
	assert.equal(mutated.classification, "unclassified");
	assert.notDeepEqual(
		mutated.profiles,
		["access-isolation"],
		"a deleted rule cannot satisfy the mapped-path oracle through fallback",
	);
});

test("future files, shared configuration and mixed domains cannot silently select no checks", () => {
	for (const path of [
		"packages/core/new.ts",
		"apps/web/next.config.ts",
		"apps/web/config/new-policy.ts",
		"new-package/package.json",
		"pnpm-lock.yaml",
		".github/workflows/new.yml",
		"tests/future.test.ts",
	])
		assert.deepEqual(
			classifyPaths([path]).profiles,
			[...ALL_PROFILES].sort(),
			path,
		);
	const combined = classifyPaths([
		"apps/worker/src/live/future.ts",
		"apps/worker/src/library-editing/future.ts",
	]);
	assert.deepEqual(
		combined.profiles,
		ids("live-lifecycle", "library-render-recovery"),
	);
	assert.equal(combined.classification, "mapped");
	for (const paths of [[], ["README.md", "docs/verification/new-guide.md"]])
		assert.equal(classifyPaths(paths).classification, "not-required");
	assert.equal(
		classifyPaths(["docs/new-contract.json"]).classification,
		"unclassified",
	);
});

test("real Git changes include committed, staged, dirty, untracked, deleted and both rename paths", (t) => {
	const f = fixture(t);
	write(join(f.root, "apps/worker/src/live/committed.ts"));
	f.git("add", ".");
	f.git("commit", "-qm", "committed change");
	write(join(f.root, "apps/web/src/lib/auth/staged.ts"));
	f.git("add", ".");
	write(join(f.root, "README.md"), "staged only\n");
	f.git("add", "README.md");
	write(join(f.root, "README.md"));
	write(join(f.root, "apps/worker/src/live/example.ts"), "dirty\n");
	write(join(f.root, "apps/worker/src/library-editing/untracked.ts"));
	rmSync(join(f.root, "apps/web/src/app/vod/new/example.ts"));
	f.git(
		"mv",
		"apps/web/src/lib/auth/example.ts",
		"apps/worker/src/live/renamed.ts",
	);
	write(join(f.root, ".gitignore"), "ignored.ts\n");
	f.git("add", ".gitignore");
	write(join(f.root, "ignored.ts"));
	const plan = planChanges({ root: f.root, base: f.base });
	for (const path of [
		"README.md",
		"apps/worker/src/live/committed.ts",
		"apps/web/src/lib/auth/staged.ts",
		"apps/worker/src/live/example.ts",
		"apps/worker/src/library-editing/untracked.ts",
		"apps/web/src/app/vod/new/example.ts",
		"apps/web/src/lib/auth/example.ts",
		"apps/worker/src/live/renamed.ts",
	])
		assert(
			plan.paths.some((entry) => entry.path === path),
			path,
		);
	assert(!plan.paths.some((entry) => entry.path === "ignored.ts"));
	assert.equal(plan.base.sha, f.base);
	assert.equal(plan.deliveryReady, false);
	assert(plan.requiredWorkflows.every((entry) => entry.status === "pending"));
});

test("the actual registry has tracked positive-count profiles and all referenced workflow files", () => {
	const root = resolve(import.meta.dirname, "..");
	const plan = planChanges({ root, base: "HEAD" });
	assert.deepEqual(
		[...FEATURES.map((item) => item.id)].sort(),
		[...ALL_PROFILES].sort(),
	);
	assert.equal(plan.requiredWorkflows.length, WORKFLOWS.length);
});

test("invalid revisions, non-ancestor bases and missing registry files fail before execution", (t) => {
	const f = fixture(t);
	assert.throws(
		() => planChanges({ root: f.root, base: "--help" }),
		/INVALID_BASE/,
	);
	assert.throws(
		() => planChanges({ root: f.root, base: "missing-ref" }),
		/INVALID_BASE/,
	);
	f.git("checkout", "--orphan", "unrelated");
	f.git("commit", "--allow-empty", "-qm", "unrelated");
	const unrelated = f.git("rev-parse", "HEAD");
	f.git("checkout", "--detach", f.base);
	assert.throws(
		() => planChanges({ root: f.root, base: unrelated }),
		/BASE_NOT_ANCESTOR/,
	);
	rmSync(join(f.root, WORKFLOWS[0]));
	assert.throws(
		() => planChanges({ root: f.root, base: f.base }),
		/REGISTRY_INVALID/,
	);
});

test("CLI accepts only the fixed planning and execution interface", () => {
	assert.deepEqual(parseArgs(["plan", "--base", "HEAD"]), {
		mode: "plan",
		base: "HEAD",
	});
	assert.deepEqual(parseArgs(["plan", "--base", "HEAD^"]), {
		mode: "plan",
		base: "HEAD^",
	});
	assert.deepEqual(
		parseArgs(["run", "--base", "origin/main", "--output", "/tmp/new"]),
		{ mode: "run", base: "origin/main", output: "/tmp/new" },
	);
	for (const args of [
		[],
		["plan"],
		["run", "--base", "HEAD"],
		["plan", "--base", "HEAD", "--output", "/tmp/new"],
		["run", "--base", "HEAD", "--output", "/tmp/new", "--timeout", "1"],
		["plan", "--base", "-C"],
		["run", "--base", "HEAD", "--output", "relative"],
	])
		assert.throws(() => parseArgs(args));
});

test("bounded execution runs the fixed union, settles all profiles and preserves pending delivery gates", async (t) => {
	const f = fixture(t);
	write(join(f.root, "apps/worker/src/vmaf/new.ts"));
	let active = 0;
	let maximum = 0;
	const result = await runChanges({
		...f,
		executeFeature: async (id, options) => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((accept) => setTimeout(accept, 5));
			try {
				return await success(id, options);
			} finally {
				active--;
			}
		},
	});
	assert.equal(result.status, "fast-checks-passed");
	assert.equal(maximum, 2);
	assert.equal(active, 0);
	assert.deepEqual(result.actualProfiles, result.expectedProfiles);
	assert(
		result.results.every((entry) => /^[a-f0-9]{64}$/.test(entry.receiptDigest)),
	);
	assert.equal(result.deliveryReady, false);
	assert(!JSON.stringify(result).includes("assertionResults"));
	await assert.rejects(
		() => runChanges({ ...f, executeFeature: success }),
		/OUTPUT_EXISTS/,
	);
});

test("no changes and known documentation retain not-required rather than test success", async (t) => {
	const f = fixture(t);
	const empty = await runChanges({
		...f,
		executeFeature: () => assert.fail("must not execute"),
	});
	assert.equal(empty.status, "not-required");
	assert.equal(empty.reason, "NO_CHANGES");
	write(join(f.root, "README.md"), "edited docs\n");
	const docs = await runChanges({
		...f,
		output: join(f.directory, "docs"),
		executeFeature: () => assert.fail("must not execute"),
	});
	assert.equal(docs.status, "not-required");
	assert.equal(docs.reason, "DOCUMENTATION_ONLY");
});

for (const fault of ["missing", "skipped", "failed", "wrong-id", "blocked"])
	test(`a ${fault} profile receipt cannot pass and does not drop later profiles`, async (t) => {
		const f = fixture(t);
		write(join(f.root, "apps/worker/src/vmaf/new.ts"));
		let calls = 0;
		const result = await runChanges({
			...f,
			executeFeature: async (id, options) => {
				const receipt = await success(id, options);
				if (calls++ === 0) {
					if (fault === "missing") rmSync(join(options.output, "receipt.json"));
					else {
						if (fault === "skipped") receipt.actual.files[0].passed--;
						if (fault === "failed") receipt.status = "failed";
						if (fault === "blocked") receipt.status = "blocked";
						if (fault === "wrong-id") receipt.featureId = "unrequested";
						write(
							join(options.output, "receipt.json"),
							JSON.stringify(receipt),
						);
					}
				}
				return receipt;
			},
		});
		assert.equal(calls, 3);
		assert.equal(result.status, fault === "blocked" ? "blocked" : "failed");
	});

for (const drift of ["source", "index", "policy"])
	test(`${drift} drift prevents accepting otherwise green receipts`, async (t) => {
		const f = fixture(t);
		write(join(f.root, "apps/worker/src/live/new.ts"));
		let policy = "a".repeat(64);
		const result = await runChanges({
			...f,
			policy: () => policy,
			executeFeature: async (id, options) => {
				const receipt = await success(id, options);
				if (drift === "source")
					write(join(f.root, "README.md"), "changed during run\n");
				else if (drift === "index") {
					write(join(f.root, "README.md"), "staged during run\n");
					f.git("add", "README.md");
					write(join(f.root, "README.md"));
				} else policy = "b".repeat(64);
				return receipt;
			},
		});
		assert.equal(result.status, "failed");
		assert.equal(result.reason, `${drift.toUpperCase()}_CHANGED`);
	});

test("package commands and CI quality retain the tested change-plan contract", () => {
	const root = resolve(import.meta.dirname, "..");
	const scripts = JSON.parse(readFileSync(join(root, "package.json"))).scripts;
	assert.equal(
		scripts["verify:change"],
		"node scripts/change-verification.mjs",
	);
	assert.equal(
		scripts["test:change-verification"],
		"node --test scripts/change-verification.test.mjs",
	);
	assert(scripts.test.split(" && ").includes("pnpm test:change-verification"));
	const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
	const quality = ci.match(
		/^ {2}quality:\n([\s\S]*?)(?=^ {2}\S|$(?![\s\S]))/m,
	)?.[1];
	assert(quality);
	assert.match(quality, /fetch-depth: 2/);
	assert.match(quality, /persist-credentials: false/);
	assert.match(quality, /run: pnpm test:change-verification/);
	assert.match(
		quality,
		/run: node scripts\/change-verification\.mjs plan --base HEAD\^/,
	);
});

test("output inside source or through its symlink alias is refused", async (t) => {
	const f = fixture(t);
	symlinkSync(f.root, join(f.directory, "alias"));
	for (const output of [
		join(f.root, "evidence"),
		join(f.directory, "alias", "evidence"),
	])
		await assert.rejects(
			() => runChanges({ ...f, output, executeFeature: () => assert.fail() }),
			/OUTPUT_MUST_BE_OUTSIDE_SOURCE/,
		);
});

for (const mode of ["cancel", "deadline"])
	test(`${mode} aborts active profiles, awaits their cleanup and leaves unstarted profiles unclaimed`, async (t) => {
		const f = fixture(t);
		write(join(f.root, "apps/worker/src/vmaf/new.ts"));
		const controller = new AbortController();
		let closed = 0;
		const result = await runChanges({
			...f,
			signal: controller.signal,
			timeoutMs: 30,
			executeFeature: async (_id, { signal }) => {
				if (mode === "cancel") setTimeout(() => controller.abort(), 5);
				await new Promise((accept) =>
					signal.aborted
						? accept()
						: signal.addEventListener("abort", accept, { once: true }),
				);
				await new Promise((accept) => setTimeout(accept, 5));
				closed++;
				throw new Error("fixture cleanup completed");
			},
		});
		assert.equal(closed, 2);
		assert.equal(result.actualProfiles.length, 2);
		assert.equal(result.status, "failed");
		assert.equal(result.reason, mode === "cancel" ? "CANCELLED" : "TIMEOUT");
	});
