import { join, resolve } from "node:path";
import type { ProcessRunner } from "../feeder/supervisor";
import { createNativeAutoResourcePlanner } from "./native-auto-planner";
import {
	createNativeCalibrationAdapter,
	nativeCalibrationTemplates,
} from "./native-calibration-adapter";
import { createNativeCalibrationBudget } from "./native-calibration-budget";
import {
	createVmafResourceLeases,
	type ResourceLeaseRedis,
} from "./resource-leases";
import type { LocalResourceOptions } from "./resource-plan";
import {
	createSharedVmafExecution,
	localVmafHostKey,
} from "./shared-execution";
import { createSupervisedVmafRunner } from "./supervised-runner";

/** Optional native installation; initialization is lazy so cloud jobs and
 * workers without that installation keep their existing execution path. */
export function createAutomaticVmafRuntime(deps: {
	runner: ProcessRunner;
	redis: ResourceLeaseRedis;
	nativePath: string;
	ffmpegPath: string;
	ffprobePath: string;
	workDirectory: string;
	configured?: LocalResourceOptions;
	device?: number;
	onDiagnostic?: (message: string) => void;
}) {
	let hostIdentity: Promise<string> | undefined;
	const hostKey = () => (hostIdentity ??= localVmafHostKey());
	const shared = createSharedVmafExecution({
		leases: createVmafResourceLeases({ redis: deps.redis }),
		hostKey,
	});
	let initializing: ReturnType<typeof createSupervisedVmafRunner> | undefined;
	function initialize() {
		// Caller cancellation must not poison initialization for another job.
		initializing ??= createSupervisedVmafRunner(
			{ runner: deps.runner, nativePath: deps.nativePath },
			AbortSignal.timeout(10_000),
		).catch((error) => {
			initializing = undefined;
			throw error;
		});
		return initializing;
	}
	const runner: ProcessRunner = {
		spawn() {
			throw new Error("VMAF_SUPERVISOR_REQUIRES_DIRECT_RUN");
		},
		async run(program, args, options) {
			options?.signal?.throwIfAborted();
			const ready = await initialize();
			options?.signal?.throwIfAborted();
			return ready.runner.run(program, args, options);
		},
	};
	const work = resolve(deps.workDirectory);
	const calibration = createNativeCalibrationAdapter({
		runner,
		nativePath: deps.nativePath,
		ffmpegPath: deps.ffmpegPath,
		ffprobePath: deps.ffprobePath,
		cacheDirectory: join(work, "profiles"),
		workDirectory: join(work, "samples"),
		onDiagnostic: (reason) =>
			deps.onDiagnostic?.(`Native resource calibration: ${reason}`),
	});
	const calibrationBudget = createNativeCalibrationBudget();
	const resolveLocalResources = createNativeAutoResourcePlanner({
		runner,
		nativePath: deps.nativePath,
		shared,
		hostKey,
		configured: deps.configured,
		device: deps.device,
		calibrate: async (request) => {
			const { referenceProbe, distortedProbe } = request;
			if (referenceProbe === undefined || distortedProbe === undefined)
				throw new Error("NATIVE_AUTO_REQUIRES_INPUT_PROBES");
			return calibrationBudget.calibrate({
				profileKey: request.profileKey,
				maxConcurrency: request.maximumConcurrency,
				signal: request.signal,
				run: (budgetMs, ownerSignal) =>
					calibration.calibrate({
						...request,
						signal: ownerSignal,
						referenceProbe,
						distortedProbe,
						templates: nativeCalibrationTemplates({
							cpuCapacity: request.cpuCapacity,
							maxConcurrency: request.maximumConcurrency,
							supportedInflightFrames: request.supportedInflightFrames,
							manualThreads: request.manualThreads,
						}),
						budgetMs,
						trialTimeoutMs: 15_000,
						sampleFrames: Math.min(16, request.fullFrameCount),
						memoryPadding: {
							hostMarginFactor: 1.5,
							hostPerFrameBytes: 4096,
							gpuPerProcessOverheadBytes: 512 * 1024 ** 2,
							gpuMarginFactor: 1.25,
						},
					}),
			});
		},
		onDecision: (decision) =>
			deps.onDiagnostic?.(
				`Native resource plan: ${decision.source}, ${decision.concurrency} comparison(s), ${decision.inflightFrames} frame(s) in flight; ${decision.reasons.join(", ")}`,
			),
	});
	return { runner, resolveLocalResources, execute: shared.run.bind(shared) };
}
