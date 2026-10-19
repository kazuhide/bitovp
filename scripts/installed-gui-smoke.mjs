import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
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

import { PHASED_GUI_STATES } from "../tests/browser/diagnostics.ts";

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
	"keep independent installation sessions isolated",
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
		"GITHUB_ACTIONS",
		"RUNNER_ENVIRONMENT",
	])
		if (env[key]) clean[key] = env[key];
	return {
		...clean,
		CI: "1",
		NEXT_TELEMETRY_DISABLED: "1",
		TURBO_TELEMETRY_DISABLED: "1",
	};
}

export function composeOverride({ id, directory, imageId = id }) {
	assert(/^[a-f0-9]{32}$/.test(id), "Invalid smoke test identity");
	assert(/^[a-f0-9]{32}$/.test(imageId), "Invalid smoke image identity");
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
    healthcheck:
      test: ["CMD-SHELL", 'pg_isready --host=127.0.0.1 --username "$\${POSTGRES_USER}" --dbname "$\${POSTGRES_DB}"']
      interval: 1s
      timeout: 3s
      retries: 60
    restart: "no"
  redis:
    ${owned}
    ports: !override []
    restart: "no"
  migrate:
    ${env(".env.migrate")}
    ${owned}
    ${build("Dockerfile")}
    image: bitovp-gui-worker:${imageId}
  worker:
    ${env(".env")}
    ${owned}
    ${build("Dockerfile")}
    image: bitovp-gui-worker:${imageId}
    volumes: !override []
    restart: "no"
  web:
    ${env(".env")}
    ${owned}
    ${build("Dockerfile.web")}
    image: bitovp-gui-web:${imageId}
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

export function failureSummary(raw) {
	if (raw === undefined) return ["Browser diagnostic: report unavailable"];
	let report;
	try {
		assert(typeof raw === "string" && raw.length <= 2_000_000);
		report = JSON.parse(raw);
		assert(report && Array.isArray(report.suites));
	} catch {
		return ["Browser diagnostic: invalid report"];
	}
	const statuses = new Map();
	const locations = new Map();
	const stages = new Map();
	const observations = new Map();
	const pending = [...report.suites];
	let visited = 0;
	try {
		while (pending.length) {
			assert(++visited <= 256 && pending.length <= 256);
			const suite = pending.pop();
			assert(suite && typeof suite === "object");
			assert(suite.specs === undefined || Array.isArray(suite.specs));
			assert(suite.suites === undefined || Array.isArray(suite.suites));
			for (const spec of suite.specs ?? []) {
				assert(CASES.includes(spec?.title) && !statuses.has(spec.title));
				assert(spec.tests?.length === 1);
				const results = spec.tests[0].results;
				assert(Array.isArray(results));
				const status = results[0]?.status;
				if (status === "failed" || status === "timedOut") {
					for (const annotation of Array.isArray(spec.tests[0].annotations)
						? spec.tests[0].annotations.slice(0, 32)
						: []) {
						if (
							annotation?.type === "smoke-state" &&
							[
								"route-vod-new",
								"route-login",
								"route-setup",
								"route-root",
								"route-other",
								"ready-complete",
								"ready-interactive",
								"ready-loading",
								"ready-unknown",
								"navigation-ok",
								"navigation-error",
								"navigation-unknown",
								"wizard-attached",
								"wizard-visible",
								"permission-checking",
								"sign-in-required",
								"permission-unverified",
								"permission-denied",
								"global-error",
								"alert-visible",
								"browser-error",
								"diagnostic-unavailable",
								"session-pending",
								"session-http-error",
								"session-unreadable",
								"session-invalid",
								"session-unconfigured",
								"session-anonymous",
								"session-admin",
								"session-authenticated-other",
								"session-request-failed",
								...PHASED_GUI_STATES,
							].includes(annotation.description)
						) {
							const values = observations.get(spec.title) ?? [];
							if (values.length < 24) values.push(annotation.description);
							observations.set(spec.title, values);
						}
						if (
							annotation?.type === "smoke-stage" &&
							[
								"submit-clicked",
								"post-received",
								"plan-validated",
								"post-fulfilled",
								"navigation-complete",
							].includes(annotation.description)
						)
							stages.set(spec.title, annotation.description);
					}
					const lines = new Set();
					const add = (line) => {
						if (
							Number.isInteger(line) &&
							line > 0 &&
							line <= 10_000 &&
							lines.size < 3
						)
							lines.add(line);
					};
					const errors = [
						results[0].error,
						...(Array.isArray(results[0].errors)
							? results[0].errors.slice(0, 10)
							: []),
					];
					for (const error of errors) {
						const file = error?.location?.file;
						if (
							typeof file === "string" &&
							file.replaceAll("\\", "/").split("/").at(-1) ===
								"installed-gui.test.ts"
						)
							add(error.location.line);
						if (typeof error?.stack === "string")
							for (const match of error.stack
								.slice(0, 10_000)
								.matchAll(
									/(?:^|[/\\])installed-gui\.test\.ts:([1-9]\d{0,3}):[1-9]\d{0,3}\b/g,
								))
								add(Number(match[1]));
					}
					if (lines.size) locations.set(spec.title, [...lines].join(","));
				}
				statuses.set(
					spec.title,
					results.length > 1
						? "retried"
						: [
									"passed",
									"failed",
									"timedOut",
									"skipped",
									"interrupted",
								].includes(status)
							? status
							: "unknown",
				);
			}
			pending.push(...(suite.suites ?? []));
		}
	} catch {
		return ["Browser diagnostic: unrecognized report structure"];
	}
	const categories = new Set();
	for (const error of Array.isArray(report.errors)
		? report.errors.slice(0, 20)
		: []) {
		const message =
			typeof error?.message === "string" ? error.message.slice(0, 10_000) : "";
		const category =
			[
				[/Cannot find module|ERR_MODULE_NOT_FOUND/, "module resolution"],
				[/Playwright Test did not expect/, "test registration"],
				[/No tests found/, "test discovery"],
				[
					/browserType\.launch|Executable doesn't exist|Host system is missing dependencies/,
					"browser launch",
				],
				[
					/SyntaxError|Transform failed|Cannot use import statement|require is not defined/,
					"module loading",
				],
				[
					/Run browser verification on a GitHub-hosted Linux runner/,
					"hosted runner guard",
				],
				[
					/Only the dedicated loopback installation may be tested|Run the installed GUI fixture launcher first/,
					"fixture configuration",
				],
			].find(([pattern]) => pattern.test(message))?.[1] ??
			"unclassified preflight error";
		categories.add(`Browser diagnostic: ${category}`);
	}
	return [
		...categories,
		...CASES.map(
			(title) =>
				`Browser case: ${title}; status=${statuses.get(title) ?? "not-run"}${locations.has(title) ? `; lines=${locations.get(title)}` : ""}${stages.has(title) ? `; stage=${stages.get(title)}` : ""}${observations.has(title) ? `; state=${observations.get(title).join(",")}` : ""}`,
		),
	];
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
	if (state.secondary) await cleanupFixture(state.secondary, execute, env);
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

export function browserExecutionAllowed(env, platform = process.platform) {
	return (
		platform === "linux" &&
		env.GITHUB_ACTIONS === "true" &&
		env.RUNNER_ENVIRONMENT === "github-hosted"
	);
}

export function validateExecutionMode(
	env,
	runtimeOnly,
	platform = process.platform,
) {
	if (runtimeOnly)
		assert(
			!env.CI && env.GITHUB_ACTIONS !== "true",
			"CI must run the complete browser suite",
		);
	else
		assert(
			browserExecutionAllowed(env, platform),
			"Browser execution requires a GitHub-hosted Linux runner; use --runtime-only for local Docker checks",
		);
}

async function waitUntil(probe, signal) {
	for (let attempt = 0; attempt < 120; attempt++) {
		assert(!signal?.aborted, "Smoke test was cancelled");
		try {
			if (await probe()) return;
		} catch {}
		await new Promise((accept) => setTimeout(accept, 500));
	}
	throw new Error("Application readiness timed out");
}

async function install(
	state,
	{ env, execute, imageId, revision, worker, signal, stage, notify, hostname },
) {
	const { id, directory } = state;
	const temporary = join(directory, "tmp");
	mkdirSync(temporary, { mode: 0o700 });
	const clean = {
		...childEnvironment(env),
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
	};
	const run = (executable, args, options = {}) =>
		execute(executable, args, {
			env: clean,
			...options,
			log: join(directory, "command.log"),
		});
	const app = join(directory, ".env"),
		admin = join(directory, ".env.migrate"),
		override = join(directory, "compose.yml");
	writeFileSync(
		app,
		`MASTER_KEY=${randomBytes(32).toString("base64")}\nAUTH_SESSION_SECRET=${randomBytes(48).toString("base64")}\nAUTH_MODE=users\nAUTH_ALLOW_INSECURE_HTTP=true\nPUBLIC_BASE_URL=http://${hostname}\nINGRESS_MODE=none\nCOMPOSE_PROFILES=\n`,
		{ mode: 0o600, flag: "wx" },
	);
	writeFileSync(override, composeOverride({ ...state, imageId }), {
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
	const compose = (args, options = {}) =>
		docker([...composeArgs, ...args], clean, run, options);
	const db = (args) =>
		run("pnpm", [
			"--filter",
			"@bitovp/db",
			...args,
			"--admin-env",
			admin,
			"--app-env",
			app,
		]);
	stage("database initialization");
	await db(["db:runtime:init"]);
	await compose(["config", "--quiet"]);
	await compose(["up", "--detach", "--wait", "postgres", "redis"]);
	const postgres = await compose(["port", "postgres", "5432"]);
	assert(
		/^127\.0\.0\.1:[1-9]\d*$/.test(postgres),
		"PostgreSQL must use a random IPv4 loopback port",
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
	stage("restricted database role preparation");
	await db(["db:runtime:prepare"]);
	if (worker) {
		stage("fresh Web and Worker Docker builds");
		notify("Building the current source into separate Web and Worker images");
		await compose(
			["build", "--build-arg", `GIT_COMMIT=${revision}`, "worker", "web"],
			{ timeout: 1_200_000 },
		);
		notify("Web and Worker Docker builds passed");
	}
	stage("migration and application startup");
	await compose([
		"up",
		"--detach",
		"--no-build",
		...(worker ? ["worker", "web"] : ["web"]),
	]);
	const binding = await compose(["port", "web", "3100"]);
	assert(
		/^127\.0\.0\.1:[1-9]\d*$/.test(binding),
		"Web must use a random IPv4 loopback port",
	);
	const baseURL = `http://${hostname}:${binding.split(":")[1]}`;
	await waitUntil(async () => {
		const response = await fetch(`http://${binding}/api/health`, {
			signal: AbortSignal.timeout(3_000),
		});
		return response.status === 200 && (await response.json()).status === "ok";
	}, signal);
	if (worker)
		await waitUntil(
			async () => workerReady(await compose(["logs", "--no-color", "worker"])),
			signal,
		);
	const migrationId = await compose(["ps", "--all", "--quiet", "migrate"]);
	const [migrationContainer] = JSON.parse(
		await docker(["inspect", migrationId], clean, run),
	);
	assert(
		migrationContainer.State.Status === "exited" &&
			migrationContainer.State.ExitCode === 0,
		"The migration service must exit successfully",
	);
	const blocked = await fetch(`${baseURL}/api/encoding-jobs`, {
		signal: AbortSignal.timeout(10_000),
	});
	assert.equal(
		blocked.status,
		503,
		"A fresh installation must require administrator setup",
	);
	await fetch(`${baseURL}/setup`, { signal: AbortSignal.timeout(10_000) });
	const code = /\[auth\] setup-code: ([a-z0-9-]+) /.exec(
		await compose(["logs", "--no-color", "web"]),
	)?.[1];
	assert(code, "The first-boot setup code was not issued");
	notify(
		`${worker ? "Primary" : "Independent secondary"} installation: migration passed, web health 200${worker ? ", all 9 worker queue registrations observed" : ""}, bootstrap API 503`,
	);
	return {
		compose,
		clean,
		login: {
			baseURL,
			code,
			email: `admin-${id}@example.invalid`,
			password: randomBytes(24).toString("base64url"),
		},
	};
}

function failureDiagnostics(state) {
	let diagnostics = "";
	const values = [];
	const visit = (instance) => {
		for (const file of ["command.log", "browser-results.json"])
			if (existsSync(join(instance.directory, file)))
				diagnostics += readFileSync(join(instance.directory, file), "utf8");
		for (const file of [".env", ".env.migrate"])
			if (existsSync(join(instance.directory, file))) {
				for (const value of Object.values(
					parseEnv(readFileSync(join(instance.directory, file), "utf8")),
				)) {
					if (value.length >= 12) values.push(value);
					try {
						if (new URL(value).password) values.push(new URL(value).password);
					} catch {}
				}
			}
		if (instance.secondary) visit(instance.secondary);
	};
	visit(state);
	if (existsSync(join(state.directory, "browser.json"))) {
		const browser = JSON.parse(
			readFileSync(join(state.directory, "browser.json"), "utf8"),
		);
		values.push(
			browser.code,
			browser.password,
			browser.secondary?.code,
			browser.secondary?.password,
		);
	}
	for (const value of values.filter(Boolean))
		diagnostics = diagnostics.replaceAll(value, "[private fixture value]");
	return diagnostics
		.replace(
			/((?:set-cookie|cookie|authorization):)[^\r\n]*/gi,
			"$1 [private fixture value]",
		)
		.slice(-50_000);
}

export async function runFixture({
	statePath,
	env = process.env,
	signal,
	runtimeOnly = false,
	notify = console.log,
} = {}) {
	validateExecutionMode(env, runtimeOnly);
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
	const create = () => {
		const directory = realpathSync(mkdtempSync(join(parent, "bitovp-gui-")));
		const id = randomBytes(16).toString("hex");
		writeFileSync(join(directory, ".owner"), id, { mode: 0o600, flag: "wx" });
		return { id, directory };
	};
	const state = create();
	const stateFile = statePath ?? join(state.directory, "state.json");
	let stateWritten = false,
		stage = "configuration";
	const execute = (executable, args, options) => {
		assert(!signal?.aborted, "Smoke test was cancelled");
		return command(executable, args, options);
	};
	try {
		writeFileSync(stateFile, JSON.stringify(state), {
			mode: 0o600,
			flag: "wx",
		});
		stateWritten = true;
		const revision = await execute("git", ["rev-parse", "HEAD"], {
			env: clean,
		});
		const primary = await install(state, {
			env,
			execute,
			imageId: state.id,
			revision,
			worker: true,
			signal,
			notify,
			hostname: "localhost",
			stage: (value) => {
				stage = `primary ${value}`;
			},
		});
		const installations = [primary];
		if (!runtimeOnly) {
			state.secondary = create();
			writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
			const secondary = await install(state.secondary, {
				env,
				execute,
				imageId: state.id,
				revision,
				worker: false,
				signal,
				notify,
				hostname: "127.0.0.1",
				stage: (value) => {
					stage = `secondary ${value}`;
				},
			});
			installations.push(secondary);
			const fixture = join(state.directory, "browser.json");
			writeFileSync(
				fixture,
				JSON.stringify({
					id: state.id,
					directory: state.directory,
					...primary.login,
					secondary: secondary.login,
				}),
				{ mode: 0o600, flag: "wx" },
			);
			stage = "installed GUI browser tests";
			notify(
				"Checking real setup, sign-in, VOD and Live forms, heartbeat settings and independent installation sessions in hosted Chromium",
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
					env: { ...primary.clean, BITOVP_GUI_SMOKE_FIXTURE: fixture },
					timeout: 600_000,
					log: join(state.directory, "command.log"),
				},
			);
			validateReport(
				JSON.parse(
					readFileSync(join(state.directory, "browser-results.json"), "utf8"),
				),
			);
			notify(
				`${CASES.length} installed GUI browser tests passed without skips or retries`,
			);
		} else
			notify("Local Docker runtime checks passed; browser tests were not run");
		for (const instance of installations) {
			const resources = await instance.compose([
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
			const running = (
				await instance.compose(["ps", "--status", "running", "--services"])
			).split(/\s+/);
			assert(
				running.includes("web"),
				"A Web service stopped during the smoke test",
			);
			if (instance === primary)
				assert(
					running.includes("worker"),
					"The Worker stopped during the smoke test",
				);
		}
		notify(
			"Provider accounts, storage credentials, encoding jobs and Live channels remained absent",
		);
	} catch (error) {
		notify(`Installed GUI smoke failed during ${stage}`);
		if (stage === "installed GUI browser tests") {
			let report;
			try {
				report = readFileSync(
					join(state.directory, "browser-results.json"),
					"utf8",
				);
			} catch {}
			for (const line of failureSummary(report)) notify(line);
		}
		if (statePath)
			writeFileSync(`${statePath}.failure.log`, failureDiagnostics(state), {
				mode: 0o600,
			});
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
	const runtimeOnly = args[0] === "--runtime-only";
	if (runtimeOnly) args.shift();
	const cleanup = args[0] === "--cleanup";
	if (cleanup) args.shift();
	assert(
		!(runtimeOnly && cleanup),
		"Cleanup and runtime-only options cannot be combined",
	);
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
		if (!cleanup)
			return runFixture({ statePath, runtimeOnly, signal: controller.signal });
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
