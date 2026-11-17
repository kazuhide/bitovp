import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { binaryHashes, childEnvironment } from "./bombadil-component.mjs";
import { isEntryPoint } from "./gate-report.mjs";
import {
	groupExists,
	guardedCommand,
	OWNER_GUARD,
} from "./semantic-controls.mjs";
import { sourceRevision } from "./source-revision.mjs";

const root = resolve(import.meta.dirname, "..");
const specification = join(root, "tests/bombadil/installed-wizard.spec.ts");
const actionClasses = ["edit", "select", "add", "remove", "revisit"];
const negativeProperty = "configuredRenditionsMatchIntent";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const installedDiagnosticSteps = [
	"configuration",
	"browser-launch",
	"network-guard",
	"socket-negative",
	"navigate",
	"import-plan",
	"ladder",
	"seed-rows",
	"plan-json",
	"oracle",
	"cdp",
	"driver",
	"driver-arguments",
	"driver-binary",
	"driver-target",
	"driver-specification",
	"driver-execution",
	"driver-trace",
	"driver-summary",
	"network-check",
	"summary",
];
export const installedDiagnosticCategories = [
	"timeout",
	"assertion",
	"browser-launch",
	"module-loading",
	"socket-path",
	"filesystem",
	"connection",
	"driver-exit",
	"unknown",
];

/** Return fixed labels only. Original error messages and paths stay private. */
export function installedFailureCategory(error) {
	try {
		const message =
			typeof error?.message === "string" ? error.message.slice(0, 4000) : "";
		if (
			error?.code === "INSTALLED_SOCKET_PATH_TOO_LONG" ||
			/Socket path too long:/.test(message)
		)
			return "socket-path";
		if (
			error?.code === "COMMAND_TIMEOUT" ||
			error?.name === "TimeoutError" ||
			/\bTimeout \d+ms exceeded\b/.test(message)
		)
			return "timeout";
		if (
			/browserType\.launch|Executable doesn't exist|chrome_crashpad_handler|Host system is missing dependencies/.test(
				message,
			)
		)
			return "browser-launch";
		if (
			["ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION"].includes(
				error?.code,
			) ||
			error?.name === "SyntaxError"
		)
			return "module-loading";
		if (["ENOENT", "EACCES", "EEXIST", "ENOTDIR"].includes(error?.code))
			return "filesystem";
		if (
			["ECONNREFUSED", "ECONNRESET"].includes(error?.code) ||
			message === "fetch failed"
		)
			return "connection";
		if (
			error?.code === "ERR_ASSERTION" ||
			error?.name === "AssertionError" ||
			error?.matcherResult
		)
			return "assertion";
	} catch {}
	return "unknown";
}

const diagnosticPrefix = "BITOVP_INSTALLED_DIAGNOSTIC ";
export function installedDriverDiagnostic(log) {
	let last;
	for (const line of String(log).slice(-65536).split("\n")) {
		if (!line.startsWith(diagnosticPrefix) || line.length > 256) continue;
		try {
			const value = JSON.parse(line.slice(diagnosticPrefix.length));
			if (
				installedDiagnosticSteps.includes(value?.step) &&
				installedDiagnosticCategories.includes(value?.category)
			)
				last = { step: value.step, category: value.category };
		} catch {}
	}
	return last;
}

export const linuxSocketPathBytes = (temporary) =>
	Buffer.byteLength(
		join(temporary, "org.chromium.Chromium.XXXXXX", "SingletonSocket"),
	);

function installedBrowserOptions(baseURL, temporary) {
	return {
		channel: "chromium",
		headless: true,
		baseURL,
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		serviceWorkers: "block",
		timeout: 15_000,
		args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
			TMPDIR: temporary,
			NO_COLOR: "1",
		},
	};
}

