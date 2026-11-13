#!/usr/bin/env node
/**
 * A test that needs PostgreSQL, FFmpeg or Redis skips itself where that is
 * missing, and a run with skipped tests still passes. Three commands keep such
 * a test from never running:
 *
 *   node scripts/gated-tests.mjs --native-media
 *     Runs the tests that drive real FFmpeg and requires each one to run and
 *     pass. FFmpeg with libvmaf, libx264 and libsvtav1 must be on PATH and
 *     VMAF_MODEL_DIR must hold the models; scripts/native-media-tools.sh
 *     builds the worker image's FFmpeg and installs the models that it pins.
 *
 *   node scripts/gated-tests.mjs --redis
 *     Runs the tests that need a Redis server and requires each one to run and
 *     pass. redis-server must be on PATH, or VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER
 *     must name the program; scripts/redis-server-tools.sh takes it out of the
 *     image that production pins. The queue tests also use the PostgreSQL
 *     fixture of scripts/postgres-integration.mjs, which needs Docker.
 *
 *   node scripts/gated-tests.mjs --audit <workspace> <Vitest JSON report>
 *     Checks a package's plain test run: it may skip only tests that another
 *     job runs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	asFailure,
	atStep,
	GateFailure,
	isEntryPoint,
	outputTail,
} from "./gate-report.mjs";
import { command } from "./media-smoke.mjs";
import {
	childEnvironment,
	failureReport,
	GROUPS,
	reportProblems,
	runFixture,
	stopCommands,
	testEnvironment,
} from "./postgres-integration.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** Vitest files that drive real FFmpeg, with their number of tests. */
export const NATIVE_MEDIA = [
	{
		workspace: "@bitovp/core",
		directory: "packages/core",
		files: {
			"src/vmaf/command.ffmpeg.test.ts": 11,
			"src/vmaf/size-limits.ffmpeg.test.ts": 6,
		},
	},
	{
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/feeder/normalize-ffmpeg.test.ts": 3,
			"src/vmaf/live-capture-ffmpeg.test.ts": 1,
			"src/vmaf/live-loop-period-ffmpeg.test.ts": 1,
			"src/vmaf/live-two-loop-ffmpeg.test.ts": 3,
		},
	},
];

/**
 * The node:test files of the worker's operator scripts, which no package test
 * command collects. Three of their tests score real video with libvmaf.
 */
export const WORKER_SCRIPTS = {
	directory: "apps/worker",
	files: [
		"scripts/download-asr-model.test.mjs",
		"scripts/download-caption-alignment-model.test.mjs",
		"scripts/vmaf-cloud-worker.test.mjs",
	],
	tests: 43,
};

/**
 * Tests that need a Redis server. The lease tests start servers of their own
 * and no package test command collects them. Each queue test accepts only the
 * address of its own server; the tenant test also reads PostgreSQL.
 */
export const REDIS = {
	leases: {
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		config: "vitest.resource-leases.config.ts",
		files: { "src/vmaf/resource-leases.redis.integration.ts": 29 },
	},
	queues: {
		workspace: "@bitovp/worker",
		directory: "apps/worker",
		files: {
			"src/handlers.redis.integration.test.ts": 1,
			"src/live-capacity.redis.integration.test.ts": 1,
			"src/tenant/redis.integration.test.ts": 1,
		},
	},
	availability: {
		workspace: "@bitovp/web",
		directory: "apps/web",
		files: {
			"src/lib/server/local-semantic-readiness.redis.integration.test.ts": 8,
		},
	},
	servers: {
		TENANT_TEST_REDIS_URL: 16379,
		VOD_REDELIVERY_TEST_REDIS_URL: 16380,
		LIVE_CAPACITY_TEST_REDIS_URL: 16381,
		CLIP_AVAILABILITY_TEST_REDIS_URL: 16382,
	},
};

const sum = (files) =>
	Object.values(files).reduce((total, count) => total + count, 0);

