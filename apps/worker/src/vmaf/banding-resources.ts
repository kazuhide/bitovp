import { createHash } from "node:crypto";
import type { ProcessRunner } from "../feeder/supervisor";
import { officialCambiOptions } from "./banding-native";
import { assertBandingGeometry } from "./banding-score";
import type { NativeLocalSelection } from "./local-selection";
import {
	inspectNativeDevice,
	nativePhysicalDeviceKey,
} from "./native-auto-device";
import { ResourceUnavailableError } from "./resource-admission";
import { VMAF_GPU_COMPUTE_CREDITS } from "./resource-leases";
import {
	type LocalResourceOptions,
	type LocalResourcePlan,
	planLocalResources,
	type ResourcePair,
	type ResourceVideo,
} from "./resource-plan";
import { type LocalResources, readLocalResources } from "./resources";
import type { createSharedVmafExecution } from "./shared-execution";

export type BandingResourceRequest = {
	video: ResourceVideo;
	pairCount: number;
	signal: AbortSignal;
	selected?: NativeLocalSelection;
	basePlan?: LocalResourcePlan;
};
export type ResolveBandingResources = (
	request: BandingResourceRequest,
) => Promise<LocalResourcePlan>;

/** Scheduling slots share metadata; no reference media or VMAF model is used. */
export function bandingResourcePair(video: ResourceVideo): ResourcePair {
	return {
		metric: "CAMBI_NR",
		model: "CAMBI",
		reference: video,
		distorted: video,
	};
}

/** CAMBI starts with a conservative exclusive reservation, never a VMAF
 * calibration profile. Future measured profiles need their own qualification. */
export function createBandingResourcePlanner(deps: {
	runner: ProcessRunner;
	nativePath: string;
	hostKey(): Promise<string>;
	shared: ReturnType<typeof createSharedVmafExecution>;
	configured?: LocalResourceOptions;
	readResources?: () => LocalResources;
	inspect?: typeof inspectNativeDevice;
}): ResolveBandingResources {
	return async (request) => {
		const { signal, selected, video, basePlan } = request;
		signal.throwIfAborted();
		assertBandingGeometry(video);
		const current = (deps.readResources ?? readLocalResources)();
		const budgetBytes =
			current.memoryLimitBytes === undefined
				? current.budgetBytes
				: Math.floor(current.memoryLimitBytes - current.reserveBytes);
		const plan = planLocalResources(
			{ ...current, budgetBytes },
			bandingResourcePair(video),
			{
				...deps.configured,
				threads: Math.max(
					deps.configured?.threads ?? 1,
					basePlan?.threads ?? 1,
				),
			},
			request.pairCount,
		);
		const merged = {
			...basePlan,
			...plan,
			estimatedBytes: plan.estimatedBytes + (basePlan?.estimatedBytes ?? 0),
			threads: Math.max(plan.threads, basePlan?.threads ?? 1),
			...(selected || basePlan?.gpu
				? { nativeInflightFrames: 1 as const }
				: {}),
		};
		if (!budgetBytes || merged.estimatedBytes > budgetBytes)
			throw new ResourceUnavailableError("estimate");
		if (!selected) return merged;
		const inspect = deps.inspect ?? inspectNativeDevice;
		const readDevice = () =>
			inspect(
				{ runner: deps.runner, nativePath: deps.nativePath },
				{ backend: selected.backend, device: selected.device },
				signal,
			);
		const info = (await readDevice()).info;
		const assertIdentity = (value: typeof info) => {
			if (
				value.sourceSha256 !== selected.identity.sourceSha256 ||
				value.binarySha256 !== selected.identity.binarySha256 ||
				value.device.uuid !== selected.identity.deviceUuid ||
				!value.capabilities.processSupervisor ||
				value.device.driverVersion !== info.device.driverVersion ||
				value.device.driverVersionKnown !== info.device.driverVersionKnown ||
				value.capabilities.supervisorBinarySha256 !==
					selected.identity.supervisorBinarySha256
			)
				throw new Error("BANDING_RESOURCE_IDENTITY_CHANGED");
		};
		assertIdentity(info);
		const deviceKey = nativePhysicalDeviceKey(info, await deps.hostKey());
		if (basePlan?.gpu && basePlan.gpu.deviceKey !== deviceKey)
			throw new Error("BANDING_COMBINED_DEVICE_MISMATCH");
		deps.shared.registerDevice({
			deviceKey,
			read: async (activeSignal) => {
				const fresh = await inspect(
					{ runner: deps.runner, nativePath: deps.nativePath },
					{ backend: selected.backend, device: selected.device },
					activeSignal,
				);
				assertIdentity(fresh.info);
				return {
					totalBytes: fresh.info.device.memoryTotalBytes,
					availableBytes: fresh.info.device.memoryAvailableBytes,
				};
			},
		});
		const gpuBytes = Math.ceil(
			video.width * video.height * 512 + 768 * 1024 ** 2,
		);
		const total = info.device.memoryTotalBytes;
		if (
			total !== null &&
			gpuBytes > total - Math.max(512 * 1024 ** 2, Math.ceil(total * 0.1))
		)
			throw new ResourceUnavailableError("estimate");
		const profileKey = createHash("sha256")
			.update(
				JSON.stringify([
					"CAMBI_NR_FULL_FRAMES_V1",
					selected.identity,
					info.device.driverVersion,
					video.width,
					video.height,
					video.bitDepth,
					video.codec,
					officialCambiOptions({ ...video, bitDepth: video.bitDepth ?? 0 }),
					basePlan?.profileKey ?? null,
				]),
			)
			.digest("hex");
		return {
			...merged,
			profileKey,
			nativeDevice: selected.device,
			gpu: {
				deviceKey,
				bytes: Math.max(gpuBytes, basePlan?.gpu?.bytes ?? 0),
				computeCredits: VMAF_GPU_COMPUTE_CREDITS,
			},
		};
	};
}
