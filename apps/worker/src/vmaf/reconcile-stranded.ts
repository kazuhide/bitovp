import { QUEUE_NAMES } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { autoTriggerKey } from "@bitovp/db";
import type { Queue } from "bullmq";
import { qcContinuationJobId } from "./processor";

const VMAF_QUEUE_NAME = QUEUE_NAMES.vmafRunner;

/**
 *  — a VMAF row left at RUNNING by a dead worker is stranded
 * FOREVER, and it takes the data reset down with it.
 *
 * Found by the owner, 2026-08-18, trying to use 's reset: it
 * refused with "something is still running", and the Bitmovin dashboard showed
 * nothing — correctly, because VMAF is this app's own ffmpeg/libvmaf pipeline
 * and never touches Bitmovin at all. The blocking row had been RUNNING since
 * 2026-06-21. Fifty-eight days.
 *
 * Nothing could move it:
 *  - the processor's claim is `PENDING → RUNNING`, so a row already RUNNING
 *    matches zero rows on redelivery;
 *  - `DELETE /api/vmaf-jobs/[id]` refuses a non-terminal row — "wait for it to
 *    finish before deleting", and it never will;
 *  - with QC/VMAF switched off  the whole surface 404s, so the
 *    operator could not even see it.
 *
 * That is a refusal with no remedy, which is the trap this codebase keeps
 * finding. The row records a CLAIM ("a worker took this") and nothing ever
 * checked whether the claimant still exists.
 *
 * THE DISCRIMINATOR IS THE QUEUE, NOT THE CLOCK. `jobId === VmafJob.id` for
 * every producer (the VOD trigger and the live capture route both set it), so
 * "is anyone still working on this" is answerable exactly rather than guessed
 * from `updatedAt` — which would retire a legitimately long ffmpeg run that
 * simply has not written a row in a while.
 *
 * Self-correcting in the one ambiguous case: if the queue was obliterated
 * under a genuinely running ffmpeg (the reset does that), this marks the row
 * ERROR and the still-live processor writes its result over the top when it
 * finishes. An operator-visible error that later turns into a result beats a
 * row nobody can touch.
 */
export const STRANDED_VMAF_ERROR =
	"The worker running this VMAF report went away before it finished, and the queue no longer holds the job. Nothing is running — run it again if you still want the score.";

/**
 * The DEAD set, enumerated — not the live one (review-3 I4).
 *
 * The first cut listed the LIVE states and treated everything else as dead,
 * which is the fail-dangerous polarity and contradicts the doctrine this
 * feature's sibling states out loud (`reset.ts`: "stated as the stopped set
 * rather than the blocking set on purpose, so a status added later blocks by
 * default"). BullMQ 5.78's `JobState` already contains a live state the first
 * cut omitted — `waiting-children`, unreachable today only because nothing
 * uses a FlowProducer — so adopting flows, or an upgrade adding a state, would
 * have silently turned this into a killer of live work with no test failing.
 *
 * Now a state must be KNOWN-dead to retire a row. Anything unrecognised leaves
 * it alone, which costs an operator one more restart and costs a running
 * ffmpeg nothing.
 */
const DEAD_STATES = new Set(["completed", "failed", "unknown"]);

type OrchestratorQueueLike = Pick<Queue, "add">;

