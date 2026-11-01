import { join, resolve } from "node:path";
import type { ProcessRunner } from "../feeder/supervisor";
import { resolveNativeExecutable } from "./native-auto-device";
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

type AutomaticVmafRuntimeDependencies = {
	runner: ProcessRunner;
	redis: ResourceLeaseRedis;
	nativePath: string;
	ffmpegPath: string;
	ffprobePath: string;
	workDirectory: string;
	configured?: LocalResourceOptions;
	device?: number;
	onDiagnostic?: (message: string) => void;
};
type PreparedRunner = Awaited<ReturnType<typeof createSupervisedVmafRunner>>;

/** Explicit native callers keep lazy initialization and receive native failures. */
export function createAutomaticVmafRuntime(
	deps: AutomaticVmafRuntimeDependencies,
) {
	return createRuntime(deps);
}

/** Optional worker integration activates only after its native pair matches.
 * Preflight reads identities only; it does not inspect a GPU or process media. */
export async function createAvailableAutomaticVmafRuntime(
	deps: AutomaticVmafRuntimeDependencies,
) {
	let prepared: PreparedRunner;
	try {
		prepared = await createSupervisedVmafRunner(
			{ runner: deps.runner, nativePath: deps.nativePath },
			AbortSignal.timeout(10_000),
		);
	} catch {
		deps.onDiagnostic?.(
			"Automatic VMAF resource control is unavailable; legacy execution retained.",
		);
		return undefined;
	}
	return createRuntime(deps, prepared);
}

function createRuntime(
	deps: AutomaticVmafRuntimeDependencies,
	prepared?: PreparedRunner,
) {
	let hostIdentity: Promise<string> | undefined;
	const hostKey = () => (hostIdentity ??= localVmafHostKey());
	const shared = createSharedVmafExecution({
		leases: createVmafResourceLeases({ redis: deps.redis }),
		hostKey,
	});
	let initializing: ReturnType<typeof createSupervisedVmafRunner> | undefined =
		prepared ? Promise.resolve(prepared) : undefined;
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
			if ((await resolveNativeExecutable(deps.nativePath)) !== ready.executable)
				throw new Error("VMAF_SUPERVISOR_BUILD_CHANGED");
			// Keep a configured alias out of the child launch after pinning its build.
			return ready.runner.run(
				program === deps.nativePath ? ready.executable : program,
				args,
				options,
			);
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
							workloadMode: request.workloadMode,
							cpuCapacity: request.cpuCapacity,
							maxConcurrency: request.maximumConcurrency,
							supportedInflightFrames: request.supportedInflightFrames,
							manualThreads: request.manualThreads,
						}),
						budgetMs,
						trialTimeoutMs: 15_000,
						sampleFrames: request.sampleFrames,
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
