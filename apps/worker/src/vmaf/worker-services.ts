import { join } from "node:path";
import type { cipherFromEnv, Env } from "@bitovp/core";
import { vmafJobSchema, vmafModelNeedsFile } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import {
	createVmafComputeCredentialStore,
	DEFAULT_ORGANIZATION_ID,
	listVmafCloudProfiles,
} from "@bitovp/db";
import type { Job } from "bullmq";
import type { ProcessRunner } from "../feeder/supervisor";
import { requireOrganizationId, tenantService } from "../tenant/scope";
import { createAvailableAutomaticVmafRuntime } from "./automatic-runtime";
import { createVmafCloudController } from "./cloud/controller";
import { createCloudRuntimeAuth } from "./cloud/runtime-auth";
import {
	cloudJobConcurrency,
	createLocalExecutionGate,
} from "./execution-dispatch";
import { queueExcessVmafJobs } from "./job-capacity";
import { createLiveVmafProcessor } from "./live-processor";
import { createLocalVmafResources } from "./local-resources";
import { createVmafModelResolver } from "./model-path";
import { createVmafProcessor, type VmafProcessorDeps } from "./processor";
import type { ResourceLeaseRedis } from "./resource-leases";
import { readLocalResources } from "./resources";
import { localVmafHostKey } from "./shared-execution";

type VmafWorkerServicesDeps = {
	mode: "worker" | "producer" | "dedicated";
	env: Env;
	prisma: AppPrismaClient;
	cipher: ReturnType<typeof cipherFromEnv>;
	processorDeps: Pick<VmafProcessorDeps, "resolveCredential" | "now">;
	emitEvent: VmafProcessorDeps["emitEvent"];
	orchestratorProducerQueue: VmafProcessorDeps["orchestratorQueue"];
	vmafRunner: ProcessRunner;
	wakePublisher: ResourceLeaseRedis;
	vmafWorkDir: string;
	feederSpoolDir: string;
};

/** Shared scoring, transport and admission for both entrypoints. The caller
 * owns its tenant consumer, Redis connections and reconciliation schedule. */
