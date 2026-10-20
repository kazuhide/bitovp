import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	childEnvironment,
	cleanupFixture,
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
	assert.equal(GROUPS.flatMap((group) => Object.keys(group.files)).length, 12);
	assert.equal(
		GROUPS.flatMap((group) => Object.values(group.files)).reduce(
			(a, b) => a + b,
			0,
		),
		64,
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
			);
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
