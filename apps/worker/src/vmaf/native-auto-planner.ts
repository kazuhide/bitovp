import type { NativeDeviceInfo, VmafCommandOptions } from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	AUTO_GPU_SHARE_CAPACITY,
	type AutoExecutionCandidate,
	selectAutoExecutionPlan,
} from "./auto-execution-policy";
import {
	inspectNativeDevice,
	nativeAutoProfileKey,
	nativePhysicalDeviceKey,
} from "./native-auto-device";
import { prepareNativeModel } from "./native-contract";
import { ResourceUnavailableError } from "./resource-admission";
import {
	type LocalResourceOptions,
	type LocalResourcePlan,
	planLocalResources,
	type ResourcePair,
} from "./resource-plan";
import { type LocalResources, readLocalResources } from "./resources";
import type { createSharedVmafExecution } from "./shared-execution";

export type NativeAutoCalibrationRequest = {
	profileKey: string;
	cacheable: boolean;
	options: VmafCommandOptions;
	referenceProbe?: string;
	distortedProbe?: string;
	signal: AbortSignal;
	fullFrameCount: number;
	cpuCapacity: number;
	maximumConcurrency: number;
	workloadMode: "parallel-batch";
	fixedWorkUnits: 1;
	sampleFrames: number;
	supportedInflightFrames: readonly (1 | 2 | 4)[];
	manualThreads?: number;
	withExclusiveCalibration<T>(
		work: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
};
type Shared = ReturnType<typeof createSharedVmafExecution>;
const exactFrameCount = (value: number | undefined): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Profiles advise execution resources only. The complete requested inputs,
 * model and CPU parity remain unchanged when the queued comparison starts. */
export function createNativeAutoResourcePlanner(deps: {
	runner: ProcessRunner;
	nativePath: string;
	hostKey(): Promise<string>;
	shared: Shared;
	configured?: LocalResourceOptions;
	/** Omission allows the selected vendor to choose its actual API index. */
	device?: number;
	readResources?: () => LocalResources;
	inspect?: typeof inspectNativeDevice;
	prepareModel?: typeof prepareNativeModel;
	calibrate(
		request: NativeAutoCalibrationRequest,
	): Promise<AutoExecutionCandidate[]>;
	onDecision?: (decision: {
		source: string;
		concurrency: number;
		inflightFrames: number;
		reasons: readonly string[];
	}) => void;
}) {
	const read = deps.readResources ?? readLocalResources;
	const inspect = deps.inspect ?? inspectNativeDevice;
	return async (request: {
		pair: ResourcePair;
		pairCount: number;
		options: VmafCommandOptions;
		signal: AbortSignal;
		referenceProbe?: string;
		distortedProbe?: string;
	}): Promise<LocalResourcePlan> => {
		const { signal, pair } = request;
		signal.throwIfAborted();
		const current = read();
		const hostBudget =
			current.memoryLimitBytes === undefined
				? current.budgetBytes
				: Math.floor(current.memoryLimitBytes - current.reserveBytes);
		const stable = { ...current, budgetBytes: hostBudget };
		// A shared pool size must not depend on one parent's number of mirrors.
		const base = planLocalResources(stable, pair, deps.configured ?? {}, 32);
		if (!request.options.scoring) {
			const charge = base.threads + 2 * (base.decoderThreads ?? 1) + 1;
			return {
				...base,
				cpuChargePerComparison: Math.min(current.cpuCapacity, charge),
				concurrency: base.exclusive
					? 1
					: Math.max(
							1,
							Math.min(
								base.concurrency,
								Math.floor(current.cpuCapacity / charge),
							),
						),
			};
		}
		if (!hostBudget || !base.frameCount)
			throw new ResourceUnavailableError("unknown");
		const selection = {
			backend: request.options.scoring.backend,
			...(deps.device === undefined ? {} : { device: deps.device }),
		};
		const inspected = await inspect(
			{ runner: deps.runner, nativePath: deps.nativePath },
			selection,
			signal,
		);
		const info = inspected.info;
		if (!info.capabilities.processSupervisor)
			throw new Error("NATIVE_AUTO_REQUIRES_PROCESS_SUPERVISOR");
		const hostKey = await deps.hostKey();
		const deviceKey = nativePhysicalDeviceKey(info, hostKey);
		const identity = (value: NativeDeviceInfo) =>
			JSON.stringify([
				value.sourceSha256,
				value.binarySha256,
				value.capabilities.supervisorBinarySha256,
				value.device.uuid,
				value.device.driverVersion,
			]);
		deps.shared.registerDevice({
			deviceKey,
			read: async (activeSignal) => {
				const fresh = await inspect(
					{ runner: deps.runner, nativePath: deps.nativePath },
					{ backend: selection.backend, device: info.device.index },
					activeSignal,
				);
				if (identity(fresh.info) !== identity(info))
					throw new Error("NATIVE_AUTO_PROFILE_BUILD_CHANGED");
				return {
					totalBytes: fresh.info.device.memoryTotalBytes,
					availableBytes: fresh.info.device.memoryAvailableBytes,
				};
			},
		});
		const size = request.options.scaleToReference;
		if (
			!size ||
			!pair.reference.bitDepth ||
			!pair.distorted.bitDepth ||
			!pair.reference.codec ||
			!pair.distorted.codec
		)
			throw new ResourceUnavailableError("metadata");
		const model = await (deps.prepareModel ?? prepareNativeModel)(
			request.options,
			signal,
		);
		// Container duration is sufficient for padded RAM, not proof that a
		// calibration prefix contains N frames. Both exact counts must be known.
		const fps = pair.reference.fps;
		const durationCap =
			fps !== undefined && Number.isFinite(fps) && fps > 0
				? Math.floor(fps * 30)
				: 0;
		const sampleFrames =
			exactFrameCount(pair.reference.frames) &&
			exactFrameCount(pair.distorted.frames) &&
			exactFrameCount(durationCap)
				? Math.min(
						64,
						pair.reference.frames,
						pair.distorted.frames,
						durationCap,
					)
				: undefined;
		const profileKey =
			sampleFrames !== undefined && fps !== undefined
				? nativeAutoProfileKey(info, {
						calibrationMode: "parallel-batch",
						sampleFrames,
						fixedCpuThreads: deps.configured?.threads,
						model: request.options.model,
						modelSha256: model.modelSha256,
						...size,
						referenceWidth: pair.reference.width,
						referenceHeight: pair.reference.height,
						distortedWidth: pair.distorted.width,
						distortedHeight: pair.distorted.height,
						referenceBitDepth: pair.reference.bitDepth,
						distortedBitDepth: pair.distorted.bitDepth,
						referenceCodec: pair.reference.codec,
						distortedCodec: pair.distorted.codec,
						fps,
						cpuCapacity: current.cpuCapacity,
						hostCapacityBytes: hostBudget,
					})
				: undefined;
		const pixels = Math.max(
			pair.reference.width * pair.reference.height,
			pair.distorted.width * pair.distorted.height,
		);
		// Cold-start upper envelope. Measured profiles replace it with padded
		// per-model footprints; it is not a claim of exact allocation size.
		const baseline = {
			hostBytes: base.estimatedBytes,
			gpuBytes: Math.ceil(pixels * 512 + 768 * 1024 ** 2),
		};
		const total = info.device.memoryTotalBytes;
		const reserve =
			total === null ? 0 : Math.max(512 * 1024 ** 2, Math.ceil(total * 0.1));
		const gpuBudget = total === null ? undefined : Math.max(0, total - reserve);
		const concurrencyCapacity = Math.max(
			1,
			Math.min(
				32,
				deps.configured?.concurrency ?? 32,
				Math.floor(current.cpuCapacity / 4),
				Math.floor(
					hostBudget /
						(baseline.hostBytes +
							(info.device.integrated ? baseline.gpuBytes : 0)),
				),
				gpuBudget === undefined ? 1 : Math.floor(gpuBudget / baseline.gpuBytes),
			),
		);
		const maximumConcurrency = Math.max(
			1,
			Math.min(
				concurrencyCapacity,
				Math.floor(
					(current.budgetBytes ?? 0) /
						(baseline.hostBytes +
							(info.device.integrated ? baseline.gpuBytes : 0)),
				),
				info.device.memoryAvailableBytes === null
					? 1
					: Math.floor(
							Math.max(0, info.device.memoryAvailableBytes - reserve) /
								baseline.gpuBytes,
						),
			),
		);
		const options = {
			...request.options,
			scoring: { ...request.options.scoring, device: info.device.index },
		};
		const exclusive: LocalResourcePlan = {
			...base,
			exclusive: true,
			concurrency: 1,
			nativeDevice: info.device.index,
			estimatedBytes: Math.min(
				hostBudget,
				maximumConcurrency *
					(baseline.hostBytes +
						(info.device.integrated ? baseline.gpuBytes : 0)),
			),
			gpu: {
				deviceKey,
				bytes: maximumConcurrency * baseline.gpuBytes,
				computeCredits: AUTO_GPU_SHARE_CAPACITY,
			},
		};
		const candidates =
			profileKey !== undefined &&
			sampleFrames !== undefined &&
			inspected.cacheable &&
			total !== null &&
			info.device.memoryAvailableBytes !== null
				? await deps.calibrate({
						profileKey,
						cacheable: inspected.cacheable,
						options,
						referenceProbe: request.referenceProbe,
						distortedProbe: request.distortedProbe,
						signal,
						fullFrameCount: base.frameCount,
						cpuCapacity: current.cpuCapacity,
						maximumConcurrency,
						workloadMode: "parallel-batch",
						fixedWorkUnits: 1,
						sampleFrames,
						supportedInflightFrames: info.capabilities.inflightFrames,
						...(deps.configured?.threads === undefined
							? {}
							: { manualThreads: deps.configured.threads }),
						withExclusiveCalibration: (work, calibrationSignal) =>
							deps.shared.run(exclusive, calibrationSignal, (leaseSignal) =>
								work(leaseSignal),
							),
					})
				: [];
		const fresh = read();
		const decision = selectAutoExecutionPlan({
			fixedCpuThreads: deps.configured?.threads,
			expectedProfileKey: profileKey ?? "0".repeat(64),
			baseline,
			candidates: candidates.filter(
				(c) =>
					c.concurrency <= (deps.configured?.concurrency ?? 32) &&
					(deps.configured?.threads === undefined ||
						c.cpuThreads === deps.configured.threads),
			),
			resources: {
				cpuCapacity: current.cpuCapacity,
				hostBudgetBytes: hostBudget,
				hostAvailableBytes: fresh.budgetBytes ?? 0,
				gpuTotalBytes: total,
				gpuBudgetBytes: gpuBudget,
				gpuAvailableBytes:
					info.device.memoryAvailableBytes === null
						? null
						: Math.max(0, info.device.memoryAvailableBytes - reserve),
				integrated: info.device.integrated,
			},
		});
		if (decision.status === "unavailable" || !decision.plan)
			throw new ResourceUnavailableError("estimate");
		const selected = decision.plan;
		const threads = selected.cpuThreads;
		deps.onDecision?.({
			source: selected.source,
			concurrency: selected.maxActiveComparisons,
			inflightFrames: selected.inflightFrames,
			reasons: decision.reasons,
		});
		return {
			...base,
			threads,
			decoderThreads: selected.decoderThreads,
			filterComplexThreads: undefined,
			concurrency: selected.maxActiveComparisons,
			nativeInflightFrames: selected.inflightFrames,
			nativeDevice: info.device.index,
			estimatedBytes: selected.hostBytesPerComparison,
			cpuChargePerComparison: Math.min(
				current.cpuCapacity,
				threads + 2 * selected.decoderThreads + 1,
			),
			exclusive: selected.source === "conservative",
			basis: selected.source,
			reasons: decision.reasons,
			...(profileKey === undefined ? {} : { profileKey }),
			gpu: {
				deviceKey,
				bytes: selected.gpuBytesPerComparison,
				computeCredits: selected.gpuShareCredits,
			},
		};
	};
}
