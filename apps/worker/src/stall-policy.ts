import type { QueueKey } from "@bitovp/core";

/**
 * How many worker deaths a long-running job survives before BullMQ retires it.
 *
 * BullMQ's default is `maxStalledCount: 1`, which fails a job permanently on
 * its SECOND stall — and a "stall" here is not a misbehaving job, it is a
 * worker that died while holding the lock.
 *
 * Measured 2026-08-15 : a real encoding was SIGKILLed twice
 * mid-flight and landed `ERROR — job stalled more than allowable limit` at
 * step 15/34, while its Bitmovin encoding kept running and billing. `POST
 * /retry` then drove the same row to FINISHED 34/34 in 70 seconds, untouched.
 * That is the proof that nothing was wrong with the WORK: the step log is
 * authoritative and every step is idempotent by design, so re-running is
 * exactly what this system is built to do.
 *
 * Two worker restarts inside one encode is not exotic — it is a rolling
 * deploy, an OOM, or a crashloop. And on the unattended paths (watch folders,
 * the scheduler) nobody is there to press retry, so the job simply stops
 * existing while the cloud resource keeps costing money.
 *
 * Finite rather than 0 (which BullMQ reads as "never fail"): a job that
 * genuinely kills its worker every time must still come to rest.
 *
 * FIVE, not ten. Review-final argued the number down and the argument holds:
 * at the default 30s `stalledInterval` a crashlooping worker burns the whole
 * budget in minutes either way, so a high ceiling buys nothing there — it only
 * buys more partial re-executions against the live API. The case this exists
 * for is an occasional OOM or a deploy across a multi-hour encode, and five is
 * ample for that. The first cut said ten with no bound behind it.
 *
 * THE TRADE-OFF, stated rather than left implicit. A stall has two causes and
 * they behave differently:
 *
 *  - The worker DIED. There is no second executor, so the redelivery is a
 *    clean resume off the step log. This is the case the raise is for, and
 *    the case measured above.
 *  - The worker is ALIVE but missed a lock renewal (a blocked event loop).
 *    Then the redelivery runs CONCURRENTLY with the original, and
 *    `processor.ts` already records what that costs: top-level creates dedupe
 *    through 's stamp and adopt window, but unstamped manifest
 *    CHILDREN — DASH periods, HLS media infos, whose SDK models carry no
 *    customData — can duplicate inside an adopted manifest. That is the
 *    codebase's pre-existing accepted stall risk ( records the
 *    residual); this change does not create it.
 *
 * What this change does do is allow that second case to recur up to ten times
 * instead of being cut short by the job being failed outright. That is the
 * right trade only because the alternative is strictly worse: a job retired
 * permanently after two worker deaths leaves the cloud encoding running and
 * billing, loses the work on paths where nobody can press retry, and does so
 * for a reason — "the worker died twice" — that says nothing about the job.
 * A duplicated DASH period is a repairable artefact; an abandoned encoding
 * that keeps costing money is not self-correcting.
 */
export const DEFAULT_LONG_JOB_MAX_STALLED_COUNT = 5;

/**
 * Queues whose processor legitimately holds one job for a long time.
 *
 * The orchestrator waits out an encode in `await:encoding`; a feeder push owns
 * its job for the whole session, which can be hours; a VMAF run is an ffmpeg
 * pass over the full asset.
 *
 * The discriminator is the EXPOSURE WINDOW — how long one job holds the lock —
 * not job quality. An earlier version of this comment said a short queue keeps
 * the default because "a second stall really does suggest a bad job", which
 * contradicts this module's own thesis: a SIGKILL stalls every in-flight job
 * on every queue equally, and has nothing to say about the job (review-final).
 * A short queue simply has almost no window in which to be killed.
 *
 * `liveChannel` is DELIBERATELY EXCLUDED although it does run long jobs
 * (live-to-VOD, heartbeat polls). It multiplexes those with short one-shots
 * that are NOT idempotent: `insert-content` — the slate insertion SLATE_IN of ledger
 * #84, a KEY feature — guards only on `row.status !== "RUNNING"`, and the
 * channel stays RUNNING throughout an insert, so a redelivered job inserts the
 * slate AGAIN, on air. `scte35` has the same shape. Raising the ceiling there
 * would multiply that duplicate rather than a benign resume, and a duplicate
 * ad marker or slate over a live stream is not a repairable artefact.
 *
 * The exclusion costs something, and it is NOT one-sided — an earlier draft
 * said it was, and review-final found the counter-example. A SCHEDULER-FIRED
 * `provision`  that suffers the stalls lands
 * the channel ERROR with the schedule row already consumed ARMED→FIRED, and
 * nobody re-fires it: a scheduled broadcast silently does not happen, which is
 * this row's own harm class landing on the excluded queue.
 *
 * What still makes exclusion right is this module's own discriminator, the
 * EXPOSURE WINDOW. `provision` is a burst of API calls lasting a minute or
 * two, not a multi-hour hold, so two worker deaths inside it is far less
 * likely than inside an encode — while an `insert-content` duplicate is
 * unbounded-severity on air. Losing a heartbeat poll costs nothing (it is a
 * repeatable job; the next sweep re-polls), and both `live-to-VOD` and
 * `provision` have explicit wedge prevention in `index.ts` that turns an
 * out-of-processor death into ERROR rather than a stuck row, so both are
 * operator-recoverable.
 *
 * Raise it here only once `insert-content`/`scte35` carry an idempotency key —
 * the schedule row id is already in hand at enqueue time. That is not merely
 * the nicer path, it is the ONLY one: `maxStalledCount` is a Worker-level
 * option, so a per-ACTION ceiling cannot be expressed in BullMQ at all.
 */
export const LONG_RUNNING_QUEUES: ReadonlySet<QueueKey> = new Set<QueueKey>([
	"orchestrator",
	"feederManager",
	"vmafRunner",
	// #160 PR4: a probe batch legitimately holds its job for N x the abandon
	// deadline (serial by design), and every step is resumable — the same
	// dead-worker-redelivery-is-a-clean-resume argument as the three above.
	"startupProbe",
	// : a normalization downloads, transcodes and uploads a customer
	// object — minutes — and is resumable (a stale claim is re-entered, the
	// provider content is adopted by marker), the same argument as above.
	"slateNormalize",
]);

/**
 * The stall options for a queue — spread straight into the Worker options, so
 * a short queue contributes no keys at all and keeps BullMQ's own default
 * rather than a value we would then have to keep in step with it.
 */
export function stallOptionsFor(
	key: QueueKey,
	maxStalledCount: number = DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
): { maxStalledCount?: number } {
	return LONG_RUNNING_QUEUES.has(key) ? { maxStalledCount } : {};
}
