import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const SOCKET = "unix:///var/run/docker.sock";
const LABEL = "io.bitovp.gui-smoke";
export const inside = (root, path) => {
	const child = relative(root, path);
	return (
		child === "" ||
		(!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
	);
};
export const CASES = [
	"first administrator setup",
	"sign in and reject unauthenticated access",
	"configure and submit VOD",
	"configure and submit Live and inspect heartbeat",
	"persist and reset heartbeat cadence",
];
const QUEUES = [
	"usageStatistics",
	"orchestrator",
	"liveChannel",
	"vmafRunner",
	"feederManager",
	"storageInspect",
	"notify",
	"startupProbe",
	"slateNormalize",
];

export function childEnvironment(env) {
	assert(
		!env.DOCKER_HOST || env.DOCKER_HOST === SOCKET,
		"Only the local Docker socket is supported",
	);
	assert(
		!env.DOCKER_CONTEXT,
		"Unset DOCKER_CONTEXT for the isolated smoke test",
	);
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
		"PLAYWRIGHT_BROWSERS_PATH",
	])
		if (env[key]) clean[key] = env[key];
	return {
		...clean,
		CI: "1",
		NEXT_TELEMETRY_DISABLED: "1",
		TURBO_TELEMETRY_DISABLED: "1",
	};
}

export function composeOverride({ id, directory }) {
	assert(/^[a-f0-9]{32}$/.test(id), "Invalid smoke test identity");
	const env = (file) =>
		`env_file: !override\n      - path: ${JSON.stringify(join(directory, file))}\n        required: true\n        format: raw`;
	const owned = `labels:\n      ${LABEL}: ${id}`;
	const build = (dockerfile) =>
		`build:\n      context: ${JSON.stringify(ROOT)}\n      dockerfile: ${dockerfile}\n      labels:\n        ${LABEL}: ${id}`;
	return `services:
  postgres:
    ${env(".env.migrate")}
    ${owned}
    ports: !override ["127.0.0.1::5432"]
    restart: "no"
  redis:
    ${owned}
    ports: !override []
    restart: "no"
  migrate:
    ${env(".env.migrate")}
    ${owned}
    ${build("Dockerfile")}
    image: bitovp-gui-worker:${id}
  worker:
    ${env(".env")}
    ${owned}
    ${build("Dockerfile")}
    image: bitovp-gui-worker:${id}
    volumes: !override []
    restart: "no"
  web:
    ${env(".env")}
    ${owned}
    ${build("Dockerfile.web")}
    image: bitovp-gui-web:${id}
    ports: !override ["127.0.0.1::3100"]
    restart: "no"
networks:
  default:
    ${owned}
volumes:
  pgdata:
    ${owned}
  redisdata:
    ${owned}
`;
}

export function validateReport(report) {
	assert.equal(report.stats?.unexpected, 0, "Browser tests failed");
	assert.equal(report.stats?.skipped, 0, "Browser tests must not be skipped");
	assert.equal(
		report.stats?.flaky,
		0,
		"Browser tests must pass without retries",
	);
	assert.equal(
		report.stats?.expected,
		CASES.length,
		"Browser test discovery changed",
	);
	const cases = [];
	const visit = (suite) => {
		for (const spec of suite.specs ?? []) {
			assert.equal(spec.tests?.length, 1, "Unexpected browser project count");
			assert.equal(
				spec.tests[0].status,
				"expected",
				"Browser test did not pass",
			);
			assert.equal(
				spec.tests[0].results?.length,
				1,
				"Browser retries are not allowed",
			);
			assert.equal(
				spec.tests[0].results[0].status,
				"passed",
				"Browser test did not run",
			);
			cases.push(spec.title);
		}
		for (const child of suite.suites ?? []) visit(child);
	};
	for (const suite of report.suites ?? []) visit(suite);
	assert.deepEqual(
		cases,
		CASES,
		"Required browser cases were not discovered exactly once",
	);
}

export function workerReady(log) {
	return QUEUES.every((key) => log.includes(`[worker:${key}] listening on `));
}

