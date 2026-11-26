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
	dedicatedVmafOwner,
	startDedicatedVmafConsumer,
} from "./vmaf/worker-role";
import { createVmafWorkerServices } from "./vmaf/worker-services";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = loadEnv();
const key = dedicatedVmafOwner(env.VMAF_QUEUE_OWNER);
const { basePrisma, prisma, consumeTenantJob } = createWorkerTenantContext(
	env.DATABASE_URL,
);
const cipher = cipherFromEnv();
const credentials = createCredentialStore(prisma, cipher);
const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
const connection = { url: env.REDIS_URL };
// Only the QC queue is consumed here. Completion events and QC gate
// continuations remain tenant-scoped producers for the primary worker.
const queue = new Queue(QUEUE_NAMES[key], { connection });
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
let closing: Promise<void> | undefined;
function close() {
	closing ??= (async () => {
		try {
			await worker?.close();
		} finally {
			await Promise.allSettled([
				queue.close(),
				notifyQueue.close(),
				orchestratorProducerQueue.close(),
			]);
			redis.disconnect();
			await basePrisma.$disconnect();
		}
	})();
	return closing;
}
function shutdown(code: number) {
	void close().then(
		() => process.exit(code),
		() => {
			console.error("[worker:vmafRunner] dedicated shutdown failed");
			process.exit(1);
		},
	);
}

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
	const consumer = new Worker(
		QUEUE_NAMES[key],
		consumeTenantJob(
			key,
			runtime.admitVmaf(createVmafRunnerHandler(runtime.dispatchVmaf)),
		),
		{
			connection,
			autorun: false,
			name: `bitovp-dedicated-${randomUUID()}`,
			concurrency: runtime.concurrency,
			...stallOptionsFor(
				key,
				env.WORKER_MAX_STALLED_COUNT ?? DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
			),
		},
	);
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
	await startDedicatedVmafConsumer({
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
		run: () => {
			void consumer.run().catch((error: unknown) => {
				console.error(
					"[worker:vmafRunner]",
					redactSecrets(error instanceof Error ? error.message : String(error)),
				);
				shutdown(1);
			});
		},
		close,
	});
	console.log(
		`[worker:vmafRunner] dedicated consumer started (concurrency ${runtime.concurrency})`,
	);
	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));
} catch (error) {
	await close();
	throw error;
}
