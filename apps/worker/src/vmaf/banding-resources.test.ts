import { NATIVE_OFFICIAL_REVISION, type NativeDeviceInfo } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { createBandingResourcePlanner } from "./banding-resources";
import { VMAF_GPU_COMPUTE_CREDITS } from "./resource-leases";
import { planLocalResources, type ResourcePair } from "./resource-plan";

describe("banding resource admission", () => {
	it("uses a detector-specific conservative full-frame estimate without VMAF calibration", () => {
		const video = {
			width: 640,
			height: 360,
			bitDepth: 8,
			codec: "h264",
			fps: 25,
			frames: 100,
			durationSeconds: 4,
		};
		const pair: ResourcePair = {
			metric: "CAMBI_NR",
			reference: video,
			distorted: video,
			model: "CAMBI",
		};
		const plan = planLocalResources(
			{ cpuCapacity: 8, reserveBytes: 0, budgetBytes: 8 * 1024 ** 3 },
			pair,
			{},
			2,
		);
		expect(plan).toMatchObject({
			exclusive: true,
			concurrency: 1,
			threads: 1,
			frameCount: 100,
			basis: "CAMBI_NR_FULL_FRAMES_V1",
		});
		expect(plan.estimatedBytes).toBeGreaterThanOrEqual(512 * 1024 ** 2);
	});

	it("registers the pinned GPU for a detector-specific exclusive composite reservation", async () => {
		const selected = {
			backend: "cuda" as const,
			device: 0,
			identity: {
				sourceSha256: "a".repeat(64),
				binarySha256: "b".repeat(64),
				supervisorBinarySha256: "c".repeat(64),
				deviceUuid: "gpu",
			},
		};
		const info: NativeDeviceInfo = {
			schemaVersion: 1 as const,
			sourceSha256: selected.identity.sourceSha256,
			binarySha256: selected.identity.binarySha256,
			officialSourceRevision: NATIVE_OFFICIAL_REVISION,
			backend: "cuda" as const,
			device: {
				index: 0,
				name: "gpu",
				uuid: "gpu",
				vendorId: 0x10de,
				deviceId: 0,
				integrated: false,
				pciBusId: null,
				memoryBudgetBytes: 8 * 1024 ** 3,
				memoryTotalBytes: 8 * 1024 ** 3,
				memoryAvailableBytes: 8 * 1024 ** 3,
				driverVersion: "test-driver",
				driverVersionKnown: true,
				driverVersionSource: "cuda",
				memoryAvailableSource: "cuda",
			},
			capabilities: {
				inflightFrames: [1 as const],
				cpuParity: true as const,
				processSupervisor: true,
				supervisorBinarySha256: selected.identity.supervisorBinarySha256,
			},
		};
		const registerDevice = vi.fn();
		const inspect = vi.fn(async () => ({
			info,
			executable: "/native",
			cacheable: true,
		}));
		const readResources = vi.fn(() => ({
			cpuCapacity: 8,
			reserveBytes: 0,
			budgetBytes: 8 * 1024 ** 3,
		}));
		const planner = createBandingResourcePlanner({
			runner: {} as never,
			nativePath: "/native",
			hostKey: async () => "d".repeat(64),
			shared: { registerDevice } as never,
			inspect,
			readResources,
		});
		const request = {
			video: {
				width: 640,
				height: 360,
				bitDepth: 8,
				codec: "h264",
				fps: 25,
				frames: 100,
			},
			pairCount: 2,
			selected,
			signal: new AbortController().signal,
			basePlan: {
				threads: 2,
				estimatedBytes: 128 * 1024 ** 2,
				concurrency: 2,
				exclusive: false,
				manualFallback: false,
			},
		};
		const first = await planner(request);
		expect(first).toMatchObject({
			exclusive: true,
			concurrency: 1,
			nativeDevice: 0,
			nativeInflightFrames: 1,
			gpu: { computeCredits: VMAF_GPU_COMPUTE_CREDITS },
		});
		expect(first.estimatedBytes).toBeGreaterThan(
			request.basePlan.estimatedBytes,
		);
		expect(registerDevice).toHaveBeenCalledOnce();
		const second = await planner({
			...request,
			video: { ...request.video, bitDepth: 10 },
		});
		expect(first.profileKey).not.toBe(second.profileKey);
		readResources.mockClear();
		inspect.mockClear();
		await expect(
			planner({
				...request,
				video: { ...request.video, width: 7680, height: 4320 },
			}),
		).rejects.toThrow("select Local CPU");
		expect(readResources).not.toHaveBeenCalled();
		expect(inspect).not.toHaveBeenCalled();
		info.binarySha256 = "f".repeat(64);
		await expect(planner(request)).rejects.toThrow(
			"BANDING_RESOURCE_IDENTITY_CHANGED",
		);
	});
});
