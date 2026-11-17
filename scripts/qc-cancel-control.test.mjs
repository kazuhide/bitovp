import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assess, mutate, qualify } from "./qc-cancel-control.mjs";

const route = "apps/web/src/app/api/vmaf-jobs/[id]/cancel/route.ts";
const file = "apps/web/src/lib/server/qc-cancel.integration.test.ts";
const source = 'where: { id, status: { in: ["PENDING", "RUNNING"] }, mode },';
function report(root, mutant) {
	const cases = [
		"preserves the committed completion when cancellation already read RUNNING",
		"accepts legacy LOCAL cancellation once and keeps partial results on retry",
		"hides a running foreign job from the tenant requesting cancellation",
	].map((title) => ({ title, status: "passed", failureMessages: [] }));
	if (mutant) {
		cases[0].status = "failed";
		cases[0].failureMessages.push(
			"AssertionError: Cancellation overwrote a committed completion: expected 'ERROR' to be 'FINISHED' // Object.is equality\n   at test.ts",
		);
	}
	return {
		success: !mutant,
		numTotalTests: 3,
		numPassedTests: mutant ? 2 : 3,
		numFailedTests: mutant ? 1 : 0,
		numPendingTests: 0,
		numTodoTests: 0,
		numFailedTestSuites: mutant ? 2 : 0,
		numPendingTestSuites: 0,
		testResults: [
			{
				name: join(root, file),
				status: mutant ? "failed" : "passed",
				message: "",
				assertionResults: cases,
			},
		],
	};
}

test("accepts only the observed behavior failure and matching command result", () => {
	const root = "/git";
	const fresh = () => report(root, true);
	assess(fresh(), "1", "mutant", root);
	for (const change of [
		(r) => {
			r.testResults[0].assertionResults[0].failureMessages = [
				"Error: database unavailable",
			];
		},
		(r) => {
			r.testResults[0].assertionResults[0].title = "another test";
		},
		(r) => {
			r.testResults[0].assertionResults[1].status = "skipped";
		},
		(r) => {
			r.numPendingTests = 1;
		},
		(r) => {
			r.numFailedTests = 2;
		},
		(r) => {
			r.testResults[0].message = "afterAll failed";
		},
		(r) => {
			r.testResults[0].assertionResults[0].failureMessages.push("hook error");
		},
		(r) => {
			r.testResults[0].name += ".different";
		},
	]) {
		const altered = fresh();
		change(altered);
		assert.throws(() => assess(altered, "1", "mutant", root));
	}
	for (const code of ["0", "2", "124", "137"])
		assert.throws(() => assess(fresh(), code, "mutant", root));
	assert.throws(() => assess(fresh(), "0", "baseline", root));
});

test("requires the unique status predicate and retains it for CLOUD", () => {
	assert.match(
		mutate(source),
		/execution\.backend === "CLOUD" \? \{ status: .* \} : \{\}/,
	);
	assert.throws(() => mutate("no predicate"));
	assert.throws(() => mutate(source + source));
});

test("restores the exact source after a rejected command, source drift, or accepted control", async () => {
	for (const mode of ["command failure", "test drift", "success"]) {
		const root = mkdtempSync(join(tmpdir(), "qc-control-test-"));
		try {
			for (const path of [route, file])
				mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, route), source);
			writeFileSync(join(root, file), "same assertions");
			const seen = [];
			const result = qualify(root, async (name) => {
				seen.push(name);
				const mutant = name === "mutant";
				assert.equal(
					readFileSync(join(root, route), "utf8"),
					mutant ? mutate(source) : source,
				);
				if (mutant && mode === "command failure") throw new Error("cancelled");
				if (mutant && mode === "test drift")
					writeFileSync(join(root, file), "changed assertions");
				return {
					report: report(root, mutant),
					code: mutant ? "1" : "0",
					reportSha256: "test",
				};
			});
			if (mode === "success") {
				assert.equal((await result).stages.length, 3);
				assert.deepEqual(seen, ["baseline", "mutant", "restored"]);
			} else {
				await assert.rejects(
					result,
					mode === "test drift" ? /TESTS_CHANGED/ : /cancelled/,
				);
				assert.deepEqual(seen, ["baseline", "mutant"]);
			}
			assert.equal(readFileSync(join(root, route), "utf8"), source);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});
