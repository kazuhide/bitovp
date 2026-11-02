import { createHash } from "node:crypto";
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
import type { NativeDeviceInfo } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	createAutomaticVmafRuntime,
	createAvailableAutomaticVmafRuntime,
} from "./automatic-runtime";
import { resolveLocalSelection } from "./local-selection";
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

function gpuInfo(backend: "cuda" | "vulkan"): NativeDeviceInfo {
	return {
		schemaVersion: 1,
		sourceSha256: "a".repeat(64),
		binarySha256: createHash("sha256").update("native").digest("hex"),
		officialSourceRevision: NATIVE_OFFICIAL_REVISION,
		backend,
		device: {
			index: backend === "cuda" ? 2 : 3,
			name: "Example GPU",
			uuid: `${backend}-gpu`,
			vendorId: backend === "cuda" ? 0x10de : 0x1002,
			deviceId: 1,
			integrated: backend === "vulkan",
			memoryBudgetBytes: 8 * 1024 ** 3,
			memoryTotalBytes: 16 * 1024 ** 3,
			memoryAvailableBytes: 8 * 1024 ** 3,
			driverVersion: "driver1",
			driverVersionKnown: true,
			driverVersionSource: "fixture",
			memoryAvailableSource: "fixture",
			pciBusId: "0000:01:00.0",
		},
		capabilities: {
			inflightFrames: [1, 2, 4],
			cpuParity: true,
			processSupervisor: true,
			supervisorBinarySha256: createHash("sha256")
				.update("guardian")
				.digest("hex"),
		},
	};
}
async function gpuFixture(available: readonly ("cuda" | "vulkan")[]) {
	const f = await fixture();
	f.run.mockImplementation(async (_program, wrapped) => {
		const args =
			wrapped[0] === "--supervise"
				? wrapped.slice(wrapped.indexOf("--") + 2)
				: wrapped;
		if (args[0] === "--version")
			return {
				code: 0,
				stderr: "",
				stdout: `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${"a".repeat(64)}\n`,
			};
		if (args[0] === "--identity")
			return {
				code: 0,
				stderr: "",
				stdout: `bitovp-vmaf-supervisor-v1-clock=boottime-source=${"a".repeat(64)}\n`,
			};
		const backend = args[args.indexOf("--backend") + 1] as "cuda" | "vulkan";
		return available.includes(backend)
			? { code: 0, stderr: "", stdout: JSON.stringify(gpuInfo(backend)) }
			: { code: 1, stderr: "unavailable", stdout: "" };
	});
	return f;
}
it.each([
	[["cuda", "vulkan"], "cuda", 2, ["cuda"]],
	[["vulkan"], "vulkan", 3, ["cuda", "vulkan"]],
] as const)("selects the first eligible device without media or resource reservations (%s)", async (available, backend, device, inspected) => {
	const f = await gpuFixture(available);
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	const selected = await runtime?.selectLocalNative({
		signal: new AbortController().signal,
	});
	expect(selected).toEqual({
		backend,
		device,
		identity: {
			sourceSha256: "a".repeat(64),
			binarySha256: gpuInfo(backend).binarySha256,
			supervisorBinarySha256:
				gpuInfo(backend).capabilities.supervisorBinarySha256,
			deviceUuid: `${backend}-gpu`,
		},
	});
	expect(
		f.run.mock.calls
			.filter(([, args]) => args.includes("--device-info"))
			.map(([, args]) => args[args.indexOf("--backend") + 1]),
	).toEqual(inspected);
	expect(f.evalRedis).not.toHaveBeenCalled();
	expect((await readdir(f.directory)).sort()).toEqual([
		"bitovp-vmaf",
		"bitovp-vmaf-supervisor",
	]);
});
it("returns CPU only after both device queries explicitly report unavailable", async () => {
	const f = await gpuFixture([]);
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	expect(
		await runtime?.selectLocalNative({ signal: new AbortController().signal }),
	).toEqual({ backend: "cpu", reason: "GPU_NOT_AVAILABLE" });
	expect(
		f.run.mock.calls.filter(([, args]) => args.includes("--device-info")),
	).toHaveLength(2);
});
it("does not switch away from an unavailable pinned device", async () => {
	const f = await gpuFixture(["vulkan"]);
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	await expect(
		runtime?.selectLocalNative({
			signal: new AbortController().signal,
			pinned: {
				backend: "cuda",
				device: 2,
				identity: {
					sourceSha256: "a".repeat(64),
					binarySha256: "b".repeat(64),
					supervisorBinarySha256: "c".repeat(64),
					deviceUuid: "cuda-gpu",
				},
			},
		}),
	).rejects.toThrow("NATIVE_DEVICE_INFO_UNAVAILABLE");
	const calls = f.run.mock.calls.filter(([, args]) =>
		args.includes("--device-info"),
	);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.[1]).toEqual(
		expect.arrayContaining(["--backend", "cuda", "--device", "2"]),
	);
});
it("fails closed on malformed device metadata instead of trying another backend", async () => {
	const f = await gpuFixture(["cuda", "vulkan"]);
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	f.run.mockResolvedValue({ code: 0, stderr: "", stdout: "invalid" });
	await expect(
		runtime?.selectLocalNative({ signal: new AbortController().signal }),
	).rejects.toThrow("NATIVE_BINARY_REVISION_MISMATCH");
	expect(f.run).toHaveBeenCalledTimes(3);
});
it("does not query devices when selection has been cancelled", async () => {
	const f = await gpuFixture(["cuda"]);
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	await expect(
		runtime?.selectLocalNative({ signal: controller.signal }),
	).rejects.toThrow("cancelled");
	expect(f.run).toHaveBeenCalledTimes(2);
});
it("exposes invalid configured pairs to explicit AUTO while preserving legacy optional activation", async () => {
	const f = await fixture();
	const onInvalid = vi.fn();
	f.run.mockResolvedValue({ code: 0, stderr: "", stdout: "invalid version" });
	expect(
		await createAvailableAutomaticVmafRuntime({ ...f.deps, onInvalid }),
	).toBeUndefined();
	expect(onInvalid).toHaveBeenCalledWith(
		expect.objectContaining({ message: "NATIVE_BINARY_REVISION_MISMATCH" }),
	);
});
it("does not mark a missing native pair as invalid configuration", async () => {
	const f = await fixture();
	const onInvalid = vi.fn();
	await rm(f.companion);
	expect(
		await createAvailableAutomaticVmafRuntime({ ...f.deps, onInvalid }),
	).toBeUndefined();
	expect(onInvalid).not.toHaveBeenCalled();
});

