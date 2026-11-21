import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OWNER_GUARD } from "../../scripts/semantic-controls.mjs";

export function inspectLiveSource(path) {
	const root = realpathSync(path);
	const git = (...args) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	assert.equal(git("rev-parse", "--show-toplevel"), root);
	assert.equal(
		git("rev-parse", "--abbrev-ref", "HEAD"),
		"HEAD",
		"Use a detached source worktree",
	);
	assert.equal(
		git(
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--",
			".",
			":(exclude)apps/web/next-env.d.ts",
		),
		"",
		"Use a clean source worktree",
	);
	return {
		root,
		commit: git("rev-parse", "HEAD"),
		tree: git("rev-parse", "HEAD^{tree}"),
	};
}

export function launchLiveSource(source, databaseUrl, next, exitPath) {
	const cwd = join(source.root, "apps/web");
	assert.ok(
		existsSync(next) && existsSync(join(cwd, "node_modules/next/package.json")),
		"Install the frozen dependencies in the runner and each source",
	);
	assert.ok(
		!existsSync(join(cwd, ".next")),
		"Use a fresh source worktree without a previous Next build",
	);
	for (const name of [
		".env",
		".env.local",
		".env.development",
		".env.development.local",
	]) {
		assert.ok(
			!existsSync(join(cwd, name)),
			`Remove ${name} from the disposable source worktree`,
		);
	}
	const token = randomUUID();
	const publicDirectory = join(cwd, "public");
	mkdirSync(publicDirectory, { recursive: true });
	const filename = `live-layout-source-${token}.txt`;
	const marker = join(publicDirectory, filename);
	writeFileSync(marker, token, { flag: "wx", mode: 0o600 });
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			OWNER_GUARD,
			String(process.pid),
			exitPath,
			process.execPath,
			next,
			"dev",
			"--hostname",
			"127.0.0.1",
			"--port",
			"0",
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				TMPDIR: process.env.TMPDIR ?? "/tmp",
				DATABASE_URL: databaseUrl,
				AUTH_MODE: "none",
				NEXT_TELEMETRY_DISABLED: "1",
				NO_COLOR: "1",
			},
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const record = (chunk) => {
		output = (output + chunk).slice(-65536);
	};
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", record);
	child.stderr.on("data", record);
	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Local Next server startup timed out")),
			15_000,
		);
		const finish = (error, origin) => {
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(origin);
		};
		child.stdout.on("data", () => {
			const origin = /- Local:\s+(http:\/\/127\.0\.0\.1:[1-9]\d*)/.exec(
				output,
			)?.[1];
			if (origin && /Ready in/.test(output)) finish(null, origin);
		});
		child.once("error", (error) => finish(error));
		child.once("exit", (code, signal) =>
			finish(new Error(`Local Next server exited (${code ?? signal})`)),
		);
	}).then(async (origin) => {
		const response = await fetch(new URL(filename, `${origin}/`), {
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.timeout(4_000),
		});
		assert.equal(
			response.status,
			200,
			"Local endpoint must serve this checkout's fresh marker",
		);
		assert.equal(
			await response.text(),
			token,
			"Local endpoint served a different checkout",
		);
		return origin;
	});
	const signalGroup = (signal) => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	};
	const exited = new Promise((resolve) => child.once("close", resolve));
	return {
		ready,
		alive: () =>
			child.pid && child.exitCode === null && child.signalCode === null,
		getLog: () => output,
		terminate: async () => {
			signalGroup("SIGTERM");
			const escalation = setTimeout(() => signalGroup("SIGKILL"), 1500);
			try {
				await exited;
			} finally {
				clearTimeout(escalation);
				signalGroup("SIGKILL");
				rmSync(marker, { force: true });
			}
		},
	};
}