/** Which tests a plain run of `workspace` may skip, and where each one runs. */
function allowances(workspace, root) {
	const allowed = new Map();
	for (const [groups, where] of [
		[GROUPS, "the PostgreSQL integration job runs them"],
		[NATIVE_MEDIA, "the native media job runs them"],
		[[REDIS.queues, REDIS.availability], "the Redis integration job runs them"],
	])
		for (const group of groups)
			if (group.workspace === workspace)
				for (const [file, count] of Object.entries(group.files))
					allowed.set(resolve(root, group.directory, file), { count, where });
	return allowed;
}

/**
 * Why a package's plain test run hides a test: it skipped one that no other
 * job runs. Also counts the skipped tests. Only the report of a run that
 * passed can be checked: a file that failed to load is reported without its
 * tests.
 */
export function skipProblems(report, workspace, root = ROOT) {
	const allowed = allowances(workspace, root);
	const results = Array.isArray(report?.testResults) ? report.testResults : [];
	if (results.length === 0)
		return { problems: ["the report lists no test files"], skipped: 0 };
	if (report?.success !== true)
		return {
			problems: [
				"the test run failed; its report cannot show every skipped test",
			],
			skipped: 0,
		};
	const problems = [];
	const seen = new Set();
	let skipped = 0;
	for (const result of results) {
		const file = resolve(String(result?.name));
		// Each entry would otherwise get the file's whole allowance.
		if (seen.has(file))
			problems.push(`${relative(root, file)}: reported more than once`);
		seen.add(file);
		const unrun = (
			Array.isArray(result?.assertionResults) ? result.assertionResults : []
		).filter((test) => test?.status !== "passed");
		skipped += unrun.length;
		const allowance = allowed.get(file);
		if (unrun.length <= (allowance?.count ?? 0)) continue;
		problems.push(
			`${relative(root, file)}: ${unrun.length} tests skipped, ${allowance ? `${allowance.count} may be (${allowance.where})` : "none may be"}`,
		);
		for (const test of unrun.slice(0, 20))
			problems.push(
				`${JSON.stringify(test?.status)}: ${test?.fullName ?? test?.title ?? "unnamed test"}`,
			);
	}
	// The totals must agree with the tests the report lists one by one.
	const pending = report?.numPendingTests;
	const todo = report?.numTodoTests;
	if (todo !== 0)
		problems.push(`todo tests: ${JSON.stringify(todo)}, required 0`);
	if (pending + todo !== skipped)
		problems.push(
			`the report counts ${JSON.stringify(pending)} skipped tests but lists ${skipped}`,
		);
	for (const file of allowed.keys())
		if (!seen.has(file))
			problems.push(
				`${relative(root, file)}: listed as skipped by this run but not part of it`,
			);
	return { problems, skipped };
}

const TOTALS = "media fixture totals: ";
// The longest that one command of a run may take. It is below the limit of
// the run's CI job, so a command that hangs is reported with its step.
const LIMIT = 300_000;

/** Why the worker script tests did not all run and pass, from the reporter's totals. */
export function scriptProblems(log, required = WORKER_SCRIPTS.tests) {
	const lines = String(log)
		.split(/\r?\n/)
		.filter((line) => line.startsWith(TOTALS));
	if (lines.length !== 1)
		return [`totals reported ${lines.length} times, required once`];
	let totals;
	try {
		totals = JSON.parse(lines[0].slice(TOTALS.length));
	} catch {
		return ["the totals are unreadable"];
	}
	const problems = [];
	for (const [key, count] of [
		["tests", required],
		["passed", required],
		["failed", 0],
		["cancelled", 0],
		["skipped", 0],
		["todo", 0],
		["emptyFiles", 0],
	])
		if (totals?.[key] !== count)
			problems.push(
				`${key}: ${JSON.stringify(totals?.[key])}, required ${count}`,
			);
	return problems;
}

/**
 * Runs one listed group through Vitest and requires its report to show every
 * listed test as run and passed. `kind` names the tests in a failure.
 */
