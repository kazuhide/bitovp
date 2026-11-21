import {
	liveChannelJobSchema,
	liveStartupCancelParamsSchema,
	tenantQueueEnvelopeSchema,
} from "@bitovp/core";
import { DelayedError, type Job } from "bullmq";
import { isTenantSystemSweep } from "./tenant/consumer";

export const LIVE_HEARTBEAT_SLOTS = 1;

function assertConcurrency(value: number): void {
	if (
		!Number.isSafeInteger(value) ||
		!Number.isSafeInteger(value + LIVE_HEARTBEAT_SLOTS) ||
		value < 2
	) {
		throw new Error(
			"LIVE_CHANNEL_CONCURRENCY must be a safe integer of at least 2 with room for the heartbeat slot",
		);
	}
}

/** Local action slots, including one slot reserved for stop and cancellation. */
export function liveChannelConcurrency(value?: string): number {
	const concurrency = value?.trim() ? Number(value) : 8;
	assertConcurrency(concurrency);
	return concurrency;
}

function isStopOrStartupCancellation(job: Job): boolean {
	const envelope = tenantQueueEnvelopeSchema.safeParse(job.data);
	const parsed = liveChannelJobSchema.safeParse(
		envelope.success ? envelope.data.payload : job.data,
	);
	if (!parsed.success) return false;
	if (parsed.data.action === "stop") return true;
	if (parsed.data.action !== "provision") return false;
	const params = liveStartupCancelParamsSchema.safeParse(
		parsed.data.params ?? {},
	);
	return params.success && params.data.cancelRunId !== undefined;
}

async function deferJob(job: Job): Promise<never> {
	await job.moveToDelayed(Date.now() + 1000, job.token);
	throw new DelayedError();
}

/** Wrap the physical queue processor once, outside tenant dispatch. A permit
 * wait would still hold a BullMQ slot, so excess normal work must be delayed.
 * One slot is reserved for the trusted heartbeat scheduler. Further sweeps
 * can use spare normal capacity. Tenant dispatch retains all ownership checks.
 */
export function reserveLiveStopCapacity<T>(
	concurrency: number,
	process: (job: Job) => Promise<T>,
): (job: Job) => Promise<T> {
	assertConcurrency(concurrency);
	const active = { heartbeat: 0, normal: 0, control: 0 };
	return async (job) => {
		const kind = isTenantSystemSweep("liveChannel", job)
			? "heartbeat"
			: isStopOrStartupCancellation(job)
				? "control"
				: "normal";
		const usesHeartbeatSlot =
			kind === "heartbeat" && active.heartbeat < LIVE_HEARTBEAT_SLOTS;
		const normalUsed =
			active.normal + Math.max(0, active.heartbeat - LIVE_HEARTBEAT_SLOTS);
		if (
			!usesHeartbeatSlot &&
			(normalUsed + active.control >= concurrency ||
				(kind !== "control" && normalUsed >= concurrency - 1))
		) {
			return deferJob(job);
		}
		active[kind]++;
		try {
			return await process(job);
		} finally {
			active[kind]--;
		}
	};
}
