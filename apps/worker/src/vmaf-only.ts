import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cipherFromEnv, loadEnv, QUEUE_NAMES } from "@bitovp/core";
import {
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
	createVmafComputeCredentialStore,
	DEFAULT_ORGANIZATION_ID,
	getIdentityPrisma,
	listVmafCloudProfiles,
	TENANT_ORGANIZATION,
} from "@bitovp/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createNodeProcessRunner } from "./feeder/process-runner";
import { createEventEmitter } from "./notify/emitter";
import { createTenantDispatcher } from "./tenant/dispatch";
import { tenantQueue } from "./tenant/queue";
import {
	contextualTenantPrisma,
	requireOrganizationId,
	tenantService,
} from "./tenant/scope";
import { createAvailableAutomaticVmafRuntime } from "./vmaf/automatic-runtime";
import { createVmafCloudController } from "./vmaf/cloud/controller";
import { createCloudRuntimeAuth } from "./vmaf/cloud/runtime-auth";
import { cloudJobConcurrency } from "./vmaf/execution-dispatch";
import { createLiveVmafProcessor } from "./vmaf/live-processor";
import { createLocalVmafResources } from "./vmaf/local-resources";
import { createVmafModelResolver } from "./vmaf/model-path";
import { createVmafOnlyConsumer } from "./vmaf/only-consumer";
import { createVmafProcessor } from "./vmaf/processor";
import { readLocalResources } from "./vmaf/resources";

// Dedicated replica: no import of the all-queue bootstrap, background sweeps,
// feeder lifecycle, editing readiness, heartbeat or repeatable schedulers.
const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = loadEnv();
const basePrisma = createPrismaClient(env.DATABASE_URL);
const tenantClients = new Map<
	string,
	ReturnType<typeof createTenantPrismaClient>
>();
const prisma = contextualTenantPrisma((organizationId) => {
	let client = tenantClients.get(organizationId);
	if (!client) {
		client = createTenantPrismaClient(basePrisma, organizationId);
		tenantClients.set(organizationId, client);
	}
	return client;
}, TENANT_ORGANIZATION);
const identityPrisma = getIdentityPrisma();
const cipher = cipherFromEnv();
const credentials = createCredentialStore(prisma, cipher);
const resolveCredential = async (credentialId: string) => {
	const credential = await credentials.get(credentialId);
	if (!credential) throw new Error("Storage credential no longer exists");
	return {
		provider: credential.provider,
		config: (credential.config ?? {}) as Record<string, unknown>,
		secret: JSON.parse(await credentials.revealSecret(credentialId)) as Record<
			string,
			string
		>,
	};
};
// These are producers only, for the existing QC terminal event and gate
// continuation contracts. No consumer for either queue is created here.
const notifyQueue = tenantQueue(
	new Queue(QUEUE_NAMES.notify, { connection: { url: env.REDIS_URL } }),
);
const orchestratorQueue = tenantQueue(
	new Queue(QUEUE_NAMES.orchestrator, { connection: { url: env.REDIS_URL } }),
);
const emitEvent = tenantService(() =>
	createEventEmitter({
		queue: notifyQueue,
		publicBaseUrl: env.PUBLIC_BASE_URL,
	}),
);
const redis = new Redis(env.REDIS_URL);
const runner = createNodeProcessRunner();
const workDir = env.VMAF_WORKDIR ?? join(tmpdir(), "bitovp-vmaf");
const selection: { failure?: Error } = {};
const automatic =
	process.platform === "linux" && env.VMAF_NATIVE_PATH
		? await createAvailableAutomaticVmafRuntime({
				runner,
				redis,
				nativePath: env.VMAF_NATIVE_PATH,
				ffmpegPath: env.VMAF_FFMPEG_PATH ?? env.FFMPEG_PATH,
				ffprobePath: env.FFPROBE_PATH,
				workDirectory: join(workDir, ".native-automatic"),
				configured: {
					threads: env.VMAF_THREADS,
					concurrency: env.VMAF_CONCURRENCY,
				},
				...(process.env.VMAF_GPU_DEVICE?.trim()
					? { device: env.VMAF_GPU_DEVICE }
					: {}),
				onDiagnostic: (message) => console.warn(`[worker:vmaf] ${message}`),
				onInvalid: (failure) => {
					selection.failure = failure;
				},
			})
		: undefined;
