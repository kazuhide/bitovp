import assert from "node:assert/strict";
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	asFailure,
	atStep,
	failureLines,
	GateFailure,
	inStep,
	isEntryPoint,
	outputTail,
	publicLines,
	withLaterFailure,
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

test("a cut-off start of a known secret is removed too", () => {
	// A formatter that shortens a value prints a start of the secret. Vitest
	// cuts an assertion value at 40 characters; a CI mask matches whole values.
	const head = url.indexOf(password);
	assert.deepEqual(
		publicLines(
			[
				`AssertionError: expected '${password.slice(0, 37)}…' to be '' // Object.is equality`,
				`PGPASSWORD=${password.slice(0, 8)}`,
				`seven characters do not identify it: ${password.slice(0, 7)}`,
				`expected '${url.slice(0, head + 6)}…'`,
				`expected '${url.slice(0, head + 1)}…'`,
				`no password character yet: '${url.slice(0, head)}…'`,
				`${password.slice(0, 10)}, ${password} and ${password.slice(0, 9)}${password.slice(0, 9)}x`,
			].join("\n"),
			{ secrets: [password, url] },
		),
		[
			"AssertionError: expected '[private]…' to be '' // Object.is equality",
			"PGPASSWORD=[private]",
			`seven characters do not identify it: ${password.slice(0, 7)}`,
			"expected '[private]…'",
			"expected '[private]…'",
			`no password character yet: '${url.slice(0, head)}…'`,
			"[private], [private] and [private][private]x",
		],
	);
	// A short secret, and a URL without credentials, are matched whole only.
	assert.deepEqual(
		publicLines(
			"pw=SECRET-12 and SECRET-1234\nhttps://registry.example/v2/ and https://registry.example/v2/name",
			{ secrets: ["SECRET-1234", "https://registry.example/v2/name"] },
		),
		[
			"pw=SECRET-12 and [private]",
			"https://registry.example/v2/ and [private]",
		],
	);
});

test("a secret split by invisible characters is still removed", () => {
	const split = (mark) =>
		`PGPASSWORD=${password.slice(0, 12)}${mark}${password.slice(12)}`;
	const marks = [
		"\u001b[0m",
		"\u0000",
		"\u009b",
		"\u00ad",
		"\u061c",
		"\u200b",
		"\u200f",
		"\u2028",
		"\u202e",
		"\u2066",
		"\ufeff",
		"\ud800",
		"\u{e0001}",
	];
	assert.deepEqual(
		publicLines(marks.map(split).join("\n"), { secrets: [password] }),
		marks.map(() => "PGPASSWORD=[private]"),
	);
	// A registered secret that holds such a character is matched without it.
	assert.deepEqual(
		publicLines("pw=ab\u0001cdefgh and abcdefgh", {
			secrets: ["ab\u0001cdefgh"],
		}),
		["pw=[private] and [private]"],
	);
});

test("credentials in any URL are removed even when the secret is unknown", () => {
	assert.deepEqual(
		publicLines(
			[
				"postgres://app:unknown-secret@127.0.0.1:5432/db",
				"redis://:only-a-password@127.0.0.1:6379/0",
				"https://token@registry.example/v2/",
				"postgres://app:p@ss@w0rd@127.0.0.1/db and POSTGRES://a:b@h/x?y=c@d",
				"see https://example.com/users/a@b and mailto:someone@example.com",
			].join("\n"),
		),
		[
			"postgres://[private]@127.0.0.1:5432/db",
			"redis://[private]@127.0.0.1:6379/0",
			"https://[private]@registry.example/v2/",
			"postgres://[private]@127.0.0.1/db and POSTGRES://[private]@h/x?y=c@d",
			"see https://example.com/users/a@b and mailto:someone@example.com",
		],
	);
});

test("a long unbroken line is cleaned in linear time", () => {
	// The former URL pattern restarted at every letter: 256,000 hexadecimal
	// characters took 14 seconds.
	const started = performance.now();
	const lines = publicLines(`${"0123456789abcdef".repeat(16_000)}://x@y`, {
		secrets: [password, url],
	});
	assert.equal(lines.length, 1);
	assert(performance.now() - started < 2_000);
});

