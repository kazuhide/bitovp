import "server-only";
import {
	loadEnv,
	QUEUE_NAMES,
	tenantQueueEnvelope,
	tenantQueueEnvelopeSchema,
} from "@bitovp/core";
import { type Job, type JobType, Queue } from "bullmq";
import { headers } from "next/headers";
import {
	AuthContextError,
	type AuthenticatedContext,
	DEFAULT_ORGANIZATION_ID,
	resolveAuthenticatedContext,
} from "@/lib/auth/tenancy";

const AUTHENTICATED_QUEUE = Symbol.for("bitovp.authenticated-queue");
const SCAN_PAGE = 200;
const SCAN_LIMIT = 20_000;
const JOB_FIELDS = new Set([
	"id",
	"name",
	"timestamp",
	"processedOn",
	"finishedOn",
	"attemptsMade",
	"attemptsStarted",
	"failedReason",
	"returnvalue",
	"progress",
	"delay",
	"priority",
	"stacktrace",
	"repeatJobKey",
]);
const READ_JOB_METHODS = new Set([
	"getState",
	"isActive",
	"isWaiting",
	"isDelayed",
	"isCompleted",
	"isFailed",
	"isWaitingChildren",
]);
const MUTATE_JOB_METHODS = new Set([
	"remove",
	"retry",
	"promote",
	"changePriority",
	"changeDelay",
	"discard",
	"updateData",
	"updateProgress",
]);
const LIST_STATES: JobType[] = [
	"active",
	"completed",
	"delayed",
	"failed",
	"paused",
	"prioritized",
	"wait",
	"waiting-children",
];