async function runListed(group, kind, output, execute, options) {
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
				// A configuration of its own names the files; all of them are required.
				...(group.config
					? ["--config", group.config]
					: Object.keys(group.files)),
				"--maxWorkers=2",
				"--reporter=json",
				`--outputFile=${output}`,
			],
			options,
		);
	} catch (error) {
		failure = asFailure(error);
	}
	// Vitest writes its report for a failed run too; it names what failed.
	let report;
	try {
		report = JSON.parse(readFileSync(output, "utf8"));
	} catch {
		throw failure ?? new GateFailure("Vitest did not write a readable report");
	}
	const problems = reportProblems(report, group, options.cwd, kind);
	if (problems.length)
		throw new GateFailure(
			`${kind[0].toUpperCase()}${kind.slice(1)} tests must all run and pass`,
			{
				details: problems,
				diagnostics: failure instanceof GateFailure ? failure.diagnostics : "",
			},
		);
	// A complete report does not excuse a command that failed.
	if (failure) throw failure;
}

/** Runs every test that drives real FFmpeg; none may fail or be skipped. */
export async function runNativeMedia(
	{ root = ROOT, env = process.env, notify = console.log, signal } = {},
	execute = command,
) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-native-media-"));
	const clean = childEnvironment(env);
	for (const key of ["VMAF_MODEL_DIR", "FFMPEG_PATH", "FFPROBE_PATH"])
		if (env[key]) clean[key] = env[key];
	// Names the part that failed in the final report.
	let step = "starting the native media tests";
	try {
		for (const [index, group] of NATIVE_MEDIA.entries()) {
			step = `running ${group.workspace} tests that need FFmpeg`;
			await runListed(
				group,
				"native media",
				join(directory, `results-${index}.json`),
				execute,
				{ cwd: root, env: clean, signal, timeout: LIMIT },
			);
			notify(
				`${group.workspace}: ${sum(group.files)} tests that need FFmpeg passed, 0 skipped`,
			);
		}
		step = "running the worker script tests";
		let log = "";
		let failure;
		try {
			await execute(
				process.execPath,
				[
					"--test",
					"--test-reporter=spec",
					"--test-reporter-destination=stderr",
					`--test-reporter=${pathToFileURL(resolve(import.meta.dirname, "media-smoke-reporter.mjs")).href}`,
					"--test-reporter-destination=stderr",
					...WORKER_SCRIPTS.files,
				],
				{
					cwd: resolve(root, WORKER_SCRIPTS.directory),
					env: clean,
					signal,
					timeout: LIMIT,
					diagnostics: (text) => {
						log += text;
					},
				},
			);
		} catch (error) {
			failure = asFailure(error);
		}
		// A command that stopped before it reported totals explains itself.
		if (failure && !log.includes(TOTALS)) throw failure;
		const problems = scriptProblems(log);
		if (problems.length)
			throw new GateFailure("Worker script tests must all run and pass", {
				details: problems,
				diagnostics: failure instanceof GateFailure ? failure.diagnostics : "",
			});
		if (failure) throw failure;
		notify(
			`Worker scripts: ${WORKER_SCRIPTS.tests} tests in ${WORKER_SCRIPTS.files.length} files passed, 0 skipped`,
		);
	} catch (error) {
		throw atStep(asFailure(error), step);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** True when something accepts connections on a loopback port. */
const accepts = (port) =>
	new Promise((accept) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			accept(true);
		});
		socket.once("error", () => accept(false));
	});

/**
 * The process id that the Redis server on a loopback port reports, or
 * undefined when nothing answers there as Redis does within a second.
 */
const serverProcess = (port) =>
	new Promise((accept) => {
		const socket = connect({ host: "127.0.0.1", port });
		let reply = "";
		const answer = (id) => {
			clearTimeout(timer);
			socket.destroy();
			accept(id);
		};
		// For the whole exchange, whatever the other side sends meanwhile.
		const timer = setTimeout(() => answer(undefined), 1_000);
		socket.once("connect", () => socket.write("INFO server\r\n"));
		socket.on("data", (chunk) => {
			reply += chunk;
			const id = /^process_id:(\d+)\r\n/m.exec(reply)?.[1];
			if (id || reply.length > 64 * 1024) answer(id && Number(id));
		});
		for (const event of ["error", "close"])
			socket.once(event, () => answer(undefined));
	});

