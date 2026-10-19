import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = join(root, ".gitleaks.toml");
const scanner = process.env.GITLEAKS_BIN ?? "gitleaks";
const runner = join(root, "scripts/secret-scan.mjs");

function fixture(run) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-secret-test-"));
	try {
		return run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function exceptions() {
	const text = readFileSync(config, "utf8");
	assert.match(text, /useDefault = true/);
	assert.doesNotMatch(text, /disabledRules|\[\[allowlists\]\]/);
	const files = execFileSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
	}).split("\0");
	return text
		.split("[[rules.allowlists]]")
		.slice(1)
		.map((block) => {
			assert.match(block, /condition = "AND"/);
			assert.match(block, /regexTarget = "line"/);
			const pathPattern = block.match(/paths = \['''(.*?)'''\]/)?.[1];
			const linePattern = block.match(/regexes = \['''(.*?)'''\]/)?.[1];
			assert.ok(pathPattern?.startsWith("^") && pathPattern.endsWith("$"));
			assert.ok(linePattern?.startsWith("^") && linePattern.endsWith("$"));
			const matched = files.filter((file) =>
				new RegExp(pathPattern).test(file),
			);
			assert.equal(
				matched.length,
				1,
				"Each exception must name one tracked file",
			);
			const path = matched[0];
			const line = readFileSync(join(root, path), "utf8")
				.split("\n")
				.find((candidate) => new RegExp(linePattern).test(candidate));
			assert.ok(line, `Exception must still describe a known fixture: ${path}`);
			return { path, line };
		});
}