async function queueContext(mutation = false) {
	const context = await resolveAuthenticatedContext(await headers());
	if (mutation && (context.isImpersonating || context.role === "VIEWER"))
		throw new AuthContextError(403, "Queue mutation is not allowed");
	return context;
}
function payloadFor(
	job: Job,
	context: AuthenticatedContext,
): { owned: boolean; payload?: unknown } {
	const parsed = tenantQueueEnvelopeSchema.safeParse(job.data);
	if (parsed.success)
		return {
			owned: parsed.data.organizationId === context.organizationId,
			payload: parsed.data.payload,
		};
	const legacy =
		process.env.TENANT_MIGRATE_LEGACY_QUEUES === "1" &&
		context.organizationId === DEFAULT_ORGANIZATION_ID &&
		typeof job.data === "object" &&
		job.data !== null &&
		!("organizationId" in job.data) &&
		!("payload" in job.data) &&
		!("systemSweep" in job.data);
	return { owned: legacy, payload: job.data };
}
function scopedJob(job: Job, context: AuthenticatedContext): Job | undefined {
	const parsed = payloadFor(job, context);
	if (!parsed.owned) return undefined;
	return new Proxy(job, {
		get(target, key) {
			if (key === "data") return parsed.payload;
			if (key === "opts") return { repeat: target.opts?.repeat };
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function")
				return JOB_FIELDS.has(String(key)) ? value : undefined;
			if (
				!READ_JOB_METHODS.has(String(key)) &&
				!MUTATE_JOB_METHODS.has(String(key))
			)
				return async () => {
					throw new AuthContextError(
						403,
						"Queue job operation is not available",
					);
				};
			return async (...args: unknown[]) => {
				const current = await queueContext(MUTATE_JOB_METHODS.has(String(key)));
				if (
					current.organizationId !== context.organizationId ||
					!payloadFor(target, current).owned
				)
					throw new AuthContextError(403, "Queue job is unavailable");
				if (key === "updateData")
					args[0] = tenantQueueEnvelope(current.organizationId, args[0]);
				return Reflect.apply(value, target, args);
			};
		},
	});
}
/** Request identity is captured per asynchronous operation, never on the global Queue. */
export function authenticatedQueue(queue: Queue): Queue {
	if (Reflect.get(queue, AUTHENTICATED_QUEUE) === true) return queue;
	async function list(
		context: AuthenticatedContext,
		types: JobType | JobType[],
		start = 0,
		end = -1,
		asc = false,
	) {
		if (
			!Number.isSafeInteger(start) ||
			start < 0 ||
			!Number.isSafeInteger(end) ||
			end < -1
		)
			throw new Error("Invalid queue page");
		const result: Job[] = [];
		let count = 0;
		for (let offset = 0; offset < SCAN_LIMIT; offset += SCAN_PAGE) {
			const page = await queue.getJobs(
				types,
				offset,
				offset + SCAN_PAGE - 1,
				asc,
			);
			for (const job of page) {
				const owned = scopedJob(job, context);
				if (!owned) continue;
				if (count >= start && (end < 0 || count <= end)) result.push(owned);
				count++;
				if (end >= 0 && count > end) return result;
			}
			if (page.length < SCAN_PAGE) return result;
		}
		throw new Error("Tenant queue scan exceeded its bound");
	}
	async function assertJobId(
		context: AuthenticatedContext,
		opts?: { jobId?: string },
	) {
		if (!opts?.jobId) return;
		const existing = await queue.getJob(opts.jobId);
		if (existing && !payloadFor(existing, context).owned)
			throw new AuthContextError(403, "Queue job is unavailable");
	}
	return new Proxy(queue, {
		get(target, key) {
			if (key === AUTHENTICATED_QUEUE) return true;
			if (key === "then") return undefined;
			if (key === "add")
				return async (
					name: string,
					data: unknown,
					opts?: { jobId?: string },
				) => {
					const context = await queueContext(true);
					if (tenantQueueEnvelopeSchema.safeParse(data).success)
						throw new Error("Queue payload is already wrapped");
					await assertJobId(context, opts);
					const job = await target.add(
						name,
						tenantQueueEnvelope(context.organizationId, data),
						opts,
					);
					const scoped = scopedJob(job, context);
					if (!scoped)
						throw new AuthContextError(403, "Queue job is unavailable");
					return scoped;
				};
			if (key === "addBulk")
				return async (
					jobs: { name: string; data: unknown; opts?: { jobId?: string } }[],
				) => {
					const context = await queueContext(true);
					for (const job of jobs) {
						if (tenantQueueEnvelopeSchema.safeParse(job.data).success)
							throw new Error("Queue payload is already wrapped");
						await assertJobId(context, job.opts);
					}
					const added = await target.addBulk(
						jobs.map((job) => ({
							...job,
							data: tenantQueueEnvelope(context.organizationId, job.data),
						})),
					);
					return added.map((job) => {
						const scoped = scopedJob(job, context);
						if (!scoped)
							throw new AuthContextError(403, "Queue job is unavailable");
						return scoped;
					});
				};
			if (key === "getJob")
				return async (id: string) => {
					const context = await queueContext();
					const job = await target.getJob(id);
					return job ? scopedJob(job, context) : undefined;
				};
			if (key === "getJobs")
				return async (
					types: JobType | JobType[],
					start?: number,
					end?: number,
					asc?: boolean,
				) => list(await queueContext(), types, start, end, asc);
			if (key === "getFailed" || key === "getCompleted")
				return async (start?: number, end?: number, asc?: boolean) =>
					list(
						await queueContext(),
						key === "getFailed" ? "failed" : "completed",
						start,
						end,
						asc,
					);
			if (key === "getJobCountByTypes")
				return async (...types: JobType[]) =>
					(await list(await queueContext(), types.length ? types : LIST_STATES))
						.length;
			if (key === "getJobCounts")
				return async (...types: JobType[]) => {
					const context = await queueContext();
					const counts: Record<string, number> = {};
					for (const type of types.length ? types : LIST_STATES)
						counts[type] = (await list(context, type)).length;
					return counts;
				};
			if (key === "name") return target.name;
			return async () => {
				await queueContext();
				throw new AuthContextError(
					403,
					"Global queue operation is not available",
				);
			};
		},
	});
}

const globalForQueues = globalThis as unknown as {
	usageStatisticsQueue?: Queue;
	notifyQueue?: Queue;
	orchestratorQueue?: Queue;
	liveChannelQueue?: Queue;
	feederQueue?: Queue;
	vmafQueue?: Queue;
	storageInspectQueue?: Queue;
	startupProbeQueue?: Queue;
	slateNormalizeQueue?: Queue;
};

