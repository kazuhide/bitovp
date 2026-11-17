import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lintWorkflows, workflowFiles } from "./workflow-lint.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "workflow-lint-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, ".github/workflows");
	mkdirSync(directory, { recursive: true });
	return { root, directory };
}

test("all workflow extensions are checked in source archives without Git metadata", (t) => {
	const { root, directory } = fixture(t);
	for (const file of ["first.yml", "new-workflow.yaml", "notes.md"])
		writeFileSync(join(directory, file), "fixture");
	assert.equal(
		lintWorkflows(root, (binary, args, options) => {
			assert.equal(binary, "actionlint");
			assert.deepEqual(args, [
				"-shellcheck=",
				"-pyflakes=",
				join(directory, "first.yml"),
				join(directory, "new-workflow.yaml"),
			]);
			assert.equal(options.cwd, root);
			assert.equal(options.timeout, 30_000);
			return { status: 0 };
		}),
		2,
	);
});

test("an empty or symlinked workflow inventory never looks successful", (t) => {
	const { root, directory } = fixture(t);
	assert.throws(() => workflowFiles(root), /NO_WORKFLOWS/);
	writeFileSync(join(root, "external.yml"), "fixture");
	symlinkSync(join(root, "external.yml"), join(directory, "linked.yml"));
	assert.throws(() => workflowFiles(root), /REGULAR_FILE/);
});

test("failed, signalled, unavailable and timed-out linters cannot pass", (t) => {
	const { root, directory } = fixture(t);
	writeFileSync(join(directory, "test.yml"), "fixture");
	for (const result of [
		{ status: 1 },
		{ status: 0, signal: "SIGTERM" },
		{ status: null, error: new Error("ENOENT") },
		{ status: null, error: new Error("ETIMEDOUT") },
	])
		assert.throws(
			() => lintWorkflows(root, () => result),
			/WORKFLOW_LINT_FAILED/,
		);
});
