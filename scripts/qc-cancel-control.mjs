import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isEntryPoint } from "./gate-report.mjs";
import {
	reportProblems,
	runFixture,
	stopCommands,
	testEnvironment,
} from "./postgres-integration.mjs";
import { qualifyMutation } from "./semantic-controls.mjs";

const root = resolve(import.meta.dirname, "..");
const group = {
	directory: "apps/web",
	files: { "src/lib/server/qc-cancel.integration.test.ts": 3 },
};
const file = Object.keys(group.files)[0];
const route = join(
	group.directory,
	"src/app/api/vmaf-jobs/[id]/cancel/route.ts",
);
const titles = [
	"preserves the committed completion when cancellation already read RUNNING",
	"accepts legacy LOCAL cancellation once and keeps partial results on retry",
	"hides a running foreign job from the tenant requesting cancellation",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function mutate(source) {
	const predicate = 'status: { in: ["PENDING", "RUNNING"] },';
	assert.equal(
		source.split(predicate).length,
		2,
		"Expected exactly one status predicate",
	);
	return source.replace(
		predicate,
		'...(execution.backend === "CLOUD" ? { status: { in: ["PENDING", "RUNNING"] } } : {}),',
	);
}

export function assess(report, code, stage, checkout) {
	const mutant = stage === "mutant";
	assert.equal(code, mutant ? "1" : "0", "Unexpected test command exit");
	assert.equal(report.testResults.length, 1);
	const [suite] = report.testResults;
	assert.equal(suite.name, join(checkout, group.directory, file));
	const cases = suite.assertionResults;
	assert.deepEqual(cases.map((a) => a.title).sort(), [...titles].sort());
	if (!mutant) {
		assert.equal(
			reportProblems(report, group, checkout).length,
			0,
			"Required PostgreSQL cases did not all pass",
		);
		return;
	}
	assert.equal(report.success, false);
	assert.equal(suite.status, "failed");
	assert.equal(suite.message, "", "Unexpected suite setup or cleanup failure");
	assert.equal(report.numTotalTests, 3);
	assert.equal(report.numPassedTests, 2);
	assert.equal(report.numFailedTests, 1);
	assert.equal(report.numPendingTests, 0);
	assert.equal(report.numTodoTests, 0);
	assert.equal(report.numPendingTestSuites, 0);
	assert(report.numFailedTestSuites > 0);
	for (const entry of cases) {
		assert.equal(entry.status, entry.title === titles[0] ? "failed" : "passed");
		if (entry.status === "failed") {
			assert.equal(entry.failureMessages.length, 1);
			assert.match(
				entry.failureMessages[0].split("\n")[0],
				/^AssertionError: Cancellation overwrote a committed completion: expected 'ERROR' to be 'FINISHED' \/\/ Object\.is equality$/,
			);
		}
	}
}

export async function qualify(checkout, run, signal) {
	const result = await qualifyMutation({
		target: join(checkout, route),
		tests: [join(checkout, group.directory, file)],
		mutate,
		run,
		assess: (result, stage) =>
			assess(result.report, result.code, stage, checkout),
		signal,
	});
	return { ...result, testSha256: result.testSha256[0], detectedBy: titles[0] };
}

async function main(signal) {
	const [flag, output, ...extra] = process.argv.slice(2);
	assert(flag === "--output" && output && isAbsolute(output) && !extra.length);
	assert(
		process.platform === "linux" &&
			process.env.GITHUB_ACTIONS === "true" &&
			process.env.RUNNER_ENVIRONMENT === "github-hosted",
		"Requires a GitHub-hosted Linux runner",
	);
	assert.equal(realpathSync(process.env.GITHUB_WORKSPACE), root);
	const temp = realpathSync(process.env.RUNNER_TEMP);
	assert.equal(
		realpathSync(dirname(output)),
		temp,
		"Output must be directly under RUNNER_TEMP",
	);
	const git = (...args) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const sha = git("rev-parse", "HEAD");
	assert.equal(sha, process.env.GITHUB_SHA);
	assert.equal(
		git("status", "--porcelain", "--untracked-files=all"),
		"",
		"Requires a clean dedicated checkout",
	);
	assert.equal(
		git(
			"--literal-pathspecs",
			"ls-files",
			"--error-unmatch",
			"--",
			route,
			join(group.directory, file),
		).split("\n").length,
		2,
	);
	writeFileSync(output, JSON.stringify({ status: "incomplete", sha }), {
		flag: "wx",
		mode: 0o600,
	});
	let receipt;
	await runFixture({
		root,
		signal,
		statePath: join(temp, "bitovp-postgres-state.json"),
		run: async ({ directory, env }, execute) => {
			receipt = await qualify(
				root,
				async (name) => {
					console.log(`Checking LOCAL QC cancel ${name}`);
					const path = join(directory, `${name}.json`);
					assert(!existsSync(path));
					// Keep raw Vitest output private; the shared command enforces the process
					// group deadline. The shell returns the actual child status as stdout.
					const code = await execute(
						"sh",
						[
							"-c",
							'"$@" >/dev/null 2>&1; printf "%s" "$?"',
							"qc-cancel-control",
							"pnpm",
							"--filter",
							"@bitovp/web",
							"exec",
							"vitest",
							"run",
							file,
							"--allowOnly=false",
							"--reporter=json",
							`--outputFile=${path}`,
						],
						{ cwd: root, env: testEnvironment(env), timeout: 60_000 },
					);
					const bytes = readFileSync(path);
					return { report: JSON.parse(bytes), code, reportSha256: hash(bytes) };
				},
				signal,
			);
		},
	});
	signal.throwIfAborted();
	assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
	writeFileSync(
		output,
		`${JSON.stringify({ status: "passed", sha, ...receipt }, null, 2)}\n`,
	);
	console.log(
		"QC cancel PostgreSQL control: baseline 3 passed, mutant 1 expected behavior failure, restored 3 passed.",
	);
	console.log(JSON.stringify({ status: "passed", sha, ...receipt }));
}

if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			controller.abort();
			stopCommands();
			process.exitCode = 1;
		});
	main(controller.signal).catch(() => {
		console.error(
			"QC cancel control failed its environment, fixture, behavior, or restoration checks.",
		);
		process.exitCode = 1;
	});
}