function scan(directory, entries) {
	const source = join(directory, "source");
	mkdirSync(source);
	for (const [path, content] of entries) {
		const file = join(source, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	const report = join(directory, "report.json");
	const result = spawnSync(
		scanner,
		[
			"dir",
			"--config",
			config,
			"--redact=100",
			"--no-banner",
			"--ignore-gitleaks-allow",
			"--gitleaks-ignore-path",
			directory,
			"--report-format=json",
			"--report-path",
			report,
			".",
		],
		{ cwd: source, encoding: "utf8", timeout: 30_000 },
	);
	assert.ok(
		result.status === 0 || result.status === 1,
		"Scanner must complete",
	);
	return {
		...result,
		report: readFileSync(report, "utf8"),
		rows: JSON.parse(readFileSync(report, "utf8")),
	};
}

function canary() {
	return randomBytes(32).toString("hex");
}

test("accepts only the exact known synthetic and non-secret lines", () =>
	fixture((directory) => {
		const rows = exceptions();
		assert.ok(rows.length > 0);
		const files = new Map();
		for (const { path, line } of rows)
			files.set(path, `${files.get(path) ?? ""}${line}\n`);
		const result = scan(directory, files);
		assert.equal(result.status, 0);
		assert.deepEqual(result.rows, []);
	}));

for (const placement of ["next line", "same line", "changed value"]) {
	test(`detects another secret at every excepted path: ${placement}`, () =>
		fixture((directory) => {
			const rows = exceptions();
			const files = new Map();
			const secrets = [];
			const expected = [];
			for (const { path, line } of rows) {
				const secret = canary();
				secrets.push(secret);
				const added = `const secondaryApiKey = "${secret}";`;
				const content =
					placement === "next line"
						? `${line}\n${added}`
						: placement === "same line"
							? `${line} ${added}`
							: line.replace(/(["'])([^"']+)(["'])/, `"${secret}"`);
				const preceding = files.get(path) ?? "";
				expected.push({
					path,
					line:
						preceding.split("\n").length + (placement === "next line" ? 1 : 0),
				});
				files.set(path, `${preceding}${content}\n`);
			}
			const result = scan(directory, files);
			assert.equal(result.status, 1);
			for (const { path, line } of expected)
				assert.ok(
					result.rows.some(
						(row) =>
							row.File.replaceAll("\\", "/").endsWith(path) &&
							row.StartLine === line,
					),
					`Missing detection: ${path}:${line}`,
				);
			for (const secret of secrets)
				assert.ok(
					!`${result.stdout}${result.stderr}${result.report}`.includes(secret),
					"Canaries must be fully redacted",
				);
		}));
}

test("retains other scanner rules inside an excepted file", () =>
	fixture((directory) => {
		const { path, line } = exceptions()[0];
		const token = `ghp_${randomBytes(18).toString("hex")}`;
		const result = scan(directory, [
			[path, `${line}\nconst token = "${token}"; // gitleaks:allow\n`],
		]);
		assert.equal(result.status, 1);
		assert.ok(result.rows.some((row) => row.RuleID === "github-pat"));
		assert.ok(
			!`${result.stdout}${result.stderr}${result.report}`.includes(token),
		);
	}));

test("scans removed history despite repository-local ignore files and comments", () =>
	fixture((directory) => {
		const git = (...args) =>
			execFileSync("git", args, { cwd: directory, stdio: "pipe" });
		git("init", "-q");
		const commit = () => {
			git("add", ".");
			git(
				"-c",
				"user.name=Synthetic Scanner",
				"-c",
				"user.email=scanner@example.invalid",
				"commit",
				"-qm",
				"Update synthetic fixture",
			);
		};
		const secret = canary();
		writeFileSync(
			join(directory, "fixture.ts"),
			`const apiKey = "${secret}"; // gitleaks:allow\n`,
		);
		commit();
		const sha = git("rev-parse", "HEAD").toString().trim();
		writeFileSync(
			join(directory, ".gitleaksignore"),
			`${sha}:fixture.ts:generic-api-key:1\n`,
		);
		writeFileSync(
			join(directory, ".gitleaks.toml"),
			'[extend]\nuseDefault = true\ndisabledRules = ["generic-api-key"]\n',
		);
		rmSync(join(directory, "fixture.ts"));
		commit();
		const result = spawnSync(process.execPath, [runner, directory], {
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /generic-api-key/);
		assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
	}));

test("fails closed when the pinned scanner cannot run", () =>
	fixture((directory) => {
		const result = spawnSync(process.execPath, [runner, directory], {
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, GITLEAKS_BIN: join(directory, "missing-scanner") },
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /scanner/i);
	}));

test("rejects a shallow history instead of reporting a complete scan", () =>
	fixture((directory) => {
		const source = join(directory, "source");
		mkdirSync(source);
		const git = (...args) =>
			execFileSync("git", args, { cwd: source, stdio: "pipe" });
		git("init", "-q");
		for (const text of [
			"First synthetic fixture",
			"Second synthetic fixture",
		]) {
			writeFileSync(join(source, "fixture.txt"), text);
			git("add", ".");
			git(
				"-c",
				"user.name=Synthetic Scanner",
				"-c",
				"user.email=scanner@example.invalid",
				"commit",
				"-qm",
				"Update synthetic fixture",
			);
		}
		const shallow = join(directory, "shallow");
		git("clone", "--quiet", "--depth=1", `file://${source}`, shallow);
		const result = spawnSync(process.execPath, [runner, shallow], {
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /complete Git history/);
	}));

test("accepts a complete clean history", () =>
	fixture((directory) => {
		const git = (...args) =>
			execFileSync("git", args, { cwd: directory, stdio: "pipe" });
		git("init", "-q");
		writeFileSync(
			join(directory, "fixture.txt"),
			"Synthetic fixture without credentials\n",
		);
		git("add", ".");
		git(
			"-c",
			"user.name=Synthetic Scanner",
			"-c",
			"user.email=scanner@example.invalid",
			"commit",
			"-qm",
			"Add synthetic fixture",
		);
		const result = spawnSync(process.execPath, [runner, directory], {
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 0);
		assert.match(result.stdout, /Secret scan passed/);
	}));
