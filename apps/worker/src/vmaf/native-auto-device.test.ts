import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { NATIVE_OFFICIAL_REVISION, type NativeDeviceInfo } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	inspectNativeDevice,
	type NativeAutoWorkload,
	nativeAutoProfileKey,
	nativePhysicalDeviceKey,
} from "./native-auto-device";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

function info(binary: string): NativeDeviceInfo {
	return {
		schemaVersion: 1,
		sourceSha256: "a".repeat(64),
		binarySha256: createHash("sha256").update(binary).digest("hex"),
		officialSourceRevision: NATIVE_OFFICIAL_REVISION,
		backend: "cuda",
		device: {
			index: 0,
			name: "Example GPU",
			uuid: "0123456789abcdef0123456789abcdef",
			vendorId: 0x10de,
			deviceId: 0,
			integrated: false,
			memoryBudgetBytes: 8 * 1024 ** 3,
			memoryTotalBytes: 16 * 1024 ** 3,
			memoryAvailableBytes: 8 * 1024 ** 3,
			driverVersion: "example-driver-build",
			driverVersionKnown: true,
			driverVersionSource: "sysfs",
			memoryAvailableSource: "cudaMemGetInfo",
			memoryHeapIndex: null,
			pciBusId: "0000:01:00.0",
		},
		capabilities: { inflightFrames: [1, 2, 4], cpuParity: true },
	};
}

async function harness() {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-device-info-"));
	directories.push(directory);
	const executable = join(directory, "native scorer");
	const content = "test executable identity";
	await writeFile(executable, content);
	await chmod(executable, 0o700);
	let report = info(content);
	let onProbe: (() => Promise<void>) | undefined;
	const run = vi.fn(async (_binary: string, args: string[]) => {
		if (args[0] === "--version")
			return {
				code: 0,
				stdout: `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${"a".repeat(64)}\n`,
				stderr: "",
			};
		await onProbe?.();
		return { code: 0, stdout: JSON.stringify(report), stderr: "" };
	});
	const runner: ProcessRunner = {
		run,
		spawn: () => {
			throw new Error("Unexpected long-running spawn");
		},
	};
	return {
		executable,
		directory,
		deps: { runner, nativePath: executable },
		run,
		get report() {
			return report;
		},
		set report(value: NativeDeviceInfo) {
			report = value;
		},
		set onProbe(value: () => Promise<void>) {
			onProbe = value;
		},
	};
}

const selection = { backend: "cuda" as const, device: 0 };

it("checks the executable and refreshes changing headroom without caching it", async () => {
	const h = await harness();
	const first = await inspectNativeDevice(h.deps, selection);
	expect(first.cacheable).toBe(true);
	expect(first.executable).toBe(await realpath(h.executable));
	h.report.device.memoryAvailableBytes = 1024 ** 3;
	const second = await inspectNativeDevice(h.deps, selection);
	expect(second.info.device.memoryAvailableBytes).toBe(1024 ** 3);
	expect(first.info.device.memoryAvailableBytes).toBe(8 * 1024 ** 3);
	expect(h.run).toHaveBeenCalledTimes(4);
});

it("resolves PATH executables with spaces and keeps arguments separate", async () => {
	const h = await harness();
	vi.stubEnv("PATH", `${h.directory}${delimiter}${process.env.PATH ?? ""}`);
	await inspectNativeDevice(
		{ ...h.deps, nativePath: basename(h.executable) },
		selection,
	);
	expect(h.run.mock.calls[1]?.[1]).toEqual([
		"--device-info",
		"--backend",
		"cuda",
		"--device",
		"0",
		"--vendor",
		"nvidia",
	]);
});

it("selects the matching vendor automatically unless an API device index was specified", async () => {
	const h = await harness();
	h.report.device.index = 2;
	expect(
		(await inspectNativeDevice(h.deps, { backend: "cuda" })).info.device.index,
	).toBe(2);
	expect(h.run.mock.calls[1]?.[1]).not.toContain("--device");
	await expect(inspectNativeDevice(h.deps, selection)).rejects.toThrow(
		"NATIVE_DEVICE_INFO_SELECTION_MISMATCH",
	);
});

it("rejects a different build, device, source or changed executable", async () => {
	for (const patch of [
		{ sourceSha256: "b".repeat(64) },
		{ binarySha256: "c".repeat(64) },
		{ backend: "vulkan" as const },
	]) {
		const h = await harness();
		h.report = { ...h.report, ...patch };
		await expect(inspectNativeDevice(h.deps, selection)).rejects.toThrow(
			/NATIVE_DEVICE_INFO_(BUILD|SELECTION)_MISMATCH/,
		);
	}
	const h = await harness();
	h.onProbe = async () => {
		await writeFile(h.executable, "a replacement executable");
	};
	await expect(inspectNativeDevice(h.deps, selection)).rejects.toThrow(
		"NATIVE_DEVICE_INFO_BUILD_MISMATCH",
	);
});

