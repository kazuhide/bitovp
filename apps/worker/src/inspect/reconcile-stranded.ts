import { QUEUE_NAMES } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type { Queue } from "bullmq";

const INSPECT_QUEUE_NAME = QUEUE_NAMES.storageInspect;

/**
 *  — the same stranding  fixed for VMAF, in the
 * storage-inspection pipeline, found by #133's review precisely because it
 * is the same family: the processor's claim is `PENDING → RUNNING`
 * (transition-is-the-lock), so a redelivery under a row already RUNNING
 * matches zero rows, COMPLETES, and the row is RUNNING forever.
 *
 * It is WORSE off than VMAF was in one way and invisible in another: there
 * is no DELETE route at all (GET+POST, and [id] is GET-only), so the only
 * exit is the age prune — which is status-blind and defaults to 30 days —
 * and unlike VMAF the reset does not block on it, so nobody had stepped on
 * one yet. "Nobody has hit it" is why the row existed, not evidence of
 * health.
 *
 * Same discriminator as #133: THE QUEUE, NOT THE CLOCK. The route enqueues
 * with `jobId: row.id`, so "is anyone still working on this" is
 * answerable exactly; an `updatedAt` threshold would retire a legitimate
 * ffprobe over a large remote object that simply has not written yet.
 */
export const STRANDED_INSPECTION_ERROR =
	"The worker running this inspection went away before it finished, and the queue no longer holds the job. Nothing is running — inspect the object again if you still need it.";

/**
 * The DEAD set, enumerated — not the live one (review-3 I4's polarity,
 * restated here on purpose rather than imported from the VMAF module: the
 * doctrine is the point, and a shared constant would let one pipeline's
 * exception silently rewrite the other's). A state must be KNOWN-dead to
 * retire a row; anything unrecognised leaves it alone.
 */
const DEAD_STATES = new Set(["completed", "failed", "unknown"]);

export function createStrandedInspectionReconciler(deps: {
	prisma: AppPrismaClient;
	queue: Pick<Queue, "getJob" | "name">;
}) {
	// Same construction guard as #133 (review-3 I5): any queue typechecks,
	// and the wrong one answers undefined for every row — retiring all of
	// them. The name is the runtime discriminator.
	if (deps.queue.name !== INSPECT_QUEUE_NAME) {
		throw new Error(
			`stranded-inspection reconcile needs the ${INSPECT_QUEUE_NAME} queue, got ${deps.queue.name}`,
		);
	}

	return async function reconcileStrandedInspections(): Promise<number> {
		const running = await deps.prisma.storageInspection.findMany({
			where: { status: "RUNNING" },
			select: { id: true },
			// Bounded AND safe to bound because this runs on a tick: each pass
			// shrinks the RUNNING population, so a backlog drains structurally.
			take: 500,
		});
		let retired = 0;
		for (const row of running) {
			const job = await deps.queue.getJob(row.id);
			if (job && !DEAD_STATES.has(await job.getState())) {
				continue;
			}
			// Conditional on RUNNING: a peer finishing between read and write
			// keeps its result.
			const { count } = await deps.prisma.storageInspection.updateMany({
				where: { id: row.id, status: "RUNNING" },
				data: { status: "ERROR", error: STRANDED_INSPECTION_ERROR },
			});
			retired += count;
		}
		return retired;
	};
}
