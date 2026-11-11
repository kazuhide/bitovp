import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseEnv } from "node:util";
import {
	asFailure,
	atStep,
	failureLines,
	GateFailure,
	isEntryPoint,
	outputTail,
	withLaterFailure,
} from "./gate-report.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SOCKET = "unix:///var/run/docker.sock";
const LABEL = "io.bitovp.postgres-test";
export const GROUPS = [
	{
		workspace: "@bitovp/db",
		directory: "packages/db",
		files: {
			"src/runtime-role.integration.test.ts": 1,
			"src/tenant-db.integration.test.ts": 6,
			"src/tenant-legacy-migration.integration.test.ts": 1,
			"src/create-request.integration.test.ts": 7,
			"src/transaction-options.integration.test.ts": 6,
			"src/live-run-step-log.integration.test.ts": 4,
			"src/library-editing-db.integration.test.ts": 12,
			"src/library-production.integration.test.ts": 19,
			"src/library-flow-evidence-pins.integration.test.ts": 12,
			"src/library-story-choice.integration.test.ts": 2,
		},
	},
	{
		workspace: "@bitovp/web",
		directory: "apps/web",
		files: {
			"src/lib/server/create-request.integration.test.ts": 3,
			"src/lib/server/reset-live-probe.integration.test.ts": 3,
			"src/lib/server/reset-live-transition-locking.integration.test.ts": 3,
			"src/lib/server/library-catalog.integration.test.ts": 17,
			"src/lib/server/library-editing.integration.test.ts": 27,
			"src/lib/server/library-editing-presentation.integration.test.ts": 2,
			"src/lib/server/library-media-tasks.integration.test.ts": 5,
			"src/lib/server/library-media-tasks-generation.integration.test.ts": 2,
			"src/lib/server/job-evidence-retention.integration.test.ts": 7,
			"src/lib/server/selected-reset-editing.integration.test.ts": 3,
		},
	},
	{
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/alerts/engine-locking.integration.test.ts": 3,
			"src/live/poll-transition-locking.integration.test.ts": 4,
			"src/live/owned-transition-locking.integration.test.ts": 10,
			"src/watch/sweep.capacity.integration.test.ts": 12,
			"src/library-editing/derivatives.integration.test.ts": 8,
			"src/library-editing/media-task-sweep.integration.test.ts": 4,
			"src/library-editing/generation.integration.test.ts": 9,
			"src/library-editing/generation-speech.integration.test.ts": 2,
			"src/library-editing/generation-duration-review.integration.test.ts": 2,
			"src/library-editing/dialogue-source.integration.test.ts": 2,
		},
	},
];

export function childEnvironment(env) {
	const clean = {};
	for (const key of [
		"PATH",
		"TMPDIR",
		"TMP",
		"TEMP",
		"LANG",
		"LC_ALL",
		"COREPACK_HOME",
		"PNPM_HOME",
	])
		if (env[key]) clean[key] = env[key];
	return {
		...clean,
		CI: "1",
		TURBO_TELEMETRY_DISABLED: "1",
		NEXT_TELEMETRY_DISABLED: "1",
	};
}

function privateChildEnvironment(env, directory) {
	const temporary = join(realpathSync(directory), "tmp");
	mkdirSync(temporary, { mode: 0o700, recursive: true });
	assert(
		lstatSync(temporary).isDirectory() && !(lstatSync(temporary).mode & 0o077),
		"Child temporary directory must be private and owned by the fixture",
	);
	return {
		...childEnvironment(env),
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
	};
}

export function testEnvironment(env) {
	assert(
		env.BITOVP_TENANT_TEST_ADMIN_URL && env.BITOVP_TENANT_TEST_APP_URL,
		"Required PostgreSQL test URLs are missing",
	);
	let admin;
	let app;
	try {
		admin = new URL(env.BITOVP_TENANT_TEST_ADMIN_URL);
		app = new URL(env.BITOVP_TENANT_TEST_APP_URL);
	} catch {
		throw new GateFailure("Required PostgreSQL test URLs are invalid");
	}
	for (const url of [admin, app]) {
		assert(
			["postgres:", "postgresql:"].includes(url.protocol),
			"Invalid test database protocol",
		);
		assert.equal(
			url.hostname,
			"127.0.0.1",
			"Test database must use dedicated IPv4 loopback",
		);
		assert(
			url.port && Number(url.port) > 0,
			"A dedicated test port is required",
		);
		assert(
			/^\/bitovp_integration_[a-f0-9]{32}$/.test(url.pathname),
			"A dedicated integration database is required",
		);
		assert(
			url.username && url.password,
			"Test database authentication is required",
		);
		assert(
			[...url.searchParams].every(
				([key, value]) => key === "schema" && value === "public",
			),
			"Unexpected test database URL option",
		);
	}
	assert(
		admin.host === app.host && admin.pathname === app.pathname,
		"Test databases must match",
	);
	assert.notEqual(
		admin.username,
		app.username,
		"Runtime test role must differ from administrator",
	);
	return {
		...childEnvironment(env),
		BITOVP_TENANT_TEST_ADMIN_URL: admin.toString(),
		BITOVP_TENANT_TEST_APP_URL: app.toString(),
		BITOVP_MONITORING_TEST_ADMIN_URL: admin.toString(),
		BITOVP_MONITORING_TEST_DATABASE_URL: app.toString(),
	};
}