it.each([
	["JSON", "not-json", "NATIVE_DEVICE_INFO_INVALID_JSON"],
	[
		"protocol",
		JSON.stringify({ schemaVersion: 1 }),
		"NATIVE_DEVICE_INFO_PROTOCOL_MISMATCH",
	],
	[
		"source",
		JSON.stringify({ ...gpuInfo("cuda"), sourceSha256: "f".repeat(64) }),
		"NATIVE_DEVICE_INFO_BUILD_MISMATCH",
	],
	[
		"supervisor",
		JSON.stringify({
			...gpuInfo("cuda"),
			capabilities: {
				...gpuInfo("cuda").capabilities,
				supervisorBinarySha256: "f".repeat(64),
			},
		}),
		"NATIVE_DEVICE_INFO_BUILD_MISMATCH",
	],
])("never hides invalid device %s with another GPU or CPU", async (_name, stdout, code) => {
	const f = await gpuFixture(["cuda", "vulkan"]);
	const runtime = await createAvailableAutomaticVmafRuntime(f.deps);
	const ordinary = f.run.getMockImplementation();
	if (!ordinary) throw new Error("Missing runner fixture");
	f.run.mockImplementation(async (program, args, options) =>
		args.includes("--device-info")
			? { code: 0, stderr: "", stdout }
			: ordinary(program, args, options),
	);
	await expect(
		runtime?.selectLocalNative({ signal: new AbortController().signal }),
	).rejects.toThrow(code);
	expect(
		f.run.mock.calls.filter(([, args]) => args.includes("--device-info")),
	).toHaveLength(1);
});
it("fails closed if the configured alias switches during an unavailable device query", async () => {
	const f = await gpuFixture([]);
	const alias = join(f.directory, "alias"),
		replacement = join(f.directory, "replacement");
	await symlink(f.nativePath, alias);
	await writeFile(replacement, "replacement");
	await chmod(replacement, 0o700);
	const runtime = await createAvailableAutomaticVmafRuntime({
		...f.deps,
		nativePath: alias,
	});
	const ordinary = f.run.getMockImplementation();
	if (!ordinary) throw new Error("Missing runner fixture");
	f.run.mockImplementation(async (program, args, options) => {
		if (args.includes("--device-info")) {
			await rm(alias);
			await symlink(replacement, alias);
		}
		return ordinary(program, args, options);
	});
	await expect(
		runtime?.selectLocalNative({ signal: new AbortController().signal }),
	).rejects.toThrow("VMAF_SUPERVISOR_BUILD_CHANGED");
	expect(
		f.run.mock.calls.filter(([, args]) => args.includes("--device-info")),
	).toHaveLength(1);
});

