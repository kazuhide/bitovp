import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	cipherFromEnv,
	enqueueFeederJob,
	FEEDER_CONCURRENCY,
	INGRESS_RESOLVE_INTERVAL_MS,
	loadEnv,
	parseIngressConfig,
	parseSecretEgressAllowlist,
	parseStorageEndpointAllowlist,
	QUEUE_NAMES,
	type QueueKey,
	REGISTRATION_RECONCILE_INTERVAL_MS,
	redactSecrets,
	SLATE_NORMALIZE_PROMOTE_JOB,
	submitEncodingJob,
	vmafJobSchema,
	vmafModelNeedsFile,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import {
	acknowledgeResetCleanupEntity,
	appendResetCleanupEncoding,
	createBitmovinAccountStore,
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
	createVmafComputeCredentialStore,
	DEFAULT_ORGANIZATION_ID,
	getIdentityPrisma,
	listVmafCloudProfiles,
	recordUnrestrictedEgress,
	TENANT_ORGANIZATION,
} from "@bitovp/db";
import type { BrowserCredential } from "@bitovp/storage";
import { createBrowserForCredential } from "@bitovp/storage";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createAlertEngine, createOrphanResolver } from "./alerts/engine";
import { seedDefaultAlertRules } from "./alerts/seed";
import { feederOwnerId } from "./feeder/ownership";
import {
	createNodeProcessCommandReader,
	createNodeProcessRunner,
} from "./feeder/process-runner";
import {
	createFeederProcessor,
	FEEDER_TAKEOVER_DRAIN_MS,
} from "./feeder/processor";
import { createFeederOrphanReconciler } from "./feeder/reconcile-orphans";
import { createHandlers, HEARTBEAT_SWEEP_JOB } from "./handlers";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "./heartbeat-cadence";
import { createIngressMonitor } from "./ingress/monitor";
import {
	createBoundedObjectProbe,
	createStorageInspectProcessor,
} from "./inspect/processor";
import { createInspectionPrune } from "./inspect/prune";
import { createStrandedInspectionReconciler } from "./inspect/reconcile-stranded";
import {
	ANALYSIS_SWEEP_INTERVAL_MS,
	createAnalysisProvider,
	createAnalysisSweep,
} from "./library/analysis-sweep";
import { createLibraryCaptureSweep } from "./library/capture-sweep";
import { createStoredAnalysisReader } from "./library/stored-analysis";
import { createShutdown, createSweepLoop } from "./lifecycle";
import {
	isFinalManualStopFailure,
	isManualStopJob,
	recordDeadFeederJob,
	recordDeadJobScheduleOutcomes,
	recordFinalManualStopFailure,
	releaseDeadStageClaim,
} from "./live/dead-job-outcome";
import { releaseDeadLiveToVodIfFinal } from "./live/live-to-vod-release";
import { createOriginObserver } from "./live/origin-observer";
import {
	createProbeBatchProcessor,
	reconcileAbandonedProbes,
} from "./live/probe-runner";
import {
	ABANDONED_LEASE_SWEEP_MS,
	reconcileAbandonedLeases,
} from "./live/provision-lease";
import {
	createStrandedRunReconciler,
	retireTransitionalRuns,
} from "./live/reconcile-stranded-runs";
import { createRunHeartbeatSummarizer } from "./live/run-heartbeat-summary";
import { reconcileStartupCancellations } from "./live/startup-cancel";
import {
	liveChannelConcurrency,
	reserveLiveStopCapacity,
} from "./live-capacity";
import { createInboundDispatcher } from "./notify/dispatcher";
import { createEventEmitter } from "./notify/emitter";
import { createNotifyProcessor } from "./notify/processor";
import { createWakeBus } from "./notify/wake-bus";
import {
	createLiveChannelProcessor,
	createLiveHeartbeatSweep,
	type LiveChannelDeps,
	PROVISION_LEASE_MS,
} from "./orchestrator/live-processor";
import { makeWorkerSdk } from "./orchestrator/make-sdk";
import {
	claimableWhere,
	createOrchestratorProcessor,
} from "./orchestrator/processor";
import {
	createUnstoppedEncodingReconciler,
	stopRemoteEncodingsFor,
} from "./orchestrator/stop-remote-encodings";
import { createResetCleanupSweep } from "./reset/cleanup";
import { resetCleanupProvider } from "./reset/provider";
import {
	createScheduleSweep,
	DEFAULT_START_GRACE_MINUTES,
	SCHEDULE_SWEEP_INTERVAL_MS,
} from "./scheduler/sweep";
import { qcVmafEnabled } from "./settings/feature-flags";
import { readLiveHeartbeatConfig } from "./settings/live-heartbeat";
import {
	createSlateNormalizeProcessor,
	createSlateNormalizePromoter,
	SLATE_NORMALIZE_PROMOTE_INTERVAL_MS,
} from "./slate/normalize-processor";
import { createSlatePreparer } from "./slate/prepare";
import {
	DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
	stallOptionsFor,
} from "./stall-policy";
import { createTenantConsumer } from "./tenant/consumer";
import { createTenantDispatcher } from "./tenant/dispatch";
import { tenantQueue } from "./tenant/queue";
import {
	contextualTenantPrisma,
	forEachTenantService,
	requireOrganizationId,
	tenantService,
} from "./tenant/scope";
import { tenantWakeSleep } from "./tenant/wake";
import { createUsageBackfillProcessor } from "./usage/statistics-backfill";
import {
	createUsageStatisticsProvider,
	sweepUsageStatistics,
	USAGE_SWEEP_FIRST_DELAY_MS,
	USAGE_SWEEP_INTERVAL_MS,
} from "./usage/statistics-sweep";
import { createVmafCloudController } from "./vmaf/cloud/controller";
import { createCloudRuntimeAuth } from "./vmaf/cloud/runtime-auth";
import {
	cloudJobConcurrency,
	createLocalExecutionGate,
} from "./vmaf/execution-dispatch";
import { createLiveVmafProcessor } from "./vmaf/live-processor";
import { createLocalVmafResources } from "./vmaf/local-resources";
import { createVmafProcessor } from "./vmaf/processor";
import { createStrandedVmafReconciler } from "./vmaf/reconcile-stranded";
import { createVmafTrigger } from "./vmaf/trigger";
import { createWatchSweep } from "./watch/sweep";
import { createRegistrarProvider } from "./webhooks/provider";
import { createWebhookRegistrar } from "./webhooks/registrar";

// Next.js loads .env itself; plain Node processes do not. Pull the repo-root
// .env (if present) before reading config — same depth from src/ (tsx) and
// dist/ (bundled), absent in containers where env comes from the runtime.
const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) {
	process.loadEnvFile(envFile);
}

const env = loadEnv();
// Reserve one total slot for stop/cancellation even while ordinary Live work
// waits on the provider. The same total config drives admission and BullMQ.
const LIVE_CHANNEL_CONCURRENCY = liveChannelConcurrency(
	process.env.LIVE_CHANNEL_CONCURRENCY,
);

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
const forEachOrganization = createTenantDispatcher(identityPrisma);
const isOrganizationActive = async (organizationId = requireOrganizationId()) =>
	(
		await identityPrisma.organization.findUnique({
			where: { id: organizationId },
			select: { active: true },
		})
	)?.active === true;
const consumeTenantJob = createTenantConsumer({
	prisma,
	forEachOrganization,
	isOrganizationActive,
	...(process.env.TENANT_MIGRATE_LEGACY_QUEUES === "1"
		? { legacyOrganizationId: DEFAULT_ORGANIZATION_ID }
		: {}),
});

let stopping = false;
function runTenantTick(run: () => unknown): void {
	if (stopping) return;
	void forEachOrganization(() => (stopping ? undefined : run())).catch(() =>
		console.error("[tenant] background tick failed; next tick retries"),
	);
}
function setTenantInterval(run: () => unknown, ms: number) {
	return setInterval(() => runTenantTick(run), ms);
}
function setTenantTimeout(run: () => unknown, ms: number) {
	return setTimeout(() => runTenantTick(run), ms);
}
const cipher = cipherFromEnv();
const credentials = createCredentialStore(prisma, cipher);
const bitmovinAccounts = createBitmovinAccountStore(prisma, cipher);
const resetCleanup = tenantService(() =>
	createResetCleanupSweep({
		prisma,
		cipher,
		providerFor: resetCleanupProvider(cipher),
	}),
);
const resetCleanupLoop = tenantService(() =>
	createSweepLoop(resetCleanup, () =>
		console.error("[reset-cleanup] retry pending"),
	),
);
runTenantTick(() => resetCleanupLoop.run());
setTenantInterval(() => resetCleanupLoop.run(), 30_000).unref();

// Producer side of the feeder queue: the live channel worker enqueues
// feeder stops when a channel stops (P3-PR3 lifecycle coupling). The
// shared core helper applies the producer jobId convention (start = row
// id, stop = `<sessionId>:stop` deduped against route stops) and clears a
// SETTLED job parked under the stop id — failed or completed — so retries
// and reclaim stops are never swallowed. Also read by the orphan sweep
// below, which uses the START job's state to decide whether anybody is
// still supervising a push.
const feederQueue = tenantQueue(
	new Queue(QUEUE_NAMES.feederManager, {
		connection: { url: env.REDIS_URL },
	}),
);

