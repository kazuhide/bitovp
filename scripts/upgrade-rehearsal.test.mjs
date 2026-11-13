import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { upgradeOptions } from "./upgrade-rehearsal.mjs";

const root = resolve(import.meta.dirname, "..");
const wait = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function waitFor(condition, description) {
	const until = Date.now() + 5_000;
	while (!condition() && Date.now() < until) await wait(20);
	assert(condition(), description);
}
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("requires a dedicated absolute output path outside the checkout", () => {
	assert.throws(() => upgradeOptions([], "/repo"));
	assert.throws(() => upgradeOptions(["--output-directory", "results"], "/repo"));
	assert.throws(() => upgradeOptions(["--output-directory", "/repo/results"], "/repo"));
	assert.deepEqual(upgradeOptions(["--output-directory", "/private/results"], "/repo"), {
		baseRef: "v1.2.1", outputDirectory: "/private/results",
	});
});

test("rejects unrecognized or duplicated options instead of selecting a different baseline", () => {
	assert.throws(() => upgradeOptions(["--output-directory", "/private/results", "--baseline", "main"], "/repo"));
	assert.throws(() => upgradeOptions(["--output-directory", "/private/results", "--output-directory", "/other"], "/repo"));
});

for (const stage of ["work", "container startup", "cleanup"])
	for (const signal of ["SIGINT", "SIGTERM"])
	test(`the upgrade CLI handles ${signal} during ${stage} and waits for owned cleanup despite repeated signals`, { timeout: 20_000 }, async () => {
		const parent = realpathSync(mkdtempSync(join(tmpdir(), "bitovp-upgrade-signal-")));
		const bin = join(parent, "bin");
		const output = join(parent, "output");
		const statePath = join(output, "postgres-state.json");
		const marker = (name) => join(parent, name);
		mkdirSync(bin, { mode: 0o700 });
		const prelude = `#!${process.execPath}\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\nimport { join } from "node:path";\nconst parent = ${JSON.stringify(parent)};\nconst stage = ${JSON.stringify(stage)};\nconst marker = (name) => join(parent, name);\nconst state = () => JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));\n`;
		writeFileSync(join(bin, "docker"), `${prelude}
const a = process.argv.slice(2);
assert.deepEqual(a.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
const owned = state();
const name = "bitovp-postgres-" + owned.id;
switch (a[2]) {
 case "run":
  assert.equal(a[a.indexOf("--name") + 1], name);
  assert(a.includes("io.bitovp.postgres-test=" + owned.id));
  if (stage === "container startup") {
   process.on("SIGTERM", () => { fs.writeFileSync(marker("create-killed"), "killed"); process.exit(2); });
   fs.writeFileSync(marker("create-started"), String(process.pid));
   await new Promise((accept) => {
    const timer = setInterval(() => { if (fs.existsSync(marker("create-release"))) { clearInterval(timer); accept(); } }, 10);
   });
  }
  fs.writeFileSync(marker("container-live"), name);
  console.log("synthetic-owned-container");
  break;
 case "port":
  assert.equal(a[3], name);
  console.log("127.0.0.1:15432");
  break;
 case "exec":
  assert.equal(a[3], name);
  assert.equal(a[4], "pg_isready");
  break;
 case "inspect":
  assert.equal(a.at(-1), name);
  assert(fs.existsSync(marker("container-live")));
  console.log(JSON.stringify({ "io.bitovp.postgres-test": owned.id }));
  break;
 case "rm":
  assert.deepEqual(a.slice(3), ["--force", "--volumes", name]);
  process.on("SIGTERM", () => { fs.writeFileSync(marker("cleanup-killed"), "killed"); process.exit(2); });
  fs.writeFileSync(marker("cleanup-started"), String(process.pid));
  await new Promise((accept) => {
   const timer = setInterval(() => { if (fs.existsSync(marker("cleanup-release"))) { clearInterval(timer); accept(); } }, 10);
  });
  fs.unlinkSync(marker("container-live"));
  fs.writeFileSync(marker("cleanup-completed"), "removed");
  break;
 case "ps":
  assert(a.includes("name=^/" + name + "$"));
  if (fs.existsSync(marker("container-live"))) console.log(name);
  break;
 default: throw new Error("Unexpected synthetic Docker operation");
}
`, { mode: 0o700 });
		const descendant = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(marker("descendant-cancelled"))}, "cancelled"); process.exit(0); }); setInterval(() => {}, 1000); fs.writeFileSync(${JSON.stringify(marker("descendant-started"))}, String(process.pid));`;
		writeFileSync(join(bin, "pnpm"), `${prelude}
