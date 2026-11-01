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
		trials: Array.from({ length: 3 }, () => ({
			workFrames: 96,
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