/** Both the pre-image qualification and installed case use these exact options. */
export function launchInstalledBrowser(profile, baseURL, browserType) {
	const directory = dirname(profile);
	registrations({ directory, id: privateFile(join(directory, ".owner")) });
	assert(
		basename(profile).startsWith("bombadil-profile-") &&
			realpathSync(profile) === profile &&
			lstatSync(profile).isDirectory(),
		"Invalid owned browser profile",
	);
	// Chromium's Linux singleton socket adds 45 bytes below TMPDIR. The hosted
	// nested profile produces 110 bytes (sun_path[108]); its private parent
	// produces 86 bytes. Both directories remain under the same cleanup owner.
	if (process.platform === "linux" && linuxSocketPathBytes(directory) >= 108)
		throw Object.assign(
			new Error("Owned browser temporary path exceeds Linux socket limit"),
			{ code: "INSTALLED_SOCKET_PATH_TOO_LONG" },
		);
	const browser =
		browserType ??
		createRequire(join(root, "apps/web/package.json"))("@playwright/test")
			.chromium;
	return browser.launchPersistentContext(
		profile,
		installedBrowserOptions(baseURL, directory),
	);
}

export async function installedBrowserConnection(context, profile, origin) {
	assert.equal(
		context.pages().length,
		1,
		"Dedicated browser page census changed",
	);
	const port = Number(
		(await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
			"\n",
		)[0],
	);
	assert(
		Number.isSafeInteger(port) && port > 0 && port <= 65535,
		"Owned CDP port missing",
	);
	const endpoint = `http://127.0.0.1:${port}`;
	await oneTarget(endpoint, origin);
	const session = await context.newCDPSession(context.pages()[0]);
	try {
		const browserVersion = (await session.send("Browser.getVersion")).product;
		assert(
			/^Chrom(?:e|ium)\/\d+(?:\.\d+){1,3}$/.test(browserVersion),
			"Unexpected browser version",
		);
		return { endpoint, browserVersion };
	} finally {
		await session.detach();
	}
}

/** Fixed, synthetic, no-auth qualification before building the installed images. */
export async function preflightInstalledBrowser() {
	const directory = realpathSync(
		await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "bitovp-gui-")),
	);
	await writeFile(join(directory, ".owner"), randomBytes(16).toString("hex"), {
		mode: 0o600,
		flag: "wx",
	});
	const profile = await mkdtemp(join(directory, "bombadil-profile-"));
	let context,
		step = "browser-launch",
		originRequests = 0;
	const server = createServer((_request, response) => {
		originRequests++;
		response.writeHead(599).end();
	});
	try {
		await new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		const baseURL = `http://localhost:${server.address().port}`;
		const origin = `${baseURL}/vod/new`;
		if (process.platform === "linux") {
			step = "socket-negative";
			const negative = await mkdtemp(join(directory, "bombadil-profile-"));
			// RUNNER_TEMP gives the exact hosted failure shape. A shorter local
			// root is extended inside this owned fixture to hit the same boundary.
			const deep =
				linuxSocketPathBytes(negative) >= 108
					? negative
					: join(negative, "socket-path-negative".repeat(3));
			await mkdir(deep, { recursive: true, mode: 0o700 });
			let refused;
			try {
				const browser = createRequire(join(root, "apps/web/package.json"))(
					"@playwright/test",
				).chromium;
				await assert.rejects(
					async () => {
						refused = await browser.launchPersistentContext(
							negative,
							installedBrowserOptions(baseURL, deep),
						);
					},
					(error) => /Socket path too long:/.test(error.message),
					"Expected Chromium's exact Linux socket-path refusal",
				);
			} finally {
				await refused?.close();
				await rm(negative, { recursive: true, force: true });
			}
		}
		step = "browser-launch";
		context = await launchInstalledBrowser(profile, baseURL);
		step = "network-guard";
		let blocked = 0;
		await context.route("**/*", (route) => {
			if (
				route.request().url() !== origin ||
				route.request().method() !== "GET"
			) {
				blocked++;
				return route.abort();
			}
			return route.fulfill({
				contentType: "text/html",
				body: '<!doctype html><title>Owned preflight</title><link rel="icon" href="data:,"><p data-testid="owned">ready</p>',
			});
		});
		assert.equal(context.pages().length, 1);
		step = "navigate";
		await context.pages()[0].goto(origin, { timeout: 10_000 });
		assert.equal(
			await context
				.pages()[0]
				.getByTestId("owned")
				.textContent({ timeout: 5000 }),
			"ready",
		);
		step = "cdp";
		await installedBrowserConnection(context, profile, origin);
		assert.equal(originRequests, 0);
		assert.equal(blocked, 0);
		return {
			status: "passed",
			pageTargets: 1,
			originRequests: 0,
			cdpVerified: true,
			socketPathNegative:
				process.platform === "linux" ? "rejected" : "not-applicable",
		};
	} catch (error) {
		throw Object.assign(new Error("Installed browser preflight failed"), {
			installedDiagnostic: { step, category: installedFailureCategory(error) },
		});
	} finally {
		try {
			await context?.close();
		} finally {
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
			await rm(directory, { recursive: true, force: true });
		}
	}
}