// The start of a failure message states the assertion. Frames inside
// dependencies only show that the test runner called the test.
const excerpt = (text) =>
	String(text ?? "")
		.split("\n")
		.filter(
			(line) =>
				line.trim() !== "" &&
				!/^\s+at .*(?:node_modules|<anonymous>)/.test(line),
		)
		.slice(0, 8)
		.join("\n");

/** Why a Vitest report is not the complete, fully passed required run. */
export function reportProblems(report, group, root) {
	const problems = [];
	const total = Object.values(group.files).reduce(
		(sum, count) => sum + count,
		0,
	);
	if (report?.success !== true) problems.push("Vitest reported a failed run");
	for (const [key, label] of [
		["numFailedTests", "failed tests"],
		["numPendingTests", "skipped tests"],
		["numTodoTests", "todo tests"],
		["numFailedTestSuites", "failed suites"],
		["numPendingTestSuites", "unfinished suites"],
	])
		if (report?.[key] !== 0)
			problems.push(`${label}: ${JSON.stringify(report?.[key])}, required 0`);
	for (const [key, label] of [
		["numTotalTests", "tests discovered"],
		["numPassedTests", "tests passed"],
	])
		if (report?.[key] !== total)
			problems.push(
				`${label}: ${JSON.stringify(report?.[key])}, required ${total}`,
			);
	if (!Array.isArray(report?.testResults))
		problems.push("the report lists no test files");
	const seen = new Set();
	for (const result of Array.isArray(report?.testResults)
		? report.testResults
		: []) {
		const name = relative(resolve(root, group.directory), String(result?.name));
		if (!Object.hasOwn(group.files, name)) {
			problems.push(`${name}: not a required PostgreSQL test file`);
			continue;
		}
		if (seen.has(name)) {
			problems.push(`${name}: reported more than once`);
			continue;
		}
		seen.add(name);
		const tests = Array.isArray(result.assertionResults)
			? result.assertionResults
			: [];
		const passed = tests.filter((test) => test?.status === "passed").length;
		if (
			result.status === "passed" &&
			tests.length === group.files[name] &&
			passed === tests.length
		)
			continue;
		problems.push(
			`${name}: ${passed} of ${tests.length} tests passed, ${group.files[name]} required${result.status === "passed" ? "" : `; file status ${JSON.stringify(result.status)}`}`,
		);
		if (typeof result.message === "string" && result.message.trim() !== "")
			problems.push(`${name} did not load:\n${excerpt(result.message)}`);
		for (const test of tests)
			if (test?.status !== "passed")
				problems.push(
					[
						`${JSON.stringify(test?.status)}: ${test?.fullName ?? test?.title ?? "unnamed test"}`,
						excerpt(
							(Array.isArray(test?.failureMessages)
								? test.failureMessages
								: []
							).join("\n"),
						),
					]
						.filter(Boolean)
						.join("\n"),
				);
	}
	for (const name of Object.keys(group.files))
		if (!seen.has(name)) problems.push(`${name}: not run`);
	return problems;
}

export function validateReport(report, group, root, diagnostics = "") {
	const problems = reportProblems(report, group, root);
	if (problems.length)
		throw new GateFailure(
			"PostgreSQL tests must have no failures, skips or unfinished cases",
			{ details: problems, diagnostics },
		);
}