/**
 * Starts a Redis server of this run on a loopback port and waits until it
 * answers there. The queue tests name fixed ports and write to whatever
 * serves them, so the port must be free before, and the server that answers
 * must be the process that was started, not one that the program started in
 * its place or one that took the port in the meantime.
 */
export async function startRedis({
	program,
	port,
	directory,
	env,
	wait = 10_000,
}) {
	if (await accepts(port))
		throw new GateFailure(
			`127.0.0.1:${port} already accepts connections; the Redis tests need that port for a server of their own`,
		);
	const child = spawn(
		program,
		[
			"--port",
			String(port),
			"--bind",
			"127.0.0.1",
			"--save",
			"",
			"--appendonly",
			"no",
			"--dir",
			directory,
			"--loglevel",
			"warning",
		],
		// A process group of its own, so that the server is stopped together
		// with anything that the program started beside it.
		{ env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	const log = outputTail(16 * 1024);
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk) => log.add(chunk.toString()));
	let running = true;
	const ended = new Promise((accept) => {
		// A program that cannot start reports an error and may never close.
		for (const event of ["error", "close"])
			child.once(event, () => {
				running = false;
				accept();
			});
	});
	const send = (name) => {
		if (!running) return;
		try {
			process.kill(-child.pid, name);
		} catch {
			child.kill(name);
		}
	};
	const stop = async () => {
		send("SIGTERM");
		const timer = setTimeout(() => send("SIGKILL"), 2_000);
		await ended;
		clearTimeout(timer);
	};
	// A program that ended is not waited for, and neither is a port that
	// another server took in the meantime.
	let other;
	for (
		const limit = Date.now() + wait;
		running && other === undefined && Date.now() < limit;
	) {
		const id = await serverProcess(port);
		// A program that could not start has no process id either.
		if (id !== undefined && id === child.pid) return { stop };
		other = id;
		if (other === undefined)
			await new Promise((accept) => setTimeout(accept, 50));
	}
	await stop();
	throw new GateFailure(
		other === undefined
			? `The Redis server for 127.0.0.1:${port} did not answer`
			: `127.0.0.1:${port} is served by process ${other}, not by the server that this run started`,
		{ diagnostics: log.text() },
	);
}

/**
 * The part of the Redis run that needs PostgreSQL too. Runs inside the
 * fixture of scripts/postgres-integration.mjs, whose private directory holds
 * the database credentials file and the servers' working directories.
 */
async function runQueues(
	{ root, directory, env, notify },
	execute,
	program,
	start,
) {
	const database = testEnvironment(env);
	const clean = childEnvironment(env);
	const servers = [];
	// Names the part that failed in the final report.
	let step = "starting the Redis servers of the queue tests";
	try {
		clean.TENANT_TEST_DB_FILE = join(directory, "tenant-redis.json");
		writeFileSync(
			clean.TENANT_TEST_DB_FILE,
			JSON.stringify({
				adminUrl: database.BITOVP_TENANT_TEST_ADMIN_URL,
				runtimeUrl: database.BITOVP_TENANT_TEST_APP_URL,
			}),
			{ mode: 0o600, flag: "wx" },
		);
		for (const [variable, port] of Object.entries(REDIS.servers)) {
			const working = join(directory, `redis-${port}`);
			mkdirSync(working, { mode: 0o700 });
			servers.push(
				await start({
					program,
					port,
					directory: working,
					env: childEnvironment(env),
				}),
			);
			clean[variable] = `redis://127.0.0.1:${port}`;
		}
		step = "running the queue tests that need Redis";
		// The fixture's runner stops a command at 180 seconds.
		await runListed(
			REDIS.queues,
			"Redis",
			join(directory, "redis-queues.json"),
			execute,
			{ cwd: root, env: clean },
		);
		notify(
			`${REDIS.queues.workspace}: ${sum(REDIS.queues.files)} queue tests passed against Redis and PostgreSQL, 0 skipped`,
		);
		step = "running the clip availability matrix against Redis";
		await runListed(
			REDIS.availability,
			"Redis",
			join(directory, "redis-clip-availability.json"),
			execute,
			{ cwd: root, env: clean },
		);
		notify(
			`${REDIS.availability.workspace}: ${sum(REDIS.availability.files)} clip availability tests passed against Redis, 0 skipped`,
		);
	} catch (error) {
		throw atStep(asFailure(error), step);
	} finally {
		for (const server of servers) await server.stop();
	}
}