export function launchInstalledTool(binary, args, env) {
	return spawn(binary, args, {
		cwd: root,
		env,
		// The Playwright wrapper owns the driver's process group. Keep the tool
		// inside it so the outer timeout also catches it after a driver failure.
		detached: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

const stages = ["current", "negative", "replay"];
const registrationCode = `
import {spawn} from 'node:child_process';
import {registerInstalledGroup} from ${JSON.stringify(pathToFileURL(join(root, "scripts/bombadil-installed.mjs")).href)};
registerInstalledGroup(JSON.parse(process.argv[2]), process.ppid);
const child=spawn(process.execPath,process.argv.slice(4),{stdio:'inherit',detached:false});
child.once('error',()=>{process.exitCode=1;});
child.once('close',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function privateFile(path) {
	const stat = lstatSync(path);
	assert(
		stat.isFile() &&
			stat.nlink === 1 &&
			!(stat.mode & 0o077) &&
			stat.size <= 4096,
		"Invalid private driver receipt",
	);
	return readFileSync(path, "utf8");
}
function registrations(state, create = false) {
	assert(
		/^[a-f0-9]{32}$/.test(state.id) &&
			basename(state.directory).startsWith("bitovp-gui-"),
	);
	const stat = lstatSync(state.directory);
	assert(
		stat.isDirectory() &&
			!(stat.mode & 0o077) &&
			realpathSync(state.directory) === state.directory,
		"Invalid installed fixture directory",
	);
	assert.equal(
		privateFile(join(state.directory, ".owner")),
		state.id,
		"Installed fixture ownership differs",
	);
	const directory = join(state.directory, "bombadil-drivers");
	if (create && !existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
	if (existsSync(directory)) {
		const value = lstatSync(directory);
		assert(
			value.isDirectory() &&
				!(value.mode & 0o077) &&
				realpathSync(directory) === directory,
			"Invalid driver registration directory",
		);
	}
	return directory;
}

/** Inspect one known Linux PID with the same birth identity on both sides of cmdline. */
export function linuxInstalledProcessIdentity(pid, read = readFileSync) {
	assert(Number.isSafeInteger(pid) && pid > 1);
	const readStat = () => {
		const stat = read(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const group = Number(fields[2]);
		const ticks = fields[19];
		assert(
			stat.startsWith(`${pid} (`) &&
				Number.isSafeInteger(group) &&
				group > 0 &&
				typeof ticks === "string" &&
				/^\d+$/.test(ticks),
			"Invalid Linux process identity",
		);
		return { state: fields[0], group, ticks };
	};
	const dead = ({ state }) => state === "Z" || state === "X";
	let after, command;
	try {
		const before = readStat();
		if (dead(before)) return null;
		command = read(`/proc/${pid}/cmdline`, "utf8");
		after = readStat();
		assert(
			before.ticks === after.ticks && before.group === after.group,
			"Process identity changed while reading cmdline",
		);
		if (dead(after)) return null;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	const boot = read("/proc/sys/kernel/random/boot_id", "utf8").trim();
	assert(boot, "Linux boot identity unavailable");
	return {
		group: after.group,
		start: `${boot}:${after.ticks}`,
		command: command ? command.split("\0") : [],
	};
}

/** Inspect one known PID only. */
export function installedProcessIdentity(pid) {
	assert(Number.isSafeInteger(pid) && pid > 1);
	if (process.platform === "linux") return linuxInstalledProcessIdentity(pid);
	try {
		// The hosted fixture is Linux-only. This bounded PID-specific branch lets
		// the same real-process ownership regressions run on a developer's Mac.
		const text = execFileSync(
			"ps",
			[
				"-ww",
				"-p",
				String(pid),
				"-o",
				"pgid=",
				"-o",
				"lstart=",
				"-o",
				"command=",
			],
			{ encoding: "utf8", timeout: 1000 },
		);
		const match = /^\s*(\d+)\s+(.{24})\s+([\s\S]*)$/.exec(text);
		assert(match, "Owned process identity unavailable");
		return {
			group: Number(match[1]),
			start: match[2],
			command: match[3].replace(/\\([0-7]{3})/g, (_match, digits) =>
				String.fromCharCode(Number.parseInt(digits, 8)),
			),
		};
	} catch (error) {
		if (error.code === "ENOENT" || error.status === 1) return null;
		throw error;
	}
}
const contains = (identity, value) => identity.command.includes(value);

export async function installedCleanupIdentity(
	record,
	inspect = installedProcessIdentity,
) {
	const deadline = performance.now() + 3000;
	for (;;) {
		const identity = inspect(record.pid);
		if (!identity) return null;
		assert(
			identity.start === record.start && identity.group === record.pid,
			"Stale or foreign installed driver identity",
		);
		if (!Array.isArray(identity.command) || identity.command.length > 0) {
			assert(
				contains(identity, record.marker) &&
					contains(identity, OWNER_GUARD) &&
					contains(identity, registrationCode),
				"Stale or foreign installed driver identity",
			);
			return identity;
		}
		// Linux can clear the command line before publishing zombie state.
		// A matching start and group identify a candidate, not permission to signal.
		assert(
			performance.now() < deadline,
			"Installed driver identity unavailable; retaining private fixture",
		);
		await pause(20);
	}
}

export function registerInstalledGroup(state, pid) {
	const directory = registrations(state);
	assert(stages.includes(state.stage));
	const receipt = join(directory, `${state.stage}.json`);
	assert.equal(
		JSON.parse(privateFile(receipt)).marker,
		state.marker,
		"Installed launch registration changed",
	);
	const identity = installedProcessIdentity(pid);
	assert(
		identity?.group === pid &&
			contains(identity, state.marker) &&
			contains(identity, OWNER_GUARD) &&
			contains(identity, registrationCode),
		"Foreign installed driver group",
	);
	writeFileSync(
		join(directory, `${state.stage}.next`),
		JSON.stringify({
			id: state.id,
			stage: state.stage,
			marker: state.marker,
			pid,
			start: identity.start,
		}),
		{ mode: 0o600, flag: "wx" },
	);
	renameSync(join(directory, `${state.stage}.next`), receipt);
	// If cleanup won before or during publication, never start the real driver.
	assert(
		!existsSync(join(directory, ".closed")),
		"Installed fixture cleanup has started",
	);
}

/** Runs before the outer fixture can remove profiles, even after a worker was killed. */
export async function cleanupInstalledDrivers(state) {
	const directory = registrations(state);
	if (!existsSync(directory)) return;
	const closed = join(directory, ".closed");
	if (!existsSync(closed))
		writeFileSync(closed, state.id, { mode: 0o600, flag: "wx" });
	assert.equal(
		privateFile(closed),
		state.id,
		"Driver cleanup ownership differs",
	);
	const files = readdirSync(directory).filter((name) => name !== ".closed");
	assert(
		files.length <= 6 &&
			files.every((name) =>
				stages.some(
					(stage) => name === `${stage}.json` || name === `${stage}.next`,
				),
			),
		"Unexpected installed driver receipt",
	);
	for (const name of files.filter((name) => name.endsWith(".next"))) {
		privateFile(join(directory, name));
		assert(
			files.includes(name.replace(/\.next$/, ".json")),
			"Unbound driver publication",
		);
	}
	const names = files.filter((name) => name.endsWith(".json"));
	const records = [];
	for (const name of names) {
		const path = join(directory, name);
		const deadline = Date.now() + 3000;
		let record;
		for (;;) {
			if (!existsSync(path)) break;
			record = JSON.parse(privateFile(path));
			if (record.pid !== null) break;
			assert(
				Date.now() < deadline,
				"Installed driver registration unconfirmed; retaining private fixture",
			);
			await pause(20);
		}
		if (!record || !existsSync(path)) continue;
		assert(
			record.id === state.id &&
				name === `${record.stage}.json` &&
				stages.includes(record.stage),
			"Foreign installed driver receipt",
		);
		assert(
			new RegExp(
				`^--bitovp-installed-owner=${state.id}:${record.stage}:[a-f0-9]{32}$`,
			).test(record.marker),
			"Invalid installed driver marker",
		);
		assert(
			Number.isSafeInteger(record.pid) &&
				record.pid > 1 &&
				typeof record.start === "string" &&
				record.start.length > 0,
			"Invalid installed driver identity",
		);
		await installedCleanupIdentity(record);
		records.push(record);
	}
	for (const record of records) {
		const identity = await installedCleanupIdentity(record);
		if (identity) {
			try {
				process.kill(-record.pid, "SIGKILL");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
		}
		const deadline = Date.now() + 3000;
		while (groupExists(record.pid) && Date.now() < deadline) await pause(20);
		assert(
			!groupExists(record.pid),
			"Installed driver termination remains unconfirmed; retaining private fixture",
		);
	}
}

export async function executeInstalledDriver(
	args,
	output,
	temporary,
	options = {},
) {
	const directory = dirname(temporary);
	const state = {
		directory,
		id: privateFile(join(directory, ".owner")),
		stage: args.find((arg) => arg.startsWith("--stage="))?.slice(8),
	};
	assert(
		stages.includes(state.stage) &&
			basename(temporary).startsWith("bombadil-profile-") &&
			realpathSync(temporary) === temporary,
	);
	const records = registrations(state, true);
	assert(
		!existsSync(join(records, ".closed")),
		"Installed fixture cleanup has started",
	);
	const marker = `--bitovp-installed-owner=${state.id}:${state.stage}:${randomBytes(16).toString("hex")}`;
	const scratch = await mkdtemp(join(output, ".driver-"));
	// Publish intent before spawn: cleanup cannot miss a group born while its
	// parent is being killed. An unresolved publication fails closed.
	writeFileSync(
		join(records, `${state.stage}.json`),
		JSON.stringify({
			id: state.id,
			stage: state.stage,
			marker,
			pid: null,
			start: null,
		}),
		{ mode: 0o600, flag: "wx" },
	);
	let log = "",
		group,
		problem;
	try {
		const code = await guardedCommand(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				registrationCode,
				process.execPath,
				JSON.stringify({ ...state, marker }),
				marker,
				options.script ?? join(root, "scripts/bombadil-installed.mjs"),
				...args,
			],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					LANG: "en_US.UTF-8",
					TMPDIR: temporary,
					NO_COLOR: "1",
				},
				exitPath: join(scratch, "exit.json"),
				timeout: options.timeout ?? 55_000,
				diagnostics: (text) => {
					log = (log + text).slice(-65536);
				},
				onSpawn: (pid) => {
					group = pid;
					options.onSpawn?.(pid);
				},
			},
		);
		assert.equal(
			code,
			0,
			"Installed Bombadil trace validation failed; see private runner.log",
		);
	} catch (error) {
		problem = error;
	}
	const cleanupConfirmed = !group || !groupExists(group);
	try {
		if (cleanupConfirmed) {
			const receipt = join(records, `${state.stage}.json`);
			if (existsSync(receipt)) {
				assert.equal(
					JSON.parse(privateFile(receipt)).marker,
					marker,
					"Installed driver receipt changed",
				);
				unlinkSync(receipt);
			}
			await rm(scratch, { recursive: true, force: true });
		}
		await writeFile(join(output, "runner.log"), log, { mode: 0o600 });
	} catch (error) {
		problem ??= error;
	}
	if (!cleanupConfirmed)
		problem = new Error("Installed driver termination remains unconfirmed");
	if (problem)
		throw Object.assign(problem, {
			cleanupConfirmed,
			installedDiagnostic: installedDriverDiagnostic(log),
		});
}

export function acceptInstalledTrace(entries, negative = false) {
	assert(
		Array.isArray(entries) && entries.length > 0,
		"Installed trace is empty",
	);
	const names = new Set();
	const models = entries.map((entry) => {
		assert(Array.isArray(entry.violations ?? []), "Malformed violations");
		for (const violation of entry.violations ?? []) {
			assert(
				typeof violation?.name === "string" && violation.name,
				"Malformed violation",
			);
			names.add(violation.name);
		}
		const snapshots = (entry.snapshots ?? []).filter(
			(value) => value.name === "state",
		);
		assert.equal(
			snapshots.length,
			1,
			"Installed state snapshot missing or duplicated",
		);
		const model = snapshots[0].value;
		assert.equal(model?.ready, true, "Installed wizard readiness lost");
		for (const rows of [model.expected, model.actual, model.serialized])
			assert(
				Array.isArray(rows) &&
					rows.length > 0 &&
					rows.every(
						(row) =>
							Number.isFinite(row?.height) &&
							row.height > 0 &&
							Number.isFinite(row?.bitrate) &&
							row.bitrate > 0,
					),
				"Malformed installed rows",
			);
		for (const name of actionClasses)
			assert(
				Number.isInteger(model.counts?.[name]) && model.counts[name] >= 0,
				"Malformed action count",
			);
		assert(
			Number.isInteger(model.faults) && model.faults >= 0,
			"Malformed fault count",
		);
		assert(
			Number.isInteger(model.actualSelected) && model.actualSelected >= 0,
			"Malformed actual selection",
		);
		if (model.selected != null) {
			assert(
				Number.isInteger(model.selected) && model.selected > 0,
				"Malformed intended selection",
			);
			assert.equal(
				model.actualSelected,
				model.selected,
				"Visible copy selection differs from intent",
			);
		}
		if (model.counts.edit > 0)
			assert.deepEqual(
				model.guarded,
				{ mutation: true, external: true },
				"Browser network guard was not observed",
			);
		if (!negative) {
			assert.deepEqual(
				model.actual,
				model.expected,
				"Visible ladder differs from intent",
			);
			assert.deepEqual(
				model.serialized,
				model.expected,
				"Serialized ladder differs from intent",
			);
		}
		return model;
	});
	const actions = entries.filter((entry) => entry.action != null).length;
	const last = models.at(-1);
	const violationNames = [...names].sort();
	if (negative) {
		assert.deepEqual(
			violationNames,
			[negativeProperty],
			"Negative control failed for an unintended reason",
		);
		assert(
			actions > 0 && last.counts.add > 0,
			"Negative control performed no Add action",
		);
		assert.equal(
			last.faults,
			1,
			"Negative control did not inject its fault exactly once",
		);
		assert(
			!isDeepStrictEqual(last.actual, last.expected),
			"Negative control recorded no visible copy mismatch",
		);
	} else {
		assert.deepEqual(violationNames, [], "Installed property violation");
		assert(actions >= 20, "Fewer than 20 actual installed Bombadil actions");
		for (const name of actionClasses)
			assert(last.counts[name] > 0, `Unreached installed action: ${name}`);
		assert.equal(last.faults, 0, "Positive exploration injected a fault");
	}
	return { states: entries.length, actions, violationNames, last };
}

async function oneTarget(endpoint, origin) {
	const response = await fetch(`${endpoint}/json/list`, {
		signal: AbortSignal.timeout(3000),
	});
	assert(response.ok, "Owned CDP target census failed");
	const targets = (await response.json()).filter(
		(target) => target.type === "page",
	);
	assert.equal(
		targets.length,
		1,
		"Bombadil requires exactly one owned page target",
	);
	assert.equal(
		targets[0].url,
		origin,
		"Owned page is not the prepared installed wizard",
	);
	return targets[0].id;
}

let driverStep = "driver-arguments";
async function main() {
	process.umask(0o077);
	const options = Object.fromEntries(
		process.argv.slice(2).map((arg) => {
			const match =
				/^--(binary|endpoint|origin|output|stage|reproduce)=(.+)$/.exec(arg);
			assert(match, "Unknown installed Bombadil argument");
			return [match[1], match[2]];
		}),
	);
	assert(["current", "negative", "replay"].includes(options.stage));
	assert(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(options.endpoint));
	assert(/^http:\/\/localhost:[1-9]\d*\/vod\/new$/.test(options.origin));
	assert(options.binary && options.output);
	driverStep = "driver-binary";
	const toolSha256 = digest(await readFile(options.binary));
	assert.equal(
		toolSha256,
		binaryHashes[`${process.platform}-${process.arch}`],
		"Unexpected Bombadil binary hash",
	);
	driverStep = "driver-target";
	const before = await oneTarget(options.endpoint, options.origin);
	driverStep = "driver-specification";
	await mkdir(options.output, { mode: 0o700 });
	const pinnedSpec = join(options.output, "specification.ts");
	const specBytes = await readFile(specification);
	await writeFile(pinnedSpec, specBytes, { mode: 0o600, flag: "wx" });
	await writeFile(
		join(options.output, "installed-wizard-model.ts"),
		await readFile(join(root, "tests/bombadil/installed-wizard-model.ts")),
		{ mode: 0o600, flag: "wx" },
	);
	const args = [
		"browser",
		"test-external",
		"--remote-debugger",
		options.endpoint,
		"--width",
		"1440",
		"--height",
		"1000",
		"--output-path",
		join(options.output, "trace"),
		...(options.stage === "replay"
			? ["--reproduce", options.reproduce]
			: ["--time-limit", "30s", "--exit-on-violation"]),
		options.origin,
		pinnedSpec,
	];
	assert(
		options.stage !== "replay" || options.reproduce,
		"Replay trace is required",
	);
	driverStep = "driver-execution";
	const child = launchInstalledTool(
		options.binary,
		args,
		childEnvironment(options.output),
	);
	const closed = new Promise((done) => child.once("close", done));
	let log = "";
	let timedOut = false;
	let interrupted = false;
	child.stdout.on("data", (chunk) => {
		log += chunk;
	});
	child.stderr.on("data", (chunk) => {
		log += chunk;
	});
	const interrupt = () => {
		interrupted = true;
		child.kill("SIGKILL");
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	const started = performance.now();
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, 45_000);
	try {
		await new Promise((done, reject) => {
			child.once("close", done);
			child.once("error", reject);
		});
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		child.kill("SIGKILL");
		await closed;
		await writeFile(join(options.output, "bombadil.log"), log, { mode: 0o600 });
	}
	assert(
		!timedOut && !interrupted,
		"Installed Bombadil did not complete within its budget",
	);
	driverStep = "driver-target";
	assert.equal(
		await oneTarget(options.endpoint, options.origin),
		before,
		"Bombadil changed its owned target",
	);
	driverStep = "driver-trace";
	const traceBytes = await readFile(join(options.output, "trace/trace.jsonl"));
	const entries = traceBytes
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const result = {
		stage: options.stage,
		sourceRevision: sourceRevision(root),
		toolSha256,
		specificationSha256: digest(specBytes),
		lockSha256: digest(await readFile(join(root, "pnpm-lock.yaml"))),
		traceSha256: digest(traceBytes),
		exitCode: child.exitCode,
		elapsedMs: Math.round(performance.now() - started),
		...acceptInstalledTrace(entries, options.stage !== "current"),
	};
	driverStep = "driver-summary";
	await writeFile(
		join(options.output, "summary.json"),
		`${JSON.stringify(result, null, 2)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	assert.equal(
		child.exitCode,
		options.stage === "current" ? 0 : 2,
		"Unexpected Bombadil exit code",
	);
	if (options.stage === "replay") assert.match(log, /Reproduction finished/);
	console.log(JSON.stringify({ ...result, last: undefined }));
}

if (isEntryPoint(import.meta.url)) {
	if (process.argv[2] === "--preflight") {
		try {
			assert.equal(
				process.argv.length,
				3,
				"Unknown installed preflight argument",
			);
			console.log(JSON.stringify(await preflightInstalledBrowser()));
		} catch (error) {
			const diagnostic = error.installedDiagnostic ?? {
				step: "configuration",
				category: installedFailureCategory(error),
			};
			console.error(
				`Installed Bombadil preflight: stage=${diagnostic.step}; category=${diagnostic.category}`,
			);
			process.exitCode = 1;
		}
	} else {
		try {
			await main();
		} catch (error) {
			console.error(
				diagnosticPrefix +
					JSON.stringify({
						step: driverStep,
						category: installedFailureCategory(error),
					}),
			);
			throw error;
		}
	}
}