// Producer side of the VMAF queue: the orchestrator enqueues a VMAF job when a
// VOD encoding that requested VMAF or PSNR reaches FINISHED (the trigger below).
const vmafQueue = tenantQueue(
	new Queue(QUEUE_NAMES.vmafRunner, {
		connection: { url: env.REDIS_URL },
	}),
);
const vmafTrigger = tenantService(() =>
	createVmafTrigger({
		prisma,
		queue: vmafQueue,
		allowNewWork: isOrganizationActive,
	}),
);

// Producer side of the ORCHESTRATOR queue : the vmaf-runner
// enqueues the post-QC continuation that wakes an AWAITING_QC encoding once
// the gate verdict is written. The consumer is this same process's worker.
// Producer-side handle for the stranded-inspection reconcile (#134): getJob
// answers "is anyone still working on this row" exactly, because the route
// enqueues with jobId = row id.
const storageInspectQueue = tenantQueue(
	new Queue(QUEUE_NAMES.storageInspect, {
		connection: { url: env.REDIS_URL },
	}),
);
// : slate normalization — the direct route enqueues, this process
// consumes, and the promoter below re-queues rows that were waiting for the
// live input.
const slateNormalizeQueue = tenantQueue(
	new Queue(QUEUE_NAMES.slateNormalize, {
		connection: { url: env.REDIS_URL },
	}),
);
const orchestratorProducerQueue = tenantQueue(
	new Queue(QUEUE_NAMES.orchestrator, {
		connection: { url: env.REDIS_URL },
	}),
);

// Outbound notification bus : every processor's terminal
// transitions emit product events into this queue; the consumer fans them
// out to matching channels. Best-effort at the emit end by contract.
const notifyQueue = tenantQueue(
	new Queue(QUEUE_NAMES.notify, {
		connection: { url: env.REDIS_URL },
	}),
);
const emitEvent = tenantService(() =>
	createEventEmitter({
		queue: notifyQueue,
		publicBaseUrl: env.PUBLIC_BASE_URL,
	}),
);

// Inbound dispatch . A dedicated
// pub/sub pair: BullMQ owns its own connections and a SUBSCRIBED ioredis
// client cannot issue commands, so these two are separate by protocol.
const WAKE_CHANNEL_PREFIX = "bm-events:";
const wakeBus = createWakeBus();
const wakePublisher = new Redis(env.REDIS_URL);
const wakeSubscriber = new Redis(env.REDIS_URL);
wakeSubscriber.psubscribe(`${WAKE_CHANNEL_PREFIX}*`).catch((err) => {
	// An INITIAL psubscribe failure records no subscription intent, so
	// ioredis' autoResubscribe never re-arms it — wakes are off until restart
	// and behaviour degrades to exactly the fixed poll (#89 records the
	// class; review-186 N4 named this one-shot edge; a mid-life Redis bounce
	// DOES resubscribe automatically).
	console.error(
		"[dispatch] psubscribe failed (wakes off until restart; polling unaffected):",
		err instanceof Error ? err.message : err,
	);
});
wakeSubscriber.on("pmessage", (_pattern, channel) => {
	wakeBus.signal(channel.slice(WAKE_CHANNEL_PREFIX.length));
});
const wakeSleep = tenantWakeSleep(wakeBus);
const inboundDispatch = tenantService(() =>
	createInboundDispatcher({
		prisma,
		publish: async (encodingId) => {
			await wakePublisher.publish(
				`${WAKE_CHANNEL_PREFIX}${requireOrganizationId()}:${encodingId}`,
				"poll",
			);
		},
		now: () => new Date(),
	}),
);
// Watch-folder sweep : lists customer buckets (never
// writes), auto-submits stable new objects through CORE's submitEncodingJob
// — the same pipeline the API route runs, with worker-process deps. 30s
// tick; per-rule pollIntervalSec/backoff gate the actual work. Shares the
// orchestrator producer queue declared above (the #86 continuation's).
/** Validation context for watch-folder submissions, including DRM and secret egress. */
const workerValidationOptions = async () => ({
	secretEgressAllowedHosts: parseSecretEgressAllowlist(
		env.SECRET_EGRESS_ALLOWED_HOSTS,
	),
	credentialProviders: new Map(
		(
			await prisma.credential.findMany({
				select: { id: true, provider: true },
			})
		).map((c) => [c.id, c.provider as string]),
	) as ReadonlyMap<string, string>,
	// , rail 3b. The worker is the UNATTENDED submitter — the
	// watch-folder sweep auto-submits through here with no human at the door —
	// so it is the seam that must not be the one left behind. The web app's
	// mirror lives in `submitterValidationOptions`, and the two have already
	// diverged once on a gate: this one was declared and never passed.
	credentialHasPublishingAuth: await credentials.publishingAuthCredentialIds(),
});
const watchSweep = tenantService(() =>
	createWatchSweep({
		prisma,
		listPage: async (rule, cursor) => {
			const credential = await credentials.get(rule.credentialId);
			if (!credential) {
				throw new Error("Watch rule credential no longer exists");
			}
			const secret = JSON.parse(
				await credentials.revealSecret(rule.credentialId),
			) as Record<string, string>;
			const browser = createBrowserForCredential(
				{
					provider: credential.provider as BrowserCredential["provider"],
					config: (credential.config ?? {}) as Record<string, unknown>,
					secret,
				},
				{
					// : the STORAGE_ENDPOINT_ALLOWED_HOSTS rail for the
					// sweep's GENERIC_S3 listing — same trust decision as C22.
					endpointAllowlist:
						process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS === undefined
							? undefined
							: parseStorageEndpointAllowlist(
									process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS,
								),
					onWarning: (message) => console.warn(`[watch] ${message}`),
				},
			);
			try {
				const page = await browser.listObjects({
					bucket: rule.bucket,
					prefix: rule.prefix,
					cursor,
					recursive: true,
				});
				return { objects: page.objects, nextCursor: page.nextCursor };
			} finally {
				browser.dispose?.();
			}
		},
		submitPlan: async (plan, provenance) =>
			submitEncodingJob(plan, {
				internalHevcV2AccountId: env.BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID,
				//  (review-265 131-A2): the watch sweep is UNATTENDED —
				// every 30s, for as long as a rule is armed. Without this gate a
				// deployment with QC off minted a permanently-parked job per
				// detected object, with nobody watching.
				qcVmafEnabled: async () => (await qcVmafEnabled(prisma)) === true,
				cloudVmafProfileAvailable: async (profileId) =>
					(
						await listVmafCloudProfiles(
							prisma,
							process.env.VMAF_COMPUTE_PROFILES,
						)
					).some((profile) => profile.id === profileId),

				...(provenance ? { provenance } : {}),
				validationOptions: await workerValidationOptions(),
				recordEgress: (issues, bitmovinAccountId) =>
					recordUnrestrictedEgress(prisma, issues, {
						path: "worker:watch-sweep",
						bitmovinAccountId,
						// An explicit sentinel, not a null: no user submitted this,
						// the unattended sweep did, and the row should say so.
						actor: "worker:watch-sweep",
					}),
				loadAccountDefaults: (accountId) => bitmovinAccounts.get(accountId),
				createJob: async (data) =>
					prisma.encodingJob.create({
						data: {
							...data,
							// #32 §5: the unattended sweep is the creator, matching
							// its own egress-audit actor above.
							createdBy: "worker:watch-sweep",
							plan: data.plan as unknown as Prisma.InputJsonValue,
							stepLog: data.stepLog as unknown as Prisma.InputJsonValue,
						},
						select: { id: true },
					}),
				enqueue: async (jobId) => {
					await orchestratorProducerQueue.add(
						"orchestrate",
						{ encodingJobId: jobId },
						{ jobId, removeOnComplete: 1000, removeOnFail: 1000 },
					);
				},
				markEnqueueFailed: async (jobId) => {
					await prisma.encodingJob.update({
						where: { id: jobId },
						data: { status: "ERROR", error: "Enqueue failed — retry the job" },
					});
				},
			}),
		emitEvent,
		now: () => new Date(),
		uuid: () => randomUUID(),
	}),
);
const WATCH_SWEEP_INTERVAL_MS = 30_000;
setTenantInterval(async () => {
	if (!(await isOrganizationActive())) return;
	return watchSweep().catch((err) =>
		console.error(
			"[watch] sweep tick failed (next tick retries):",
			err instanceof Error ? err.message : err,
		),
	);
}, WATCH_SWEEP_INTERVAL_MS).unref();

