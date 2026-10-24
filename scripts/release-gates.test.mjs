import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	COMMANDS,
	childEnvironment,
	preflight,
	runGates,
} from "./release-gates.mjs";

test("review Biome guard rejects zero processed files even with exit zero and preserves failures", () => {
	const root = mkdtempSync(join(tmpdir(), "review-biome-test-"));
	const wrapper = new URL("./review-worktree.sh", import.meta.url).pathname;
	const biome = new URL("../node_modules/.bin/biome", import.meta.url).pathname;
	try {
		mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
		symlinkSync(biome, join(root, "node_modules/.bin/biome"));
		symlinkSync(
			new URL("../node_modules/@biomejs", import.meta.url).pathname,
			join(root, "node_modules/@biomejs"),
		);
		// pnpm's executable shim resolves its package through the virtual store.
		symlinkSync(
			new URL("../node_modules/.pnpm", import.meta.url).pathname,
			join(root, "node_modules/.pnpm"),
		);
		writeFileSync(join(root, "good.json"), "{}\n");
		const args = ["--no-errors-on-unmatched", "missing.ts"];
		const vacuous = spawnSync(biome, ["check", ...args], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(vacuous.status, 0);
		assert.match(vacuous.stdout, /Checked 0 files/);
		const run = (...paths) =>
			spawnSync("bash", [wrapper, "--check", ...paths], {
				cwd: root,
				encoding: "utf8",
			});
		const rejected = run(...args);
		assert.equal(rejected.status, 1);
		assert.match(rejected.stderr, /processed file population/);
		const passed = run("good.json");
		assert.equal(passed.status, 0, passed.stdout + passed.stderr);
		assert.match(passed.stdout, /Checked 1 file/);
		writeFileSync(join(root, "bad.json"), "{invalid}");
		const bad = run("bad.json");
		assert.notEqual(bad.status, 0);
		assert.match(bad.stdout + bad.stderr, /parse/);
		// A tool failure must retain its own status even if its output says zero.
		rmSync(join(root, "node_modules/.bin/biome"));
		writeFileSync(
			join(root, "node_modules/.bin/biome"),
			'#!/bin/sh\nprintf "Checked 0 files\\n"\nexit 17\n',
			{ mode: 0o755 },
		);
		assert.equal(run().status, 17);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "release-gates-test-"));
	execFileSync("git", ["init", "-q", root]);
	writeFileSync(join(root, "source.txt"), "original");
	execFileSync("git", ["-C", root, "add", "source.txt"]);
	execFileSync("git", [
		"-C",
		root,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const output = join(
		mkdtempSync(join(tmpdir(), "release-gates-output-")),
		"evidence",
	);
	return { root, sha, output };
};

test("fixed local gates include API freshness and the runner tests, never deploy/paid commands", () => {
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url)),
	);
	assert(COMMANDS.some((c) => c.join(" ") === "pnpm test"));
	assert.equal(
		pkg.scripts.test,
		"turbo run test && pnpm test:api-coverage && pnpm test:release-gates && pnpm test:postgres-runner",
	);
	assert.equal(COMMANDS.length, 7);
	assert(!JSON.stringify(COMMANDS).match(/docker|verify run|deploy|gh /));
});
test("exact committed clean standalone checkout only", () => {
	const f = fixture();
	assert.equal(preflight(f.root, f.sha), f.sha);
	assert.throws(() => preflight(f.root, "a".repeat(40)), /HEAD/);
	writeFileSync(join(f.root, "source.txt"), "dirty");
	assert.throws(() => preflight(f.root, f.sha), /clean/);
});
test("untracked source and external dependency links are rejected", () => {
	const f = fixture();
	writeFileSync(join(f.root, "untracked.ts"), "untracked");
	assert.throws(() => preflight(f.root, f.sha), /clean/);
	const g = fixture();
	writeFileSync(join(g.root, ".git", "info", "exclude"), "node_modules\n");
	symlinkSync(tmpdir(), join(g.root, "node_modules"));
	assert.throws(() => preflight(g.root, g.sha), /linked/);
});
test("linked worktree is refused before any command", () => {
	const f = fixture();
	const linked = join(
		mkdtempSync(join(tmpdir(), "release-gates-linked-")),
		"tree",
	);
	execFileSync(
		"git",
		["-C", f.root, "worktree", "add", "--detach", linked, f.sha],
		{ stdio: "pipe" },
	);
	assert.throws(() => preflight(linked, f.sha), /standalone/);
});
test("failure records each completed gate and stops, without raw output or secrets", () => {
	const f = fixture();
	let calls = 0;
	const result = runGates(f, () => ({
		status: ++calls === 2 ? 7 : 0,
		signal: null,
		stdout: Buffer.from("SECRET_TEST_VALUE"),
		stderr: Buffer.from("private diagnostic"),
	}));
	assert.equal(calls, 2);
	assert.equal(result.state, "FAILED");
	const log = readFileSync(join(f.output, "gates.jsonl"), "utf8");
	assert(!log.includes("SECRET_TEST_VALUE"));
	assert(!log.includes("private diagnostic"));
	const rows = log.trim().split("\n").map(JSON.parse);
	assert.equal(rows.filter((r) => r.event === "finished").length, 2);
	assert.equal(rows.at(-1).exitCode, 7);
	assert.match(rows.at(-1).stdout.sha256, /^[a-f0-9]{64}$/);
});
test("signal, spawn error, source drift and existing output all fail closed", () => {
	for (const outcome of [
		{ status: null, signal: "SIGTERM" },
		{ status: null, error: new Error("SECRET") },
	]) {
		const f = fixture();
		assert.equal(runGates(f, () => outcome).state, "FAILED");
	}
	const f = fixture();
	let calls = 0;
	assert.equal(
		runGates(f, () => {
			calls++;
			writeFileSync(join(f.root, "source.txt"), "changed");
			return { status: 0 };
		}).state,
		"SOURCE_CHANGED",
	);
	assert.equal(calls, 1);
	const g = fixture();
	mkdirSync(g.output);
	assert.throws(
		() => runGates(g, () => assert.fail("must not execute")),
		/exist/,
	);
});
test("output cannot be inside source and complete success remains local-only", () => {
	const f = fixture();
	assert.throws(
		() => runGates({ ...f, output: join(f.root, "logs") }),
		/outside/,
	);
	const result = runGates(f, () => ({ status: 0, signal: null }));
	assert.equal(result.state, "LOCAL_GATES_PASSED");
	assert.equal(result.gates.length, 7);
	assert.equal(
		JSON.parse(readFileSync(join(f.output, "result.json"))).sha,
		f.sha,
	);
});
test("child environment excludes application secrets and unsafe Node injection", () => {
	const env = childEnvironment({
		PATH: "/safe",
		MASTER_KEY: "secret",
		NODE_OPTIONS: "--require evil",
		VERIFY_PASSWORD: "secret",
		TURBO_FORCE: "false",
	});
	assert.deepEqual(env, { PATH: "/safe", CI: "1", TURBO_FORCE: "true" });
});
test("child environment preserves the existing HOME without Compose or cloud overrides", () => {
	const env = childEnvironment({
		PATH: "/safe",
		HOME: "/fixture-home",
		COMPOSE_FILE: "/unsafe.yml",
		COMPOSE_PROFILES: "unwanted",
		DOCKER_HOST: "unsafe",
		AWS_ACCESS_KEY_ID: "secret",
		AWS_SECRET_ACCESS_KEY: "secret",
		GOOGLE_APPLICATION_CREDENTIALS: "/unsafe.json",
	});
	assert.deepEqual(env, {
		PATH: "/safe",
		HOME: "/fixture-home",
		CI: "1",
		TURBO_FORCE: "true",
	});
});
test("nightly preflight initializes diagnostics before refusal and pins build revision", () => {
	const source = readFileSync(
		new URL("../docker/verify-nightly.sh", import.meta.url),
		"utf8",
	);
	assert(
		source.indexOf("notify()") <
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion
			source.indexOf('if [ -z "${VERIFY_PASSWORD:-}" ]'),
	);
	assert(
		source.indexOf('GIT_COMMIT="$(git rev-parse HEAD)"') <
			source.indexOf("docker compose up"),
	);
	assert(source.includes("export GIT_COMMIT"));
	assert(source.includes("git status --porcelain"));
});