const children = new Map();
const terminate = (child) => {
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
};
export async function command(executable, args, options) {
	return new Promise((accept, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const errors = outputTail();
		const decoder = new StringDecoder("utf8");
		let expired = "";
		let killTimer;
		const stop = (reason) => {
			expired ||= reason;
			terminate(child);
			killTimer ??= setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 5_000);
		};
		const limit = options.timeout ?? 180_000;
		const timer = setTimeout(
			() => stop(`was stopped at its ${limit / 1000} second limit`),
			limit,
		);
		children.set(child, () => stop("was cancelled"));
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
			if (output.length > 8_000_000) stop("exceeded its output limit");
		});
		// Raw child diagnostics can contain connection URLs. Never forward them
		// as they arrive: only their end is kept, for a redacted failure report.
		child.stderr.on("data", (chunk) => errors.add(decoder.write(chunk)));
		child.on("error", () => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			children.delete(child);
			reject(new GateFailure("PostgreSQL integration command could not start"));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			children.delete(child);
			if (code === 0 && !expired) return accept(output.trim());
			// A command that wrote no diagnostics is explained by the end of its output.
			const printed = outputTail(16 * 1024);
			printed.add(output);
			reject(
				new GateFailure("PostgreSQL integration command failed", {
					details: expired ? [`The command ${expired}`] : [],
					diagnostics:
						errors.text().trim() === "" ? printed.text() : errors.text(),
				}),
			);
		});
	});
}

export async function runIntegrationTests(
	{ root, directory, env, notify = console.log },
	execute = command,
) {
	const validated = testEnvironment(env);
	const clean = {
		...validated,
		...privateChildEnvironment(validated, directory),
	};
	// Names the part that failed in the final report.
	let step = "checking the required PostgreSQL test files";
	try {
		for (const group of GROUPS)
			for (const file of Object.keys(group.files))
				assert(
					existsSync(resolve(root, group.directory, file)),
					"Required PostgreSQL integration source is missing",
				);
		const discovered = [];
		const visit = (directory) => {
			if (!existsSync(directory)) return;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) visit(path);
				else if (
					entry.name.endsWith(".integration.test.ts") &&
					/BITOVP_(?:TENANT|MONITORING)_TEST_(?:ADMIN|APP|DATABASE)_URL/.test(
						readFileSync(path, "utf8"),
					)
				)
					discovered.push(path);
			}
		};
		for (const source of ["packages/db/src", "apps/web/src", "apps/worker/src"])
			visit(resolve(root, source));
		const required = GROUPS.flatMap((group) =>
			Object.keys(group.files).map((file) =>
				resolve(root, group.directory, file),
			),
		);
		assert.deepEqual(
			discovered.sort(),
			required.sort(),
			"PostgreSQL integration source discovery differs from the required manifest",
		);
		for (const [index, group] of GROUPS.entries()) {
			step = `running ${group.workspace} PostgreSQL tests`;
			const output = join(directory, `results-${index}.json`);
			assert(!existsSync(output), "PostgreSQL report already exists");
			// A rejection without an error is still a failure.
			let failure;
			try {
				await execute(
					"pnpm",
					[
						"--filter",
						group.workspace,
						"exec",
						"vitest",
						"run",
						...Object.keys(group.files),
						"--maxWorkers=2",
						"--reporter=json",
						`--outputFile=${output}`,
					],
					{ cwd: root, env: clean },
				);
			} catch (error) {
				failure = asFailure(error);
			}
			// Vitest writes its report for a failed run too; it names what failed.
			let report;
			try {
				report = JSON.parse(readFileSync(output, "utf8"));
			} catch {
				throw (
					failure ??
					new GateFailure("Vitest did not write a readable PostgreSQL report")
				);
			}
			validateReport(
				report,
				group,
				root,
				failure instanceof GateFailure ? failure.diagnostics : "",
			);
			// A complete report does not excuse a command that failed.
			if (failure) throw failure;
			notify(
				`${group.workspace}: ${Object.keys(group.files).length} PostgreSQL files, ${Object.values(group.files).reduce((sum, count) => sum + count, 0)} passed, 0 skipped`,
			);
		}
	} catch (error) {
		throw atStep(error, step);
	}
}

const name = (id) => `bitovp-postgres-${id}`;
const docker = (args, env, execute) =>
	execute("docker", ["--host", SOCKET, ...args], {
		env: childEnvironment(env),
		timeout: 60_000,
	});
const absent = async (id, env, execute) =>
	(await docker(
		[
			"ps",
			"--all",
			"--filter",
			`name=^/${name(id)}$`,
			"--format",
			"{{.Names}}",
		],
		env,
		execute,
	)) === "";