const children = new Set();
async function command(
	executable,
	args,
	{ env, cwd = ROOT, timeout = 180_000, log } = {},
) {
	return new Promise((accept, reject) => {
		const child = spawn(executable, args, {
			cwd,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);
		let output = "";
		let diagnostics = "";
		let expired = false;
		const kill = () => {
			expired = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(kill, timeout);
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.length > 8_000_000) kill();
		});
		child.stderr.on("data", (chunk) => {
			diagnostics = (diagnostics + chunk).slice(-2_000_000);
		});
		child.on("error", () => {
			clearTimeout(timer);
			children.delete(child);
			reject(new Error("Smoke test command could not start"));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			children.delete(child);
			if (log) writeFileSync(log, output + diagnostics, { mode: 0o600 });
			if (code === 0 && !expired) accept(output.trim());
			else
				reject(
					new Error(
						"Smoke test command failed; diagnostics remain private until cleanup",
					),
				);
		});
	});
}

const ownedName = (id) => `bitovp-gui-${id}`;
const docker = (args, env, execute = command, options = {}) =>
	execute("docker", ["--host", SOCKET, ...args], {
		env: childEnvironment(env),
		timeout: 60_000,
		...options,
	});
const privateDirectory = (state) => {
	assert(/^[a-f0-9]{32}$/.test(state.id), "Invalid smoke test identity");
	assert(
		isAbsolute(state.directory) &&
			basename(state.directory).startsWith("bitovp-gui-"),
		"Invalid private smoke directory",
	);
	if (!existsSync(state.directory)) return;
	assert(
		lstatSync(state.directory).isDirectory() &&
			realpathSync(state.directory) === state.directory &&
			!(lstatSync(state.directory).mode & 0o077),
		"Smoke directory is not private and canonical",
	);
	assert.equal(
		readFileSync(join(state.directory, ".owner"), "utf8"),
		state.id,
		"Smoke directory ownership differs",
	);
};

export async function cleanupFixture(
	state,
	execute = command,
	env = process.env,
) {
	privateDirectory(state);
	for (const [kind, list, remove] of [
		["container", ["ps", "--all", "--quiet"], ["rm", "--force", "--volumes"]],
		["volume", ["volume", "ls", "--quiet"], ["volume", "rm"]],
		["network", ["network", "ls", "--quiet"], ["network", "rm"]],
	]) {
		const resources = (
			await docker(
				[
					...list,
					"--filter",
					`label=${LABEL}=${state.id}`,
					"--filter",
					`label=com.docker.compose.project=${ownedName(state.id)}`,
				],
				env,
				execute,
			)
		)
			.split(/\s+/)
			.filter(Boolean);
		for (const resource of resources) {
			assert(/^[a-zA-Z0-9_.-]+$/.test(resource), "Invalid owned resource name");
			const inspected = JSON.parse(
				await docker([kind, "inspect", resource], env, execute),
			)[0];
			const labels =
				kind === "container" ? inspected.Config.Labels : inspected.Labels;
			assert(
				labels?.[LABEL] === state.id &&
					labels?.["com.docker.compose.project"] === ownedName(state.id),
				"Docker resource ownership differs",
			);
			await docker([...remove, resource], env, execute);
		}
		assert.equal(
			await docker(
				[
					...list,
					"--filter",
					`label=${LABEL}=${state.id}`,
					"--filter",
					`label=com.docker.compose.project=${ownedName(state.id)}`,
				],
				env,
				execute,
			),
			"",
			"Owned Docker resources remain after cleanup",
		);
	}
	for (const image of [
		`bitovp-gui-web:${state.id}`,
		`bitovp-gui-worker:${state.id}`,
	]) {
		const present = await docker(
			["image", "ls", "--quiet", image],
			env,
			execute,
		);
		if (!present) continue;
		const [inspected] = JSON.parse(
			await docker(["image", "inspect", image], env, execute),
		);
		assert.equal(
			inspected.Config.Labels?.[LABEL],
			state.id,
			"Image ownership differs",
		);
		await docker(["image", "rm", image], env, execute);
	}
	if (existsSync(state.directory)) rmSync(state.directory, { recursive: true });
}

