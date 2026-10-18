import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../../..");
const rules = readFileSync(join(root, ".dockerignore"), "utf8")
	.split(/\r?\n/)
	.map((line) => line.trim())
	.filter((line) => line !== "" && !line.startsWith("#"));

// COPY . . includes ignored/untracked Git files too. Keep an explicit policy
// for local evidence and agent worktrees; verify real image contents at release.
describe("release Docker context", () => {
	it.each([
		".codex",
		".claude",
		"verify-runs",
		"_to_delete",
	])("excludes local-only %s without deleting the owner's originals", (directory) => {
		expect(rules).toContain(directory);
	});

	it("does not re-include private paths through a later exception", () => {
		expect(rules.filter((rule) => rule.startsWith("!"))).toEqual([
			"!.env.example",
		]);
		expect(rules).toEqual(expect.arrayContaining([".env", ".env.*"]));
	});
});

// Source contract only: an offline image-start test must still prove that the
// prepared package manager is usable as node, without a runtime download.
describe("non-root Docker package-manager cache", () => {
	it.each([
		"Dockerfile",
		"Dockerfile.web",
	])("%s prepares the pinned pnpm in a shared readable cache before dropping privileges", (file) => {
		const instructions = readFileSync(join(root, file), "utf8")
			.split(/\r?\n/)
			.filter((line) => !line.trim().startsWith("#"))
			.join("\n")
			.replace(/\\\s*\n\s*/g, " ")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const { packageManager } = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { packageManager: string };
		const pinnedPnpm = packageManager.split("+")[0];
		const cache = instructions.indexOf("ENV COREPACK_HOME=/corepack");
		const prepare = instructions.findIndex((line) =>
			line.startsWith("RUN corepack enable"),
		);
		const dropPrivileges = instructions.lastIndexOf("USER node");
		expect(cache).toBeGreaterThanOrEqual(0);
		expect(prepare).toBeGreaterThan(cache);
		expect(instructions[prepare]).toContain(
			`corepack prepare ${pinnedPnpm} --activate`,
		);
		expect(instructions[prepare]).toContain("&& chmod -R a+rX /corepack");
		expect(dropPrivileges).toBeGreaterThan(prepare);
		expect(
			instructions.filter((line) => line.startsWith("ENV COREPACK_HOME=")),
		).toEqual(["ENV COREPACK_HOME=/corepack"]);
		expect(instructions.filter((line) => line.startsWith("USER "))).toEqual([
			"USER node",
		]);
	});
});