/** Runs every test that needs Redis; none may fail or be skipped. */
export async function runRedis(
	{ root = ROOT, env = process.env, notify = console.log, signal } = {},
	{ execute = command, fixture = runFixture, start = startRedis } = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-redis-tests-"));
	const clean = childEnvironment(env);
	// The lease tests start this program themselves and read the same variable.
	const program = env.VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER || "redis-server";
	if (env.VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER)
		clean.VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER = program;
	// Names the part that failed in the final report.
	let step = "checking the Redis server program";
	try {
		let version;
		try {
			version = await execute(program, ["--version"], { env: clean, signal });
		} catch (error) {
			// A cancelled run is not told to install the program.
			if (signal?.aborted) throw error;
			throw new GateFailure(
				"redis-server could not be run; put it on PATH or name it in VMAF_RESOURCE_LEASE_TEST_REDIS_SERVER",
				{ diagnostics: error instanceof GateFailure ? error.diagnostics : "" },
			);
		}
		const [, release] = /^Redis server v=(\d+\.\d+\.\d+) /.exec(version) ?? [];
		if (!release)
			throw new GateFailure("redis-server did not report a Redis version");
		notify(`Redis server ${release}`);
		step = "running the resource lease tests";
		await runListed(
			REDIS.leases,
			"Redis",
			join(directory, "leases.json"),
			execute,
			{ cwd: root, env: clean, signal, timeout: LIMIT },
		);
		notify(
			`${REDIS.leases.workspace}: ${sum(REDIS.leases.files)} resource lease tests passed, 0 skipped`,
		);
		step = "running the queue tests in the PostgreSQL fixture";
		await fixture({
			root,
			env,
			signal,
			notify,
			run: (context, run) => runQueues(context, run, program, start),
		});
	} catch (error) {
		throw atStep(asFailure(error), step);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Checks one package's plain test run from its Vitest JSON report. */
export function auditSkips(workspace, reportPath, { root = ROOT } = {}) {
	assert(/^@bitovp\/[a-z-]+$/.test(workspace), "A workspace name is required");
	let report;
	try {
		report = JSON.parse(readFileSync(reportPath, "utf8"));
	} catch {
		throw new GateFailure("The Vitest JSON report is missing or unreadable");
	}
	const { problems, skipped } = skipProblems(report, workspace, root);
	if (problems.length)
		throw new GateFailure(
			"A plain test run may skip only tests that another job runs",
			{ details: problems },
		);
	return `${workspace}: ${skipped} tests skipped by the plain run; another job runs each of them`;
}

async function main(signal) {
	const [mode, ...rest] = process.argv.slice(2);
	if (mode === "--native-media" && rest.length === 0)
		return runNativeMedia({ signal });
	if (mode === "--redis" && rest.length === 0) return runRedis({ signal });
	if (mode === "--audit" && rest.length === 2)
		return console.log(auditSkips(rest[0], rest[1]));
	throw new GateFailure(
		"Usage: gated-tests.mjs --native-media | --redis | --audit <workspace> <Vitest JSON report>",
	);
}

if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			controller.abort();
			stopCommands();
			process.exitCode = 1;
		});
	main(controller.signal).catch((error) => {
		console.error("Gated tests failed; a required test did not run and pass.");
		// Leaves out the credentials of a PostgreSQL fixture this run started.
		for (const line of failureReport(error)) console.error(line);
		process.exitCode = 1;
	});
}
