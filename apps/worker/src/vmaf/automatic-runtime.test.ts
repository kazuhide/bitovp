import {
	chmod,
	mkdtemp,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	createAutomaticVmafRuntime,
	createAvailableAutomaticVmafRuntime,
} from "./automatic-runtime";
import { NATIVE_OFFICIAL_REVISION } from "./native-contract";

vi.mock("./supervised-runner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./supervised-runner")>();
	return {
		...actual,
		createSupervisedVmafRunner: (
			deps: Parameters<typeof actual.createSupervisedVmafRunner>[0],
			signal?: AbortSignal,
		) =>
			actual.createSupervisedVmafRunner(
				{ ...deps, platform: "linux", readUptime: () => "100.25 99.10\n" },
				signal,
			),
	};
});

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-automatic-runtime-"));
	directories.push(directory);
	const nativePath = join(directory, "bitovp-vmaf");
	const companion = join(directory, "bitovp-vmaf-supervisor");
	const source = "a".repeat(64);
	await writeFile(nativePath, "native");
	await chmod(nativePath, 0o700);
	await writeFile(companion, "guardian");
	await chmod(companion, 0o700);
	const run = vi.fn<ProcessRunner["run"]>(async (_program, args) => ({
		code: 0,
		stderr: "",
		stdout:
			args[0] === "--version"
				? `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${source}\n`
				: args[0] === "--identity"
					? `bitovp-vmaf-supervisor-v1-clock=boottime-source=${source}\n`
					: "output",
	}));
	const evalRedis = vi.fn(async () => {
		throw new Error("Redis must not be used during compatibility preflight");
	});
	const diagnostic = vi.fn();
	return {
		directory,
		nativePath,
		companion,
		run,
		evalRedis,
		diagnostic,
		deps: {
			runner: { run, spawn: vi.fn() },
			redis: { eval: evalRedis },
			nativePath,
			ffmpegPath: "/ffmpeg",
			ffprobePath: "/ffprobe",
			workDirectory: join(directory, "work"),
			onDiagnostic: diagnostic,
		},
	};
}

it.each([
	"native",
	"companion",
] as const)("keeps the optional runtime unavailable when the %s file is missing", async (missing) => {
	const f = await fixture();
	await rm(missing === "native" ? f.nativePath : f.companion);
	expect(await createAvailableAutomaticVmafRuntime(f.deps)).toBeUndefined();
	expect(f.run).not.toHaveBeenCalled();
	expect(f.evalRedis).not.toHaveBeenCalled();
	expect(f.diagnostic).toHaveBeenCalledWith(
		expect.stringContaining("legacy execution"),
	);
});

it("rejects an incompatible companion identity without installing automatic execution", async () => {
	const f = await fixture();
	f.run.mockImplementation(async (_program, args) => ({
		code: 0,
		stderr: "",
		stdout:
			args[0] === "--version"
				? `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${"a".repeat(64)}\n`
				: `bitovp-vmaf-supervisor-v1-clock=boottime-source=${"b".repeat(64)}\n`,
	}));
	expect(await createAvailableAutomaticVmafRuntime(f.deps)).toBeUndefined();
	expect(f.run.mock.calls.map(([, args]) => args)).toEqual([
		["--version"],
		["--identity"],
	]);
	expect(f.evalRedis).not.toHaveBeenCalled();
});

it("preflights only a matching pair and reuses its pinned runner without GPU or media work", async () => {
	const f = await fixture();
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	expect(runtime).toBeDefined();
	expect(f.run.mock.calls.map(([, args]) => args)).toEqual([
		["--version"],
		["--identity"],
	]);
	expect(f.evalRedis).not.toHaveBeenCalled();
	expect((await readdir(f.directory)).sort()).toEqual([
		"bitovp-vmaf",
		"bitovp-vmaf-supervisor",
	]);
	expect(await runtime?.runner.run("/ffprobe", ["-v", "error"])).toMatchObject({
		code: 0,
		stdout: "output",
	});
	expect(f.run).toHaveBeenCalledTimes(3);
	expect(f.run.mock.calls[2]?.[1]).toEqual(
		expect.arrayContaining(["--supervise", "--", "/ffprobe", "-v", "error"]),
	);
	expect(f.diagnostic).not.toHaveBeenCalled();
});

it.each([
	"removed-companion",
	"replaced-companion",
	"replaced-native",
] as const)("fails closed after activation when the pair changes: %s", async (changed) => {
	const f = await fixture();
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	expect(runtime).toBeDefined();
	if (changed === "removed-companion") await rm(f.companion);
	else
		await writeFile(
			changed === "replaced-native" ? f.nativePath : f.companion,
			"different executable",
		);
	await expect(runtime?.runner.run("/ffmpeg", ["-version"])).rejects.toThrow();
	await expect(runtime?.runner.run("/ffmpeg", ["-version"])).rejects.toThrow();
	expect(f.run).toHaveBeenCalledTimes(2);
	expect(f.evalRedis).not.toHaveBeenCalled();
	expect(f.diagnostic).not.toHaveBeenCalled();
});

it("preserves the explicit lazy constructor for callers that require native scoring", async () => {
	const f = await fixture();
	const runtime = createAutomaticVmafRuntime(f.deps);
	expect(f.run).not.toHaveBeenCalled();
	expect(await runtime.runner.run("/ffprobe", [])).toMatchObject({ code: 0 });
	expect(f.run.mock.calls.map(([, args]) => args[0])).toEqual([
		"--version",
		"--identity",
		"--supervise",
	]);
});

it("pins native invocations to the executable resolved during activation", async () => {
	const f = await fixture();
	const alias = join(f.directory, "native-alias");
	await symlink(f.nativePath, alias);
	const runtime = await createAvailableAutomaticVmafRuntime({
		...f.deps,
		nativePath: alias,
	});
	expect(runtime).toBeDefined();
	await runtime?.runner.run(alias, ["--version"]);
	const args = f.run.mock.calls[2]?.[1] ?? [];
	expect(args.slice(args.indexOf("--") + 1)).toEqual([
		await realpath(f.nativePath),
		"--version",
	]);
});

it("rejects a switched configured alias while its original native pair remains intact", async () => {
	const f = await fixture();
	const alias = join(f.directory, "native-alias");
	const replacement = join(f.directory, "replacement");
	await writeFile(replacement, "another executable");
	await chmod(replacement, 0o700);
	await symlink(f.nativePath, alias);
	const runtime = await createAvailableAutomaticVmafRuntime({
		...f.deps,
		nativePath: alias,
	});
	expect(runtime).toBeDefined();
	await rm(alias);
	await symlink(replacement, alias);
	await expect(runtime?.runner.run(alias, ["--version"])).rejects.toThrow(
		"VMAF_SUPERVISOR_BUILD_CHANGED",
	);
	expect(f.run).toHaveBeenCalledTimes(2);
});