/** Account-scoped historical Statistics imports; the worker owns provider reads. */
export function getUsageStatisticsQueue(): Queue {
	if (!globalForQueues.usageStatisticsQueue) {
		globalForQueues.usageStatisticsQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.usageStatistics, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.usageStatisticsQueue = authenticatedQueue(
		globalForQueues.usageStatisticsQueue,
	);
	return globalForQueues.usageStatisticsQueue;
}

/** Producer side of the orchestrator queue (consumer lives in apps/worker). */
export function getOrchestratorQueue(): Queue {
	if (!globalForQueues.orchestratorQueue) {
		globalForQueues.orchestratorQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.orchestrator, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.orchestratorQueue = authenticatedQueue(
		globalForQueues.orchestratorQueue,
	);
	return globalForQueues.orchestratorQueue;
}

/** Producer side of the live-channel queue (provision + actions). */
export function getLiveChannelQueue(): Queue {
	if (!globalForQueues.liveChannelQueue) {
		globalForQueues.liveChannelQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.liveChannel, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.liveChannelQueue = authenticatedQueue(
		globalForQueues.liveChannelQueue,
	);
	return globalForQueues.liveChannelQueue;
}

/** Producer side of the feeder-manager queue (session start/stop). */
export function getFeederQueue(): Queue {
	if (!globalForQueues.feederQueue) {
		globalForQueues.feederQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.feederManager, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.feederQueue = authenticatedQueue(globalForQueues.feederQueue);
	return globalForQueues.feederQueue;
}

/** Producer side of the vmaf-runner queue (VOD trigger + live capture). */
export function getVmafQueue(): Queue {
	if (!globalForQueues.vmafQueue) {
		globalForQueues.vmafQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.vmafRunner, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.vmafQueue = authenticatedQueue(globalForQueues.vmafQueue);
	return globalForQueues.vmafQueue;
}

/**
 * Producer side of the storage-inspect queue (bounded ffprobe of one object).
 * ffprobe lives in the worker image, so the browser's "Inspect" action can only
 * ever enqueue — the web app never reads customer storage for a preview.
 */
export function getStorageInspectQueue(): Queue {
	if (!globalForQueues.storageInspectQueue) {
		globalForQueues.storageInspectQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.storageInspect, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.storageInspectQueue = authenticatedQueue(
		globalForQueues.storageInspectQueue,
	);
	return globalForQueues.storageInspectQueue;
}

/** Read side of the notify queue ( PR2: the delivery-log panel
 * reads the queue — no extra table in v1, per the design's own trade). */
export function getNotifyQueue(): Queue {
	if (!globalForQueues.notifyQueue) {
		globalForQueues.notifyQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.notify, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.notifyQueue = authenticatedQueue(globalForQueues.notifyQueue);
	return globalForQueues.notifyQueue;
}

/** Producer side of the startup-probe queue . */
export function getStartupProbeQueue(): Queue {
	if (!globalForQueues.startupProbeQueue) {
		globalForQueues.startupProbeQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.startupProbe, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.startupProbeQueue = authenticatedQueue(
		globalForQueues.startupProbeQueue,
	);
	return globalForQueues.startupProbeQueue;
}

/**
 * Producer side of the slate-normalize queue : the registration
 * route creates a `SlateNormalization` row and enqueues it; the worker
 * downloads, transcodes, uploads and registers. The web tier never runs
 * ffmpeg.
 */
export function getSlateNormalizeQueue(): Queue {
	if (!globalForQueues.slateNormalizeQueue) {
		globalForQueues.slateNormalizeQueue = authenticatedQueue(
			new Queue(QUEUE_NAMES.slateNormalize, {
				connection: { url: loadEnv().REDIS_URL },
			}),
		);
	}
	globalForQueues.slateNormalizeQueue = authenticatedQueue(
		globalForQueues.slateNormalizeQueue,
	);
	return globalForQueues.slateNormalizeQueue;
}