export async function cleanupFixture(
	state,
	execute = command,
	env = process.env,
) {
	assert(
		/^[a-f0-9]{32}$/.test(state.id),
		"Invalid PostgreSQL fixture ownership identity",
	);
	let labels;
	let found = false;
	try {
		labels = JSON.parse(
			await docker(
				["inspect", "--format", "{{json .Config.Labels}}", name(state.id)],
				env,
				execute,
			),
		);
		found = true;
	} catch {
		assert(
			await absent(state.id, env, execute),
			"Unable to establish PostgreSQL fixture ownership",
		);
	}
	if (found) {
		assert.equal(
			labels?.[LABEL],
			state.id,
			"PostgreSQL fixture ownership label does not match",
		);
		await docker(["rm", "--force", "--volumes", name(state.id)], env, execute);
		assert(
			await absent(state.id, env, execute),
			"PostgreSQL fixture cleanup did not complete",
		);
	}
	if (existsSync(state.directory)) {
		assert(
			basename(state.directory).startsWith("bitovp-postgres-"),
			"Invalid PostgreSQL fixture directory",
		);
		assert(
			lstatSync(state.directory).isDirectory() &&
				realpathSync(state.directory) === resolve(state.directory) &&
				!(lstatSync(state.directory).mode & 0o077),
			"Invalid PostgreSQL fixture directory ownership",
		);
		assert.equal(
			readFileSync(join(state.directory, ".owner"), "utf8"),
			state.id,
			"PostgreSQL fixture directory ownership does not match",
		);
		rmSync(state.directory, { recursive: true });
	}
}

