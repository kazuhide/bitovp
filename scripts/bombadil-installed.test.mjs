import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	acceptInstalledTrace,
	cleanupInstalledDrivers,
	executeInstalledDriver,
	installedBrowserConnection,
	installedDriverDiagnostic,
	installedFailureCategory,
	installedProcessIdentity,
	launchInstalledBrowser,
	linuxSocketPathBytes,
} from "./bombadil-installed.mjs";
import { cleanupFixture } from "./installed-gui-smoke.mjs";

test("installed browser qualification and actual adapter share the bounded launcher before image build", async () => {
	let observed;
	const expectedContext = {};
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "bitovp-gui-")),
	);
	await writeFile(join(directory, ".owner"), "a".repeat(32), { mode: 0o600 });
	const profile = await mkdtemp(join(directory, "bombadil-profile-"));
	try {
		assert.equal(
			await launchInstalledBrowser(profile, "http://localhost:1234", {
				launchPersistentContext: async (profile, options) => {
					observed = { profile, options };
					return expectedContext;
				},
			}),
			expectedContext,
		);
		assert.equal(observed.profile, profile);
		assert.equal(observed.options.channel, "chromium");
		assert.equal(observed.options.headless, true);
		assert.equal(observed.options.serviceWorkers, "block");
		assert.equal(observed.options.timeout, 15000);
		assert.deepEqual(observed.options.args, [
			"--remote-debugging-port=0",
			"--remote-debugging-address=127.0.0.1",
		]);
		assert.deepEqual(Object.keys(observed.options.env).sort(), [
			"LANG",
			"NO_COLOR",
			"PATH",
			"TMPDIR",
		]);
		assert.equal(observed.options.env.TMPDIR, directory);
		const hosted = "/home/runner/work/_temp/bitovp-gui-XXXXXX";
		assert.equal(
			linuxSocketPathBytes(join(hosted, "bombadil-profile-XXXXXX")),
			110,
		);
		assert.equal(linuxSocketPathBytes(hosted), 86);
		const adapter = await readFile(
			join(import.meta.dirname, "../tests/browser/installed-bombadil.ts"),
			"utf8",
		);
		assert.match(
			adapter,
			/launchInstalledBrowser\(\s*profile,\s*baseURL,\s*chromium/,
		);
		assert.doesNotMatch(adapter, /launchPersistentContext\(/);
		assert.match(adapter, /installedBrowserConnection\(/);
		const workflow = await readFile(
			join(import.meta.dirname, "../.github/workflows/installed-gui.yml"),
			"utf8",
		);
		const qualified = workflow.indexOf(
			"run: node scripts/bombadil-installed.mjs --preflight",
		);
		assert(
			qualified > workflow.indexOf("playwright install --with-deps chromium"),
		);
		assert(
			qualified < workflow.indexOf("run: sh scripts/native-media-tools.sh"),
		);
		assert(
			qualified <
				workflow.indexOf("run: node scripts/installed-gui-smoke.mjs --ffmpeg"),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared CDP qualification rejects wrong or additional page targets and detaches its session", async () => {
	const profile = await mkdtemp(join(tmpdir(), "bitovp-cdp-contract-"));
	const origin = "http://localhost:1234/vod/new";
	let targets = [{ type: "page", id: "owned", url: origin }],
		detached = 0;
	const server = createServer((_request, response) =>
		response.end(JSON.stringify(targets)),
	);
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const port = server.address().port;
	await writeFile(
		join(profile, "DevToolsActivePort"),
		`${port}\n/private-browser-id\n`,
	);
	const context = {
		pages: () => [{}],
		newCDPSession: async () => ({
			send: async () => ({ product: "Chrome/150.0.1.2" }),
			detach: async () => {
				detached++;
			},
		}),
	};
	try {
		assert.deepEqual(
			await installedBrowserConnection(context, profile, origin),
			{
				endpoint: `http://127.0.0.1:${port}`,
				browserVersion: "Chrome/150.0.1.2",
			},
		);
		assert.equal(detached, 1);
		targets[0].url = "http://localhost:1234/login";
		await assert.rejects(
			installedBrowserConnection(context, profile, origin),
			/not the prepared installed wizard/,
		);
		targets = [
			{ type: "page", id: "owned", url: origin },
			{ type: "page", id: "extra", url: origin },
		];
		await assert.rejects(
			installedBrowserConnection(context, profile, origin),
			/exactly one owned page target/,
		);
	} finally {
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
		await rm(profile, { recursive: true, force: true });
	}
});

test("installed failure diagnostics project private errors to fixed labels and reject injected records", () => {
	for (const [error, category] of [
		[
			{
				message:
					"browserType.launchPersistentContext: Socket path too long: private-profile",
			},
			"socket-path",
		],
		[
			{
				message: "browserType.launchPersistentContext: private cookie profile",
				name: "Error",
			},
			"browser-launch",
		],
		[{ name: "TimeoutError", message: "private URL" }, "timeout"],
		[{ code: "ENOENT", message: "private credential path" }, "filesystem"],
		[{ code: "ERR_ASSERTION", message: "private value" }, "assertion"],
		[{ message: "private cookie" }, "unknown"],
	])
		assert.equal(installedFailureCategory(error), category);
	assert.deepEqual(
		installedDriverDiagnostic(
			'private logs\nBITOVP_INSTALLED_DIAGNOSTIC {"step":"driver-target","category":"assertion","private":"cookie"}\nBITOVP_INSTALLED_DIAGNOSTIC {"step":"private-path","category":"timeout"}\n',
		),
		{ step: "driver-target", category: "assertion" },
	);
	assert.equal(
		installedDriverDiagnostic(
			'BITOVP_INSTALLED_DIAGNOSTIC {"step":"driver-target","category":"private-secret"}',
		),
		undefined,
	);
	const script = join(import.meta.dirname, "bombadil-installed.mjs");
	const child = spawnSync(
		process.execPath,
		[script, "--preflight", "private-secret"],
		{ encoding: "utf8", timeout: 3000 },
	);
	assert.equal(child.status, 1);
	assert.equal(
		child.stderr.trim(),
		"Installed Bombadil preflight: stage=configuration; category=assertion",
	);
	assert.doesNotMatch(child.stdout + child.stderr, /private-secret/);
});

async function running(pid) {
	try {
		process.kill(pid, 0);
		if (process.platform === "linux") {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
		}
		return true;
	} catch (error) {
		if (["ESRCH", "ENOENT"].includes(error.code)) return false;
		throw error;
	}
}

for (const signal of ["SIGTERM", "SIGKILL", null])
	test(`outer fixture cleanup waits for installed driver and tool after ${signal ?? "a live wrapper"}`, {
		timeout: 10000,
	}, async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "bitovp-gui-")),
		);
		await writeFile(join(directory, ".owner"), "a".repeat(32), { mode: 0o600 });
		const profile = await mkdtemp(join(directory, "bombadil-profile-"));
		const output = join(directory, "output");
		await mkdir(output);
		const module = pathToFileURL(
			join(import.meta.dirname, "bombadil-installed.mjs"),
		).href;
		const leafPath = join(directory, "leaf.pid"),
			driverPath = join(directory, "driver.pid"),
			groupPath = join(directory, "group.pid");
		const script = join(directory, "fixture.mjs");
		await writeFile(
			script,
			`import {writeFileSync} from 'node:fs'; import {launchInstalledTool} from ${JSON.stringify(module)}; writeFileSync(${JSON.stringify(driverPath)},String(process.pid)); launchInstalledTool(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(leafPath)},String(process.pid));setInterval(()=>{},1000);`)}],process.env);`,
		);
		const source = `import {executeInstalledDriver} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';await executeInstalledDriver(['--stage=current'],${JSON.stringify(output)},${JSON.stringify(profile)},{script:${JSON.stringify(script)},onSpawn:pid=>writeFileSync(${JSON.stringify(groupPath)},String(pid))});`;
		const owner = spawn(
			process.execPath,
			["--input-type=module", "-e", source],
			{ stdio: "ignore" },
		);
		const closed = once(owner, "close");
		let driver, leaf, group;
		try {
			for (let count = 0; count < 100; count++) {
				try {
					[driver, leaf, group] = await Promise.all(
						[driverPath, leafPath, groupPath].map(async (path) =>
							Number(await readFile(path, "utf8")),
						),
					);
					break;
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				await pause(20);
			}
			assert(
				driver && leaf && group,
				`Synthetic installed driver/tool did not start: ${await readFile(join(output, "runner.log"), "utf8").catch(() => "log unavailable")}`,
			);
			if (signal) {
				owner.kill(signal);
				await closed;
			}
			let cleanupObserved = false;
			await cleanupFixture(
				{ id: "a".repeat(32), directory },
				async () => {
					assert.equal(
						await running(driver),
						false,
						"Outer cleanup touched files before driver termination",
					);
					assert.equal(
						await running(leaf),
						false,
						"Outer cleanup touched files before tool termination",
					);
					assert.equal(await realpath(profile), profile);
					cleanupObserved = true;
					return "";
				},
				{},
			);
			assert(cleanupObserved);
			await closed;
			assert.equal(
				await running(driver),
				false,
				"Installed driver survived its wrapper parent",
			);
			assert.equal(
				await running(leaf),
				false,
				"Bombadil child survived its wrapper parent",
			);
			await assert.rejects(realpath(profile), { code: "ENOENT" });
		} finally {
			owner.kill("SIGKILL");
			for (const pid of [group && -group, driver, leaf].filter(Boolean)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch (error) {
					assert.equal(error.code, "ESRCH");
				}
			}
			await closed;
			await rm(directory, { recursive: true, force: true });
		}
	});