it("keeps unknown driver identities usable but ineligible for persistent calibration", async () => {
	const h = await harness();
	h.report.device.driverVersionKnown = false;
	expect((await inspectNativeDevice(h.deps, selection)).cacheable).toBe(false);
	h.report.device.driverVersionKnown = true;
	h.report.binarySha256 = null;
	expect((await inspectNativeDevice(h.deps, selection)).cacheable).toBe(false);
});

it("does not inspect or accept a cancelled query", async () => {
	const h = await harness();
	const abort = new AbortController();
	abort.abort(new Error("cancelled"));
	await expect(
		inspectNativeDevice(h.deps, selection, abort.signal),
	).rejects.toThrow("cancelled");
	expect(h.run).not.toHaveBeenCalled();
});

const workload: NativeAutoWorkload = {
	model: "vmaf_v1.0.16_3d0h",
	modelSha256: "d".repeat(64),
	width: 1920,
	height: 1080,
	referenceWidth: 1920,
	referenceHeight: 1080,
	distortedWidth: 1280,
	distortedHeight: 720,
	referenceBitDepth: 8,
	distortedBitDepth: 8,
	referenceCodec: "h264",
	distortedCodec: "hevc",
	fps: 24,
	cpuCapacity: 20,
	hostCapacityBytes: 16 * 1024 ** 3,
};

it("binds profiles to scoring settings and build identities, but not live free memory", () => {
	const report = info("binary");
	const expected = nativeAutoProfileKey(report, workload);
	const lessFree = structuredClone(report);
	lessFree.device.memoryAvailableBytes = 0;
	expect(nativeAutoProfileKey(lessFree, workload)).toBe(expected);
	for (const patch of [
		{ modelSha256: "e".repeat(64) },
		{ width: 3840, height: 2160 },
		{ distortedWidth: 640, distortedHeight: 360 },
		{ referenceBitDepth: 10 },
		{ distortedCodec: "av1" },
		{ fps: 25 },
		{ cpuCapacity: 4 },
		{ hostCapacityBytes: 4 * 1024 ** 3 },
	])
		expect(nativeAutoProfileKey(report, { ...workload, ...patch })).not.toBe(
			expected,
		);
	for (const patch of [
		{ sourceSha256: "e".repeat(64) },
		{ binarySha256: "f".repeat(64) },
	])
		expect(nativeAutoProfileKey({ ...report, ...patch }, workload)).not.toBe(
			expected,
		);
	const driver = structuredClone(report);
	driver.device.driverVersion = "new-driver";
	expect(nativeAutoProfileKey(driver, workload)).not.toBe(expected);
	for (const patch of [{ fps: Number.NaN }, { cpuCapacity: 0 }, { width: -1 }])
		expect(() =>
			nativeAutoProfileKey(report, { ...workload, ...patch }),
		).toThrow();
});

it("binds the actual per-comparison sample and calibration mode into profile identity", () => {
	const report = info("binary");
	const full = nativeAutoProfileKey(report, {
		...workload,
		calibrationMode: "parallel-batch",
		sampleFrames: 64,
	});
	const short = nativeAutoProfileKey(report, {
		...workload,
		calibrationMode: "parallel-batch",
		sampleFrames: 16,
	});
	const fixed = nativeAutoProfileKey(report, {
		...workload,
		calibrationMode: "fixed-batch",
		sampleFrames: 64,
	});
	expect(new Set([full, short, fixed]).size).toBe(3);
	for (const sampleFrames of [0, 257, NaN, 1.5])
		expect(() =>
			nativeAutoProfileKey(report, { ...workload, sampleFrames }),
		).toThrow("NATIVE_AUTO_PROFILE_SETTINGS_INVALID");
});

it("binds an exact manual compute-thread override independently from automatic search", () => {
	const report = info("binary");
	const keys = [undefined, 2, 4, 8].map((fixedCpuThreads) =>
		nativeAutoProfileKey(report, { ...workload, fixedCpuThreads }),
	);
	expect(new Set(keys).size).toBe(4);
	for (const fixedCpuThreads of [0, 257, 1.5, NaN])
		expect(() =>
			nativeAutoProfileKey(report, { ...workload, fixedCpuThreads }),
		).toThrow("NATIVE_AUTO_PROFILE_SETTINGS_INVALID");
});

it("joins API identities by host and PCI, and uses UUID when PCI is unavailable", () => {
	const host = "a".repeat(64),
		report = info("binary");
	const samePhysical = structuredClone(report);
	samePhysical.backend = "vulkan";
	samePhysical.device.uuid = "a-different-api-uuid";
	expect(nativePhysicalDeviceKey(samePhysical, host)).toBe(
		nativePhysicalDeviceKey(report, host),
	);
	expect(nativePhysicalDeviceKey(report, "b".repeat(64))).not.toBe(
		nativePhysicalDeviceKey(report, host),
	);
	report.device.pciBusId = null;
	expect(nativePhysicalDeviceKey(report, host)).toBe(
		nativePhysicalDeviceKey(report, "b".repeat(64)),
	);
	expect(() => nativePhysicalDeviceKey(report, "unscoped")).toThrow();
});
