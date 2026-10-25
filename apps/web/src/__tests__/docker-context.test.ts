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

describe("security maintenance images", () => {
	it("pins the same patched Node 24 base by digest for Web and Worker", () => {
		const bases = ["Dockerfile", "Dockerfile.web"].map(
			(file) =>
				readFileSync(join(root, file), "utf8").match(/^FROM (\S+)$/m)?.[1],
		);
		expect(bases[0]).toMatch(
			/^node:24\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/,
		);
		expect(bases[1]).toBe(bases[0]);
		const version = bases[0]?.match(/^node:24\.(\d+)\.(\d+)-/);
		const minor = Number(version?.[1]);
		const patch = Number(version?.[2]);
		expect(minor > 22 || (minor === 22 && patch >= 1)).toBe(true);
	});

	it.each([
		"Dockerfile",
		"Dockerfile.web",
	])("%s upgrades installed OS packages before adding runtime dependencies", (file) => {
		const source = readFileSync(join(root, file), "utf8").replace(
			/\\\s*\n\s*/g,
			" ",
		);
		expect(source).toMatch(
			/RUN apt-get update\s+&& apt-get upgrade -y\s+&& apt-get install /,
		);
	});

	it("uses the same PostgreSQL and Redis security patch images in both deployments", () => {
		const images = ["docker-compose.yml", "docker-compose.customer.yml"].map(
			(file) => readFileSync(join(root, file), "utf8"),
		);
		for (const image of ["postgres:17.11-alpine", "redis:8.8.3-alpine"]) {
			const pinned = images.map((text) =>
				text
					.split("\n")
					.find((line) => line.trim().startsWith(`image: ${image}@`)),
			);
			expect(pinned[0]?.trim()).toMatch(/@sha256:[a-f0-9]{64}$/);
			expect(pinned[1]?.trim()).toBe(pinned[0]?.trim());
		}
	});

	it.each([
		"ci.yml",
		"pages.yml",
		"installed-gui.yml",
		"offline-media.yml",
	])("%s installs the committed package-manager identity with Corepack", (file) => {
		const workflow = readFileSync(
			join(root, ".github/workflows", file),
			"utf8",
		);
		const installs =
			workflow.match(/pnpm install --frozen-lockfile/g)?.length ?? 0;
		expect(workflow).not.toContain("pnpm/action-setup");
		expect(installs).toBeGreaterThan(0);
		expect(
			workflow.match(/corepack enable\n\s+corepack install\n/g)?.length,
		).toBe(installs);
		expect(
			workflow.match(/mktemp -d "\$RUNNER_TEMP\/corepack-bitovp\.XXXXXX"/g)
				?.length,
		).toBe(installs);
		expect(workflow.match(/>> "\$GITHUB_ENV"/g)?.length).toBe(installs);
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
		const pinnedPnpm = packageManager;
		expect(pinnedPnpm).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]{128}$/);
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