// Public ingress monitor (WP-G G-1): resolves this install's public base URL
// in the configured INGRESS_MODE, persists it under AppSetting[ingress.current]
// (the web app reads THAT, never the env) and emits INGRESS_CHANGED when it
// moves. A boot tick, then the 30s cadence; the sweep-loop shape so shutdown
// can drain a tick mid-persist. `parseIngressConfig` throws on a typo'd mode —
// deliberately fatal at boot rather than a silent "no webhooks".
// Per-encoding webhook registrar (WP-G G-2): reconciles WebhookRegistration
// against live jobs/runs + the persisted ingress every 10s — registers the
// four kinds (createByEncodingId, signed) once an encoding id exists, deletes
// at the provider on terminal/orphan, re-registers on an ingress or master
// change. A reconciler over persisted state rather than a hook in the
// orchestrator's lease-fenced step loop: crash-safe by construction and
// idempotent (a second start finds its rows). The ingress monitor's onChange
// runs a tick immediately so a rotated tunnel URL is re-registered within
// one provider round-trip, not one cadence.
const webhookRegistrar = tenantService(() =>
	createWebhookRegistrar({
		prisma,
		cipher,
		envSecret: env.BITMOVIN_WEBHOOK_SECRET,
		// WP-G G-3 (C37): the account-level Live Encoding Heartbeat hook. Its
		// cadence is Settings → Live (AppSetting `live:heartbeat-webhook`), read AT
		// USE once per tick, with HEARTBEAT_WEBHOOK_INTERVAL_S /
		// HEARTBEAT_WEBHOOK_IDLE_MINUTES as the deployment default (20 s is the
		// provider default, C37; 60 min is ours). `0` / `off` resolves to null: no hook, and an
		// existing one retires as idle — rev414 O1.
		heartbeat: () => readLiveHeartbeatConfig(prisma, process.env),
		heartbeatRolloutEnabledAt: async () =>
			(
				await identityPrisma.organization.findUnique({
					where: { id: requireOrganizationId() },
					select: { createdAt: true },
				})
			)?.createdAt ?? null,
		providerFor: createRegistrarProvider({
			prisma,
			revealBitmovinAccount: async (accountId) => {
				const account = await bitmovinAccounts.get(accountId);
				if (!account) {
					throw new Error("Bitmovin account no longer exists");
				}
				return {
					apiKey: await bitmovinAccounts.revealApiKey(accountId),
					tenantOrgId: account.tenantOrgId,
				};
			},
		}),
	}),
);
const registrarLoop = tenantService(() =>
	createSweepLoop(
		() => webhookRegistrar.tick(),
		(err) =>
			console.error(
				"[webhook-registrar] tick failed (next tick retries):",
				err instanceof Error ? err.message : err,
			),
	),
);

const captureLibrarySources = tenantService(() =>
	createLibraryCaptureSweep({ prisma }),
);
const importLibraryAnalysis = tenantService(() =>
	createAnalysisSweep({
		prisma,
		readOutput: createStoredAnalysisReader(async (credentialId) => {
			const credential = await credentials.get(credentialId);
			if (!credential) throw new Error("Storage credential no longer exists");
			return createBrowserForCredential(
				{
					provider: credential.provider as BrowserCredential["provider"],
					config: (credential.config ?? {}) as Record<string, unknown>,
					secret: JSON.parse(await credentials.revealSecret(credentialId)),
				},
				{
					readTimeoutMs: 25_000,
					endpointAllowlist:
						process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS === undefined
							? undefined
							: parseStorageEndpointAllowlist(
									process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS,
								),
				},
			);
		}),
		providerFor: createAnalysisProvider({
			revealBitmovinAccount: async (accountId) => {
				const account = await bitmovinAccounts.get(accountId);
				if (!account) throw new Error("Bitmovin account no longer exists");
				return {
					apiKey: await bitmovinAccounts.revealApiKey(accountId),
					tenantOrgId: account.tenantOrgId,
				};
			},
		}),
	}),
);
const analysisSweepLoop = tenantService(() =>
	createSweepLoop(
		async () => {
			await captureLibrarySources();
			await importLibraryAnalysis();
		},
		() => console.error("[library-analysis] sweep failed; next tick retries"),
	),
);
runTenantTick(() => analysisSweepLoop.run());
setTenantInterval(
	() => analysisSweepLoop.run(),
	ANALYSIS_SWEEP_INTERVAL_MS,
).unref();

const ingressMonitor = tenantService(() =>
	createIngressMonitor({
		prisma,
		config: parseIngressConfig(process.env),
		emitEvent,
		onChange: () => registrarLoop.run(),
	}),
);
const ingressLoop = tenantService(() =>
	createSweepLoop(
		() => ingressMonitor.tick(),
		(err) =>
			console.error(
				"[ingress] resolve tick failed (next tick retries):",
				err instanceof Error ? err.message : err,
			),
	),
);
runTenantTick(() => ingressLoop.run());
setTenantInterval(() => ingressLoop.run(), INGRESS_RESOLVE_INTERVAL_MS).unref();

// : the usage statistics sweep — Bitmovin's daily VOD / live encoding
// statistics per account, with a routine 90-day initial window. Older aggregate
// history uses the explicit backfill queue. In-process interval, best-effort, next tick retries;
// the first run is delayed so a boot is not a burst of provider reads.
const usageProviderFor = tenantService(() =>
	createUsageStatisticsProvider({
		revealBitmovinAccount: async (accountId) => {
			const account = await bitmovinAccounts.get(accountId);
			if (!account) {
				throw new Error("Bitmovin account no longer exists");
			}
			return {
				apiKey: await bitmovinAccounts.revealApiKey(accountId),
				tenantOrgId: account.tenantOrgId,
			};
		},
	}),
);
const runUsageSweep = async () => {
	if (!(await isOrganizationActive())) return;
	return sweepUsageStatistics({ prisma, providerFor: usageProviderFor })
		.then((stats) => {
			if (stats.rowsUpserted > 0 || stats.errors.length > 0) {
				console.log(
					`[usage-sweep] accounts=${stats.accounts} rows=${stats.rowsUpserted} skipped=${stats.skippedNoDate} errors=${stats.errors.length}`,
				);
			}
		})
		.catch((err) => console.error("[usage-sweep] tick failed:", err));
};
setTenantTimeout(runUsageSweep, USAGE_SWEEP_FIRST_DELAY_MS).unref();
setTenantInterval(runUsageSweep, USAGE_SWEEP_INTERVAL_MS).unref();
runTenantTick(() => registrarLoop.run());
setTenantInterval(
	() => registrarLoop.run(),
	REGISTRATION_RECONCILE_INTERVAL_MS,
).unref();

// 5s interval, heartbeat-sweep precedent: best-effort, a failure logs and
// the next tick retries; polling remains the state driver regardless.
const DISPATCH_INTERVAL_MS = 5_000;
setTenantInterval(() => {
	inboundDispatch().catch((err) =>
		console.error(
			"[dispatch] tick failed (polling unaffected):",
			err instanceof Error ? err.message : err,
		),
	);
}, DISPATCH_INTERVAL_MS).unref();

// Shared by the VOD orchestrator and the live channel worker — both replay
// compiled step logs through the same executor/sdk-ops boundary.
const processorDeps: LiveChannelDeps = {
	prisma,
	emitEvent,
	wakeSleep,
	enqueueFeederJob: (job) => enqueueFeederJob(feederQueue, job),
	async revealBitmovinAccount(accountId) {
		const account = await bitmovinAccounts.get(accountId);
		if (!account) {
			throw new Error("Bitmovin account no longer exists");
		}
		return {
			apiKey: await bitmovinAccounts.revealApiKey(accountId),
			tenantOrgId: account.tenantOrgId,
		};
	},
	async resolveCredential(credentialId) {
		const credential = await credentials.get(credentialId);
		if (!credential) {
			throw new Error("Storage credential no longer exists");
		}
		return {
			provider: credential.provider,
			config: (credential.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(credentialId),
			) as Record<string, string>,
		};
	},
	// The exported factory, not an inline lambda: make-sdk.ts is the SAME
	// function object make-sdk.test.ts drives to the wire, so the dropped-
	// argument defect that shipped here once (review of PR #163, Mutation A)
	// now fails a test instead of a production run.
	makeSdk: makeWorkerSdk(prisma),
	journalResetEncoding: (entityKey, encodingId, accountId) =>
		appendResetCleanupEncoding(
			prisma,
			cipher,
			entityKey,
			encodingId,
			accountId,
		),
	acknowledgeResetEntity: async (entityKey, ownerToken) => {
		await acknowledgeResetCleanupEntity(prisma, cipher, entityKey, ownerToken);
	},
	sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
	pollIntervalMs: 10_000,
	// Generous VOD ceiling; live AWAIT_RUNNING typically resolves in
	// minutes, but a stuck QUEUED start should fail by timeout, not hang.
	pollTimeoutMs: 4 * 60 * 60 * 1000,
	now: () => new Date().toISOString(),
};

