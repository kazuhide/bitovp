import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { atStep, GateFailure } from "./gate-report.mjs";
import {
	childEnvironment,
	cleanupFixture,
	command,
	failureReport,
	GROUPS,
	runFixture,
	runIntegrationTests,
	testEnvironment,
	validateReport,
} from "./postgres-integration.mjs";

const root = resolve(import.meta.dirname, "..");
const database = "bitovp_integration_0123456789abcdef0123456789abcdef";
const urls = {
	BITOVP_TENANT_TEST_ADMIN_URL: `postgresql://fixture_admin:random-admin@127.0.0.1:15432/${database}?schema=public`,
	BITOVP_TENANT_TEST_APP_URL: `postgresql://bitovp_runtime:random-app@127.0.0.1:15432/${database}?schema=public`,
};

function report(group) {
	const total = Object.values(group.files).reduce((a, b) => a + b, 0);
	return {
		success: true,
		numTotalTests: total,
		numPassedTests: total,
		numFailedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		testResults: Object.entries(group.files).map(([name, count]) => ({
			name: resolve(root, group.directory, name),
			status: "passed",
			assertionResults: Array.from({ length: count }, () => ({
				status: "passed",
			})),
		})),
	};
}

test("requires both dedicated URLs before starting any test process", async () => {
	let invoked = false;
	for (const env of [{}, { ...urls, BITOVP_TENANT_TEST_APP_URL: "" }]) {
		await assert.rejects(
			runIntegrationTests({ root, directory: tmpdir(), env }, async () => {
				invoked = true;
			}),
			/Required PostgreSQL test URLs/,
		);
	}
	assert.equal(invoked, false);
});

test("refuses admin-as-runtime, remote, unrelated or non-dedicated databases", () => {
	for (const app of [
		urls.BITOVP_TENANT_TEST_ADMIN_URL,
		urls.BITOVP_TENANT_TEST_APP_URL.replace("127.0.0.1", "example.invalid"),
		urls.BITOVP_TENANT_TEST_APP_URL.replace(":15432/", ":15433/"),
		urls.BITOVP_TENANT_TEST_APP_URL.replace(database, "production"),
		`${urls.BITOVP_TENANT_TEST_APP_URL}&host=example.invalid`,
	]) {
		assert.throws(() =>
			testEnvironment({ ...urls, BITOVP_TENANT_TEST_APP_URL: app }),
		);
	}
});

test("child environment excludes ambient application, provider and tooling overrides", () => {
	const result = childEnvironment({
		PATH: "/bin",
		LANG: "C.UTF-8",
		DATABASE_URL: "private",
		AWS_SECRET_ACCESS_KEY: "private",
		NODE_OPTIONS: "--import private",
		DOCKER_HOST: "tcp://remote.invalid",
		MIGRATION_DATABASE_URL: "private",
		BITOVP_TENANT_TEST_ADMIN_URL: "private",
	});
	assert.deepEqual(result, {
		PATH: "/bin",
		LANG: "C.UTF-8",
		CI: "1",
		TURBO_TELEMETRY_DISABLED: "1",
		NEXT_TELEMETRY_DISABLED: "1",
	});
	assert.equal(testEnvironment({ ...result, ...urls }).DATABASE_URL, undefined);
	const clean = testEnvironment({
		...urls,
		BITOVP_MONITORING_TEST_DATABASE_URL: "private",
	});
	assert.equal(
		clean.BITOVP_MONITORING_TEST_DATABASE_URL,
		urls.BITOVP_TENANT_TEST_APP_URL,
	);
	assert.equal(
		clean.BITOVP_MONITORING_TEST_ADMIN_URL,
		urls.BITOVP_TENANT_TEST_ADMIN_URL,
	);
});

test("accepts exactly the required files and all passed assertions", () => {
	for (const group of GROUPS) {
		assert.doesNotThrow(() => validateReport(report(group), group, root));
	}
	// Editing adds DB/API/derivative/reset suites to the required census.
	assert.equal(GROUPS.flatMap((group) => Object.keys(group.files)).length, 32);
	assert.equal(
		GROUPS.flatMap((group) => Object.values(group.files)).reduce(
			(a, b) => a + b,
			0,
		),
		207,
	);
});

for (const [name, mutate] of [
	["missing file", (r) => r.testResults.pop()],
	["duplicate file", (r) => r.testResults.push(r.testResults[0])],
	[
		"unexpected file",
		(r) => {
			r.testResults[0].name += ".other";
		},
	],
	[
		"zero assertions",
		(r) => {
			r.testResults[0].assertionResults = [];
		},
	],
	[
		"skipped assertion",
		(r) => {
			r.testResults[0].assertionResults[0].status = "skipped";
		},
	],
	[
		"todo assertion",
		(r) => {
			r.testResults[0].assertionResults[0].status = "todo";
		},
	],
	[
		"failed assertion",
		(r) => {
			r.testResults[0].assertionResults[0].status = "failed";
		},
	],
	[
		"pending total",
		(r) => {
			r.numPendingTests = 1;
		},
	],
	[
		"todo total",
		(r) => {
			r.numTodoTests = 1;
		},
	],
	[
		"wrong total",
		(r) => {
			r.numTotalTests -= 1;
		},
	],
	[
		"failed suite",
		(r) => {
			r.numFailedTestSuites = 1;
		},
	],
	[
		"runtime error",
		(r) => {
			r.success = false;
		},
	],
]) {
	test(`rejects a green-looking report with ${name}`, () => {
		const value = report(GROUPS[0]);
		mutate(value);
		assert.throws(() => validateReport(value, GROUPS[0], root));
	});
}

