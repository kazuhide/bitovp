import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProcessRunner } from "../feeder/supervisor";
import { createBandingResourcePlanner } from "./banding-resources";
import type { SelectLocalNative } from "./local-selection";
import {
	inspectNativeDevice,
	resolveNativeExecutable,
} from "./native-auto-device";
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
	/** Invalid configured pairs cannot become a silent AUTO CPU fallback. */
	onInvalid?: (error: Error) => void;
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
	let pairPresent = false;
	try {
		const executable = await resolveNativeExecutable(deps.nativePath);
		await access(join(dirname(executable), "bitovp-vmaf-supervisor"));
		pairPresent = true;
		prepared = await createSupervisedVmafRunner(
			{ runner: deps.runner, nativePath: deps.nativePath },
			AbortSignal.timeout(10_000),
		);
	} catch (error) {
		const unavailable =
			!pairPresent &&
			error instanceof Error &&
			(error.message === "NATIVE_EXECUTABLE_UNAVAILABLE" ||
				("code" in error && error.code === "ENOENT"));
		if (!unavailable)
			deps.onInvalid?.(
				error instanceof Error
					? error
					: new Error("VMAF_AUTO_RUNTIME_INVALID", { cause: error }),
			);
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
	const selectLocalNative: SelectLocalNative = async ({ signal, pinned }) => {
		signal.throwIfAborted();
		const ready = await initialize();
		signal.throwIfAborted();
		const assertAlias = async () => {
			if ((await resolveNativeExecutable(deps.nativePath)) !== ready.executable)
				throw new Error("VMAF_SUPERVISOR_BUILD_CHANGED");
		};
		await assertAlias();
		const backends = pinned ? [pinned.backend] : (["cuda", "vulkan"] as const);
		for (const backend of backends) {
			try {
				const inspected = await inspectNativeDevice(
					{ runner, nativePath: deps.nativePath },
					{ backend, ...(pinned ? { device: pinned.device } : {}) },
					signal,
				);
				await assertAlias();
				signal.throwIfAborted();
				const { info } = inspected;
				if (
					info.sourceSha256 !== ready.sourceSha256 ||
					(info.binarySha256 !== null &&
						info.binarySha256 !== ready.binarySha256) ||
					!info.capabilities.processSupervisor ||
					!info.capabilities.cpuParity ||
					info.capabilities.supervisorBinarySha256 !==
						ready.supervisorBinarySha256
				)
					throw new Error("NATIVE_DEVICE_INFO_BUILD_MISMATCH");
				return {
					backend,
					device: info.device.index,
					identity: {
						sourceSha256: ready.sourceSha256,
						binarySha256: ready.binarySha256,
						supervisorBinarySha256: ready.supervisorBinarySha256,
						deviceUuid: info.device.uuid,
					},
				};
			} catch (error) {
				signal.throwIfAborted();
				await assertAlias();
				if (
					pinned ||
					!(error instanceof Error) ||
					error.message !== "NATIVE_DEVICE_INFO_UNAVAILABLE"
				)
					throw error;
			}
		}
		return { backend: "cpu", reason: "GPU_NOT_AVAILABLE" };
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
	return {
		runner,
		selectLocalNative,
		resolveLocalResources,
		resolveBandingResources: createBandingResourcePlanner({
			runner,
			nativePath: deps.nativePath,
			shared,
			hostKey,
			configured: deps.configured,
		}),
		execute: shared.run.bind(shared),
	};
}