// The orchestrator gets the VMAF trigger as its VOD completion hook; the
// live-channel processor does not (live → VOD VMAF is a later PR).
const orchestrate = tenantService(() =>
	createOrchestratorProcessor({
		...processorDeps,
		onVodFinished: vmafTrigger,
		// Wrapped, not passed by reference: the capability is declared further
		// down (it needs the resolved model dir), and this closure resolves the
		// binding when a JOB arrives — long after module init.
		vmafModelAvailable: (model: string) => isVmafModelAvailable(model),
	}),
);
const liveChannel = tenantService(() =>
	createLiveChannelProcessor({
		...processorDeps,
		//  — the slate compatibility gate's measuring instrument.
		// Wrapped for the SAME reason `vmafModelAvailable` above is: the runner
		// and work dir are declared further down, and this closure resolves the
		// bindings when a REGISTRATION arrives, long after module init.
		probeStorageObject: (args) =>
			createBoundedObjectProbe({
				resolveCredential: processorDeps.resolveCredential,
				runner: vmafRunner,
				ffprobePath: env.FFPROBE_PATH,
				workDir: join(vmafWorkDir, requireOrganizationId()),
			})(args),
		// : the scheduled slate's preparer, resolved at call time for the
		// same late-binding reason.
		prepareSlate: (args) => slatePreparer()(args),
	}),
);
// Alert transitions  ride the heartbeat sweep — no new poller.
// review-83b I2: the alert engine's staleness math MUST use the sweep's
// REAL interval — two same-value constants ~200 lines apart meant raising
// the sweep to 60s would false-CRIT every healthy channel. One constant —
// now declared in heartbeat-cadence.ts (review-260 127-A9 moved it so the
// #127 vouching-window coupling could import the real value in a test);
// this engine and the repeatable-job registration below both read it.
const alertEngine = tenantService(() =>
	createAlertEngine({
		prisma,
		emitEvent,
		now: () => new Date(),
		sweepIntervalMs: HEARTBEAT_SWEEP_INTERVAL_MS,
	}),
);
// review-83b C1: the stranded-alert escape — resolves open events whose
// channel/rule left the engine's reach, once per sweep.
const resolveOrphanedAlerts = tenantService(() =>
	createOrphanResolver({
		prisma,
		emitEvent,
		now: () => new Date(),
	}),
);
// The per-run heartbeat summary (retention is 7 days; a run keeps its summary
// past that) — written once per ended run, a few runs per sweep tick.
const summarizeEndedRuns = tenantService(() =>
	createRunHeartbeatSummarizer({
		prisma,
		now: processorDeps.now,
	}),
);
const liveHeartbeatSweepInner = tenantService(() =>
	createLiveHeartbeatSweep({
		...processorDeps,
		alertEngine,
		resolveOrphanedAlerts,
		summarizeEndedRuns,
	}),
);
// One-shot on startup : retire VMAF rows whose claimant is gone.
// A row claimed PENDING → RUNNING and then lost its worker can never move
// again — the claim only matches PENDING, the delete route refuses a
// non-terminal row, and with QC/VMAF off the surface 404s. The owner hit one
// that had been RUNNING for 58 days and it blocked the data reset, pointing
// them at a Bitmovin dashboard for a job that never touched Bitmovin.
const reconcileStrandedVmaf = tenantService(() =>
	createStrandedVmafReconciler({
		prisma,
		queue: vmafQueue,
		orchestratorQueue: orchestratorProducerQueue,
	}),
);
// review-3 I3: on a PERIODIC tick, not only at boot. The archetypal case is
// "worker was killed, operator restarts it" — and at boot the killed run's
// job is still in BullMQ's `active` list, because the stalled sweep that
// reclaims it has not run yet (30s default). So the one-shot skips it, the
// stall then redelivers, the processor's claim matches zero rows and the job
// COMPLETES, and the row is still RUNNING. Only a SECOND restart would have
// caught it — "fixed next time you restart twice" is not fixed, least of all
// for the deployment that sat 58 days.
const STRANDED_VMAF_SWEEP_MS = 60_000;
setTenantInterval(() => {
	reconcileStrandedVmaf()
		.then((retired) => {
			if (retired > 0) {
				console.warn(
					`[vmaf] retired ${retired} stranded RUNNING report(s) — their worker went away`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[vmaf] stranded-report reconcile failed (reports still work):",
				err instanceof Error ? err.message : err,
			),
		);
}, STRANDED_VMAF_SWEEP_MS).unref();
runTenantTick(() =>
	reconcileStrandedVmaf()
		.then((retired) => {
			if (retired > 0) {
				console.warn(
					`[vmaf] retired ${retired} stranded RUNNING report(s) — their worker went away`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[vmaf] stranded-report reconcile failed (reports still work):",
				err instanceof Error ? err.message : err,
			),
		),
);
/**
 * Audit F63-RUN-009, the boot half. The failure-time stop above runs
 * in-process, so a worker that is itself dying never makes it — and every job
 * stranded before that code existed has nobody to make it at all. Bounded
 * rotating passes at boot and every60s; RUNNING/QUEUED are deliberately
 * out of scope, because a live worker owns those.
 */
const reconcileUnstoppedEncodings = tenantService(() =>
	createUnstoppedEncodingReconciler(processorDeps),
);
const orphanEncodingSweep = () =>
	reconcileUnstoppedEncodings()
		.then((stopped) => {
			if (stopped > 0) {
				console.warn(
					`[orchestrator] requested STOP for ${stopped} orphan Bitmovin encoding(s); provider terminal confirmation is separate`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[orchestrator] unstopped-encoding reconcile failed:",
				err instanceof Error ? err.message : err,
			),
		);
setTenantInterval(orphanEncodingSweep, 60_000).unref();
runTenantTick(() => orphanEncodingSweep());
// : the SAME stranding, storage-inspection pipeline — same
// claim shape (PENDING → RUNNING), same queue discriminator (jobId = row
// id), no DELETE route and a status-blind 30-day prune as the only exit.
// Same cadence as the VMAF reconciler and for the same review-3 I3 reason.
const reconcileStrandedInspections = tenantService(() =>
	createStrandedInspectionReconciler({
		prisma,
		queue: storageInspectQueue,
	}),
);
const strandedInspectionSweep = () => {
	reconcileStrandedInspections()
		.then((retired) => {
			if (retired > 0) {
				console.warn(
					`[inspect] retired ${retired} stranded RUNNING inspection(s) — their worker went away`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[inspect] stranded-inspection reconcile failed (inspections still work):",
				err instanceof Error ? err.message : err,
			),
		);
};
setTenantInterval(strandedInspectionSweep, STRANDED_VMAF_SWEEP_MS).unref();
runTenantTick(() => strandedInspectionSweep());
// Review-336 I1: a channel whose provisioning lease went stale with no
// takeover is wedged in PROVISIONING — no sweep, action or retry reached it.
// This sweep CAS-flips it to ERROR (exact-token fence), releases the lease and
// retires its transitional run, so "start" works again.
const abandonedLeaseSweep = () =>
	reconcileAbandonedLeases(prisma, new Date())
		.then((flipped) => {
			if (flipped > 0) {
				console.warn(
					`[live] released ${flipped} abandoned provisioning lease(s) — channel(s) marked ERROR, run(s) retired, start unblocked`,
				);
			}
		})
		.catch((err) => console.error("[live] abandoned-lease sweep failed:", err));
setTenantInterval(abandonedLeaseSweep, ABANDONED_LEASE_SWEEP_MS).unref();
runTenantTick(() => abandonedLeaseSweep());
// : runs stranded mid-transition under an ERROR channel — the
// signature no healthy transition can produce — blocked every restart via
// the one-live-run-per-channel index. One-shot covers history; the reaper
// now retires the run with the channel going forward.
runTenantTick(() =>
	createStrandedRunReconciler({ prisma })()
		.then((retired) => {
			if (retired > 0) {
				console.warn(
					`[live] retired ${retired} stranded transitional run(s) under ERROR channels — restarts unblocked`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[live] stranded-run reconcile failed (channels still work):",
				err instanceof Error ? err.message : err,
			),
		),
);
// One-shot on startup : marker-guarded, so an operator who
// deletes the defaults keeps their empty table.
runTenantTick(() =>
	seedDefaultAlertRules({ prisma }).catch((err) =>
		console.error(
			"[alerts] default seed failed (alerts still work, just unseeded):",
			err instanceof Error ? err.message : err,
		),
	),
);
// : the inspection age-prune rides the same 30s sweep tick.
// Fire-and-forget with a logged error — a prune failure must never break
// heartbeats (the same best-effort discipline as heartbeat-history writes).
const pruneInspections = tenantService(() =>
	createInspectionPrune({
		prisma,
		retentionDays: env.INSPECTION_RETENTION_DAYS,
		now: processorDeps.now,
	}),
);
const liveHeartbeatSweep: typeof liveHeartbeatSweepInner = async () => {
	pruneInspections().catch((err) =>
		console.error(
			"[storage-inspect] retention prune failed:",
			err instanceof Error ? err.message : err,
		),
	);
	return liveHeartbeatSweepInner();
};

// Feeder-manager (P3-PR3): supervised ffmpeg loops pushing storage MP4s
// into live channels. Binaries resolve via FFMPEG_PATH/FFPROBE_PATH; the
// spool defaults under the OS tmpdir.
const WORKER_HOSTNAME = hostname();
/**
 * this worker INSTANCE, which is what a feeder ownership lease is
 * held by. The nonce is what makes each BOOT distinct — a restarted worker can
 * be handed the same pid, and a lease held by "whatever used to be 4711" is a
 * lease held by nobody.
 */
const WORKER_INSTANCE_ID = feederOwnerId({
	hostname: WORKER_HOSTNAME,
	pid: process.pid,
	nonce: randomUUID().slice(0, 8),
});
const feederCommandReader = createNodeProcessCommandReader();
/** Orphan-push sweep cadence (same 60s as the stranded-report reconcilers). */
const FEEDER_ORPHAN_SWEEP_MS = 60_000;
// The feeder spools its source and the normalized loop here; the live VMAF
// processor reads the loop from the same place when both run in this process.
const feederSpoolDir = env.FEEDER_SPOOL_DIR ?? join(tmpdir(), "bitovp-feeder");

const feederProcessor = tenantService(() =>
	createFeederProcessor({
		prisma,
		emitEvent,
		resolveCredential: processorDeps.resolveCredential,
		runner: createNodeProcessRunner(),
		ffmpegPath: env.FFMPEG_PATH,
		ffprobePath: env.FFPROBE_PATH,
		spoolDir: join(feederSpoolDir, requireOrganizationId()),
		// Persisted next to every pid: a bare number is only signallable on the
		// host that minted it (audit 2026-08-29 CRITICAL-2).
		hostname: WORKER_HOSTNAME,
		// : the holder of every ownership lease this process claims.
		ownerId: WORKER_INSTANCE_ID,
		sleep: processorDeps.sleep,
		now: processorDeps.now,
		// Orphan reaping on registry-miss stops (worker restarted mid-push) and
		// on TERMINAL rows that still record an unreclaimed pid: the processor
		// runs its verified kill ladder through this (signal 0 probes existence).
		killPid: (pid, signal) => process.kill(pid, signal),
		// Pid-reuse veto for that ladder — reads /proc/<pid>/cmdline (no `ps` in
		// this image) so a recycled number is recognised as not ours.
		readProcessCommand: feederCommandReader,
	}),
);
// Audit 2026-08-29 CRITICAL-2, boot half: a START job that died OUTSIDE the
// processor leaves a `-stream_loop -1` ffmpeg pushing forever — the child
// survives the worker that spawned it, and no product path reached it. This
// sweep kills what THIS host left behind (queue-dead job + identity-matched
// command line only) and records the proof on the row.
//
// On a tick, not only at boot, for the review-3 I3 reason the VMAF reconciler
// records: at boot the killed job is often still in BullMQ's `active` list
// (the stalled sweep that reclaims it has not run yet), so a one-shot would
// skip exactly the case it exists for and "fixed after two restarts" is not
// fixed.
const reconcileFeederOrphans = tenantService(() =>
	createFeederOrphanReconciler({
		prisma,
		queue: feederQueue,
		hostname: WORKER_HOSTNAME,
		killPid: (pid, signal) => process.kill(pid, signal),
		readProcessCommand: feederCommandReader,
		sleep: processorDeps.sleep,
		now: processorDeps.now,
		emitEvent,
	}),
);
const feederOrphanSweep = () => {
	reconcileFeederOrphans()
		.then((reclaimed) => {
			if (reclaimed > 0) {
				console.warn(
					`[feeder] reclaimed ${reclaimed} orphaned push(es) left by dead start job(s) — their ffmpeg was still pushing into a live ingest`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[feeder] orphan reconcile failed (feeders still work):",
				err instanceof Error ? err.message : err,
			),
		);
};
setTenantInterval(feederOrphanSweep, FEEDER_ORPHAN_SWEEP_MS).unref();
runTenantTick(() => feederOrphanSweep());

// , audit 2026-08-29 HIGH-5: resume feeder sessions whose owner
// stopped renewing its lease.
//
// This is the half the orphan sweep above CANNOT do. That one acts on pids
// minted on THIS host, so a session lost with another replica — or with the
// outgoing pod of a rolling deploy — had no path back at all: the registry
// that knew about it died with the process, and the BullMQ job that carried it
// is only classifiable by a worker on the same queue. The lease is a fact in
// the DATABASE, so any worker can see that a push has been unattended for
// three renewal windows and take it.
//
// On the same 60s tick as its sibling, and like it also at boot — though the
// boot pass will NOT usually see this host's own sessions: their last renewal
// is at most one interval old, so they stay protected for the takeover window
// and a later tick picks them up. What the boot pass does catch is what a
// LONG outage left behind, here or on any other host, and it costs one query.
const FEEDER_TAKEOVER_SWEEP_MS = 60_000;
const feederTakeoverSweep = () => {
	feederProcessor
		.takeOverStale()
		.then((ids) => {
			if (ids.length > 0) {
				console.warn(
					`[feeder] took over ${ids.length} session(s) whose owner stopped renewing its lease: ${ids.join(", ")}`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[feeder] ownership takeover sweep failed (the next tick retries):",
				err instanceof Error ? err.message : err,
			),
		);
};
setTenantInterval(feederTakeoverSweep, FEEDER_TAKEOVER_SWEEP_MS).unref();
runTenantTick(() => feederTakeoverSweep());

// VOD VMAF runner (P4-PR3): downloads each qc/<key>.mp4 mirror + the source
// and scores them with the image's libvmaf ffmpeg. Reuses the same process
// runner, binaries, and credential resolution as the feeder; the work dir
// defaults under the OS tmpdir.
const vmafWorkDir = env.VMAF_WORKDIR ?? join(tmpdir(), "bitovp-vmaf");
const vmafRunner = createNodeProcessRunner();
// Local resource decisions are made after probing each pair, using the CPU
// quota, memory headroom and decoded reference geometry. Explicit thread and
// concurrency settings retain their respective exact value and upper bound.
const localVmafResources = createLocalVmafResources({
	threads: env.VMAF_THREADS,
	concurrency: env.VMAF_CONCURRENCY,
});
// Frame subsampling remains an explicit quality tradeoff; automatic resource
// planning never changes the scored frame set.
const vmafSubsample = env.VMAF_SUBSAMPLE;
// Bundled VMAF model files (the Docker image populates VMAF_MODEL_DIR). The
// "VMAF v1" models (vmaf_v1.0.16_3d0h and the other _NdNh / _hfr variants) are
// NOT libvmaf built-ins — they only load from a model FILE — so the runner maps
// a model name to its bundled JSON when one is present and uses `model=path=`;
// otherwise it falls back to the built-in `model=version=` (the v0.6.1 family,
// reachable on the host too). Undefined when VMAF_MODEL_DIR is unset (host dev).
const vmafModelDir = env.VMAF_MODEL_DIR;
const resolveModelPath = vmafModelDir
	? (model: string): string | undefined => {
			const file = join(vmafModelDir, `${model}.json`);
			return existsSync(file) ? file : undefined;
		}
	: undefined;
/**
 * The capability the orchestrator refuses against (review-234 I1): a model is
 * scorable here if libvmaf has it built in, or if a bundled JSON exists.
 * Passed to the orchestrator so a plan naming an unusable model fails BEFORE
 * any Bitmovin resource is created rather than after the encode.
 */
const isVmafModelAvailable = (model: string): boolean =>
	!vmafModelNeedsFile(model) || resolveModelPath?.(model) !== undefined;

if (vmafModelDir) {
	console.log(`[worker:vmaf] model dir ${vmafModelDir} (model=path= enabled)`);
}
// Profiles are operator-owned; HTTP requests can only select their IDs.
const vmafComputeCredentials = createVmafComputeCredentialStore(prisma, cipher);
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
const cloudReconcile = () =>
	vmafCloud
		.reconcile()
		.catch(() =>
			console.error("[vmaf:cloud] resource reconciliation needs attention"),
		);
setTenantInterval(cloudReconcile, 30_000).unref();
void runTenantTick(() => cloudReconcile());
const vmafProcessor = tenantService(() =>
	createVmafProcessor({
		cloudScore: vmafCloud.score,
		resolveCloudProfile: vmafCloud.resolveProfile,
		emitEvent,
		orchestratorQueue: orchestratorProducerQueue,
		prisma,
		resolveCredential: processorDeps.resolveCredential,
		runner: vmafRunner,
		ffmpegPath: env.FFMPEG_PATH,
		ffprobePath: env.FFPROBE_PATH,
		workDir: join(vmafWorkDir, requireOrganizationId()),
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

// Storage inspection (P5): bounded ffprobe over one customer object, so the
// storage browser can say what a file actually is before it becomes an input.
// Shares the VMAF work dir, process runner and credential resolution; the
// slice it downloads is removed in a finally (never keep customer bytes).
const storageInspectProcessor = tenantService(() =>
	createStorageInspectProcessor({
		prisma,
		resolveCredential: processorDeps.resolveCredential,
		runner: vmafRunner,
		ffprobePath: env.FFPROBE_PATH,
		workDir: join(vmafWorkDir, requireOrganizationId()),
		now: processorDeps.now,
	}),
);

// : slate normalization + registration. Shares the work dir, runner
// and credential resolution with the inspection above; every customer byte
// it downloads or produces is removed in a finally (`slate/prepare.ts`).
const slatePreparer = () =>
	createSlatePreparer({
		prisma,
		resolveCredential: processorDeps.resolveCredential,
		probeObject: createBoundedObjectProbe({
			resolveCredential: processorDeps.resolveCredential,
			runner: vmafRunner,
			ffprobePath: env.FFPROBE_PATH,
			workDir: join(vmafWorkDir, requireOrganizationId()),
		}),
		runner: vmafRunner,
		ffmpegPath: env.FFMPEG_PATH,
		workDir: join(vmafWorkDir, requireOrganizationId()),
	});
const slateNormalizeProcessor = tenantService(() =>
	createSlateNormalizeProcessor({
		prisma,
		prepare: (args) => slatePreparer()(args),
		revealBitmovinAccount: processorDeps.revealBitmovinAccount,
		makeSdk: processorDeps.makeSdk,
		resolveCredential: processorDeps.resolveCredential,
		now: () => new Date(processorDeps.now()),
		sleep: processorDeps.sleep,
		pollIntervalMs: processorDeps.pollIntervalMs,
	}),
);
const slateNormalizePromoter = tenantService(() =>
	createSlateNormalizePromoter({
		prisma,
		allowNewWork: isOrganizationActive,
		now: () => new Date(processorDeps.now()),
		// The epoch in the job id scopes BullMQ's dedupe to ONE enqueue: a row
		// re-queued after waiting must be a runnable job, not a completed one.
		enqueue: async (slateNormalizationId) => {
			await slateNormalizeQueue.add(
				"slate-normalize",
				{ slateNormalizationId },
				{
					jobId: `slate-normalize-${slateNormalizationId}-${Date.now()}`,
					attempts: 1,
					removeOnComplete: 1000,
					removeOnFail: 1000,
				},
			);
		},
	}),
);

// Live (pseudo-live) VMAF runner (P4-PR6b): captures recent OUTPUT segments
// from the channel's storage, aligns the looping feeder source via the PR6a
// engine, and scores the windowed capture with libvmaf. Shares the runner +
// credential resolution; dispatched by VmafJob.mode below.
const liveVmafProcessor = tenantService(() =>
	createLiveVmafProcessor({
		emitEvent,
		prisma,
		resolveCredential: processorDeps.resolveCredential,
		runner: vmafRunner,
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

// One vmaf-runner queue, dispatched by mode: VOD → mirror scoring, LIVE →
// pseudo-live capture+align. The job data stays { vmafJobId }; the row's mode
// column decides the processor (a cheap pre-read, then the chosen processor
// re-reads the full row under its own atomic claim).
const localVmafExecution = createLocalExecutionGate();
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

const notifyProcessor = tenantService(() =>
	createNotifyProcessor({
		prisma,
		revealWebhookUrl: async (credentialId) => {
			const secret = JSON.parse(
				await credentials.revealSecret(credentialId),
			) as {
				url?: string;
			};
			if (!secret.url) {
				throw new Error("notification credential carries no url");
			}
			return secret.url;
		},
		// executor.ts parity (review-183 I1): loadEnv filters "" to undefined, so
		// an undefined-passthrough made the unset default skip the check SILENTLY
		// and the "empty-but-configured" branch unreachable in production. Always
		// an array; [] warns-and-delivers like every other worker egress point.
		egressAllowlist: () =>
			parseSecretEgressAllowlist(env.SECRET_EGRESS_ALLOWED_HOSTS),
	}),
);

//  PR4 — startup-probe batches. Probes ride the NORMAL live
// queue for provision/stop; this processor only orchestrates around them.
const enqueueLiveJob = async (
	job: { liveChannelId: string; action: string },
	dedupeId: string,
) => {
	await liveChannelQueue.add("live-channel", job, {
		jobId: dedupeId,
		attempts: 5,
		backoff: { type: "exponential", delay: 5_000 },
		removeOnComplete: 1000,
		removeOnFail: 1000,
	});
};
const processProbeBatch = tenantService(() =>
	createProbeBatchProcessor({
		prisma,
		enqueueLiveJob,
		resolveCredential: processorDeps.resolveCredential,
	}),
);

const handlers = createHandlers({
	usageStatistics: tenantService(() =>
		createUsageBackfillProcessor({
			prisma,
			providerFor: usageProviderFor,
		}),
	),
	orchestrate,
	liveChannel,
	liveHeartbeatSweep,
	feeder: (jobData) => feederProcessor.process(jobData),
	vmaf: dispatchVmaf,
	storageInspect: (jobData) => storageInspectProcessor(jobData),
	notify: (jobData) => notifyProcessor({ data: jobData }),
	startupProbe: (jobData) => processProbeBatch(jobData),
	slateNormalize: (job) =>
		job.name === SLATE_NORMALIZE_PROMOTE_JOB
			? slateNormalizePromoter()
			: slateNormalizeProcessor(job.data),
});

// Repeatable heartbeat sweep (PR2 transport: one scheduler job polls every
// RUNNING channel; the dashboard UI lands in PR4). upsert = idempotent
// across worker restarts.
const liveChannelQueue = tenantQueue(
	new Queue(QUEUE_NAMES.liveChannel, {
		connection: { url: env.REDIS_URL },
	}),
);
const startupCancellationLoop = tenantService(() =>
	createSweepLoop(
		async () => {
			await reconcileStartupCancellations(prisma, async (job, jobId) => {
				const existing = await liveChannelQueue.getJob(jobId);
				if (
					existing &&
					["failed", "completed"].includes(await existing.getState())
				)
					await existing.remove();
				await liveChannelQueue.add("live-channel", job, {
					jobId,
					removeOnComplete: 1000,
					removeOnFail: 1000,
				});
			});
		},
		(error) =>
			console.error("[live] startup cancellation recovery failed:", error),
	),
);
setTenantInterval(
	startupCancellationLoop.run,
	ABANDONED_LEASE_SWEEP_MS,
).unref();
runTenantTick(() => startupCancellationLoop.run());

liveChannelQueue
	.upsertJobScheduler(
		"live-heartbeat-sweep",
		{ every: HEARTBEAT_SWEEP_INTERVAL_MS },
		{ name: HEARTBEAT_SWEEP_JOB, data: { systemSweep: "heartbeat" } },
	)
	.catch((err) =>
		console.error(
			"[worker:liveChannel] failed to schedule heartbeat sweep:",
			err,
		),
	);

// : the slate promoter — re-queues rows that waited for the live
// input once the channel reports stream attributes. upsert = idempotent.
slateNormalizeQueue
	.upsertJobScheduler(
		SLATE_NORMALIZE_PROMOTE_JOB,
		{ every: SLATE_NORMALIZE_PROMOTE_INTERVAL_MS },
		{ name: SLATE_NORMALIZE_PROMOTE_JOB, data: { systemSweep: "slate" } },
	)
	.catch((err) =>
		console.error(
			"[worker:slateNormalize] failed to schedule the promoter:",
			err,
		),
	);

// Live schedule sweep : fires ARMED LiveSchedule rows through
// the queue actions above — dispatcher idiom (in-process interval,
// best-effort, next tick retries). 30s matches the heartbeat cadence; a
// schedule is minute-granular, so the tick is never the bottleneck.
//  §3: the origin observer — bitovp's independent delivery-side
// witness, one fixed-cadence sweep (10s tick; per-channel due-at honors
// max(min segmentLength, 10s)). Best-effort like every sweep here.
const originObserver = tenantService(() =>
	createOriginObserver({
		prisma,
		resolveCredential: processorDeps.resolveCredential,
		emitEvent,
	}),
);
// review-161-162 M5: an in-flight latch (the scheduler sweep's idiom) — a
// tick is up to 10 pages × 50 channels × N playlists of SEQUENTIAL network
// reads , so
// un-latched 10s ticks would overlap and stack without bound, each
// re-reading cursors the previous tick had not yet written.
const originSweepInFlight = new Set<string>();
setTenantInterval(() => {
	const organizationId = requireOrganizationId();
	if (originSweepInFlight.has(organizationId)) {
		return;
	}
	originSweepInFlight.add(organizationId);
	return originObserver()
		.catch((err) =>
			console.error(
				"origin observer failed:",
				err instanceof Error ? err.message : err,
			),
		)
		.finally(() => {
			originSweepInFlight.delete(organizationId);
		});
}, 10_000).unref();

// #160 PR4 §4: the out-of-process probe teardown — a dead runner's RUNNING
// probe is stopped by the next minute's pass, independent of any batch job.
setTenantInterval(() => {
	reconcileAbandonedProbes(prisma, enqueueLiveJob, new Date()).catch((err) =>
		console.error(
			"probe reconcile failed:",
			err instanceof Error ? err.message : err,
		),
	);
}, 60_000).unref();

const scheduleSweep = tenantService(() =>
	createScheduleSweep({
		prisma,
		allowNewWork: isOrganizationActive,
		enqueue: async (job, dedupeId) => {
			await liveChannelQueue.add("live-channel", job, {
				jobId: dedupeId,
				// review-190 I3/C2: a scheduled action must survive a transient
				// failure (the review-183 C1 lesson — BullMQ's default attempts
				// is 0), and completed sched-* jobs must not pile up in Redis.
				attempts: 5,
				backoff: { type: "exponential", delay: 5_000 },
				removeOnComplete: 1000,
				removeOnFail: 1000,
			});
		},
		emitEvent,
		now: () => new Date(),
		startGraceMinutes: Number(
			process.env.SCHEDULE_START_GRACE_MINUTES ?? DEFAULT_START_GRACE_MINUTES,
		),
	}),
);
// : the tick is now TRACKED, so `shutdown` can await a sweep
// that is between its committed claim and its `queue.add` instead of
// closing the queue underneath it.
const scheduleSweepLoop = tenantService(() =>
	createSweepLoop(
		async () => {
			const stats = await scheduleSweep();
			// review-190 re-verify N2: waiting/errors were computed and
			// discarded — a STOP waiting on a wedged channel was silent.
			if (
				stats.errors > 0 ||
				stats.waiting > 0 ||
				stats.redispatched > 0 ||
				stats.rearmsDropped > 0
			) {
				console.warn(
					`[scheduler] tick: ${stats.waiting} waiting, ${stats.errors} errors, ${stats.redispatched} re-dispatched, ${stats.rearmsDropped} re-arms dropped from the replay queue (fired ${stats.fired}, capStops ${stats.capStops})`,
				);
			}
		},
		(err) =>
			console.error(
				"[scheduler] sweep tick failed (next tick retries):",
				err instanceof Error ? err.message : err,
			),
	),
);
setTenantInterval(() => {
	scheduleSweepLoop.run();
}, SCHEDULE_SWEEP_INTERVAL_MS).unref();
// : the BOOT pass. A worker killed between a schedule row's
// claim and its `queue.add` leaves the action recoverable but unowned; the
// replacement process must pick it up on start, not a tick later — a lost
// STOP is a live encoding still billing.
runTenantTick(() =>
	scheduleSweep
		.dispatchPending()
		.then((count) => {
			if (count > 0) {
				console.warn(
					`[scheduler] boot: re-dispatched ${count} schedule row(s) whose queue handoff was lost`,
				);
			}
		})
		.catch((err) =>
			console.error(
				"[scheduler] boot dispatch recovery failed (the next tick retries):",
				err instanceof Error ? err.message : err,
			),
		),
);

// BullMQ owns the Redis connections (one per worker); it applies the
// blocking-connection settings (maxRetriesPerRequest: null) itself.
// feederManager needs concurrency > 1: a "start" job stays active for the
// entire push (hours), and "stop" jobs must still reach the in-process
// supervisor registry meanwhile. FEEDER_CONCURRENCY comes from core: the
// create route caps admissions at FEEDER_MAX_ACTIVE_SESSIONS (= this − 1)
// so at least one slot is always free for a stop.
/**
 * The orchestrator's concurrency, which was BullMQ's default of 1.
 *
 * An orchestrator job is almost entirely waiting — `await:encoding` polls Bitmovin for
 * minutes, `manifest-await:*` likewise — so a single slot serialises the whole system behind
 * whichever encoding is slowest. With one slot, a verification run submitting 38 scenarios
 * had 6 of them still at `step 0/N (status QUEUED)` when their 900s budget expired: the
 * harness reported INVALID for jobs the worker had never picked up.
 *
 * Found by a real corpus run, and it is a PRODUCT limit rather than a harness one — an
 * operator queueing three encodings from the wizard had exactly the same experience, with no
 * timeout to tell them why. Raised, and overridable, because the right number depends on how
 * many encodings an install runs at once.
 */
const ORCHESTRATOR_CONCURRENCY = Number(
	process.env.ORCHESTRATOR_CONCURRENCY ?? 8,
);

// Through the validated env, NOT `Number(process.env.X ?? DEFAULT)`:
// `Number("")` is 0, BullMQ reads 0 as "never fail", and `??` does not catch
// the empty string a `KEY=` line produces (review-final measured all four
// cases). `loadEnv` strips blanks and coerces, so an unset or blank var
// reaches the default and a garbage one fails loudly at startup.
const MAX_STALLED_COUNT =
	env.WORKER_MAX_STALLED_COUNT ?? DEFAULT_LONG_JOB_MAX_STALLED_COUNT;

const VMAF_JOB_CONCURRENCY = cloudJobConcurrency(
	process.env.VMAF_JOB_CONCURRENCY,
	true, // Named database profiles may be added without restarting this worker.
);

const workers = (Object.keys(handlers) as QueueKey[]).map((key) => {
	const consume = consumeTenantJob(key, handlers[key]);
	const worker = new Worker(
		QUEUE_NAMES[key],
		key === "liveChannel"
			? reserveLiveStopCapacity(LIVE_CHANNEL_CONCURRENCY, consume)
			: consume,
		{
			connection: { url: env.REDIS_URL },
			// : BullMQ's default retires a resumable job on its SECOND
			// worker death. See stall-policy.ts for the measurement.
			...stallOptionsFor(key, MAX_STALLED_COUNT),
			...(key === "feederManager" ? { concurrency: FEEDER_CONCURRENCY } : {}),
			...(key === "orchestrator"
				? { concurrency: ORCHESTRATOR_CONCURRENCY }
				: {}),
			...(key === "liveChannel"
				? { concurrency: LIVE_CHANNEL_CONCURRENCY }
				: {}),
			// review-183 I3: one slow webhook host must not serialize the bus.
			...(key === "notify" ? { concurrency: 4 } : {}),
			...(key === "vmafRunner" ? { concurrency: VMAF_JOB_CONCURRENCY } : {}),
		},
	);
	worker.on("ready", () => {
		// The concurrency is part of the line because it is otherwise invisible: the orchestrator
		// ran at BullMQ's default of 1 for the project's whole life, and the only symptom was
		// encodings that appeared to be "slow". An operator should be able to read it off a log.
		console.log(
			`[worker:${key}] listening on "${QUEUE_NAMES[key]}" ` +
				`(concurrency ${worker.opts.concurrency ?? 1}, ` +
				`maxStalledCount ${worker.opts.maxStalledCount ?? 1})`,
		);
	});
	worker.on("failed", (job, err) => {
		if (!job) return;
		void consumeTenantJob(
			key,
			async (job) => {
				console.error(`[worker:${key}] job ${job?.id} failed:`, err.message);
				// A job can die outside the processor (stalled twice, lock lost).
				// Without this, the row wedges in QUEUED/RUNNING and /retry 409s.
				if (key === "orchestrator") {
					const encodingJobId = (job?.data as { encodingJobId?: string })
						?.encodingJobId;
					if (encodingJobId) {
						prisma.encodingJob
							.updateMany({
								// Only a row nobody holds — or one whose holder stopped
								// renewing a lease window ago. BullMQ raises `failed` for a
								// delivery that stalled twice regardless of whether a
								// REDELIVERY has since claimed the row and is running
								// correctly ; on status alone this
								// handler ERRORed that winner and stopped its encoding
								// (review-322 C2). Same derivation as the processor's claim.
								where: claimableWhere(
									encodingJobId,
									["QUEUED", "RUNNING"],
									new Date(),
								),
								// Redacted like every other persisted error string —
								// this is the one path outside the processors.
								// The lease is RELEASED here too (CRITICAL-1): this handler
								// fires when a job died outside the processor, and a retry
								// must be able to claim at once rather than wait out a
								// window nobody is renewing.
								data: {
									status: "ERROR",
									error: redactSecrets(err.message),
									attemptClaimedAt: null,
								},
							})
							.then(({ count }) => {
								// marking the row
								// ERROR stops it wedging, but the ENCODING this job may have
								// started at Bitmovin keeps billing — and the cancel API
								// claims `status in (QUEUED, RUNNING)`, so the write above is
								// what makes every later cancel 409. Nothing else in the
								// product could stop it. Guarded on count so only the handler
								// that actually performed the transition acts.
								if (count === 0) {
									return;
								}
								// unattendedOnly: stopping an ATTENDED job's encoding would
								// destroy the documented Retry resume —  measured
								// a stalled job going FINISHED 34/34 in seventy seconds,
								// untouched, and a stopped encoding makes that throw on
								// CANCELED instead. Unattended jobs (watch sweep, scheduler)
								// have nobody to press Retry, so they stop at once; attended
								// ones are bounded by the boot sweep's grace window.
								return stopRemoteEncodingsFor(processorDeps, encodingJobId, {
									unattendedOnly: true,
								}).then(() => undefined);
							})
							.catch((updateErr) =>
								console.error(
									"[worker:orchestrator] failed to mark job ERROR or stop its encodings:",
									updateErr,
								),
							);
					}
				}
				// Same wedge prevention for live channels stuck mid-transition.
				// Scoped twice: heartbeat sweeps never flip status, and neither do
				// parameter actions (reset-timeshift/scte35/heartbeat) — only the
				// status-owning actions (provision/stop/restart) can strand a
				// transitional state, so only their dead jobs may reset one.
				const liveJob = job?.data as
					| {
							liveChannelId?: string;
							action?: string;
							attemptId?: string;
							liveChannelRunId?: string;
							encodingId?: string;
					  }
					| undefined;
				const liveAction = liveJob?.action ?? "provision";
				const manualStopJob = key === "liveChannel" && isManualStopJob(job);
				const finalManualStopFailure =
					manualStopJob && isFinalManualStopFailure(job);
				if (
					key === "liveChannel" &&
					job?.name !== HEARTBEAT_SWEEP_JOB &&
					!manualStopJob &&
					(liveAction === "provision" ||
						liveAction === "stop" ||
						liveAction === "restart")
				) {
					const liveChannelId = liveJob?.liveChannelId;
					if (liveChannelId) {
						prisma.liveChannel
							.updateMany({
								where: {
									id: liveChannelId,
									status: { in: ["CREATED", "PROVISIONING", "STOPPING"] },
									// Staleness guard :
									// a row whose lease is still being renewed belongs to a
									// live worker — this dead job's failure must not flip
									// the winner's channel to ERROR. A stale or absent lease
									// is the wedge this handler exists to clear.
									OR: [
										{ provisionClaimedAt: null },
										{
											provisionClaimedAt: {
												lt: new Date(Date.now() - PROVISION_LEASE_MS),
											},
										},
									],
								},
								data: {
									status: "ERROR",
									error: redactSecrets(err.message),
									provisionClaimedAt: null,
								},
							})
							.then(({ count }) => {
								// review-336 C3: the run follows the CHANNEL verdict. A dead
								// loser whose failure did not win the flip (a live lease, or
								// a row already terminal) must not retire the WINNER's run —
								// this was the one unfenced write left after .
								if (count === 0) {
									return;
								}
								// : the run dies WITH its job, or the partial unique
								// index (one live run per channel) rejects every future start
								// with RunAlreadyLiveError — thrown before the channel claim,
								// so the channel is permanently unstartable. The status trio
								// and endedAt semantics live in ONE module shared with the
								// boot sweep (a RUNNING run is left alone — its encoder may
								// genuinely be live at Bitmovin).
								return retireTransitionalRuns(
									prisma,
									liveChannelId,
									redactSecrets(err.message),
								).then(() => undefined);
							})
							.catch((updateErr) =>
								console.error(
									"[worker:liveChannel] failed to mark channel/run ERROR:",
									updateErr,
								),
							);
					}
				}
				if (key === "liveChannel" && finalManualStopFailure) {
					void recordFinalManualStopFailure(
						prisma,
						job,
						err.message,
						emitEvent,
					).catch((updateErr) =>
						console.error(
							"[worker:liveChannel] failed to project exhausted manual stop:",
							updateErr,
						),
					);
				}
				//  / review-226 I1: a dead feeder-start/switch job left its
				// SCHEDULE row FIRED — success-green on the timeline, no error, no
				// note — for a feed that never started (and after a switch's stops,
				// dead air). The row is the operator's view; flip it to ERROR with
				// the reason. Guarded on FIRED so a row that already progressed
				// (note written by a successful retry racing this handler) is left
				// alone. The row's DELIVERY outcome is a separate, weaker claim and is
				// written by `recordDeadJobScheduleOutcomes` below — UNKNOWN, not
				// FAILED, because the audit's CRITICAL-2 shows this job can leave an
				// orphaned ffmpeg still pushing.
				// : a dead pre-stage releases its claim instead — the row has
				// not fired, and the next tick can stage it again while the lead lasts.
				if (key === "liveChannel" && liveAction === "feeder-stage") {
					void releaseDeadStageClaim(prisma, job);
				}
				if (
					key === "liveChannel" &&
					(liveAction === "feeder-start" ||
						liveAction === "feeder-switch" ||
						liveAction === "feeder-commit")
				) {
					const scheduleId = (liveJob as { params?: { scheduleId?: string } })
						?.params?.scheduleId;
					if (scheduleId) {
						prisma.liveSchedule
							.updateMany({
								where: { id: scheduleId, status: "FIRED" },
								data: {
									status: "ERROR",
									error: redactSecrets(
										`scheduled feeder job died: ${err.message}`,
									),
								},
							})
							.catch((updateErr) =>
								console.error(
									"[worker:liveChannel] failed to mark feeder schedule row ERROR:",
									updateErr,
								),
							);
					}
				}
				/**
				 * , review-350 HIGH-1: EVERY dead liveChannel job closes the
				 * schedule row it fired.
				 *
				 * ONE call, and the decision lives in a module `index.ts` cannot hide —
				 * nothing imports this file, so the four branches this replaces were
				 * unreachable by every test in the repo, and the provision/stop one
				 * wrote nothing at all: a scheduled STOP whose job died stayed
				 * FIRED/PENDING ("outcome not confirmed yet") next to a channel the
				 * arm above had just marked ERROR, and the dangling row was resolved
				 * later by an unrelated stop. `live/dead-job-outcome.ts` carries the
				 * per-action verdicts and why each is UNKNOWN.
				 *
				 * The queue key is the ONLY condition here on purpose: the heartbeat
				 * sweep's exemption and every per-action rule live in the module, so
				 * they are stated once and tested, rather than half here and half
				 * there where the two copies can drift.
				 */
				if (
					key === "liveChannel" &&
					(!manualStopJob || finalManualStopFailure)
				) {
					void recordDeadJobScheduleOutcomes(
						prisma,
						job,
						err.message,
						new Date(),
					);
				}
				// live-to-VOD needs the SAME wedge prevention, but on its OWN record —
				// never on `status` (a failed publish is not a channel failure). The
				// in-processor catch handles ordinary failures; an out-of-processor
				// death (stalled twice, lock lost, worker killed) writes nothing, and
				// the route hard-409s while the record says RUNNING, so the channel
				// could never publish again. Status-guarded so only a genuinely
				// in-flight record is released (review catch M1) — and a MERGE, not a
				// stamp : the blank `{ status: ERROR, manifests: [] }` this
				// used to write erased every family the worker had delivered before it
				// died. `live/live-to-vod-release.ts` keeps them.
				if (key === "liveChannel" && liveAction === "live-to-vod") {
					const { liveChannelId, liveChannelRunId, encodingId, attemptId } =
						liveJob ?? {};
					if (
						liveChannelId &&
						liveChannelRunId &&
						encodingId &&
						attemptId &&
						job
					) {
						releaseDeadLiveToVodIfFinal(
							prisma,
							{ liveChannelId, liveChannelRunId, encodingId, attemptId },
							err.message,
							new Date(),
							() => job.getState(),
						).catch((updateErr) =>
							console.error(
								"[worker:liveChannel] failed to release live-to-VOD:",
								updateErr,
							),
						);
					}
				}
				// Feeder wedge prevention, scoped to dead START jobs only — moved into
				// `live/dead-job-outcome.ts` (review-351): it kept the forensic pid and
				// landed the session ERROR, but NOTIFIED nobody on the most common
				// trigger of the orphan-ffmpeg case, and 's emit instrument
				// could not see that because its population never included this file.
				if (key === "feederManager") {
					void recordDeadFeederJob({ prisma, emitEvent }, job, err.message);
				}
			},
			{ reserveFeederStopSlot: false, enforceActive: false },
		)(job).catch(() =>
			console.error(
				"[tenant] failed-job ownership unavailable; recovery remains scoped",
			),
		);
	});
	worker.on("error", (err) => {
		console.error(`[worker:${key}] error:`, err);
	});
	return worker;
});

function drainTenantLoop(loop: { stop(): void; drain(): Promise<void> }) {
	return Promise.all(
		forEachTenantService(loop, (instance) => {
			instance.stop();
			return instance.drain();
		}),
	).then(() => undefined);
}

const shutdown = createShutdown({
	// Signal every running feeder supervisor FIRST: their ffmpeg children
	// would outlive this process otherwise. The active start jobs then
	// resolve to STOPPED and worker.close waits for them.
	stopFeeders: () => {
		stopping = true;
		return forEachTenantService(feederProcessor, (instance) =>
			instance.stopAll(),
		).flat();
	},
	// : a scheduler tick between its committed claim and its
	// `queue.add` finishes BEFORE the queue closes — the ordinary stop must
	// not manufacture the lost handoff the outbox exists to recover from.
	drains: [
		{
			name: "live startup cancellation",
			run: () => drainTenantLoop(startupCancellationLoop),
			recovery: "durable per-run cancellation intent retries after restart",
		},
		{
			name: "reset cleanup",
			run: () => drainTenantLoop(resetCleanupLoop),
			recovery: "encrypted reset cleanup receipts retry after restart",
		},
		{
			name: "library analysis",
			run: () => drainTenantLoop(analysisSweepLoop),
			recovery:
				"the persisted analysis request is retried after its lease expires",
		},
		{
			name: "schedule sweep",
			run: () => drainTenantLoop(scheduleSweepLoop),
			recovery: "the schedule outbox recovers it on the next boot",
		},
		// WP-G G-1: a tick between resolve and persist finishes, so the row
		// never holds a half-written snapshot across a deploy.
		{
			name: "ingress monitor",
			run: () => drainTenantLoop(ingressLoop),
			recovery: "the next boot's tick re-resolves and re-persists",
		},
		// WP-G G-2: a tick between a provider create and its ACTIVE row write
		// finishes; an abandoned one leaves a CAS-claimed row whose claim
		// expires in 60 s and is then retried (the provider hook, if created,
		// is re-created — the duplicate is harmless and listed).
		{
			name: "webhook registrar",
			run: () => drainTenantLoop(registrarLoop),
			recovery: "the row's claim expires and the next boot's tick retries",
		},
		// : `worker.close` below waits for ACTIVE BullMQ jobs, which
		// is what lands every start-job session on STOPPED. A session this
		// process RESUMED has no job to be waited on, so without this drain a
		// deploy would exit with its ffmpeg still running and its row still
		// PUSHING — re-creating the orphan the takeover had just rescued.
		//
		// Its own budget (review-365 I-2): this drain waits for ffmpeg to die,
		// which takes longer than the 5s the bookkeeping sweeps get.
		{
			name: "feeder takeover",
			run: () =>
				Promise.all(
					forEachTenantService(feederProcessor, (instance) =>
						instance.drainTakeovers(),
					),
				).then(() => undefined),
			timeoutMs: FEEDER_TAKEOVER_DRAIN_MS,
			recovery:
				"its lease goes stale and another worker's takeover sweep resumes the session",
		},
	],
	closables: [
		...workers,
		liveChannelQueue,
		feederQueue,
		vmafQueue,
		orchestratorProducerQueue,
	],
	disconnect: () => basePrisma.$disconnect(),
	exit: (code) => process.exit(code),
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
