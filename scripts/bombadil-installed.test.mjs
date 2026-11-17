import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { acceptInstalledTrace } from "./bombadil-installed.mjs";

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
