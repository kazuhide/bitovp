import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	cipherFromEnv,
	loadEnv,
	QUEUE_NAMES,
	redactSecrets,
} from "@bitovp/core";
import { createCredentialStore } from "@bitovp/db";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createNodeProcessRunner } from "./feeder/process-runner";
import { createEventEmitter } from "./notify/emitter";
import {
	DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
	stallOptionsFor,
} from "./stall-policy";
import { tenantQueue } from "./tenant/queue";
import { tenantService } from "./tenant/scope";
import {
	createWorkerStorageCredentialResolver,
	createWorkerTenantContext,
} from "./tenant/worker-context";
import { createVmafRunnerHandler } from "./vmaf/job-capacity";
import {
	closeVmafBullWorker,
	createDedicatedVmafRegistration,
	createVmafOwnershipConnection,
	createVmafQueueRegistry,
	guardVmafQueueOwnership,
	readVmafQueueDatabase,
	waitForVmafBrokerClose,
} from "./vmaf/queue-ownership";
import { startOwnedVmafReconciliation } from "./vmaf/reconcile-stranded";
import {
	dedicatedVmafOwner,
	startDedicatedVmafConsumer,
} from "./vmaf/worker-role";
import { createVmafWorkerServices } from "./vmaf/worker-services";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = loadEnv();
const key = dedicatedVmafOwner(env.VMAF_QUEUE_OWNER);
const { basePrisma, prisma, forEachOrganization, consumeTenantJob } =
	createWorkerTenantContext(env.DATABASE_URL);
const cipher = cipherFromEnv();
const credentials = createCredentialStore(prisma, cipher);
const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
const ownerRedis = createVmafOwnershipConnection(env.REDIS_URL);
const ownership = createVmafQueueRegistry(ownerRedis);
const ownsQueue = async () =>
	!registration.signal.aborted &&
	ownership.owns("dedicated", await readVmafQueueDatabase(basePrisma));
const connection = { url: env.REDIS_URL };
// Only the QC queue is consumed here. Completion events and QC gate
// continuations remain tenant-scoped producers for the primary worker.
const queue = new Queue(QUEUE_NAMES[key], { connection });
const scopedVmafQueue = tenantQueue(queue);
const notifyQueue = tenantQueue(new Queue(QUEUE_NAMES.notify, { connection }));
const orchestratorProducerQueue = tenantQueue(
	new Queue(QUEUE_NAMES.orchestrator, { connection }),
);
const emitEvent = tenantService(() =>
	createEventEmitter({
		queue: notifyQueue,
		publicBaseUrl: env.PUBLIC_BASE_URL,
	}),
);
let worker: Worker | undefined;
let started = false;
let drainWork: (() => Promise<void>) | undefined;
let stopSweep: (() => Promise<void>) | undefined;
const registration = createDedicatedVmafRegistration(ownership, async () => {
	if (worker)
		await closeVmafBullWorker(worker, async () => drainWork?.(), {
			neverStarted: !started,
			stopSweep,
		});
});
let closing: Promise<void> | undefined;
function close() {
	closing ??= (async () => {
		try {
			await registration.close();
		} finally {
			await Promise.allSettled([
				waitForVmafBrokerClose(queue.close()),
				waitForVmafBrokerClose(notifyQueue.close()),
				waitForVmafBrokerClose(orchestratorProducerQueue.close()),
			]);
			redis.disconnect();
			ownerRedis.disconnect();
			await basePrisma.$disconnect();
		}
	})();
	return closing;
}
function shutdown(code: number) {
	void close().then(
		() => process.exit(code),
		(error: unknown) => {
			console.error(
				"[worker:vmafRunner] dedicated shutdown could not verify release:",
				redactSecrets(error instanceof Error ? error.message : String(error)),
			);
			process.exit(1);
		},
	);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
	const runtime = await createVmafWorkerServices({
		mode: "dedicated",
		env,
		prisma,
		cipher,
		processorDeps: {
			resolveCredential: createWorkerStorageCredentialResolver(credentials),
			now: () => new Date().toISOString(),
		},
		emitEvent,
		orchestratorProducerQueue,
		vmafRunner: createNodeProcessRunner(),
		wakePublisher: redis,
		vmafWorkDir: env.VMAF_WORKDIR ?? join(tmpdir(), "bitovp-vmaf"),
		feederSpoolDir: env.FEEDER_SPOOL_DIR ?? join(tmpdir(), "bitovp-feeder"),
	});
	registration.signal.throwIfAborted();
	await ownerRedis.connect();
	const database = await readVmafQueueDatabase(basePrisma);
	if (!(await registration.claim(database)))
		throw new Error(
			"VMAF_QUEUE_OWNERSHIP_UNAVAILABLE: verify the split primary and drain other QC consumers",
		);
	const guarded = guardVmafQueueOwnership(
		ownsQueue,
		consumeTenantJob(
			key,
			runtime.admitVmaf(createVmafRunnerHandler(runtime.dispatchVmaf)),
		),
	);
	drainWork = guarded.drain;
	const consumer = new Worker(QUEUE_NAMES[key], guarded, {
		connection,
		autorun: false,
		name: `bitovp-dedicated-${randomUUID()}`,
		concurrency: runtime.concurrency,
		...stallOptionsFor(
			key,
			env.WORKER_MAX_STALLED_COUNT ?? DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
		),
	});
	worker = consumer;
	consumer.on("error", (error) =>
		console.error("[worker:vmafRunner]", redactSecrets(error.message)),
	);
	consumer.on("failed", (job, error) =>
		console.error(
			`[worker:vmafRunner] job ${job?.id} failed:`,
			redactSecrets(error.message),
		),
	);
	await startDedicatedVmafConsumer(
		{
			ready: async () => {
				const client = await consumer.waitUntilReady();
				const name: unknown = client.options.connectionName;
				const database: unknown = client.options.db ?? 0;
				if (
					typeof name !== "string" ||
					typeof database !== "number" ||
					!Number.isSafeInteger(database) ||
					database < 0
				)
					throw new Error("VMAF_QUEUE_CONSUMER_IDENTITY_UNAVAILABLE");
				return { name, database };
			},
			listWorkers: () => queue.getWorkers(),
			ownsQueue,
			run: () => {
				started = true;
				void consumer.run().catch((error: unknown) => {
					console.error(
						"[worker:vmafRunner]",
						redactSecrets(
							error instanceof Error ? error.message : String(error),
						),
					);
					shutdown(1);
				});
				stopSweep = startOwnedVmafReconciliation(
					ownsQueue,
					forEachOrganization,
					{
						prisma,
						queue: scopedVmafQueue,
						orchestratorQueue: orchestratorProducerQueue,
					},
				);
			},
			close,
		},
		registration.signal,
	);
	console.log(
		`[worker:vmafRunner] dedicated consumer started (concurrency ${runtime.concurrency})`,
	);
} catch (error) {
	await close();
	throw error;
}