const inside = (root, path) => {
	const child = relative(root, path);
	return (
		child === "" ||
		(!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
	);
};
// Fixture credentials: CI masks them in its log and failure reports redact them.
const secrets = new Set();
const mask = (env, values) => {
	const fresh = [...new Set(values)];
	for (const value of fresh) secrets.add(value);
	// A line break inside a value would end the mask command early and let the
	// rest of the value start a line of its own.
	assert(
		fresh.every((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value)),
		"Fixture credentials must not contain control characters",
	);
	if (env.GITHUB_ACTIONS === "true")
		for (const value of fresh) console.log(`::add-mask::${value}`);
};

/** The public explanation of a failed run. */
export const failureReport = (error) =>
	failureLines(error, { secrets: [...secrets] });

export async function runFixture(
	{
		root = ROOT,
		statePath,
		env = process.env,
		signal,
		notify = console.log,
	} = {},
	execute = command,
) {
	const cleanupExecute = execute;
	execute = async (...args) => {
		assert(!signal?.aborted, "PostgreSQL integration was cancelled");
		const result = await cleanupExecute(...args);
		assert(!signal?.aborted, "PostgreSQL integration was cancelled");
		return result;
	};
	if (statePath) {
		assert(
			isAbsolute(statePath) && !inside(root, statePath),
			"Fixture state must be outside the source checkout",
		);
		assert(!existsSync(statePath), "Fixture state already exists");
	}
	// Child tooling uses Unix sockets; keep their paths short even for deep state paths.
	const parent = realpathSync("/tmp");
	assert(
		!inside(realpathSync(root), parent),
		"Private fixture files must be outside the source checkout",
	);
	const id = randomBytes(16).toString("hex");
	const directory = realpathSync(mkdtempSync(join(parent, "bitovp-postgres-")));
	const state = { id, directory };
	const stateFile = statePath ?? join(directory, "state.json");
	let stateWritten = false;
	// Names the part that failed in the final report.
	let step = "creating private fixture files";
	let failure;
	writeFileSync(join(directory, ".owner"), id, { mode: 0o600, flag: "wx" });
	try {
		writeFileSync(stateFile, JSON.stringify(state), {
			mode: 0o600,
			flag: "wx",
		});
		stateWritten = true;
		const password = randomBytes(32).toString("base64url");
		mask(env, [password]);
		const postgresEnv = join(directory, "postgres.env");
		writeFileSync(
			postgresEnv,
			`POSTGRES_USER=bitovp_fixture_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=bitovp_integration_${id}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n`,
			{ mode: 0o600, flag: "wx" },
		);
		step = "starting the PostgreSQL container";
		await docker(
			[
				"run",
				"--detach",
				"--name",
				name(id),
				"--label",
				`${LABEL}=${id}`,
				"--tmpfs",
				"/var/lib/postgresql/data:rw",
				"--publish",
				"127.0.0.1::5432",
				"--env-file",
				postgresEnv,
				"postgres:17.11-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b",
			],
			env,
			execute,
		);
		const binding = await docker(["port", name(id), "5432/tcp"], env, execute);
		assert(
			/^127\.0\.0\.1:\d+$/.test(binding),
			"PostgreSQL fixture must expose only a random loopback port",
		);
		step = "waiting for PostgreSQL to accept connections";
		let ready = false;
		let refusal;
		for (let attempt = 0; attempt < 60; attempt++) {
			try {
				await docker(
					[
						"exec",
						name(id),
						"pg_isready",
						"--host",
						"127.0.0.1",
						"--username",
						"bitovp_fixture_admin",
						"--dbname",
						`bitovp_integration_${id}`,
					],
					env,
					execute,
				);
				ready = true;
				break;
			} catch (error) {
				assert(!signal?.aborted, "PostgreSQL integration was cancelled");
				refusal = error;
				await new Promise((accept) => setTimeout(accept, 250));
			}
		}
		if (!ready)
			throw new GateFailure("PostgreSQL fixture did not become ready", {
				diagnostics: refusal instanceof GateFailure ? refusal.diagnostics : "",
			});
		const adminUrl = `postgresql://bitovp_fixture_admin:${password}@${binding}/bitovp_integration_${id}?schema=public`;
		mask(env, [adminUrl]);
		const adminFile = join(directory, ".env.migrate");
		const appFile = join(directory, ".env");
		writeFileSync(adminFile, `DATABASE_URL=${adminUrl}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		const options = { cwd: root, env: privateChildEnvironment(env, directory) };
		notify("Preparing dedicated PostgreSQL runtime role and migrations");
		step = "preparing the runtime database role";
		await execute(
			"pnpm",
			[
				"--filter",
				"@bitovp/db",
				"db:runtime:prepare",
				"--admin-env",
				adminFile,
				"--app-env",
				appFile,
			],
			options,
		);
		step = "applying database migrations";
		await execute(
			"pnpm",
			["--filter", "@bitovp/db", "db:migrate:deploy", "--admin-env", adminFile],
			options,
		);
		step = "reading the runtime role credentials";
		const appUrl = parseEnv(readFileSync(appFile, "utf8")).DATABASE_URL;
		const appPassword = new URL(appUrl).password;
		mask(env, [appUrl, appPassword, decodeURIComponent(appPassword)]);
		await runIntegrationTests(
			{
				root,
				directory,
				notify,
				env: {
					...options.env,
					BITOVP_TENANT_TEST_ADMIN_URL: adminUrl,
					BITOVP_TENANT_TEST_APP_URL: appUrl,
				},
			},
			execute,
		);
	} catch (error) {
		failure = atStep(asFailure(error), step);
	}
	// Cleanup runs on every path. When it fails too, the report keeps the first
	// failure and adds the cleanup failure after it.
	try {
		await cleanupFixture(state, cleanupExecute, env);
	} catch (error) {
		// A cleanup can reject with anything; the report still names its step.
		const later = atStep(
			asFailure(error),
			"removing the PostgreSQL fixture and private files",
		);
		throw failure ? withLaterFailure(failure, later) : later;
	}
	if (stateWritten) rmSync(stateFile, { force: true });
	notify("Dedicated PostgreSQL fixture and private files removed");
	if (failure) throw failure;
}

async function main(signal) {
	const args = process.argv.slice(2);
	const cleanup = args[0] === "--cleanup";
	if (cleanup) args.shift();
	assert(
		args.length === 0 || (args.length === 2 && args[0] === "--state-file"),
		"Unknown PostgreSQL integration option",
	);
	const statePath = args[1];
	if (cleanup) {
		assert(
			statePath && isAbsolute(statePath) && !inside(ROOT, statePath),
			"A private fixture state file is required",
		);
		if (!existsSync(statePath)) return;
		const stat = lstatSync(statePath);
		assert(
			stat.isFile() && !(stat.mode & 0o077),
			"Fixture state must be a regular private file",
		);
		await cleanupFixture(JSON.parse(readFileSync(statePath, "utf8")));
		rmSync(statePath, { force: true });
	} else {
		await runFixture({ statePath, signal });
	}
}

if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			controller.abort();
			for (const stop of children.values()) stop();
			process.exitCode = 1;
		});
	main(controller.signal).catch((error) => {
		console.error(
			"PostgreSQL integration failed; required tests or fixture cleanup did not complete.",
		);
		for (const line of failureReport(error)) console.error(line);
		process.exitCode = 1;
	});
}
