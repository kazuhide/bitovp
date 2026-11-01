import {
	NATIVE_OFFICIAL_REVISION,
	type NativeDeviceInfo,
	type VmafCommandOptions,
} from "@bitovp/core";
import { expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import type { AutoExecutionCandidate } from "./auto-execution-policy";
import type { inspectNativeDevice } from "./native-auto-device";
import {
	createNativeAutoResourcePlanner,
	type NativeAutoCalibrationRequest,
} from "./native-auto-planner";
import type { ResourcePair } from "./resource-plan";
import { createSharedVmafExecution } from "./shared-execution";

const GiB = 1024 ** 3;
function harness() {
	const info: NativeDeviceInfo = {
		schemaVersion: 1,
		sourceSha256: "a".repeat(64),
		binarySha256: "b".repeat(64),
		officialSourceRevision: NATIVE_OFFICIAL_REVISION,
		backend: "cuda",
		device: {
			index: 2,
			name: "Example",
			uuid: "example-gpu",
			vendorId: 0x10de,
			deviceId: 1,
			integrated: false,
			memoryBudgetBytes: 12 * GiB,
			memoryTotalBytes: 16 * GiB,
			memoryAvailableBytes: 12 * GiB,
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
			supervisorBinarySha256: "c".repeat(64),
		},
	};
	const resources = {
		cpuCapacity: 24,
		memoryLimitBytes: 64 * GiB,
		budgetBytes: 48 * GiB,
		reserveBytes: 8 * GiB,
	};
	const pair: ResourcePair = {
		model: "vmaf_v1.0.16_3d0h",
		scoringBackend: "cuda",
		reference: {
			width: 1920,
			height: 1080,
			fps: 24,
			bitDepth: 8,
			chromaFactor: 1,
			codec: "h264",
			frames: 720,
		},
		distorted: {
			width: 1280,
			height: 720,
			fps: 24,
			bitDepth: 8,
			chromaFactor: 1,
			codec: "h264",
			frames: 720,
		},
	};
	const options: VmafCommandOptions = {
		model: pair.model,
		referencePath: "/reference.mp4",
		distortedPath: "/distorted.mp4",
		logPath: "/actual-job.json",
		modelPath: "/model.json",
		scaleToReference: { width: 1920, height: 1080 },
		distortedOriginal: { width: 1280, height: 720, bitdepth: 8 },
		scoring: { backend: "cuda", device: 0 },
	};
	const runner: ProcessRunner = { run: vi.fn(), spawn: vi.fn() };
	const inspect = vi.fn<typeof inspectNativeDevice>(async () => ({
		executable: "/native",
		info: structuredClone(info),
		cacheable: true,
	}));
	const shared = createSharedVmafExecution({
		leases: {
			async run(_request, signal, work) {
				return work({
					signal,
					assertOwned: async () => {},
					fitsHeadroom: async () => true,
				});
			},
		},
		hostKey: async () => "d".repeat(64),
		readResources: () => ({ ...resources }),
	});
	const register = vi.spyOn(shared, "registerDevice");
	const candidate = (
		request: NativeAutoCalibrationRequest,
		count: number,
	): AutoExecutionCandidate => ({
		profileKey: request.profileKey,
		scope: "native-with-cpu-parity",
		concurrency: count,
		inflightFrames: 4,
		cpuThreads: 2,
		decoderThreads: 1,
		hostBytesPerComparison: GiB,
		gpuBytesPerComparison: GiB,
		workload: { mode: "parallel-batch", sampleFrames: request.sampleFrames },
		trials: Array.from({ length: 3 }, () => ({
			workFrames: request.sampleFrames * count,
			wallMs: count === 1 ? 2000 : 1000,
			cpuVerified: true,
		})),
	});
	const calibrate = vi.fn(async (request: NativeAutoCalibrationRequest) => [
		candidate(request, 1),
		candidate(request, 3),
	]);
	const deps = {
		runner,
		nativePath: "/native",
		shared,
		hostKey: async () => "d".repeat(64),
		readResources: () => ({ ...resources }),
		inspect,
		calibrate,
		prepareModel: async () => ({ modelSha256: "e".repeat(64) }),
	};
	const request = {
		pair,
		options,
		pairCount: 1,
		signal: new AbortController().signal,
	};
	return {
		deps,
		request,
		info,
		resources,
		inspect,
		calibrate,
		register,
		shared,
	};
}
it("chooses one shared measured pool independently of a parent's mirror count", async () => {
	const h = harness();
	const before = structuredClone(h.request.options);
	const plan = await createNativeAutoResourcePlanner(h.deps)(h.request);
	expect(plan).toMatchObject({
		concurrency: 3,
		threads: 2,
		decoderThreads: 1,
		nativeDevice: 2,
		nativeInflightFrames: 4,
		cpuChargePerComparison: 5,
		exclusive: false,
		basis: "calibrated",
	});
	expect(h.request.options).toEqual(before);
	expect(h.calibrate.mock.calls[0]?.[0].options.scoring?.device).toBe(2);
	expect(h.calibrate.mock.calls[0]?.[0].fullFrameCount).toBe(720);
	expect(h.calibrate.mock.calls[0]?.[0]).toMatchObject({
		workloadMode: "parallel-batch",
		fixedWorkUnits: 1,
		sampleFrames: 64,
	});
});

it("binds actual sample length and manual threads into cache identity", async () => {
	const h = harness();
	await createNativeAutoResourcePlanner(h.deps)(h.request);
	const first = h.calibrate.mock.calls.at(-1)?.[0];
	const shortRequest = {
		...h.request,
		pair: {
			...h.request.pair,
			reference: { ...h.request.pair.reference, frames: 32 },
			distorted: { ...h.request.pair.distorted, frames: 32 },
		},
	};
	await createNativeAutoResourcePlanner(h.deps)(shortRequest);
	const short = h.calibrate.mock.calls.at(-1)?.[0];
	expect(short?.sampleFrames).toBe(32);
	expect(short?.profileKey).not.toBe(first?.profileKey);
	await createNativeAutoResourcePlanner({
		...h.deps,
		configured: { threads: 2 },
	})(h.request);
	const manual = h.calibrate.mock.calls.at(-1)?.[0];
	expect(manual?.manualThreads).toBe(2);
	expect(manual?.profileKey).not.toBe(first?.profileKey);
	await createNativeAutoResourcePlanner({
		...h.deps,
		configured: { threads: 4 },
	})(h.request);
	expect(h.calibrate.mock.calls.at(-1)?.[0].profileKey).not.toBe(
		manual?.profileKey,
	);
});
it("uses exact frame counts rather than rounded container duration for calibration", async () => {
	const h = harness();
	for (const video of [h.request.pair.reference, h.request.pair.distorted])
		Object.assign(video, { frames: 60, fps: 30, durationSeconds: 2.05 });
	const plan = await createNativeAutoResourcePlanner(h.deps)(h.request);
	expect(plan.frameCount).toBe(62);
	expect(h.calibrate.mock.calls[0]?.[0]).toMatchObject({
		sampleFrames: 60,
		fullFrameCount: 62,
	});
});
it.each([
	[1, 30],
	[2, 60],
	[7 / 10, 20],
] as const)("limits a %s fps proxy to at most thirty seconds", async (fps, expected) => {
	const h = harness();
	h.request.pair.reference.fps = fps;
	h.request.pair.distorted.fps = fps;
	h.calibrate.mockImplementation(async (request) => {
		expect(request.sampleFrames / fps).toBeLessThanOrEqual(30);
		return [];
	});
	await createNativeAutoResourcePlanner(h.deps)(h.request);
	expect(h.calibrate.mock.calls[0]?.[0].sampleFrames).toBe(expected);
});
it("uses the shorter exact input when both inputs report counts", async () => {
	const h = harness();
	h.request.pair.reference.frames = 60;
	h.request.pair.distorted.frames = 45;
	await createNativeAutoResourcePlanner(h.deps)(h.request);
	expect(h.calibrate.mock.calls[0]?.[0].sampleFrames).toBe(45);
});
it.each([
	undefined,
	0,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	-1,
	Number.MAX_SAFE_INTEGER + 1,
])("skips all calibration/cache access without an exact frame count: %s", async (frames) => {
	for (const side of ["reference", "distorted"] as const) {
		const h = harness();
		for (const video of [h.request.pair.reference, h.request.pair.distorted])
			video.durationSeconds = 30;
		h.request.pair[side].frames = frames;
		const plan = await createNativeAutoResourcePlanner(h.deps)(h.request);
		expect(h.calibrate).not.toHaveBeenCalled();
		expect(plan).toMatchObject({
			basis: "conservative",
			concurrency: 1,
			nativeInflightFrames: 1,
		});
		expect(plan).not.toHaveProperty("profileKey");
	}
});
it.each([
	1 / 60,
	0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	undefined,
])("skips calibration when cadence cannot provide one frame in a thirty-second proxy: %s", async (fps) => {
	const h = harness();
	h.request.pair.reference.fps = fps;
	h.request.pair.distorted.fps = fps;
	const plan = await createNativeAutoResourcePlanner(h.deps)(h.request);
	expect(h.calibrate).not.toHaveBeenCalled();
	expect(plan.basis).toBe("conservative");
	expect(plan).not.toHaveProperty("profileKey");
});
it("preserves advanced thread overrides and uses serial planning when GPU headroom is unknown", async () => {
	const h = harness();
	h.info.device.memoryAvailableBytes = null;
	const plan = await createNativeAutoResourcePlanner({
		...h.deps,
		configured: { threads: 8 },
	})(h.request);
	expect(plan).toMatchObject({
		concurrency: 1,
		threads: 8,
		nativeInflightFrames: 1,
		basis: "conservative",
	});
	expect(h.calibrate).not.toHaveBeenCalled();
});
it("revalidates executable, source, driver and physical device before execution", async () => {
	const h = harness();
	await createNativeAutoResourcePlanner(h.deps)(h.request);
	const device = h.register.mock.calls[0]?.[0];
	expect(device).toBeDefined();
	h.info.device.driverVersion = "driver2";
	await expect(device?.read(h.request.signal)).rejects.toThrow(
		"NATIVE_AUTO_PROFILE_BUILD_CHANGED",
	);
});
it("does not calibrate a CPU job or depend its global capacity on one mirror", async () => {
	const h = harness();
	const request = {
		...h.request,
		pair: {
			...h.request.pair,
			model: "vmaf_v0.6.1",
			scoringBackend: undefined,
		},
		options: { ...h.request.options, scoring: undefined },
	};
	const plan = await createNativeAutoResourcePlanner(h.deps)(request);
	expect(plan.concurrency).toBeGreaterThan(1);
	expect(h.inspect).not.toHaveBeenCalled();
	expect(h.calibrate).not.toHaveBeenCalled();
});
it("treats explicit concurrency as a shared upper bound", async () => {
	const h = harness();
	const plan = await createNativeAutoResourcePlanner({
		...h.deps,
		configured: { concurrency: 1 },
	})(h.request);
	expect(plan.concurrency).toBe(1);
	expect(h.calibrate.mock.calls[0]?.[0].maximumConcurrency).toBe(1);
});
it("requires kernel supervision and pinned models before starting any calibration", async () => {
	const h = harness();
	h.info.capabilities.processSupervisor = false;
	await expect(
		createNativeAutoResourcePlanner(h.deps)(h.request),
	).rejects.toThrow("NATIVE_AUTO_REQUIRES_PROCESS_SUPERVISOR");
	expect(h.calibrate).not.toHaveBeenCalled();
});

it("rejects an overridden serial configuration whose measured footprint cannot fit", async () => {
	const h = harness();
	Object.assign(h.resources, {
		memoryLimitBytes: 1.5 * GiB,
		reserveBytes: 0,
		budgetBytes: 1.5 * GiB,
	});
	h.calibrate.mockImplementation(async (request) => [
		{
			profileKey: request.profileKey,
			scope: "native-with-cpu-parity",
			concurrency: 1,
			inflightFrames: 1,
			cpuThreads: 2,
			decoderThreads: 1,
			hostBytesPerComparison: 2 * GiB,
			gpuBytesPerComparison: GiB,
			trials: Array.from({ length: 3 }, () => ({
				workFrames: 96,
				wallMs: 1000,
				cpuVerified: true,
			})),
		},
	]);
	await expect(
		createNativeAutoResourcePlanner({ ...h.deps, configured: { threads: 2 } })(
			h.request,
		),
	).rejects.toThrow("requires more memory");
});

it("uses the pinned per-job device before the legacy environment index", async () => {
	const h = harness();
	await createNativeAutoResourcePlanner({ ...h.deps, device: 7 })({
		...h.request,
		selectedNativeDevice: 2,
		selectedNativeIdentity: {
			sourceSha256: h.info.sourceSha256,
			binarySha256: h.info.binarySha256 as string,
			supervisorBinarySha256: h.info.capabilities
				.supervisorBinarySha256 as string,
			deviceUuid: h.info.device.uuid,
		},
	});
	expect(h.inspect.mock.calls[0]?.[1]).toEqual({ backend: "cuda", device: 2 });
});
it("retains the legacy device index when there is no per-job selection", async () => {
	const h = harness();
	await createNativeAutoResourcePlanner({ ...h.deps, device: 7 })(h.request);
	expect(h.inspect.mock.calls[0]?.[1]).toEqual({ backend: "cuda", device: 7 });
});
it.each([
	"sourceSha256",
	"binarySha256",
	"supervisorBinarySha256",
	"deviceUuid",
] as const)("rejects changed pinned %s before calibration or shared registration", async (field) => {
	const h = harness();
	const identity = {
		sourceSha256: h.info.sourceSha256,
		binarySha256: h.info.binarySha256 as string,
		supervisorBinarySha256: h.info.capabilities
			.supervisorBinarySha256 as string,
		deviceUuid: h.info.device.uuid,
	};
	identity[field] = field === "deviceUuid" ? "other-gpu" : "f".repeat(64);
	await expect(
		createNativeAutoResourcePlanner(h.deps)({
			...h.request,
			selectedNativeDevice: 2,
			selectedNativeIdentity: identity,
		}),
	).rejects.toThrow("NATIVE_AUTO_SELECTED_IDENTITY_CHANGED");
	expect(h.calibrate).not.toHaveBeenCalled();
	expect(h.register).not.toHaveBeenCalled();
});
