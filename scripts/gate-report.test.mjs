import assert from "node:assert/strict";
import test from "node:test";
import {
	failureLines,
	GateFailure,
	outputTail,
	publicLines,
} from "./gate-report.mjs";

const password = "Zx9_fixture-password-0123456789abcdefABCDEF";
const url = `postgresql://bitovp_fixture_admin:${password}@127.0.0.1:15432/bitovp_integration_0123?schema=public`;

test("known secrets are removed wherever they appear, longest first", () => {
	const lines = publicLines(
		`connecting to ${url}\nPASSWORD '${password}' rejected\nprefix${password}suffix`,
		{ secrets: [password, url, "", undefined] },
	);
	assert.deepEqual(lines, [
		"connecting to [private]",
		"PASSWORD '[private]' rejected",
		"prefix[private]suffix",
	]);
});

test("credentials in any URL are removed even when the secret is unknown", () => {
	assert.deepEqual(
		publicLines(
			[
				"postgres://app:unknown-secret@127.0.0.1:5432/db",
				"redis://:only-a-password@127.0.0.1:6379/0",
				"https://token@registry.example/v2/",
				"see https://example.com/users/a@b and mailto:someone@example.com",
			].join("\n"),
		),
		[
			"postgres://[private]@127.0.0.1:5432/db",
			"redis://[private]@127.0.0.1:6379/0",
			"https://[private]@registry.example/v2/",
			"see https://example.com/users/a@b and mailto:someone@example.com",
		],
	);
});

test("terminal control, blank lines and overlong output cannot reach the log", () => {
	assert.deepEqual(
		publicLines(
			"\u001b[31mred\u001b[0m text\r\n\n   \nbell\u0007 and \u009b2J and ‮flipped\rcarriage",
		),
		["red text", "bell and 2J and flipped", "carriage"],
	);
	const many = Array.from({ length: 200 }, (_, index) => `line ${index}`);
	assert.deepEqual(publicLines(many.join("\n"), { limit: 3 }), [
		"line 197",
		"line 198",
		"line 199",
	]);
	assert.deepEqual(publicLines(many.join("\n"), { limit: 2, keep: "start" }), [
		"line 0",
		"line 1",
	]);
	assert.equal(publicLines("x".repeat(5000))[0].length, 300);
	// A secret is removed before a long line is shortened.
	assert.deepEqual(
		publicLines(`${"x".repeat(290)}${password}`, { secrets: [password] }),
		[`${"x".repeat(290)}[private]`],
	);
});

test("a cut output tail never begins inside a line", () => {
	const tail = outputTail(40);
	tail.add("short\n");
	assert.equal(tail.text(), "short\n");
	tail.add(`first half of ${password}\nlast complete line\n`);
	assert.equal(tail.text(), "last complete line\n");
	const single = outputTail(10);
	single.add(`no newline ${password}`);
	assert.equal(single.text(), "");
});

test("only messages written by the gate are printed", () => {
	const generated = (() => {
		try {
			assert.deepEqual({ url }, { url: "other" });
		} catch (error) {
			return error;
		}
	})();
	const syntax = (() => {
		try {
			JSON.parse(url);
		} catch (error) {
			return error;
		}
	})();
	const system = Object.assign(
		new Error(`ENOENT: no such file, open '${url}'`),
		{
			code: "ENOENT",
		},
	);
	for (const [error, expected] of [
		[new GateFailure("The gate wrote this"), "Reason: The gate wrote this"],
		[
			new assert.AssertionError({ message: "An authored assertion" }),
			"Reason: An authored assertion",
		],
		[generated, "Reason: AssertionError ERR_ASSERTION (message withheld)"],
		[syntax, "Reason: SyntaxError (message withheld)"],
		[system, "Reason: Error ENOENT (message withheld)"],
		[new Error(`foreign ${url}`), "Reason: Error (message withheld)"],
		[
			new TypeError(`fetch failed for ${url}`, {
				cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
			}),
			"Reason: TypeError ECONNRESET (message withheld)",
		],
		[
			new DOMException("timed out", "TimeoutError"),
			"Reason: TimeoutError (message withheld)",
		],
		["a thrown string", "Reason: Error (message withheld)"],
		[undefined, "Reason: Error (message withheld)"],
	])
		assert.deepEqual(failureLines(error), [expected]);
});

test("a failure report names the step, the details and the end of the child output", () => {
	const error = new GateFailure("Tests must pass", {
		details: [
			"src/a.integration.test.ts: 1 of 2 tests passed, 2 required",
			`"failed": suite > case\nAssertionError: expected ${url}\n    at file.ts:1:1`,
		],
		diagnostics: `noise\nconnection to ${url} refused\n`,
	});
	error.step = "running @bitovp/db PostgreSQL tests";
	assert.deepEqual(failureLines(error, { secrets: [password, url] }), [
		"Step: running @bitovp/db PostgreSQL tests",
		"Reason: Tests must pass",
		"  - src/a.integration.test.ts: 1 of 2 tests passed, 2 required",
		'  - "failed": suite > case',
		"    | AssertionError: expected [private]",
		"    |     at file.ts:1:1",
		"Last 2 lines of the failed command:",
		"  | noise",
		"  | connection to [private] refused",
	]);
});

test("child text cannot start a line or forge a CI workflow command", () => {
	const hostile =
		"::error file=a.ts::forged\n   ::add-mask::x\n##[group]forged\ntext ##[error]forged\n::stop-commands::token";
	const error = new GateFailure("Failed", {
		details: [hostile],
		diagnostics: hostile,
	});
	error.step = hostile;
	const lines = failureLines(error);
	assert(lines.length > 10);
	for (const line of lines) {
		assert(!line.trimStart().startsWith("::"), line);
		assert(!line.includes("##["), line);
	}
	assert(lines.includes("  | ::error file=a.ts::forged"));
	assert(lines.includes("  | text ## [error]forged"));
});

test("a long list of details is bounded", () => {
	const error = new GateFailure("Failed", {
		details: Array.from({ length: 500 }, (_, index) => `detail ${index}`),
	});
	const lines = failureLines(error);
	assert.equal(lines.length, 162);
	assert.equal(lines.at(-1), "  - 340 more lines not shown");
});
