import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sourceRevision } from "./source-revision.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (directory, ...args) =>
	execFileSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

function fixture(run) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-source-revision-"));
	try {
		git(directory, "init", "--quiet");
		git(directory, "config", "user.email", "fixture@example.invalid");
		git(directory, "config", "user.name", "Source archive fixture");
		mkdirSync(join(directory, "scripts"));
		copyFileSync(
			join(root, "scripts/source-revision.mjs"),
			join(directory, "scripts/source-revision.mjs"),
		);
		copyFileSync(
			join(root, "SOURCE_REVISION"),
			join(directory, "SOURCE_REVISION"),
		);
		copyFileSync(
			join(root, ".gitattributes"),
			join(directory, ".gitattributes"),
		);
		git(directory, "add", ".");
		git(directory, "commit", "--quiet", "-m", "Create source archive fixture");
		return run(directory, git(directory, "rev-parse", "HEAD"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("uses the checkout's HEAD rather than an exported revision", () => {
	fixture((directory, sha) => {
		writeFileSync(join(directory, "SOURCE_REVISION"), `${"0".repeat(40)}\n`);
		assert.equal(sourceRevision(directory), sha);
	});
});

test("supports a checkout whose .git is a worktree file", () => {
	fixture((directory, sha) => {
		const target = join(directory, "linked");
		git(directory, "worktree", "add", "--quiet", "--detach", target, sha);
		assert.equal(sourceRevision(target), sha);
	});
});

for (const format of ["tar", "zip"]) {
	test(`reads the exported revision from a real ${format} source archive`, () => {
		fixture((directory, sha) => {
			const archive = join(directory, `source.${format}`);
			git(
				directory,
				"archive",
				`--format=${format}`,
				`--output=${archive}`,
				sha,
			);
			const target = join(directory, "expanded");
			mkdirSync(target);
			if (format === "tar") execFileSync("tar", ["-xf", archive, "-C", target]);
			else execFileSync("unzip", ["-q", archive, "-d", target]);
			assert.equal(
				readFileSync(join(target, "SOURCE_REVISION"), "utf8").trim(),
				sha,
			);
			assert.equal(sourceRevision(target), sha);
			const command = execFileSync(
				process.execPath,
				[join(target, "scripts/source-revision.mjs")],
				{ cwd: directory, encoding: "utf8" },
			);
			assert.equal(command, `${sha}\n`);
		});
	});
}

test("does not discover an enclosing repository for an incomplete archive", () => {
	fixture((directory) => {
		const target = join(directory, "incomplete");
		mkdirSync(target);
		writeFileSync(join(target, "SOURCE_REVISION"), "$Format:%H$\n");
		assert.throws(() => sourceRevision(target));
	});
});

test("rejects missing, malformed, or multiple archive revisions", () => {
	fixture((directory) => {
		const target = join(directory, "invalid");
		mkdirSync(target);
		assert.throws(() => sourceRevision(target));
		for (const contents of [
			"",
			"unknown",
			"a".repeat(39),
			`${"a".repeat(40)}\nextra`,
		]) {
			writeFileSync(join(target, "SOURCE_REVISION"), contents);
			assert.throws(() => sourceRevision(target));
		}
	});
});

test("rejects a .git file pointing at another checkout", () => {
	fixture((directory) => {
		const target = join(directory, "wrong-checkout");
		mkdirSync(target);
		writeFileSync(join(target, ".git"), `gitdir: ${join(directory, ".git")}\n`);
		assert.throws(() => sourceRevision(target));
	});
});

test("ignores inherited Git location overrides", () => {
	fixture((directory, sha) => {
		const result = spawnSync(
			process.execPath,
			[join(directory, "scripts/source-revision.mjs")],
			{
				encoding: "utf8",
				env: {
					...process.env,
					GIT_DIR: join(directory, "missing"),
					GIT_WORK_TREE: root,
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${sha}\n`);
	});
});

test("the command exits unsuccessfully without printing an invalid revision", () => {
	fixture((directory) => {
		const target = join(directory, "incomplete-cli");
		mkdirSync(join(target, "scripts"), { recursive: true });
		copyFileSync(
			join(directory, "scripts/source-revision.mjs"),
			join(target, "scripts/source-revision.mjs"),
		);
		writeFileSync(join(target, "SOURCE_REVISION"), "$Format:%H$\n");
		const result = spawnSync(
			process.execPath,
			[join(target, "scripts/source-revision.mjs")],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Source revision unavailable/);
	});
});
