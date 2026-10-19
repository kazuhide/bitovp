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
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

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
		},
	},
	{
		workspace: "@bitovp/web",
		directory: "apps/web",
		files: { "src/lib/server/create-request.integration.test.ts": 3 },
	},
	{
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: { "src/alerts/engine-locking.integration.test.ts": 3 },
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
		throw new Error("Required PostgreSQL test URLs are invalid");
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

export function validateReport(report, group, root) {
	const expected = Object.entries(group.files);
	const total = expected.reduce((sum, [, count]) => sum + count, 0);
	assert(report?.success === true, "PostgreSQL test report did not succeed");
	for (const key of [
		"numFailedTests",
		"numPendingTests",
		"numTodoTests",
		"numFailedTestSuites",
		"numPendingTestSuites",
	])
		assert.equal(
			report[key],
			0,
			"PostgreSQL tests must have no failures, skips or unfinished cases",
		);
	assert.equal(
		report.numTotalTests,
		total,
		"Unexpected PostgreSQL test discovery count",
	);
	assert.equal(report.numPassedTests, total, "All PostgreSQL tests must pass");
	assert.equal(
		report.testResults?.length,
		expected.length,
		"Required PostgreSQL test files were not discovered exactly once",
	);
	const seen = new Set();
	for (const result of report.testResults) {
		const name = relative(resolve(root, group.directory), result.name);
		assert(
			Object.hasOwn(group.files, name) && !seen.has(name),
			"Unexpected or duplicate PostgreSQL test file",
		);
		seen.add(name);
		assert.equal(result.status, "passed", "PostgreSQL test file failed");
		assert.equal(
			result.assertionResults?.length,
			group.files[name],
			"Unexpected per-file PostgreSQL test count",
		);
		assert(
			result.assertionResults.every((test) => test.status === "passed"),
			"Every PostgreSQL assertion must run and pass",
		);
	}
}

const children = new Map();
const terminate = (child) => {
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
};
async function command(executable, args, options) {
	return new Promise((accept, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let expired = false;
		let killTimer;
		const stop = () => {
			expired = true;
			terminate(child);
			killTimer ??= setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 5_000);
		};
		const timer = setTimeout(stop, options.timeout ?? 180_000);
		children.set(child, stop);
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
			if (output.length > 8_000_000) stop();
		});
		// Raw child diagnostics can contain connection URLs. Never forward them.
		child.stderr.resume();
		child.on("error", () => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			children.delete(child);
			reject(new Error("PostgreSQL integration command could not start"));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			children.delete(child);
			if (code === 0 && !expired) accept(output.trim());
			else reject(new Error("PostgreSQL integration command failed"));
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
		const output = join(directory, `results-${index}.json`);
		assert(!existsSync(output), "PostgreSQL report already exists");
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
		validateReport(JSON.parse(readFileSync(output, "utf8")), group, root);
		notify(
			`${group.workspace}: ${Object.keys(group.files).length} PostgreSQL files, ${Object.values(group.files).reduce((sum, count) => sum + count, 0)} passed, 0 skipped`,
		);
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
const mask = (env, values) => {
	if (env.GITHUB_ACTIONS === "true")
		for (const value of values) console.log(`::add-mask::${value}`);
};

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
				"postgres:17-alpine",
			],
			env,
			execute,
		);
		const binding = await docker(["port", name(id), "5432/tcp"], env, execute);
		assert(
			/^127\.0\.0\.1:\d+$/.test(binding),
			"PostgreSQL fixture must expose only a random loopback port",
		);
		let ready = false;
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
			} catch {
				assert(!signal?.aborted, "PostgreSQL integration was cancelled");
				await new Promise((accept) => setTimeout(accept, 250));
			}
		}
		assert(ready, "PostgreSQL fixture did not become ready");
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
		await execute(
			"pnpm",
			["--filter", "@bitovp/db", "db:migrate:deploy", "--admin-env", adminFile],
			options,
		);
		const appUrl = parseEnv(readFileSync(appFile, "utf8")).DATABASE_URL;
		mask(env, [appUrl, new URL(appUrl).password]);
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
	} finally {
		await cleanupFixture(state, cleanupExecute, env);
		if (stateWritten) rmSync(stateFile, { force: true });
		notify("Dedicated PostgreSQL fixture and private files removed");
	}
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

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			controller.abort();
			for (const stop of children.values()) stop();
			process.exitCode = 1;
		});
	main(controller.signal).catch(() => {
		console.error(
			"PostgreSQL integration failed; required tests or fixture cleanup did not complete.",
		);
		process.exitCode = 1;
	});
}