test("a rejected report names each file, its counts and every test that did not pass", () => {
	const group = GROUPS[0];
	const files = Object.keys(group.files);
	const value = report(group);
	value.success = false;
	value.numFailedTests = 1;
	value.numPendingTests = 1;
	value.numPassedTests -= 2;
	value.testResults[1].status = "failed";
	value.testResults[1].assertionResults[0] = {
		status: "failed",
		fullName: "tenant database > isolates organisations",
		failureMessages: [
			`AssertionError: expected ${urls.BITOVP_TENANT_TEST_APP_URL} to answer\n    at first.ts:1:1\n    at file:///repo/node_modules/vitest/runner.js:1:1\n    at new Promise (<anonymous>)\n${"    at deeper.ts:1:1\n".repeat(30)}`,
		],
	};
	value.testResults[1].assertionResults[1] = {
		status: "skipped",
		fullName: "tenant database > needs a second role",
		failureMessages: [],
	};
	value.testResults[2].status = "failed";
	value.testResults[2].message = "Error: Cannot find module './missing'";
	value.testResults[2].assertionResults = [];
	value.testResults.pop();
	let error;
	assert.throws(
		() => validateReport(value, group, root),
		(thrown) => {
			error = thrown;
			return true;
		},
	);
	const total = Object.values(group.files).reduce((a, b) => a + b, 0);
	assert.deepEqual(
		error.details.map((detail) => detail.split("\n")[0]),
		[
			"Vitest reported a failed run",
			"failed tests: 1, required 0",
			"skipped tests: 1, required 0",
			`tests passed: ${total - 2}, required ${total}`,
			`${files[1]}: ${group.files[files[1]] - 2} of ${group.files[files[1]]} tests passed, ${group.files[files[1]]} required; file status "failed"`,
			'"failed": tenant database > isolates organisations',
			'"skipped": tenant database > needs a second role',
			`${files[2]}: 0 of 0 tests passed, ${group.files[files[2]]} required; file status "failed"`,
			`${files[2]} did not load:`,
			`${files.at(-1)}: not run`,
		],
	);
	// A failure message keeps its first lines and loses its credentials.
	const lines = failureReport(error);
	assert.equal(
		lines[0],
		"Reason: PostgreSQL tests must have no failures, skips or unfinished cases",
	);
	assert(
		lines.includes(
			`    | AssertionError: expected postgresql://[private]@127.0.0.1:15432/${database}?schema=public to answer`,
		),
	);
	assert(lines.includes("    | Error: Cannot find module './missing'"));
	// Frames inside dependencies are dropped and the rest is kept short.
	assert(lines.includes("    |     at first.ts:1:1"));
	assert.equal(lines.filter((line) => line.includes("deeper.ts")).length, 6);
	assert(!lines.some((line) => /node_modules|anonymous/.test(line)));
	assert(!lines.join("\n").includes("random-app"));
});