it("retains a missing file during preflight as an integrity failure after the pair was present", async () => {
	const f = await fixture(),
		onInvalid = vi.fn();
	const ordinary = f.run.getMockImplementation();
	if (!ordinary) throw new Error("Missing runner fixture");
	f.run.mockImplementation(async (program, args, options) => {
		if (args[0] === "--version") await rm(f.companion);
		return ordinary(program, args, options);
	});
	expect(
		await createAvailableAutomaticVmafRuntime({ ...f.deps, onInvalid }),
	).toBeUndefined();
	expect(onInvalid).toHaveBeenCalledWith(
		expect.objectContaining({ code: "ENOENT" }),
	);
});

it.each([
	"non-executable",
	"directory",
	"non-directory-component",
] as const)("does not silently select CPU for an invalid configured native path: %s", async (kind) => {
	const f = await fixture();
	let nativePath = f.nativePath;
	if (kind === "non-executable") await chmod(nativePath, 0o600);
	else if (kind === "directory") nativePath = f.directory;
	else nativePath = join(f.nativePath, "child");
	let nativeFailure: Error | undefined;
	const runtime = await createAvailableAutomaticVmafRuntime({
		...f.deps,
		nativePath,
		onInvalid: (error) => {
			nativeFailure = error;
		},
	});
	expect(runtime).toBeUndefined();
	expect(nativeFailure?.message).toBe("NATIVE_EXECUTABLE_INVALID");
	expect(f.run).not.toHaveBeenCalled();
	expect(f.evalRedis).not.toHaveBeenCalled();
	const request = {
		execution: { backend: "LOCAL" as const, localMode: "AUTO" as const },
		model: "vmaf_v1.0.16_3d0h",
		gate: false,
		signal: new AbortController().signal,
	};
	await expect(
		resolveLocalSelection({ nativeFailure }, request),
	).rejects.toThrow("NATIVE_EXECUTABLE_INVALID");
	expect(
		await resolveLocalSelection(
			{ nativeFailure },
			{ ...request, execution: { backend: "LOCAL", localMode: "CPU" } },
		),
	).toMatchObject({ requested: "CPU", backend: "cpu" });
});
it("still permits AUTO CPU fallback for a genuinely missing configured native executable", async () => {
	const f = await fixture(),
		onInvalid = vi.fn();
	const runtime = await createAvailableAutomaticVmafRuntime({
		...f.deps,
		nativePath: join(f.directory, "missing"),
		onInvalid,
	});
	expect(runtime).toBeUndefined();
	expect(onInvalid).not.toHaveBeenCalled();
	expect(
		await resolveLocalSelection(
			{},
			{
				execution: { backend: "LOCAL", localMode: "AUTO" },
				model: "vmaf_v1.0.16_3d0h",
				gate: false,
				signal: new AbortController().signal,
			},
		),
	).toMatchObject({ backend: "cpu", reason: "GPU_RUNTIME_UNAVAILABLE" });
	expect(f.run).not.toHaveBeenCalled();
	expect(f.evalRedis).not.toHaveBeenCalled();
});
