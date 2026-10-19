import {
	liveChannelJobSchema,
	liveStartupCancelParamsSchema,
	tenantQueueEnvelopeSchema,
} from "@bitovp/core";
import { DelayedError, type Job } from "bullmq";

function assertConcurrency(value: number): void {
	if (!Number.isSafeInteger(value) || value < 2) {
		throw new Error(
			"LIVE_CHANNEL_CONCURRENCY must be an integer of at least 2",
		);
	}
}

/** Total local slots: ordinary actions may use all but the reserved control slot. */
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

/** Wrap the physical queue processor once, outside tenant dispatch. A permit
 * wait would still hold a BullMQ slot, so excess normal work must be delayed.
 * The original processor retains every ownership, generation and lease check.
 */
export function reserveLiveStopCapacity<T>(
	concurrency: number,
	process: (job: Job) => Promise<T>,
): (job: Job) => Promise<T> {
	assertConcurrency(concurrency);
	let normalActive = 0;
	return async (job) => {
		if (isStopOrStartupCancellation(job)) return process(job);
		if (normalActive >= concurrency - 1) {
			await job.moveToDelayed(Date.now() + 1000, job.token);
			throw new DelayedError();
		}
		normalActive++;
		try {
			return await process(job);
		} finally {
			normalActive--;
		}
	};
}