test("terminal control, blank lines and overlong output cannot reach the log", () => {
	assert.deepEqual(
		publicLines(
			"\u001b[31mred\u001b[0m text\r\n\n   \nbell\u0007 and \u009b2J and \u202eflipped\rcarriage",
		),
		["red text", "bell and 2J and flipped", "carriage"],
	);
	// Characters that a viewer hides are removed; a tab and an emoji stay.
	assert.deepEqual(
		publicLines(
			"a\u00adb\u061cc\u200bd\u200ee\u2028f\u2029g\u2060h\u2069i\ufeffj\ud83dk\u{e0041}l\tm \u{1f600}",
		),
		["abcdefghijkl\tm \u{1f600}"],
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
		// Details and child output are printed only when the gate attached them.
		[
			Object.assign(new TypeError(`foreign ${url}`), {
				details: [`foreign detail ${url}`],
				diagnostics: `foreign diagnostics ${url}`,
			}),
			"Reason: TypeError (message withheld)",
		],
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
		"::error file=a.ts::forged\n   ::add-mask::x\n##[group]forged\ntext ##[error]forged\n::stop-commands::token\n#\u200b#[warning]split\n#\u0000#\u202e[notice]split";
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
	// A marker that only forms once invisible characters are removed.
	assert(lines.includes("  | ## [warning]split"));
	assert(lines.includes("  | ## [notice]split"));
});

test("a long list of details is bounded", () => {
	const error = new GateFailure("Failed", {
		details: Array.from({ length: 500 }, (_, index) => `detail ${index}`),
	});
	const lines = failureLines(error);
	assert.equal(lines.length, 162);
	assert.equal(lines.at(-1), "  - 340 more lines not shown");
});

test("a failure names the step that threw first, and a later cleanup failure follows it", async () => {
	const first = new GateFailure("Tests must pass", { details: ["a: not run"] });
	await assert.rejects(
		inStep("outer step", () =>
			inStep("running tests", () => Promise.reject(first)),
		),
		(error) => error === first && error.step === "running tests",
	);
	// A thrown value that is not an error becomes one that can be reported.
	assert.equal(asFailure(first), first);
	for (const value of [undefined, null, 0, "", false, "text"])
		assert.deepEqual(failureLines(atStep(asFailure(value), "a step")), [
			"Step: a step",
			"Reason: A step failed without an error",
		]);
	// What cannot carry a step is passed on unchanged.
	const frozen = Object.freeze(new Error("frozen"));
	assert.equal(atStep(frozen, "step"), frozen);
	assert.equal(atStep("text", "step"), "text");
	assert.equal(atStep(undefined, "step"), undefined);
	await assert.rejects(
		inStep("step", () => Promise.reject(frozen)),
		(error) => error === frozen && error.step === undefined,
	);
	assert.equal(await inStep("step", () => "result"), "result");

	const later = atStep(
		new GateFailure("Cleanup failed", { diagnostics: `rm ${url}\n` }),
		"removing the fixture",
	);
	assert.equal(withLaterFailure(first, later), first);
	assert.deepEqual(failureLines(first, { secrets: [url] }), [
		"Step: running tests",
		"Reason: Tests must pass",
		"  - a: not run",
		"A later step also failed:",
		"Step: removing the fixture",
		"Reason: Cleanup failed",
		"Last 1 lines of the failed command:",
		"  | rm [private]",
	]);
	// Only one later failure is reported, so a cycle cannot repeat the report.
	withLaterFailure(later, first);
	assert.equal(
		failureLines(first).filter((line) => line === "A later step also failed:")
			.length,
		1,
	);
	// A first failure that cannot carry the cleanup failure gives way to it.
	for (const value of [undefined, null, "text", frozen])
		assert.equal(withLaterFailure(value, later), later);
});

test("a script knows that it was started, also through a symlink or a preserved symlink", () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "gate-entry-")));
	try {
		const real = join(directory, "script.mjs");
		writeFileSync(real, "");
		symlinkSync(directory, join(directory, "linked"));
		const linked = join(directory, "linked", "script.mjs");
		const url = pathToFileURL(real).href;
		assert.equal(isEntryPoint(url, real), true);
		// Node resolves the symlink before it loads the script ...
		assert.equal(isEntryPoint(url, linked), true);
		// ... unless --preserve-symlinks-main keeps the path as it was given.
		assert.equal(isEntryPoint(pathToFileURL(linked).href, linked), true);
		assert.equal(isEntryPoint(url, join(directory, "other.mjs")), false);
		writeFileSync(join(directory, "other.mjs"), "");
		assert.equal(isEntryPoint(url, join(directory, "other.mjs")), false);
		// A test runner passes patterns and labels that are not files.
		for (const path of [undefined, "", "*.test.mjs", join(directory, "none")])
			assert.equal(isEntryPoint(url, path), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("every workflow marker in a line is rewritten", () => {
	assert.deepEqual(publicLines("a ##[warning]b ##[error]c"), [
		"a ## [warning]b ## [error]c",
	]);
});

test("URL credentials are removed whatever the scheme's spelling", () => {
	assert.deepEqual(
		publicLines(
			[
				"POSTGRES://app:unknown-secret@127.0.0.1:5432/db",
				"postgresql+psycopg2://app:unknown-secret@127.0.0.1:5432/db",
				"s3://key:unknown-secret@bucket/object",
			].join("\n"),
		),
		[
			"POSTGRES://[private]@127.0.0.1:5432/db",
			"postgresql+psycopg2://[private]@127.0.0.1:5432/db",
			"s3://[private]@bucket/object",
		],
	);
});

test("a report bounds the step, the reason and the child output by default", () => {
	const error = new GateFailure("one\ntwo\nthree\nfour", {
		diagnostics: Array.from(
			{ length: 200 },
			(_, index) => `line ${index}`,
		).join("\n"),
	});
	error.step = "first\nsecond";
	const lines = failureLines(error);
	// One line names the step, whatever the step text holds.
	assert.deepEqual(lines.slice(0, 5), [
		"Step: first",
		"Reason: one",
		"Reason: two",
		"Reason: three",
		"Last 80 lines of the failed command:",
	]);
	assert.equal(lines.length, 85);
	assert.equal(lines[5], "  | line 120");
	assert.equal(lines.at(-1), "  | line 199");
});

test("an authored equality assertion prints its message, not the values it compared", () => {
	const thrown = (() => {
		try {
			assert.equal(
				`child wrote ${password}`,
				"expected",
				"The gate wrote this",
			);
		} catch (error) {
			return error;
		}
	})();
	assert.equal(thrown.generatedMessage, false);
	// Node appends the compared values to the message of an equality assertion.
	assert(thrown.message.includes(password));
	assert.deepEqual(failureLines(thrown), ["Reason: The gate wrote this"]);
});