export async function runFixture({
	statePath,
	env = process.env,
	signal,
	notify = console.log,
} = {}) {
	const clean = childEnvironment(env);
	if (statePath)
		assert(
			isAbsolute(statePath) &&
				!inside(ROOT, statePath) &&
				!existsSync(statePath),
			"State file must be new and outside the checkout",
		);
	const parent = realpathSync(statePath ? dirname(statePath) : tmpdir());
	assert(
		!inside(realpathSync(ROOT), parent),
		"Private smoke configuration must be outside the checkout",
	);
	const directory = realpathSync(mkdtempSync(join(parent, "bitovp-gui-")));
	const id = randomBytes(16).toString("hex");
	const state = { id, directory };
	const stateFile = statePath ?? join(directory, "state.json");
	writeFileSync(join(directory, ".owner"), id, { mode: 0o600, flag: "wx" });
	let stateWritten = false;
	let stage = "configuration";
	const execute = async (executable, args, options = {}) => {
		assert(!signal?.aborted, "Smoke test was cancelled");
		return command(executable, args, {
			env: clean,
			...options,
			log: join(directory, "command.log"),
		});
	};
	try {
		writeFileSync(stateFile, JSON.stringify(state), {
			mode: 0o600,
			flag: "wx",
		});
		stateWritten = true;
		const app = join(directory, ".env");
		const admin = join(directory, ".env.migrate");
		writeFileSync(
			app,
			`MASTER_KEY=${randomBytes(32).toString("base64")}\nAUTH_SESSION_SECRET=${randomBytes(48).toString("base64")}\nAUTH_MODE=users\nAUTH_ALLOW_INSECURE_HTTP=true\nPUBLIC_BASE_URL=http://127.0.0.1\nINGRESS_MODE=none\nCOMPOSE_PROFILES=\n`,
			{ mode: 0o600, flag: "wx" },
		);
		const override = join(directory, "compose.yml");
		writeFileSync(override, composeOverride(state), {
			mode: 0o600,
			flag: "wx",
		});
		const composeArgs = [
			"compose",
			"--project-name",
			ownedName(id),
			"--env-file",
			app,
			"-f",
			join(ROOT, "docker-compose.yml"),
			"-f",
			override,
		];
		const compose = (args, options) =>
			docker([...composeArgs, ...args], env, execute, options);
		const db = (args) =>
			execute("pnpm", [
				"--filter",
				"@bitovp/db",
				...args,
				"--admin-env",
				admin,
				"--app-env",
				app,
			]);
		await db(["db:runtime:init"]);
		await compose(["config", "--quiet"]);
		stage = "PostgreSQL and Redis startup";
		notify(
			"Starting dedicated PostgreSQL and Redis with private generated configuration",
		);
		await compose(["up", "--detach", "--wait", "postgres", "redis"]);
		const postgres = await compose(["port", "postgres", "5432"]);
		assert(
			/^127\.0\.0\.1:\d+$/.test(postgres),
			"PostgreSQL must use a random loopback port",
		);
		const migration = parseEnv(readFileSync(admin, "utf8"));
		const url = new URL(migration.DATABASE_URL);
		url.host = postgres;
		migration.DATABASE_URL = url.toString();
		writeFileSync(
			admin,
			Object.entries(migration)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(""),
			{ mode: 0o600 },
		);
		stage = "runtime database preparation";
		await db(["db:runtime:prepare"]);
		stage = "fresh Docker build";
		notify("Building the current source into separate Web and Worker images");
		const revision = await execute("git", ["rev-parse", "HEAD"]);
		await compose(
			[
				"build",
				"--build-arg",
				`GIT_COMMIT=${revision}`,
				"migrate",
				"worker",
				"web",
			],
			{ timeout: 1_200_000 },
		);
		stage = "migration and application startup";
		await compose(["up", "--detach", "--no-build", "worker", "web"]);
		const port = await compose(["port", "web", "3100"]);
		assert(
			/^127\.0\.0\.1:\d+$/.test(port),
			"Web must use a random loopback port",
		);
		const baseURL = `http://${port}`;
		const wait = async (probe) => {
			for (let attempt = 0; attempt < 120; attempt++) {
				assert(!signal?.aborted, "Smoke test was cancelled");
				try {
					if (await probe()) return;
				} catch {}
				await new Promise((accept) => setTimeout(accept, 500));
			}
			throw new Error("Application readiness timed out");
		};
		await wait(async () => {
			const response = await fetch(`${baseURL}/api/health`, {
				signal: AbortSignal.timeout(3_000),
			});
			return response.status === 200 && (await response.json()).status === "ok";
		});
		await wait(async () =>
			workerReady(await compose(["logs", "--no-color", "worker"])),
		);
		const services = (await compose(["ps", "--all", "--services"])).split(
			/\s+/,
		);
		for (const service of ["postgres", "redis", "migrate", "worker", "web"])
			assert(
				services.includes(service),
				"Required application services are missing",
			);
		await fetch(`${baseURL}/setup`, { signal: AbortSignal.timeout(10_000) });
		const log = await compose(["logs", "--no-color", "web"]);
		const code = /\[auth\] setup-code: ([a-z0-9-]+) /.exec(log)?.[1];
		assert(code, "The first-boot setup code was not issued");
		const fixture = join(directory, "browser.json");
		writeFileSync(
			fixture,
			JSON.stringify({
				id,
				baseURL,
				code,
				directory,
				email: `admin-${id}@example.invalid`,
				password: randomBytes(24).toString("base64url"),
			}),
			{ mode: 0o600, flag: "wx" },
		);
		stage = "installed GUI browser tests";
		notify(
			"Checking real setup, sign-in, VOD and Live forms, and heartbeat settings in isolated Chromium",
		);
		await execute(
			"pnpm",
			[
				"exec",
				"playwright",
				"test",
				"--config",
				"tests/browser/playwright.config.ts",
			],
			{
				env: { ...clean, BITOVP_GUI_SMOKE_FIXTURE: fixture },
				timeout: 300_000,
			},
		);
		validateReport(
			JSON.parse(readFileSync(join(directory, "browser-results.json"), "utf8")),
		);
		const resources = await compose([
			"exec",
			"--no-TTY",
			"postgres",
			"psql",
			"--username",
			"bitovp",
			"--dbname",
			"bitovp",
			"--tuples-only",
			"--no-align",
			"--command",
			'SELECT (SELECT count(*) FROM "BitmovinAccount") + (SELECT count(*) FROM "Credential") + (SELECT count(*) FROM "EncodingJob") + (SELECT count(*) FROM "LiveChannel")',
		]);
		assert.equal(
			resources,
			"0",
			"Browser fixtures must not register provider accounts or enqueue real jobs",
		);
		const running = await compose(["ps", "--status", "running", "--services"]);
		assert(
			running.split(/\s+/).includes("worker") &&
				running.split(/\s+/).includes("web"),
			"Application services stopped during the GUI test",
		);
		notify(
			`${CASES.length} installed GUI browser tests passed; no provider credentials or encoding requests were used`,
		);
	} catch (error) {
		notify(`Installed GUI smoke failed during ${stage}`);
		if (statePath && existsSync(join(directory, "command.log"))) {
			let diagnostics = readFileSync(join(directory, "command.log"), "utf8");
			if (existsSync(join(directory, "browser-results.json")))
				diagnostics += readFileSync(
					join(directory, "browser-results.json"),
					"utf8",
				);
			for (const file of [".env", ".env.migrate"]) {
				if (!existsSync(join(directory, file))) continue;
				for (const value of Object.values(
					parseEnv(readFileSync(join(directory, file), "utf8")),
				)) {
					if (value.length < 12) continue;
					diagnostics = diagnostics.replaceAll(
						value,
						"[private fixture value]",
					);
					try {
						const password = new URL(value).password;
						if (password)
							diagnostics = diagnostics.replaceAll(
								password,
								"[private fixture credential]",
							);
					} catch {}
				}
			}
			if (existsSync(join(directory, "browser.json"))) {
				const browser = JSON.parse(
					readFileSync(join(directory, "browser.json"), "utf8"),
				);
				for (const value of [browser.code, browser.password])
					diagnostics = diagnostics.replaceAll(
						value,
						"[private fixture value]",
					);
			}
			writeFileSync(`${statePath}.failure.log`, diagnostics.slice(-50_000), {
				mode: 0o600,
			});
		}
		throw error;
	} finally {
		await cleanupFixture(state, command, env);
		if (stateWritten) rmSync(stateFile, { force: true });
		notify("Owned smoke containers, volumes, images and private files removed");
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const args = process.argv.slice(2);
	const cleanup = args[0] === "--cleanup";
	if (cleanup) args.shift();
	assert(
		args.length === 0 || (args.length === 2 && args[0] === "--state-file"),
		"Unknown installed GUI smoke option",
	);
	const statePath = args[1];
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			controller.abort();
			for (const child of children) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
			process.exitCode = 1;
		});
	(async () => {
		if (!cleanup) return runFixture({ statePath, signal: controller.signal });
		assert(
			statePath && isAbsolute(statePath) && !inside(ROOT, statePath),
			"Cleanup requires an external private state file",
		);
		if (!existsSync(statePath)) return;
		assert(
			lstatSync(statePath).isFile() && !(lstatSync(statePath).mode & 0o077),
			"State must be a private regular file",
		);
		await cleanupFixture(JSON.parse(readFileSync(statePath, "utf8")));
		rmSync(statePath, { force: true });
	})().catch(() => {
		console.error("Installed GUI smoke did not complete successfully");
		process.exitCode = 1;
	});
}