import { spawn } from "node:child_process";
const a = process.argv.slice(2);
assert.deepEqual(a.slice(0, 2), ["--filter", "@bitovp/db"]);
if (a[2] === "db:runtime:prepare") {
 const owned = state();
 const app = a[a.indexOf("--app-env") + 1];
 assert.equal(app, join(owned.directory, ".env"));
 fs.writeFileSync(app, "DATABASE_URL=postgresql://bitovp_runtime:synthetic-app-private@127.0.0.1:15432/bitovp_integration_" + owned.id + "?schema=public\\n", { mode: 0o600 });
 const nested = join(owned.directory, "tmp", "nested-private");
 fs.mkdirSync(nested, { mode: 0o700 });
 fs.writeFileSync(join(nested, ".env.migrate"), "synthetic-nested-private", { mode: 0o600 });
} else if (a[2] === "db:migrate:deploy") {
 assert(fs.existsSync(join(state().directory, ".env.migrate")));
} else {
 assert.deepEqual(a.slice(2, 5), ["exec", "tsx", "scripts/upgrade-rehearsal-fixture.ts"]);
 assert(process.env.BITOVP_TENANT_TEST_ADMIN_URL);
 assert(process.env.BITOVP_TENANT_TEST_APP_URL);
 if (stage === "cleanup") {
  console.log("BITOVP_UPGRADE_REPORT=" + JSON.stringify({ status: "passed", fixture: "synthetic" }));
  process.exit(0);
 }
 let stopped = false;
 let ended = false;
 const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
 child.on("exit", () => { ended = true; if (stopped) process.exit(0); });
 process.on("SIGTERM", () => {
  stopped = true;
  fs.writeFileSync(marker("work-cancelled"), "cancelled");
  if (ended) process.exit(0);
 });
 fs.writeFileSync(marker("work-started"), String(process.pid));
 setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
		const child = spawn(process.execPath, [join(root, "scripts/upgrade-rehearsal.mjs"), "--output-directory", output], {
			env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const completed = new Promise((accept, reject) => {
			child.once("error", reject);
			child.once("close", (code, stoppedBy) => accept({ code, signal: stoppedBy }));
		});
		try {
			await waitFor(() => stage === "work"
				? existsSync(marker("work-started")) && existsSync(marker("descendant-started"))
				: existsSync(marker(stage === "container startup" ? "create-started" : "cleanup-started")), "The interrupted fixture stage must actually start");
			const state = JSON.parse(readFileSync(statePath, "utf8"));
			const credentials = (stage === "container startup" ? ["postgres.env"] : ["postgres.env", ".env.migrate", ".env", "tmp/nested-private/.env.migrate"]).map((name) => join(state.directory, name));
			for (const file of credentials) assert(existsSync(file));
			const privateValue = stage === "container startup"
				? /^POSTGRES_PASSWORD=(.+)$/m.exec(readFileSync(join(state.directory, "postgres.env"), "utf8"))?.[1]
				: readFileSync(join(state.directory, ".env.migrate"), "utf8").trim().slice("DATABASE_URL=".length);
			assert(privateValue);
			assert(child.kill(signal));
			if (stage === "container startup") {
				await wait(100);
				assert.equal(existsSync(marker("create-killed")), false, "An in-flight Docker create must settle before cleanup checks absence");
				assert.equal(child.exitCode, null);
				assert.equal(child.signalCode, null);
				writeFileSync(marker("create-release"), "release");
			}
			await waitFor(() => existsSync(marker("cleanup-started")), "Cancellation must reach the real fixture cleanup");
			if (stage === "work") {
				assert(existsSync(marker("work-cancelled")), "The detached command must receive cancellation");
				assert(existsSync(marker("descendant-cancelled")), "The command process group must be stopped");
				const workPid = Number(readFileSync(marker("work-started"), "utf8"));
				const descendantPid = Number(readFileSync(marker("descendant-started"), "utf8"));
				await waitFor(() => !alive(workPid) && !alive(descendantPid), "Cancelled child processes must be reaped");
			}
			assert(child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT"));
			assert(child.kill(signal));
			await wait(100);
			assert.equal(child.exitCode, null, "The CLI must await held cleanup before exiting");
			assert.equal(child.signalCode, null);
			assert.equal(existsSync(marker("cleanup-killed")), false, "Repeated signals must not kill cleanup commands");
			assert(existsSync(statePath));
			for (const file of credentials) assert(existsSync(file));
			writeFileSync(marker("cleanup-release"), "release");
			await waitFor(() => child.exitCode !== null || child.signalCode !== null, "The CLI must exit after cleanup");
			assert.deepEqual(await completed, { code: 1, signal: null });
			assert(existsSync(marker("cleanup-completed")));
			assert.equal(existsSync(marker("container-live")), false);
			assert.equal(existsSync(state.directory), false);
			assert.equal(existsSync(statePath), false);
			const report = join(output, "upgrade-report.json");
			if (stage === "cleanup")
				assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { status: "pending-cleanup", fixture: "synthetic", cleanup: "pending" });
			else assert.equal(existsSync(report), false);
			assert.match(stdout, /Dedicated PostgreSQL fixture and private files removed/);
			assert.doesNotMatch(stdout, /Upgrade and rollback rehearsal passed/);
			assert.match(stderr, /cancelled/);
			assert.equal(`${stdout}${stderr}`.includes(privateValue), false);
			assert.equal(`${stdout}${stderr}`.includes("synthetic-app-private"), false);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			for (const file of ["work-started", "descendant-started", "cleanup-started", "create-started"]) {
				if (!existsSync(marker(file))) continue;
				const pid = Number(readFileSync(marker(file), "utf8"));
				assert(Number.isSafeInteger(pid) && pid > 1);
				try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ }
			}
			await completed;
			if (existsSync(statePath)) {
				const state = JSON.parse(readFileSync(statePath, "utf8"));
				assert.match(state.id, /^[a-f0-9]{32}$/);
				assert(basename(state.directory).startsWith("bitovp-postgres-"));
				assert.equal(readFileSync(join(state.directory, ".owner"), "utf8"), state.id);
				rmSync(state.directory, { recursive: true });
			}
			rmSync(parent, { recursive: true, force: true });
		}
	});