export async function createVmafWorkerServices({
	mode,
	env,
	prisma,
	cipher,
	processorDeps,
	emitEvent,
	orchestratorProducerQueue,
	vmafRunner,
	wakePublisher,
	vmafWorkDir,
	feederSpoolDir,
}: VmafWorkerServicesDeps) {
	const automaticVmafSelectionState: { failure?: Error } = {};
	// Read-only pair validation precedes replacing the legacy local execution path.
	const automaticVmafRuntime =
		mode !== "producer" && process.platform === "linux" && env.VMAF_NATIVE_PATH
			? await createAvailableAutomaticVmafRuntime({
					runner: vmafRunner,
					redis: wakePublisher,
					nativePath: env.VMAF_NATIVE_PATH,
					ffmpegPath: env.VMAF_FFMPEG_PATH ?? env.FFMPEG_PATH,
					ffprobePath: env.FFPROBE_PATH,
					workDirectory: join(vmafWorkDir, ".native-automatic"),
					configured: {
						threads: env.VMAF_THREADS,
						concurrency: env.VMAF_CONCURRENCY,
					},
					...(process.env.VMAF_GPU_DEVICE?.trim()
						? { device: env.VMAF_GPU_DEVICE }
						: {}),
					onDiagnostic: (message) => console.warn(`[worker:vmaf] ${message}`),
					onInvalid: (failure) => {
						automaticVmafSelectionState.failure = failure;
					},
				})
			: undefined;
	if (mode === "dedicated") {
		if (!automaticVmafRuntime || readLocalResources().budgetBytes === undefined)
			throw new Error("VMAF_DEDICATED_SHARED_RUNTIME_REQUIRED", {
				cause: automaticVmafSelectionState.failure,
			});
		await localVmafHostKey();
	}
	const localVmafResources = createLocalVmafResources({
		threads: env.VMAF_THREADS,
		concurrency: env.VMAF_CONCURRENCY,
		execute: automaticVmafRuntime?.execute,
	});
	const vmafSubsample = env.VMAF_SUBSAMPLE;
	const resolveModelPath = createVmafModelResolver({
		sdrDir: env.VMAF_MODEL_DIR,
		hdrDir: env.VMAF_HDR_MODEL_DIR,
	});
	if (env.VMAF_MODEL_DIR)
		console.log(
			`[worker:vmaf] model dir ${env.VMAF_MODEL_DIR} (model=path= enabled)`,
		);

	// Profiles are operator-owned; HTTP requests can only select their IDs.
	const vmafComputeCredentials = createVmafComputeCredentialStore(
		prisma,
		cipher,
	);
	const vmafCloudAuth = createCloudRuntimeAuth(
		vmafComputeCredentials.revealSecret,
		() => requireOrganizationId() === DEFAULT_ORGANIZATION_ID,
	);
	const vmafCloud = tenantService(() =>
		createVmafCloudController({
			prisma,
			resolveProfile: async (id) =>
				(
					await listVmafCloudProfiles(prisma, process.env.VMAF_COMPUTE_PROFILES)
				).find((profile) => profile.id === id),
			...vmafCloudAuth,
			workDir: join(vmafWorkDir, requireOrganizationId(), "cloud"),
		}),
	);
	const vmafProcessor = tenantService(() =>
		createVmafProcessor({
			cloudScore: vmafCloud.score,
			resolveCloudProfile: vmafCloud.resolveProfile,
			emitEvent,
			orchestratorQueue: orchestratorProducerQueue,
			prisma,
			resolveCredential: processorDeps.resolveCredential,
			runner: vmafRunner,
			...(automaticVmafRuntime
				? {
						localRunner: automaticVmafRuntime.runner,
						resolveLocalResources: automaticVmafRuntime.resolveLocalResources,
						resolveBandingResources:
							automaticVmafRuntime.resolveBandingResources,
						selectLocalNative: automaticVmafRuntime.selectLocalNative,
					}
				: {}),
			nativeSelectionFailure: automaticVmafSelectionState.failure,
			ffmpegPath: env.VMAF_FFMPEG_PATH ?? env.FFMPEG_PATH,
			hdrFfmpegPath: env.VMAF_HDR_FFMPEG_PATH,
			hdrFfprobePath: env.VMAF_HDR_FFPROBE_PATH,
			ffprobePath: env.FFPROBE_PATH,
			workDir: join(vmafWorkDir, requireOrganizationId()),
			decodePolicy: {
				backend: env.VMAF_DECODE_BACKEND,
				device: env.VMAF_GPU_DEVICE,
			},
			scoringBackend: env.VMAF_SCORING_BACKEND,
			reuseVerifiedNativeResults:
				env.VMAF_REUSE_VERIFIED_NATIVE_RESULTS === "1",
			...(env.VMAF_NATIVE_PATH ? { nativePath: env.VMAF_NATIVE_PATH } : {}),
			now: processorDeps.now,
			localResources: localVmafResources,
			...(env.VMAF_THREADS !== undefined ? { threads: env.VMAF_THREADS } : {}),
			...(env.VMAF_CONCURRENCY !== undefined
				? { concurrency: env.VMAF_CONCURRENCY }
				: {}),
			...(vmafSubsample !== undefined ? { subsample: vmafSubsample } : {}),
			...(resolveModelPath ? { resolveModelPath } : {}),
		}),
	);
	const liveVmafProcessor = tenantService(() =>
		createLiveVmafProcessor({
			emitEvent,
			prisma,
			resolveCredential: processorDeps.resolveCredential,
			runner: automaticVmafRuntime?.runner ?? vmafRunner,
			...(automaticVmafRuntime
				? { resolveLocalResources: automaticVmafRuntime.resolveLocalResources }
				: {}),
			ffmpegPath: env.FFMPEG_PATH,
			ffprobePath: env.FFPROBE_PATH,
			workDir: join(vmafWorkDir, requireOrganizationId()),
			spoolDir: join(feederSpoolDir, requireOrganizationId()),
			now: processorDeps.now,
			localResources: localVmafResources,
			...(env.VMAF_THREADS !== undefined ? { threads: env.VMAF_THREADS } : {}),
			...(vmafSubsample !== undefined ? { subsample: vmafSubsample } : {}),
			...(resolveModelPath ? { resolveModelPath } : {}),
		}),
	);
	const localVmafExecution = automaticVmafRuntime
		? <T>(run: () => Promise<T>): Promise<T> => run()
		: createLocalExecutionGate();
	const dispatchVmaf = async (jobData: unknown): Promise<unknown> => {
		const { vmafJobId } = vmafJobSchema.parse(jobData);
		const job = await prisma.vmafJob.findUnique({
			where: { id: vmafJobId },
			select: { mode: true, params: true },
		});
		if (job?.mode === "LIVE") {
			return localVmafExecution(() => liveVmafProcessor.process(jobData));
		}
		const params = job?.params as { execution?: { backend?: string } } | null;
		return params?.execution?.backend === "CLOUD"
			? vmafProcessor.process(jobData)
			: localVmafExecution(() => vmafProcessor.process(jobData));
	};
	const VMAF_CLOUD_JOB_CONCURRENCY = cloudJobConcurrency(
		process.env.VMAF_JOB_CONCURRENCY,
		true, // Named database profiles may be added without restarting.
	);
	const VMAF_JOB_CONCURRENCY = process.env.VMAF_JOB_CONCURRENCY?.trim()
		? VMAF_CLOUD_JOB_CONCURRENCY
		: Math.min(
				32,
				VMAF_CLOUD_JOB_CONCURRENCY +
					(automaticVmafRuntime
						? Math.max(1, Math.floor(readLocalResources().cpuCapacity))
						: 1),
			);
	// Both entrypoints wrap this handler with the tenant consumer before
	// classification, so all reads and credential lookups are tenant scoped.
	const classifyVmafJob = async (
		job: Job,
	): Promise<"local" | "cloud" | "control"> => {
		const { vmafJobId } = vmafJobSchema.parse(job.data);
		const row = await prisma.vmafJob.findUnique({
			where: { id: vmafJobId },
			select: { mode: true, params: true, status: true },
		});
		if (!row || !["PENDING", "RUNNING"].includes(row.status)) return "control";
		if (row.mode === "LIVE") return "local";
		const params = row.params as { execution?: { backend?: string } } | null;
		return params?.execution?.backend === "CLOUD" ? "cloud" : "local";
	};
	const admitVmaf = <T>(handler: (job: Job) => Promise<T>) =>
		queueExcessVmafJobs({
			localCapacity: () =>
				automaticVmafRuntime ? localVmafResources.jobCapacity() : 1,
			cloudCapacity: VMAF_CLOUD_JOB_CONCURRENCY,
			classify: classifyVmafJob,
			process: handler,
		});
	return {
		dispatchVmaf,
		admitVmaf,
		concurrency: VMAF_JOB_CONCURRENCY,
		reconcileCloud: vmafCloud.reconcile,
		isModelAvailable: (model: string) =>
			!vmafModelNeedsFile(model) || resolveModelPath?.(model) !== undefined,
	};
}