export function createStrandedVmafReconciler(deps: {
	prisma: AppPrismaClient;
	queue: Pick<Queue, "getJob" | "name">;
	/** Wired in every real deployment; see `wakeParkedJob`. */
	orchestratorQueue?: OrchestratorQueueLike;
}) {
	// review-3 I5: `Pick<Queue, "getJob">` accepted ANY queue, and passing the
	// wrong one typechecks perfectly while making getJob answer undefined for
	// every row — retiring all of them, live ones included. The name is what
	// distinguishes them at runtime, so it is checked at construction.
	if (deps.queue.name !== VMAF_QUEUE_NAME) {
		throw new Error(
			`stranded-VMAF reconcile needs the ${VMAF_QUEUE_NAME} queue, got ${deps.queue.name}`,
		);
	}

	/**
	 * review-3 I1: retiring the report is not enough when its job is PARKED.
	 *
	 * A plan with `qc.gate.onFail = BLOCK_MANIFESTS` leaves its EncodingJob at
	 * AWAITING_QC, and the only exit is the orchestrator continuation the VMAF
	 * processor enqueues at its terminal choke point. Writing ERROR straight
	 * past that choke point retires the report into a state whose sole rescue —
	 * the processor's claim-failed self-heal — runs on a queue REDELIVERY,
	 * which this reconciler's own precondition (nothing live on the queue)
	 * guarantees will never arrive. The fix for one stranded row would have
	 * created another, in a status the reset also blocks on.
	 *
	 * AWAITING_QC is the discriminator rather than re-parsing the plan: the
	 * orchestrator parks a job there only behind a blocking gate, and it stays
	 * the single writer of job status — the continuation lets it land
	 * QC_FAILED with a "measurement failed" reason, exactly as it would for a
	 * measurement that errored normally.
	 */
	async function wakeParkedJob(
		vmafJobId: string,
		encodingJobId: string | null,
		triggerKey: string | null,
	): Promise<void> {
		if (!encodingJobId) {
			return;
		}
		// review-3 S1: the SAME scope the boundary reads. resolveQcBoundary
		// looks up `vod-auto:<encodingJobId>` specifically — a scope added
		// (review-258 122-A2) because an unscoped read let a lab row
		// fail-close a passing job. Waking on any row that merely carries an
		// encodingJobId is the writer's side of that same mistake: safe today
		// only through a reachability argument across three files (lab-manual
		// rows require a FINISHED job; live captures carry no encodingJobId),
		// and reachability arguments are what failed on the reader's side.
		// Both ends derive the scope from one rule now.
		if (triggerKey !== autoTriggerKey(encodingJobId)) {
			return;
		}
		if (!deps.orchestratorQueue) {
			// review-3 S2: silence here would quietly un-fix I1 — the row is
			// retired and its job stays parked forever. The processor's
			// equivalent optional dep shouts for the same reason.
			console.error(
				`[vmaf] retired report ${vmafJobId} but no orchestrator queue is wired — encoding ${encodingJobId} stays parked until a manual resume`,
			);
			return;
		}
		try {
			const parked = await deps.prisma.encodingJob.findFirst({
				where: { id: encodingJobId, status: "AWAITING_QC" },
				select: { id: true },
			});
			if (!parked) {
				return;
			}
			await deps.orchestratorQueue.add(
				"orchestrate",
				{ encodingJobId },
				{
					jobId: qcContinuationJobId(encodingJobId, vmafJobId),
					removeOnComplete: 1000,
					removeOnFail: 1000,
				},
			);
		} catch (err) {
			// Best-effort, like the processor's own enqueue: the row is already
			// retired and the job can still be resumed by hand.
			console.error(
				`[vmaf] could not wake encoding ${encodingJobId} parked behind a retired report:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	return async function reconcileStrandedVmafJobs(): Promise<number> {
		const running = await deps.prisma.vmafJob.findMany({
			where: { status: "RUNNING" },
			select: { id: true, encodingJobId: true, triggerKey: true },
			// review-3: bounded, and safe to bound ONLY because this runs on a
			// tick. Each pass removes what it retires from the RUNNING
			// population, so the set strictly shrinks and a table over the
			// bound drains across successive ticks — termination is structural,
			// not statistical. Boot-only, this would have been a silent
			// truncation abandoning rows 501+ forever. Live rows cannot
			// approach 500: VMAF concurrency is max(1, cores/4) per worker.
			take: 500,
		});
		let retired = 0;
		for (const row of running) {
			const job = await deps.queue.getJob(row.id);
			// A job still on the queue in a state nobody has classified as dead
			// means a worker owns it, or is about to. Leave it.
			if (job && !DEAD_STATES.has(await job.getState())) {
				continue;
			}
			// Conditional on RUNNING: a peer that finishes between the read and
			// this write keeps its result.
			const { count } = await deps.prisma.vmafJob.updateMany({
				where: { id: row.id, status: "RUNNING" },
				data: { status: "ERROR", error: STRANDED_VMAF_ERROR },
			});
			if (count === 0) {
				continue;
			}
			retired += count;
			await wakeParkedJob(row.id, row.encodingJobId, row.triggerKey);
		}
		return retired;
	};
}