for (const [name, wroteReport, failed, expected] of [
	[
		"a failed run that wrote its report is explained from the report",
		true,
		true,
		[
			"Step: running @bitovp/db PostgreSQL tests",
			"Reason: PostgreSQL tests must have no failures, skips or unfinished cases",
			"  - Vitest reported a failed run",
			"  - failed tests: 1, required 0",
			"  - tests passed: 69, required 70",
			'  - src/runtime-role.integration.test.ts: 0 of 1 tests passed, 1 required; file status "failed"',
			'  - "failed": runtime role > cannot create tables',
			"    | Error: permission was granted",
			"Last 1 lines of the failed command:",
			`  | stderr mentioned postgresql://[private]@127.0.0.1:15432/${database}?schema=public`,
		],
	],
	[
		"a failed run without a report keeps its own explanation",
		false,
		true,
		[
			"Step: running @bitovp/db PostgreSQL tests",
			"Reason: PostgreSQL integration command failed",
			"Last 1 lines of the failed command:",
			`  | stderr mentioned postgresql://[private]@127.0.0.1:15432/${database}?schema=public`,
		],
	],
	[
		"a successful run without a report is not accepted",
		false,
		false,
		[
			"Step: running @bitovp/db PostgreSQL tests",
			"Reason: Vitest did not write a readable PostgreSQL report",
		],
	],
])
	test(name, async () => {
		const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-explained-"));
		try {
			await assert.rejects(
				runIntegrationTests(
					{ root, directory, env: urls, notify: () => {} },
					async (_command, args) => {
						if (wroteReport) {
							const value = report(GROUPS[0]);
							value.success = false;
							value.numFailedTests = 1;
							value.numPassedTests -= 1;
							value.testResults[0].status = "failed";
							value.testResults[0].assertionResults[0] = {
								status: "failed",
								fullName: "runtime role > cannot create tables",
								failureMessages: ["Error: permission was granted"],
							};
							writeFileSync(
								args
									.find((arg) => arg.startsWith("--outputFile="))
									.slice("--outputFile=".length),
								JSON.stringify(value),
							);
						}
						if (failed)
							throw new GateFailure("PostgreSQL integration command failed", {
								diagnostics: `stderr mentioned ${urls.BITOVP_TENANT_TEST_ADMIN_URL}\n`,
							});
					},
				),
				(error) => {
					assert.deepEqual(failureReport(error), expected);
					return true;
				},
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

test("missing source files fail before launching Vitest", async () => {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-missing-"));
	let invoked = false;
	try {
		await assert.rejects(
			runIntegrationTests(
				{ root: directory, directory, env: urls },
				async () => {
					invoked = true;
				},
			),
			/Required PostgreSQL integration source/,
		);
		assert.equal(invoked, false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("runs each selected package and validates its actual report before continuing", async () => {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-reports-"));
	const invoked = [];
	try {
		await runIntegrationTests(
			{ root, directory, env: urls, notify: () => {} },
			async (command, args, options) => {
				const group = GROUPS[invoked.length];
				const temporary = realpathSync(options.env.TMPDIR);
				assert.equal(temporary, join(realpathSync(directory), "tmp"));
				assert.equal(options.env.TMP, temporary);
				assert.equal(options.env.TEMP, temporary);
				assert.equal(command, "pnpm");
				assert.equal(args[1], group.workspace);
				assert(args.includes("--maxWorkers=2"));
				for (const file of Object.keys(group.files))
					assert(args.includes(file));
				assert.equal(
					options.env.BITOVP_TENANT_TEST_APP_URL,
					urls.BITOVP_TENANT_TEST_APP_URL,
				);
				const output = args
					.find((arg) => arg.startsWith("--outputFile="))
					.slice("--outputFile=".length);
				writeFileSync(output, JSON.stringify(report(group)));
				invoked.push(group.workspace);
			},
		);
		assert.deepEqual(
			invoked,
			GROUPS.map((group) => group.workspace),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a skipped report stops the runner even when the Vitest process succeeds", async () => {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-skipped-"));
	let invoked = 0;
	try {
		await assert.rejects(
			runIntegrationTests(
				{ root, directory, env: urls, notify: () => {} },
				async (_command, args) => {
					invoked += 1;
					const value = report(GROUPS[0]);
					value.numPendingTests = value.numTotalTests;
					value.numPassedTests = 0;
					for (const file of value.testResults)
						for (const assertion of file.assertionResults)
							assertion.status = "skipped";
					const output = args
						.find((arg) => arg.startsWith("--outputFile="))
						.slice("--outputFile=".length);
					writeFileSync(output, JSON.stringify(value));
				},
			),
			/no failures, skips/,
		);
		assert.equal(invoked, 1);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("new opt-in PostgreSQL files cannot silently fall outside the manifest", async () => {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-discovery-"));
	let invoked = false;
	try {
		for (const group of GROUPS)
			for (const file of Object.keys(group.files)) {
				const path = resolve(directory, group.directory, file);
				mkdirSync(resolve(path, ".."), { recursive: true });
				writeFileSync(path, "process.env.BITOVP_TENANT_TEST_ADMIN_URL");
			}
		const extra = join(directory, "apps/worker/src/new.integration.test.ts");
		mkdirSync(resolve(extra, ".."), { recursive: true });
		writeFileSync(extra, "process.env.BITOVP_MONITORING_TEST_DATABASE_URL");
		await assert.rejects(
			runIntegrationTests(
				{ root: directory, directory, env: urls },
				async () => {
					invoked = true;
				},
			),
			/manifest/,
		);
		assert.equal(invoked, false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("stale reports are rejected before running the corresponding process", async () => {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-stale-"));
	let invoked = false;
	try {
		writeFileSync(
			join(directory, "results-0.json"),
			JSON.stringify(report(GROUPS[0])),
		);
		await assert.rejects(
			runIntegrationTests({ root, directory, env: urls }, async () => {
				invoked = true;
			}),
			/already exists/,
		);
		assert.equal(invoked, false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("CI requires the fixture runner and an unconditional fallback cleanup step", () => {
	const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
	const job = workflow
		.split("  postgres-integration:\n")[1]
		?.split("\n  secrets:")[0];
	assert(job);
	assert.match(job, /run: pnpm test:postgres-runner/);
	assert.match(job, /run: pnpm --filter @bitovp\/db build/);
	assert.match(
		job,
		/run: pnpm test:postgres --state-file "\$RUNNER_TEMP\/bitovp-postgres-state.json"/,
	);
	assert.match(
		job,
		/if: always\(\)\n\s+run: node scripts\/postgres-integration.mjs --cleanup --state-file "\$RUNNER_TEMP\/bitovp-postgres-state.json"/,
	);
	assert.equal((job.match(/\n\s+if:/g) ?? []).length, 1);
	const scripts = JSON.parse(readFileSync(join(root, "package.json"))).scripts;
	assert.equal(
		scripts["test:postgres"],
		"node scripts/postgres-integration.mjs",
	);
	assert(scripts.test.includes("pnpm test:postgres-runner"));
});

for (const cancellation of [false, true])
	test(`fixture ${cancellation ? "cancellation" : "failure"} cleans only its labeled container and private files`, async () => {
		const parent = mkdtempSync(join(tmpdir(), "bitovp-pg-fixture-test-"));
		const statePath = join(parent, "fixture.json");
		let state;
		let removed = false;
		let ran = false;
		let image;
		let probe;
		let credentialFile;
		const controller = new AbortController();
		const execute = async (command, args, options) => {
			assert.equal(options.env.DATABASE_URL, undefined);
			assert.equal(options.env.DOCKER_HOST, undefined);
			if (command === "docker") {
				assert.deepEqual(args.slice(0, 2), [
					"--host",
					"unix:///var/run/docker.sock",
				]);
				const dockerArgs = args.slice(2);
				if (dockerArgs[0] === "run") {
					image = dockerArgs.at(-1);
					state = JSON.parse(readFileSync(statePath, "utf8"));
					assert.equal(statSync(statePath).mode & 0o777, 0o600);
					assert.equal(statSync(state.directory).mode & 0o777, 0o700);
					assert.match(
						dockerArgs[dockerArgs.indexOf("--publish") + 1],
						/^127\.0\.0\.1::5432$/,
					);
					const config = readFileSync(
						dockerArgs[dockerArgs.indexOf("--env-file") + 1],
						"utf8",
					);
					assert.match(config, /POSTGRES_PASSWORD=[A-Za-z0-9_-]{40,}/);
					assert.equal(
						statSync(dockerArgs[dockerArgs.indexOf("--env-file") + 1]).mode &
							0o777,
						0o600,
					);
					ran = true;
					return "fixture-id";
				}
				if (dockerArgs[0] === "port") return "127.0.0.1:15432";
				if (dockerArgs[0] === "exec") {
					probe = dockerArgs;
					return "";
				}
				if (dockerArgs[0] === "inspect")
					return JSON.stringify({ "io.bitovp.postgres-test": state.id });
				if (dockerArgs[0] === "rm") {
					removed = true;
					return "";
				}
				if (dockerArgs[0] === "ps") return "";
			}
			assert.equal(options.env.TMPDIR, join(state.directory, "tmp"));
			assert(
				options.env.TMPDIR.length < 70,
				"Child IPC paths must fit Unix socket limits",
			);
			assert.equal(options.env.TMP, options.env.TMPDIR);
			assert.equal(options.env.TEMP, options.env.TMPDIR);
			if (cancellation) {
				const nested = mkdtempSync(join(options.env.TMPDIR, "bitovp-role-db-"));
				credentialFile = join(nested, ".env.migrate");
				writeFileSync(credentialFile, "DATABASE_URL=synthetic-fixture\n", {
					mode: 0o600,
				});
				assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
				controller.abort();
				return "";
			}
			throw new Error("Simulated setup failure containing a private URL");
		};
		try {
			await assert.rejects(
				runFixture(
					{
						root,
						statePath,
						signal: controller.signal,
						notify: () => {},
						env: { PATH: process.env.PATH, DATABASE_URL: "private" },
					},
					execute,
				),
				(error) => {
					// A foreign message can hold a private URL, so only its kind is shown.
					assert.deepEqual(failureReport(error), [
						"Step: preparing the runtime database role",
						cancellation
							? "Reason: PostgreSQL integration was cancelled"
							: "Reason: Error (message withheld)",
					]);
					return true;
				},
			);
			const expectedImage = readFileSync(
				join(root, "docker-compose.yml"),
				"utf8",
			).match(/image: (postgres:\S+)/)?.[1];
			assert.match(
				expectedImage,
				/^postgres:17\.11-alpine@sha256:[a-f0-9]{64}$/,
			);
			assert.equal(image, expectedImage);
			assert.equal(ran, true);
			assert.equal(removed, true);
			assert.deepEqual(probe, [
				"exec",
				`bitovp-postgres-${state.id}`,
				"pg_isready",
				"--host",
				"127.0.0.1",
				"--username",
				"bitovp_fixture_admin",
				"--dbname",
				`bitovp_integration_${state.id}`,
			]);
			if (cancellation) {
				assert(
					credentialFile,
					"Cancellation must occur after child credentials exist",
				);
				assert.throws(() => statSync(credentialFile));
			}
			assert.throws(() => readFileSync(join(state.directory, ".owner")));
			assert.throws(() => readFileSync(statePath));
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

test("CI cleanup command removes credential-bearing child temporary directories", () => {
	const parent = realpathSync(
		mkdtempSync(join(tmpdir(), "bitovp-pg-fallback-test-")),
	);
	const id = randomBytes(16).toString("hex");
	const directory = join(parent, "bitovp-postgres-owned");
	const statePath = join(parent, "state.json");
	const removed = join(parent, "removed");
	try {
		mkdirSync(directory, { mode: 0o700 });
		writeFileSync(join(directory, ".owner"), id, { mode: 0o600 });
		writeFileSync(statePath, JSON.stringify({ id, directory }), {
			mode: 0o600,
		});
		const childTemp = join(directory, "tmp", "bitovp-role-db-interrupted");
		mkdirSync(childTemp, { recursive: true, mode: 0o700 });
		const credentialFile = join(childTemp, ".env");
		writeFileSync(
			credentialFile,
			`DATABASE_URL=${randomBytes(24).toString("base64url")}\n`,
			{ mode: 0o600 },
		);
		assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
		const docker = join(parent, "docker");
		writeFileSync(
			docker,
			`#!/usr/bin/env node\nconst fs = require('node:fs');\nconst a = process.argv.slice(2);\nif (a[0] !== '--host' || a[1] !== 'unix:///var/run/docker.sock') process.exit(2);\nif (a[2] === 'inspect') console.log(JSON.stringify({'io.bitovp.postgres-test': ${JSON.stringify(id)}}));\nelse if (a[2] === 'rm') fs.writeFileSync(${JSON.stringify(removed)}, 'removed');\nelse if (a[2] !== 'ps') process.exit(2);\n`,
			{ mode: 0o700 },
		);
		const result = spawnSync(
			process.execPath,
			[
				join(root, "scripts/postgres-integration.mjs"),
				"--cleanup",
				"--state-file",
				statePath,
			],
			{
				env: {
					...childEnvironment(process.env),
					PATH: `${parent}:${process.env.PATH}`,
				},
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		assert.equal(result.status, 0);
		assert.equal(readFileSync(removed, "utf8"), "removed");
		assert.throws(() => statSync(credentialFile));
		assert.throws(() => statSync(directory));
		assert.throws(() => statSync(statePath));
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("a failed run prints its step and redacted child output, never its credentials", () => {
	const parent = realpathSync(
		mkdtempSync(join(tmpdir(), "bitovp-pg-report-test-")),
	);
	try {
		// The container cannot start, and the failing command leaks what a careless
		// child could: the credential file, a URL and forged CI commands.
		writeFileSync(
			join(parent, "docker"),
			`#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(4);
if (a[0] === 'run') {
	const credentials = fs.readFileSync(a[a.indexOf('--env-file') + 1], 'utf8');
	const password = /POSTGRES_PASSWORD=(.+)/.exec(credentials)[1];
	console.error('::error::forged annotation');
	console.error(credentials);
	console.error('psql: postgresql://bitovp_fixture_admin:' + password + '@127.0.0.1:15432/db refused');
	console.error('\\u001b[31mno response\\u001b[0m ##[error]forged');
	process.exit(125);
}
else if (a[0] === 'inspect') process.exit(1);
else if (a[0] !== 'ps') process.exit(2);
`,
			{ mode: 0o700 },
		);
		const result = spawnSync(
			process.execPath,
			[join(root, "scripts/postgres-integration.mjs")],
			{
				env: {
					...childEnvironment(process.env),
					PATH: `${parent}:${process.env.PATH}`,
					GITHUB_ACTIONS: "true",
				},
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		assert.equal(result.status, 1);
		const password = /^::add-mask::(.+)$/m.exec(result.stdout)?.[1];
		assert.match(password, /^[A-Za-z0-9_-]{40,}$/);
		assert(!result.stderr.includes(password));
		const lines = result.stderr.trimEnd().split("\n");
		assert.deepEqual(lines.slice(0, 4), [
			"PostgreSQL integration failed; required tests or fixture cleanup did not complete.",
			"Step: starting the PostgreSQL container",
			"Reason: PostgreSQL integration command failed",
			"Last 7 lines of the failed command:",
		]);
		assert.deepEqual(
			lines.slice(4).map((line) => line.replace(/_[a-f0-9]{32}$/, "_ID")),
			[
				"  | ::error::forged annotation",
				"  | POSTGRES_USER=bitovp_fixture_admin",
				"  | POSTGRES_PASSWORD=[private]",
				"  | POSTGRES_DB=bitovp_integration_ID",
				"  | POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
				"  | psql: postgresql://[private]@127.0.0.1:15432/db refused",
				"  | no response ## [error]forged",
			],
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("the runner started through a symlinked path still runs and reports its failure", () => {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-symlink-test-"));
	try {
		symlinkSync(join(root, "scripts"), join(directory, "linked"));
		const result = spawnSync(
			process.execPath,
			[join(directory, "linked", "postgres-integration.mjs"), "--unknown"],
			{
				env: childEnvironment(process.env),
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		assert.equal(result.status, 1);
		assert.deepEqual(result.stderr.trimEnd().split("\n"), [
			"PostgreSQL integration failed; required tests or fixture cleanup did not complete.",
			"Reason: Unknown PostgreSQL integration option",
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

for (const labels of [null, {}, { "io.bitovp.postgres-test": "another-owner" }])
	test(`cleanup refuses missing or different ownership labels: ${JSON.stringify(labels)}`, async () => {
		await assert.rejects(
			cleanupFixture(
				{ id: "0123456789abcdef0123456789abcdef", directory: "/unused" },
				async () => JSON.stringify(labels),
			),
			/ownership/,
		);
	});

test("a failed Vitest command is not accepted even when its report is complete and green", async () => {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-green-failure-"));
	try {
		await assert.rejects(
			runIntegrationTests(
				{ root, directory, env: urls, notify: () => {} },
				async (_command, args) => {
					writeFileSync(
						args
							.find((arg) => arg.startsWith("--outputFile="))
							.slice("--outputFile=".length),
						JSON.stringify(report(GROUPS[0])),
					);
					throw new GateFailure("PostgreSQL integration command failed", {
						diagnostics: "Unhandled rejection after the last test\n",
					});
				},
			),
			(error) => {
				assert.deepEqual(failureReport(error), [
					"Step: running @bitovp/db PostgreSQL tests",
					"Reason: PostgreSQL integration command failed",
					"Last 1 lines of the failed command:",
					"  | Unhandled rejection after the last test",
				]);
				return true;
			},
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

// A whole fixture run against fakes: the container starts and the runtime role
// is prepared; `vitest` and `inspect` decide how the tests and the cleanup end.
const runtimePassword = "runtime/pass+word@0123456789";
const fakeFixture = ({
	vitest,
	inspect,
	remove = () => "",
	password = runtimePassword,
}) => {
	const seen = {};
	return async (command, args) => {
		if (command === "docker") {
			const dockerArgs = args.slice(2);
			if (dockerArgs[0] === "port") return "127.0.0.1:15432";
			if (dockerArgs[0] === "inspect") return inspect(dockerArgs.at(-1));
			if (dockerArgs[0] === "rm") return remove();
			return "";
		}
		if (args.includes("db:runtime:prepare")) {
			seen.adminUrl = /^DATABASE_URL=(.+)$/m.exec(
				readFileSync(args[args.indexOf("--admin-env") + 1], "utf8"),
			)[1];
			const app = new URL(seen.adminUrl);
			app.username = "bitovp_runtime";
			app.password = password;
			seen.appUrl = app.toString();
			writeFileSync(
				args[args.indexOf("--app-env") + 1],
				`DATABASE_URL=${seen.appUrl}\n`,
				{ mode: 0o600 },
			);
			return "";
		}
		if (args.includes("db:migrate:deploy")) return "";
		return vitest(args, seen);
	};
};
const ownLabel = (name) =>
	JSON.stringify({
		"io.bitovp.postgres-test": name.slice("bitovp-postgres-".length),
	});

test("the runtime role's URL and password are redacted from a failed test run", async () => {
	const parent = mkdtempSync(join(tmpdir(), "bitovp-pg-runtime-secret-"));
	try {
		await assert.rejects(
			runFixture(
				{
					root,
					statePath: join(parent, "fixture.json"),
					notify: () => {},
					env: { PATH: process.env.PATH },
				},
				fakeFixture({
					inspect: ownLabel,
					vitest: (_args, { adminUrl, appUrl }) => {
						throw new GateFailure("PostgreSQL integration command failed", {
							diagnostics: [
								`admin ${adminUrl}`,
								`runtime ${appUrl}`,
								`ALTER ROLE bitovp_runtime PASSWORD '${runtimePassword}'`,
								`encoded ${new URL(appUrl).password}`,
								"",
							].join("\n"),
						});
					},
				}),
			),
			(error) => {
				assert.deepEqual(failureReport(error), [
					"Step: running @bitovp/db PostgreSQL tests",
					"Reason: PostgreSQL integration command failed",
					"Last 4 lines of the failed command:",
					"  | admin [private]",
					"  | runtime [private]",
					"  | ALTER ROLE bitovp_runtime PASSWORD '[private]'",
					"  | encoded [private]",
				]);
				return true;
			},
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("a fixture whose tests all pass still fails when its cleanup does not complete", async () => {
	const parent = mkdtempSync(join(tmpdir(), "bitovp-pg-cleanup-failure-"));
	const statePath = join(parent, "fixture.json");
	const notes = [];
	try {
		await assert.rejects(
			runFixture(
				{
					root,
					statePath,
					notify: (note) => notes.push(note),
					env: { PATH: process.env.PATH },
				},
				fakeFixture({
					inspect: () =>
						JSON.stringify({ "io.bitovp.postgres-test": "another-owner" }),
					vitest: (args) => {
						writeFileSync(
							args
								.find((arg) => arg.startsWith("--outputFile="))
								.slice("--outputFile=".length),
							JSON.stringify(
								report(GROUPS.find((group) => group.workspace === args[1])),
							),
						);
						return "";
					},
				}),
			),
			(error) => {
				assert.deepEqual(failureReport(error).slice(0, 2), [
					"Step: removing the PostgreSQL fixture and private files",
					"Reason: PostgreSQL fixture ownership label does not match",
				]);
				return true;
			},
		);
		// Every group ran and passed before the cleanup failed.
		assert.equal(
			notes.filter((note) => note.endsWith("0 skipped")).length,
			GROUPS.length,
		);
	} finally {
		// A failed cleanup leaves the private directory for the fallback step.
		try {
			rmSync(JSON.parse(readFileSync(statePath, "utf8")).directory, {
				recursive: true,
				force: true,
			});
		} catch {}
		rmSync(parent, { recursive: true, force: true });
	}
});

test("another gate's tests run against the prepared database, and the fixture is removed after them", async () => {
	const parent = mkdtempSync(join(tmpdir(), "bitovp-pg-other-gate-"));
	const notes = [];
	const execute = fakeFixture({
		inspect: ownLabel,
		vitest: () => {
			throw new Error("The PostgreSQL tests must not run here");
		},
	});
	const fixture = (run) =>
		runFixture(
			{
				root,
				statePath: join(parent, "fixture.json"),
				notify: (note) => notes.push(note),
				env: { PATH: process.env.PATH, GITHUB_TOKEN: "not for a child" },
				run,
			},
			execute,
		);
	try {
		const seen = {};
		await fixture(async (context, run) => {
			seen.context = context;
			seen.mode = statSync(context.directory).mode & 0o777;
			// The same command runner, so a cancelled run stops here too.
			seen.listed = await run("docker", ["--host", "x", "port"], {});
			context.notify("the other gate's tests passed");
		});
		assert.deepEqual(Object.keys(seen.context).sort(), [
			"directory",
			"env",
			"notify",
			"root",
		]);
		assert.equal(seen.context.root, root);
		assert.equal(seen.mode, 0o700);
		assert.equal(seen.listed, "127.0.0.1:15432");
		// The private child environment and both URLs; nothing else of the caller's.
		const {
			BITOVP_TENANT_TEST_ADMIN_URL: admin,
			BITOVP_TENANT_TEST_APP_URL: app,
			...child
		} = seen.context.env;
		const temporary = join(seen.context.directory, "tmp");
		assert.deepEqual(child, {
			PATH: process.env.PATH,
			TMPDIR: temporary,
			TMP: temporary,
			TEMP: temporary,
			CI: "1",
			TURBO_TELEMETRY_DISABLED: "1",
			NEXT_TELEMETRY_DISABLED: "1",
		});
		assert.match(
			admin,
			/^postgresql:\/\/bitovp_fixture_admin:[\w-]{43}@127\.0\.0\.1:15432\/bitovp_integration_[a-f0-9]{32}\?schema=public$/,
		);
		assert.equal(new URL(app).username, "bitovp_runtime");
		// They are the URLs that the required tests would get.
		assert.equal(
			testEnvironment(seen.context.env).BITOVP_TENANT_TEST_APP_URL,
			app,
		);
		assert.equal(existsSync(seen.context.directory), false);
		assert.equal(existsSync(join(parent, "fixture.json")), false);
		assert.deepEqual(notes, [
			"Preparing dedicated PostgreSQL runtime role and migrations",
			"the other gate's tests passed",
			"Dedicated PostgreSQL fixture and private files removed",
		]);

		// Their failure keeps its own step and is reported after the cleanup.
		let directory;
		await assert.rejects(
			fixture(async (context) => {
				directory = context.directory;
				throw atStep(
					new GateFailure("Redis tests must all run and pass", {
						diagnostics: `connect ${context.env.BITOVP_TENANT_TEST_ADMIN_URL}\n`,
					}),
					"running the queue tests that need Redis",
				);
			}),
			(error) => {
				assert.deepEqual(failureReport(error), [
					"Step: running the queue tests that need Redis",
					"Reason: Redis tests must all run and pass",
					"Last 1 lines of the failed command:",
					"  | connect [private]",
				]);
				return true;
			},
		);
		assert.equal(existsSync(directory), false);
		assert.equal(
			notes.at(-1),
			"Dedicated PostgreSQL fixture and private files removed",
		);
		// Without a step of its own, the failure is the fixture's last step.
		await assert.rejects(
			fixture(async () => {
				throw undefined;
			}),
			(error) => {
				assert.deepEqual(failureReport(error), [
					"Step: reading the runtime role credentials",
					"Reason: A step failed without an error",
				]);
				return true;
			},
		);
		// A run cancelled during their step stops at the step's next command,
		// and the fixture is removed all the same.
		const controller = new AbortController();
		const reached = [];
		await assert.rejects(
			runFixture(
				{
					root,
					statePath: join(parent, "fixture.json"),
					signal: controller.signal,
					notify: (note) => notes.push(note),
					env: { PATH: process.env.PATH },
					run: async (context, run) => {
						directory = context.directory;
						controller.abort();
						reached.push("before the command");
						await run("docker", ["--host", "x", "port"], {});
						reached.push("after the command");
					},
				},
				execute,
			),
			(error) => {
				assert.deepEqual(failureReport(error), [
					"Step: reading the runtime role credentials",
					"Reason: PostgreSQL integration was cancelled",
				]);
				return true;
			},
		);
		assert.deepEqual(reached, ["before the command"]);
		assert.equal(existsSync(directory), false);
		assert.equal(existsSync(join(parent, "fixture.json")), false);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("child output reaches the log only through the failure report", () => {
	const parent = realpathSync(
		mkdtempSync(join(tmpdir(), "bitovp-pg-forward-test-")),
	);
	try {
		writeFileSync(
			join(parent, "docker"),
			`#!/usr/bin/env node
const a = process.argv.slice(4);
if (a[0] === 'run') {
	console.log('::error::forged on stdout');
	console.error('::error::forged on stderr');
	process.exit(125);
}
else if (a[0] === 'inspect') process.exit(1);
else if (a[0] !== 'ps') process.exit(2);
`,
			{ mode: 0o700 },
		);
		const result = spawnSync(
			process.execPath,
			[join(root, "scripts/postgres-integration.mjs")],
			{
				env: {
					...childEnvironment(process.env),
					PATH: `${parent}:${process.env.PATH}`,
				},
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		assert.equal(result.status, 1);
		assert.deepEqual(result.stdout.trimEnd().split("\n"), [
			"Dedicated PostgreSQL fixture and private files removed",
		]);
		assert.deepEqual(result.stderr.trimEnd().split("\n"), [
			"PostgreSQL integration failed; required tests or fixture cleanup did not complete.",
			"Step: starting the PostgreSQL container",
			"Reason: PostgreSQL integration command failed",
			"Last 1 lines of the failed command:",
			"  | ::error::forged on stderr",
		]);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

for (const [name, mutate] of [
	[
		"unfinished suite",
		(r) => {
			r.numPendingTestSuites = 1;
		},
	],
	[
		"failed total",
		(r) => {
			r.numFailedTests = 1;
		},
	],
	[
		"passed total",
		(r) => {
			r.numPassedTests -= 1;
		},
	],
	[
		"failed file status",
		(r) => {
			r.testResults[0].status = "failed";
		},
	],
	[
		"extra file",
		(r) => {
			r.testResults.push({
				...r.testResults[0],
				name: `${r.testResults[0].name}.other`,
			});
		},
	],
])
	test(`rejects a green-looking report with ${name}`, () => {
		const value = report(GROUPS[0]);
		mutate(value);
		assert.throws(() => validateReport(value, GROUPS[0], root));
	});

for (const value of [undefined, null, 0, "", false, "a thrown string"])
	test(`a command that rejects with ${JSON.stringify(value) ?? "nothing"} fails the run, with or without a complete report`, async () => {
		for (const wroteReport of [true, false]) {
			const directory = mkdtempSync(join(tmpdir(), "bitovp-pg-rejection-"));
			try {
				await assert.rejects(
					runIntegrationTests(
						{ root, directory, env: urls, notify: () => {} },
						async (_command, args) => {
							if (wroteReport)
								writeFileSync(
									args
										.find((arg) => arg.startsWith("--outputFile="))
										.slice("--outputFile=".length),
									JSON.stringify(report(GROUPS[0])),
								);
							throw value;
						},
					),
					(error) => {
						assert.deepEqual(failureReport(error), [
							"Step: running @bitovp/db PostgreSQL tests",
							"Reason: A step failed without an error",
						]);
						return true;
					},
				);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	});

test("a report that lists no test files is rejected, and a failed run adds the end of its output", () => {
	const value = report(GROUPS[0]);
	delete value.testResults;
	assert.throws(
		() => validateReport(value, GROUPS[0], root, "the end of the output\n"),
		(error) => {
			assert.deepEqual(failureReport(error), [
				"Reason: PostgreSQL tests must have no failures, skips or unfinished cases",
				"  - the report lists no test files",
				...Object.keys(GROUPS[0].files).map((name) => `  - ${name}: not run`),
				"Last 1 lines of the failed command:",
				"  | the end of the output",
			]);
			return true;
		},
	);
});

test("a failed run whose cleanup also fails reports the run first and the cleanup after it", async () => {
	for (const [cleanup, reason] of [
		[
			{
				inspect: () =>
					JSON.stringify({ "io.bitovp.postgres-test": "another-owner" }),
			},
			"PostgreSQL fixture ownership label does not match",
		],
		// A cleanup can reject with anything; the report still names it.
		[
			{ inspect: ownLabel, remove: () => Promise.reject() },
			"A step failed without an error",
		],
	]) {
		const parent = mkdtempSync(join(tmpdir(), "bitovp-pg-both-failed-"));
		const statePath = join(parent, "fixture.json");
		try {
			await assert.rejects(
				runFixture(
					{
						root,
						statePath,
						notify: () => {},
						env: { PATH: process.env.PATH },
					},
					fakeFixture({
						...cleanup,
						vitest: () => {
							throw new GateFailure("PostgreSQL integration command failed", {
								diagnostics: "the tests could not connect\n",
							});
						},
					}),
				),
				(error) => {
					assert.deepEqual(failureReport(error), [
						"Step: running @bitovp/db PostgreSQL tests",
						"Reason: PostgreSQL integration command failed",
						"Last 1 lines of the failed command:",
						"  | the tests could not connect",
						"A later step also failed:",
						"Step: removing the PostgreSQL fixture and private files",
						`Reason: ${reason}`,
					]);
					return true;
				},
			);
		} finally {
			// A failed cleanup leaves the private directory for the fallback step.
			try {
				rmSync(JSON.parse(readFileSync(statePath, "utf8")).directory, {
					recursive: true,
					force: true,
				});
			} catch {}
			rmSync(parent, { recursive: true, force: true });
		}
	}
});

test("a runtime credential that holds a line break is refused before it is masked", async (t) => {
	const printed = t.mock.method(console, "log", () => {});
	const parent = mkdtempSync(join(tmpdir(), "bitovp-pg-mask-break-"));
	try {
		await assert.rejects(
			runFixture(
				{
					root,
					statePath: join(parent, "fixture.json"),
					notify: () => {},
					env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true" },
				},
				fakeFixture({
					inspect: ownLabel,
					// The URL holds it as %0A; decoding would end the mask command early.
					password: "first-half\n::warning::second-half",
					vitest: () => assert.fail("the tests must not start"),
				}),
			),
			(error) => {
				assert.deepEqual(failureReport(error), [
					"Step: reading the runtime role credentials",
					"Reason: Fixture credentials must not contain control characters",
				]);
				return true;
			},
		);
		const lines = printed.mock.calls.map((call) => String(call.arguments[0]));
		// Only the fixture administrator's password and URL were masked.
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.match(line, /^::add-mask::[^\r\n]+$/);
			assert(!line.includes("half"), "The refused credential was printed");
		}
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("a command stopped at its limit fails even when the child then exits 0, and a missing binary or a silent failure is explained", {
	timeout: 10_000,
}, async () => {
	await assert.rejects(
		command(
			process.execPath,
			[
				"-e",
				"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
			],
			{ env: {}, timeout: 500 },
		),
		(error) => {
			assert.equal(error.message, "PostgreSQL integration command failed");
			assert.deepEqual(error.details, [
				"The command was stopped at its 0.5 second limit",
			]);
			return true;
		},
	);
	await assert.rejects(
		command(join(tmpdir(), "bitovp-no-such-binary"), [], { env: {} }),
		/PostgreSQL integration command could not start/,
	);
	// A command that wrote no diagnostics is explained by the end of its output.
	await assert.rejects(
		command(
			process.execPath,
			["-e", "console.log('only on stdout');process.exit(3)"],
			{ env: {} },
		),
		(error) => {
			assert.equal(error.diagnostics, "only on stdout\n");
			return true;
		},
	);
	await assert.rejects(
		command(
			process.execPath,
			[
				"-e",
				"console.log('on stdout');console.error('on stderr');process.exit(3)",
			],
			{ env: {} },
		),
		(error) => {
			assert.equal(error.diagnostics, "on stderr\n");
			return true;
		},
	);
});

test("a fixture step that rejects without an error still fails the run", async () => {
	const parent = mkdtempSync(join(tmpdir(), "bitovp-pg-bare-rejection-"));
	try {
		const fake = fakeFixture({
			inspect: ownLabel,
			vitest: () => assert.fail("the tests must not start"),
		});
		await assert.rejects(
			runFixture(
				{
					root,
					statePath: join(parent, "fixture.json"),
					notify: () => {},
					env: { PATH: process.env.PATH },
				},
				(command, args) =>
					args.includes("db:migrate:deploy")
						? Promise.reject()
						: fake(command, args),
			),
			(error) => {
				assert.deepEqual(failureReport(error), [
					"Step: applying database migrations",
					"Reason: A step failed without an error",
				]);
				return true;
			},
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