test("installed driver normal exit and timeout settle before private profile cleanup", {
	timeout: 10000,
}, async () => {
	for (const mode of ["normal", "timeout"]) {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "bitovp-gui-")),
		);
		await writeFile(join(directory, ".owner"), "a".repeat(32), { mode: 0o600 });
		const profile = await mkdtemp(join(directory, "bombadil-profile-"));
		const output = join(directory, "output");
		await mkdir(output);
		const pidPath = join(directory, "pid");
		const script = join(directory, "driver.mjs");
		await writeFile(
			script,
			`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)},String(process.pid));${mode === "timeout" ? "setInterval(()=>{},1000)" : "process.exit(0)"}`,
		);
		try {
			const result = executeInstalledDriver(
				["--stage=current"],
				output,
				profile,
				{ script, timeout: mode === "timeout" ? 500 : 3000 },
			);
			if (mode === "timeout")
				await assert.rejects(
					result,
					(error) =>
						error.cleanupConfirmed === true && error.code === "COMMAND_TIMEOUT",
				);
			else await result;
			assert.equal(
				await running(Number(await readFile(pidPath, "utf8"))),
				false,
			);
			await rm(profile, { recursive: true });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("outer driver cleanup rejects foreign, stale and symlink receipts before signalling or removing files", async () => {
	for (const fault of [
		"foreign",
		"stale",
		"symlink",
		"unexpected",
		"pending",
	]) {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "bitovp-gui-")),
		);
		const id = "a".repeat(32);
		await writeFile(join(directory, ".owner"), id, { mode: 0o600 });
		const records = join(directory, "bombadil-drivers");
		await mkdir(records, { mode: 0o700 });
		const receipt = {
			id: fault === "foreign" ? "b".repeat(32) : id,
			stage: "current",
			marker: `--bitovp-installed-owner=${id}:current:${"c".repeat(32)}`,
			pid: process.pid,
			start: `${installedProcessIdentity(process.pid).start}-stale`,
		};
		if (fault === "pending") {
			receipt.pid = null;
			receipt.start = null;
		}
		const path = join(
			records,
			fault === "unexpected" ? "fourth.json" : "current.json",
		);
		if (fault === "symlink") {
			await writeFile(join(directory, "foreign"), JSON.stringify(receipt), {
				mode: 0o600,
			});
			await symlink(join(directory, "foreign"), path);
		} else await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
		try {
			await assert.rejects(cleanupInstalledDrivers({ id, directory }));
			assert.equal(await readFile(join(directory, ".owner"), "utf8"), id);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("an installed tool remains in its driver's cleanup group after the driver exits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "installed-bombadil-group-"));
	const marker = join(directory, "terminated");
	const leaf = `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "terminated"); process.exit(0); }); process.stdout.write("ready"); setInterval(() => {}, 1000);`;
	const module = pathToFileURL(
		join(import.meta.dirname, "bombadil-installed.mjs"),
	).href;
	const source = `import { launchInstalledTool } from ${JSON.stringify(module)}; const child = launchInstalledTool(process.execPath, ["-e", ${JSON.stringify(leaf)}], process.env); child.stdout.once("data", () => process.stdout.write(String(child.pid), () => process.exit(0)));`;
	const driver = spawn(
		process.execPath,
		["--input-type=module", "-e", source],
		{ detached: true, stdio: ["ignore", "pipe", "inherit"] },
	);
	let leafPid = "";
	driver.stdout.on("data", (chunk) => {
		leafPid += chunk;
	});
	const signal = (pid, value) => {
		try {
			process.kill(pid, value);
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	};
	try {
		await once(driver, "exit", { signal: AbortSignal.timeout(5000) });
		assert.equal(driver.exitCode, 0);
		assert(Number(leafPid) > 0);
		signal(-driver.pid, "SIGTERM");
		let receipt;
		for (let count = 0; count < 100; count++) {
			try {
				receipt = await readFile(marker, "utf8");
				break;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await pause(10);
		}
		assert.equal(
			receipt,
			"terminated",
			"Installed child escaped its owned cleanup group",
		);
	} finally {
		signal(-driver.pid, "SIGKILL");
		if (Number(leafPid) > 0) signal(Number(leafPid), "SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

test("a symlinked installed runner validates its arguments instead of exiting successfully", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "installed-bombadil-entry-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const alias = join(directory, "run.mjs");
	await symlink(join(import.meta.dirname, "bombadil-installed.mjs"), alias);
	const result = spawnSync(process.execPath, [alias, "--unknown"], {
		encoding: "utf8",
		timeout: 5000,
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Unknown installed Bombadil argument/);
});

const row = { height: 720, bitrate: 1_500_000 };
function trace(negative = false) {
	return Array.from({ length: negative ? 3 : 25 }, (_, index) => ({
		action: { Custom: {} },
		violations:
			negative && index === 2
				? [{ name: "configuredRenditionsMatchIntent" }]
				: [],
		snapshots: [
			{
				name: "state",
				value: {
					ready: true,
					expected: [row],
					actual: [negative && index === 2 ? { ...row, height: 360 } : row],
					serialized: [row],
					counts: { edit: 1, select: 1, add: 1, remove: 1, revisit: 1 },
					faults: negative && index === 2 ? 1 : 0,
					guarded: { mutation: true, external: true },
					selected: 1,
					actualSelected: 1,
				},
			},
		],
	}));
}
test("installed exploration requires observed UI, serialization and every action class", () => {
	assert.equal(acceptInstalledTrace(trace()).actions, 25);
	for (const mutate of [
		(entries) => entries.pop(),
		(entries) => {
			entries[2].snapshots[0].value.ready = false;
		},
		(entries) => {
			entries[2].snapshots[0].value.actual = [];
		},
		(entries) => {
			entries[2].snapshots[0].value.serialized = [];
		},
		(entries) => {
			entries.at(-1).snapshots[0].value.counts.revisit = 0;
		},
	]) {
		const entries = trace();
		mutate(entries);
		if (entries.length === 24)
			assert.equal(acceptInstalledTrace(entries).actions, 24);
		else assert.throws(() => acceptInstalledTrace(entries));
	}
	assert.throws(() => acceptInstalledTrace(trace().slice(0, 19)), /20 actual/);
	assert.throws(() => acceptInstalledTrace([]), /empty/);
});
test("negative control must detect the injected copy redirection, never an unrelated error", () => {
	const accepted = acceptInstalledTrace(trace(true), true);
	assert.deepEqual(accepted.violationNames, [
		"configuredRenditionsMatchIntent",
	]);
	for (const names of [
		[],
		["readiness"],
		["configuredRenditionsMatchIntent", "other"],
	]) {
		const entries = trace(true);
		entries.at(-1).violations = names.map((name) => ({ name }));
		assert.throws(() => acceptInstalledTrace(entries, true));
	}
	const noFault = trace(true);
	noFault.at(-1).snapshots[0].value.faults = 0;
	assert.throws(() => acceptInstalledTrace(noFault, true), /fault/);
	const noMismatch = trace(true);
	noMismatch.at(-1).snapshots[0].value.actual = [row];
	assert.throws(() => acceptInstalledTrace(noMismatch, true), /mismatch/);
});
test("retained copy selection must match intent even without a violation notification", () => {
	const entries = trace();
	entries[1].snapshots[0].value.actualSelected = 2;
	assert.throws(() => acceptInstalledTrace(entries), /selection/);
});
test("malformed and lost snapshots fail closed instead of passing vacuously", () => {
	for (const mutate of [
		(entries) => {
			entries[1].snapshots = [];
		},
		(entries) => {
			entries[1].snapshots.push(entries[1].snapshots[0]);
		},
		(entries) => {
			entries[1].violations = [null];
		},
		(entries) => {
			entries[1].snapshots[0].value.counts.edit = Number.NaN;
		},
	]) {
		const entries = trace();
		mutate(entries);
		assert.throws(() => acceptInstalledTrace(entries));
	}
});