const localResources = createLocalVmafResources({
	threads: env.VMAF_THREADS,
	concurrency: env.VMAF_CONCURRENCY,
	execute: automatic?.execute,
});
const resolveModelPath = createVmafModelResolver({
	sdrDir: env.VMAF_MODEL_DIR,
	hdrDir: env.VMAF_HDR_MODEL_DIR,
});
const computeCredentials = createVmafComputeCredentialStore(prisma, cipher);
const cloud = tenantService(() =>
	createVmafCloudController({
		prisma,
		resolveProfile: async (id) =>
			(
				await listVmafCloudProfiles(prisma, process.env.VMAF_COMPUTE_PROFILES)
			).find((profile) => profile.id === id),
		...createCloudRuntimeAuth(
			computeCredentials.revealSecret,
			() => requireOrganizationId() === DEFAULT_ORGANIZATION_ID,
		),
		workDir: join(workDir, requireOrganizationId(), "cloud"),
	}),
);
const now = () => new Date().toISOString();
const vod = tenantService(() =>
	createVmafProcessor({
		prisma,
		resolveCredential,
		runner,
		emitEvent,
		orchestratorQueue,
		cloudScore: cloud.score,
		resolveCloudProfile: cloud.resolveProfile,
		...(automatic
			? {
					localRunner: automatic.runner,
					resolveLocalResources: automatic.resolveLocalResources,
					resolveBandingResources: automatic.resolveBandingResources,
					selectLocalNative: automatic.selectLocalNative,
				}
			: {}),
		nativeSelectionFailure: selection.failure,
		ffmpegPath: env.VMAF_FFMPEG_PATH ?? env.FFMPEG_PATH,
		ffprobePath: env.FFPROBE_PATH,
		hdrFfmpegPath: env.VMAF_HDR_FFMPEG_PATH,
		hdrFfprobePath: env.VMAF_HDR_FFPROBE_PATH,
		workDir: join(workDir, requireOrganizationId()),
		now,
		localResources,
		decodePolicy: {
			backend: env.VMAF_DECODE_BACKEND,
			device: env.VMAF_GPU_DEVICE,
		},
		scoringBackend: env.VMAF_SCORING_BACKEND,
		...(env.VMAF_NATIVE_PATH ? { nativePath: env.VMAF_NATIVE_PATH } : {}),
		...(env.VMAF_THREADS !== undefined ? { threads: env.VMAF_THREADS } : {}),
		...(env.VMAF_CONCURRENCY !== undefined
			? { concurrency: env.VMAF_CONCURRENCY }
			: {}),
		...(env.VMAF_SUBSAMPLE !== undefined
			? { subsample: env.VMAF_SUBSAMPLE }
			: {}),
		...(resolveModelPath ? { resolveModelPath } : {}),
	}),
);
const live = tenantService(() =>
	createLiveVmafProcessor({
		prisma,
		resolveCredential,
		emitEvent,
		runner: automatic?.runner ?? runner,
		...(automatic
			? { resolveLocalResources: automatic.resolveLocalResources }
			: {}),
		ffmpegPath: env.FFMPEG_PATH,
		ffprobePath: env.FFPROBE_PATH,
		workDir: join(workDir, requireOrganizationId()),
		spoolDir: join(
			env.FEEDER_SPOOL_DIR ?? join(tmpdir(), "bitovp-feeder"),
			requireOrganizationId(),
		),
		now,
		localResources,
		...(env.VMAF_THREADS !== undefined ? { threads: env.VMAF_THREADS } : {}),
		...(env.VMAF_SUBSAMPLE !== undefined
			? { subsample: env.VMAF_SUBSAMPLE }
			: {}),
		...(resolveModelPath ? { resolveModelPath } : {}),
	}),
);
const cloudCapacity = cloudJobConcurrency(
	process.env.VMAF_JOB_CONCURRENCY,
	true,
);
const concurrency = process.env.VMAF_JOB_CONCURRENCY?.trim()
	? cloudCapacity
	: Math.min(
			32,
			cloudCapacity +
				(automatic
					? Math.max(1, Math.floor(readLocalResources().cpuCapacity))
					: 1),
		);
const worker = createVmafOnlyConsumer({
	prisma,
	redisUrl: env.REDIS_URL,
	forEachOrganization: createTenantDispatcher(identityPrisma),
	isOrganizationActive: async (organizationId) =>
		(
			await identityPrisma.organization.findUnique({
				where: { id: organizationId },
				select: { active: true },
			})
		)?.active === true,
	...(process.env.TENANT_MIGRATE_LEGACY_QUEUES === "1"
		? { legacyOrganizationId: DEFAULT_ORGANIZATION_ID }
		: {}),
	processVod: vod.process,
	processLive: live.process,
	automaticRuntime: Boolean(automatic),
	localCapacity: () => (automatic ? localResources.jobCapacity() : 1),
	cloudCapacity,
	concurrency,
	maxStalledCount: env.WORKER_MAX_STALLED_COUNT,
});
let closing: Promise<void> | undefined;
function shutdown() {
	closing ??= (async () => {
		// Drain this replica's active QC normally before releasing its Redis/DB
		// handles. There are no feeder stops or global queue pause operations.
		await worker.close();
		await Promise.all([notifyQueue.close(), orchestratorQueue.close()]);
		await redis.quit();
		await basePrisma.$disconnect();
	})();
	void closing.then(
		() => process.exit(0),
		() => {
			console.error("[worker:vmafRunner] shutdown failed");
			process.exit(1);
		},
	);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
