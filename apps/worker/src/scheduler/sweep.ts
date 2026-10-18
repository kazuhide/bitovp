import { randomUUID } from "node:crypto";
import type {
	LiveChannelJob,
	LiveEffectAction,
	LiveEffectIntent,
	SlateSource,
} from "@bitovp/core";
import {
	compileLiveRunStepLog,
	DEFAULT_SCHEDULE_START_GRACE_MINUTES,
	deriveProviderLifecycle,
	feederErrorEnglish,
	ingestConnectedFresh,
	isLiveRunStatus,
	isStaleGeneration,
	liveChannelPlanSchema,
	MIN_SLATE_FIRE_SECONDS,
	MslEncoderVersionError,
	PROVISION_LEASE_RELEASE,
	reseedFailedSteps,
	sealedFeederSourceSchema,
	slateSourceSchema,
	stepLogSchema,
} from "@bitovp/core";
import { type AppPrismaClient, DB_NULL, type Prisma } from "@bitovp/db";
import { estimateStageLeadMs, STAGE_LEAD_MAX_MS } from "../feeder/stage-lead";
import type { EmitProductEvent } from "../notify/emitter";
import { createRunMirror } from "../orchestrator/run-mirror";
import { DEFAULT_REGISTRATION_TIMEOUT_MS } from "../orchestrator/slate-register";
import { reconcileStartupSamples } from "../orchestrator/startup-sample";
import {
	admitInactiveOrganization,
	hasCommittedStart,
} from "../tenant/admission";
import {
	CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
	recordScheduleOutcomeBestEffort,
	transitionScheduleToStale,
} from "./schedule-outcome";

/**
 * Live schedule sweep . Fires
 * due LiveSchedule rows through the EXISTING
 * queue actions.
 *
 * REWRITTEN after review-190 (C1/C2/C3 + I1/I2/I4/I6 — root cause: the
 * first cut claimed its own row, fired an action WITHOUT claiming the
 * channel, and never reconciled, so wrong channel state, thrown actions,
 * failed enqueues and invalid params all rendered as success):
 *
 * - The sweep now makes the SAME channel claims the actions route makes
 *   (transition-is-the-lock): START claims CREATED|ERROR→PROVISIONING
 *   (re-seeding FAILED/RUNNING steps for ERROR — the route's resume
 *   pattern) and maps STOPPED→`restart` with its PROVISIONING claim;
 *   STOP claims RUNNING|ERROR→STOPPING. A channel already RUNNING makes a
 *   START row COMPLETED with a note (design §3.1) — success is never
 *   reported for work that did not happen.
 * - Transient states WAIT instead of failing: a STOP due while the
 *   channel is PROVISIONING/STOPPING stays ARMED and retries next tick
 *   (stop has no grace, so "fires no matter how late" now means
 *   EVENTUALLY, not "thrown into a mid-transition channel"). A START due
 *   while STOPPING stays ARMED the same way; its grace window still
 *   bounds the wait.
 * - Enqueue failure RELEASES: the row returns to ARMED (the grace
 *   machinery decides — STOP retries forever, START/SLATE retry until
 *   grace then MISSED) and the channel gets the route's ERROR mark so the
 *   claim is never left dangling.
 * - SLATE_IN rows are validated BEFORE any claim (missing content fields
 *   ⇒ ERROR + MISSED, never a doomed queue job), and only fire into a
 *   RUNNING channel — otherwise they wait out their grace.
 * - The cap reads LiveChannel.runningSince (an indexed column the worker
 *   writes at every RUNNING transition — restarts start a fresh epoch)
 *   and claims atomically: the channel claim RUNNING→STOPPING is the
 *   lock, the synthetic row's fireAt is the DETERMINISTIC epoch deadline
 *   under a partial unique index (P2002 = already recorded), and the
 *   queue jobId derives from the same deadline so a re-enqueue after a
 *   crash dedupes instead of double-stopping.
 * - runOnce is reentrancy-guarded: a tick that outruns the interval skips
 *   instead of overlapping itself.
 *
 *  (audit 2026-08-29 IMPORTANT-3): those WAITs are what made the
 * fixed `take: 100` due window a starvation hazard — a waiting row keeps
 * its place at the head of it forever. Both ARMED scans now page with a
 * resuming keyset cursor; `DUE_SCAN_BUDGET` below carries the mechanism and
 * the two designs it beat.
 */

/**
 * Re-exported from core, which owns the number so the WEB layer can reason
 * about overdue rows with the same value (review-234 I2). The runtime override
 * (`SCHEDULE_START_GRACE_MINUTES`) still lives in the worker.
 */
export const DEFAULT_START_GRACE_MINUTES = DEFAULT_SCHEDULE_START_GRACE_MINUTES;
/** Claims older than this are a dead job's leavings — re-claimable (F1). */
export const STALE_CLAIM_MS = DEFAULT_REGISTRATION_TIMEOUT_MS + 60_000;
const CAP_NOTE = "max-run-cap";

/**
 * The sweep cadence. It lives HERE rather than at the interval in
 * `index.ts` because the outbox grace below is defined in ticks — a
 * cadence the worker could change without the sweep knowing would silently
 * re-dispatch healthy in-flight handoffs (or wait ten minutes to recover a
 * lost one).
 */
export const SCHEDULE_SWEEP_INTERVAL_MS = 30_000;

/**
 * How long a FIRED row may sit with no handoff stamp before the dispatcher
 * treats the handoff as LOST .
 *
 * TWO ticks, not one: the tick that claimed a row calls `queue.add`
 * microseconds later, so its own next tick would still find the stamp
 * missing only if the write is genuinely in flight — one tick of slack
 * keeps a healthy dispatch out of the recovery path, and the re-add is
 * idempotent anyway (same deterministic job id).
 */
export const DISPATCH_GRACE_MS = SCHEDULE_SWEEP_INTERVAL_MS * 2;

/**
 * The deterministic queue id for a scheduled action — DERIVED from the row,
 * so a re-dispatch after a crash lands on the same id and BullMQ dedupes
 * instead of running the action twice .
 *
 * Constant per ROW, not per firing, on purpose. BullMQ's jobId dedupe
 * consults the COMPLETED/FAILED sets too, so an epoch suffix is REQUIRED
 * wherever a row can legitimately be handed off more than once — which is
 * why `registerPendingSlates` carries its claim epoch (review-223 F1). An
 * ACTION row cannot: the only path back to ARMED is `rearm`, which runs
 * exclusively in the catch of a FAILED `enqueue`, and in the torn case
 * where the add did reach Redis, deduping on the constant id is exactly
 * the wanted outcome — one job for one row.
 */
/**
 * : the pre-stage's own deterministic id. Distinct from the row's
 * fire id because a switch row is handed off TWICE — the stage at
 * fireAt − lead and the commit at fireAt — and BullMQ's dedupe would
 * otherwise read the second as a replay of the first.
 *
 * Suffixed with the CLAIM instant (rev367 I-2), because a constant id made
 * the dead-stage recovery a no-op: liveChannel jobs are added with
 * `removeOnFail: 1000`, BullMQ's jobId dedupe consults the FAILED set too,
 * and `releaseDeadStageClaim` puts the row back into the stage scan — whose
 * re-add under the same id returned the dead job and queued NOTHING, so at
 * fireAt the row was refused "the pre-stage job has not created a session
 * yet". A released claim is re-staged under a NEW instant and therefore a
 * new id; a LOST-HANDOFF re-add (`redispatchStrandedStages`) derives the
 * SAME instant from the row's own `stagedAt`, so a handoff that DID land
 * still dedupes instead of staging twice — and if a dead job's claim were
 * ever re-added rather than released, the row-#262 guard makes the second
 * run a no-op.
 */
export function scheduleStageJobId(scheduleId: string, stagedAt: Date): string {
	return `${scheduleJobId(scheduleId)}:stage:${stagedAt.getTime()}`;
}

/** : how many switch rows one tick examines for staging. */
export const STAGE_SCAN_BUDGET = 100;

export function scheduleJobId(scheduleId: string): string {
	return `sched-${scheduleId}`;
}

/**
 * How many due rows ONE tick may examine (audit 2026-08-29
 * IMPORTANT-3).
 *
 * The defect: the due scan was `orderBy fireAt asc, take 100` and nothing
 * else. A row that is due but CANNOT fire yet — a STOP against a
 * PROVISIONING channel, a slate waiting for a connected ingest, a feeder
 * waiting for RUNNING — stays ARMED by design (that is the whole "wait,
 * never fail into a mid-transition channel" contract of review-190). Those
 * rows keep the OLDEST fireAt, so they re-occupy the head of the window on
 * every tick: 100 of them on one channel and no other channel's row is ever
 * SEEN again, globally, forever. Nothing recovers it — the rows are ARMED,
 * so the #236 outbox dispatcher (which scans FIRED) cannot see them either.
 *
 * The mechanism: KEYSET-CURSOR PAGING. The tick pages through the due set
 * in `(fireAt, id)` order until the budget below is spent, then REMEMBERS
 * where it stopped; the next tick resumes there, and a tick that reaches
 * the tail resets to the head. Every due row is therefore examined within
 * ⌈due/budget⌉ ticks regardless of what the HEAD does — which is the whole
 * defect. That bound holds with NO exception for re-armed rows: they ride a
 * separate allowance (`pageScan`'s `replay`) rather than costing the forward
 * scan a tick, which is the correction review #356 v2 forced after the first
 * rework spent ticks on them and capped the tail at two windows. The honest
 * limit on the figure is the TAIL: a fixed budget per tick chases a receding
 * one, so it holds against a due set that is not growing faster than the
 * budget clears it. Sizing the budget is what buys that margin, and
 * `stats.waiting` staying high tick after tick is the signal that it no
 * longer does.
 *
 * Three properties this shape buys, which is why it beat the alternatives:
 *
 *  - Today's timing is UNCHANGED below the budget. With fewer than
 *    `DUE_SCAN_BUDGET` due rows the cursor never survives a tick (the tail
 *    is reached, it resets to null) and every due row is examined every
 *    tick — exactly what `take: 100` did for the first hundred, now for all
 *    of them. The ordinary case (one due row, channel RUNNING) still fires
 *    on the tick it comes due, in one query. (A due set landing EXACTLY on
 *    the budget is the one seam: see `pageScan`.)
 *  - KEYSET, not OFFSET. Rows LEAVE the result set as they fire (ARMED is
 *    in the where-clause), so `skip` would step over the rows that shifted
 *    down into the gap — silently skipping exactly the rows that were
 *    behind the ones that worked.
 *  - Nothing about the row changes. The claim → `dispatchedAt` → dispatcher
 *    contract  and every per-row decision are untouched; this
 *    is purely which rows the tick gets to LOOK at.
 *
 * Rejected — `deferredUntil` / `nextAttemptAt` stamped on a row that was
 * examined and could not fire, with the scan skipping stamped rows: it
 * clears the head, but it CHANGES WHEN A ROW FIRES. A STOP whose channel
 * finishes PROVISIONING two seconds into a 60s deferral no longer fires on
 * the next tick, and "a stop fires no matter how late" (review-190 C2)
 * becomes "no earlier than the backoff I guessed". It also costs a
 * migration, a write per blocked row per tick, and a fourth row state that
 * the outbox/CAS discipline does not know about — a stale stamp would sit
 * on a critical STOP with nothing to clear it.
 *
 * Rejected — per-channel fairness (at most N due rows per channel per
 * tick): it fixes the audit's example and not the defect. One hundred
 * channels holding one blocked due row each still fill any fixed window and
 * still starve everyone behind them, because the unfairness is between the
 * HEAD of a global ordering and its tail, not between channels. Expressing
 * "N per channel" in SQL also means over-fetching and filtering in memory,
 * which is the unbounded scan the window exists to prevent.
 */
export const DUE_SCAN_BUDGET = 500;

/** Rows per keyset page. The budget, not this, bounds a tick. */
const DUE_PAGE_SIZE = 100;

/**
 * The registration pass's budget . Same defect, same fix, smaller
 * numbers: `registerPendingSlates` scanned `take: 20` ARMED SLATE_IN rows
 * and skipped any whose channel was not RUNNING WITHOUT changing the row,
 * so twenty creation-time slates on one stuck channel would block slate
 * registration for every other channel in the deployment. A claim that
 * SUCCEEDS evicts itself from the scan (`contentClaimedAt` is in the
 * where-clause); only the blocked ones persist, which is precisely the
 * starving head.
 */
export const REGISTRATION_SCAN_BUDGET = 100;

/** Registration rows per keyset page. */
const REGISTRATION_PAGE_SIZE = 20;

/** Where a paged scan stopped: the last row it examined. */
type ScanCursor = { fireAt: Date; id: string } | null;

/**
 * The window ONE page reads: the keyset half ("strictly after `cursor` in
 * (fireAt, id) order") OR the re-examination set (review #356 v2).
 *
 * Composed as a single `AND` element holding a single `OR`, never as a bare
 * `OR:` key. `registerPendingSlates` already spends its object's top-level
 * `OR` on claim staleness, and a second `OR:` key on the same object literal
 * does not merge — it REPLACES, silently, and the staleness clause would
 * vanish with no error anywhere. One `AND` element keeps both scans on one
 * shape and leaves the other predicate untouched.
 *
 * A null cursor returns `{}`: at the head the base predicate already selects
 * every candidate, and the replay ids are a SUBSET of it — narrowing to
 * `OR id IN (...)` there would hide the forward scan behind the replay set.
 */
function scanWindow(
	cursor: ScanCursor,
	replay: readonly string[],
): Prisma.LiveScheduleWhereInput {
	if (cursor === null) {
		return {};
	}
	return {
		AND: [
			{
				OR: [
					{ fireAt: { gt: cursor.fireAt } },
					{ fireAt: cursor.fireAt, id: { gt: cursor.id } },
					...(replay.length > 0 ? [{ id: { in: [...replay] } }] : []),
				],
			},
		],
	};
}

/** `max(cursor, row)` in (fireAt, id) order — the cursor never rewinds. */
function advanceCursor(
	cursor: ScanCursor,
	row: { id: string; fireAt: Date },
): ScanCursor {
	if (cursor === null) {
		return { fireAt: row.fireAt, id: row.id };
	}
	const delta = row.fireAt.getTime() - cursor.fireAt.getTime();
	const ahead = delta > 0 || (delta === 0 && row.id > cursor.id);
	return ahead ? { fireAt: row.fireAt, id: row.id } : cursor;
}

/**
 * Page a scan from `start`, handling every row, and return where the NEXT
 * tick should resume: the last row reached, or `null` for the tail.
 *
 * A SHORT page proves the tail without a second round trip, and the reset it
 * triggers happens in the SAME tick, so the common case costs nothing extra.
 * The one case that does: a page that fills the allowance EXACTLY leaves the
 * cursor set, and the next tick spends one empty query discovering the tail
 * before resetting. Harmless — a query, not a missed firing.
 *
 * RE-EXAMINATION (review #356 v2 — the CRITICAL correction). A row that
 * re-arms goes back to ARMED at its own fireAt, which the cursor has already
 * passed; without help it waits for the cursor's next lap. The first fix
 * rewound the cursor for it, and that was wrong in a way worth recording,
 * because the shape recurs: rewinding spends TICKS, and ticks are the same
 * resource forward progress needs. Under sustained triggering — an ordinary
 * BullMQ outage, where EVERY row re-arms — the scan cycled between its first
 * two windows forever (measured: 1500 rows, 16 ticks, only 1000 ids ever
 * attempted), which is this row's own starvation defect rebuilt on the
 * billing-critical STOP path. Any scheme that pays ticks for re-examination
 * has that ceiling.
 *
 * `replay` decouples the two. The ids re-armed on the previous tick are
 * merged into the page QUERY, so they are re-examined without the cursor
 * moving back a single row, and the allowance is `budget + replay.size`: at
 * most `replay.size` of the rows examined can be replays, so a full budget
 * of FORWARD rows is still available every tick. That is why the set cannot
 * cost the forward scan a tick — it does not compete for the same allowance.
 * The tail bound therefore stays ceil(due/budget) ticks, with no exception
 * for re-arms, and a re-armed row is examined on the very next tick.
 *
 * Each fetched id leaves the set, so a replayed row cannot be served twice
 * inside one tick; re-arming again simply enrols it for the NEXT tick.
 */
async function pageScan<T extends { id: string; fireAt: Date }>(opts: {
	start: ScanCursor;
	/** Ids re-armed on the previous tick. Drained as they are served. */
	replay: Set<string>;
	budget: number;
	pageSize: number;
	fetch: (
		cursor: ScanCursor,
		replay: readonly string[],
		take: number,
	) => Promise<T[]>;
	handle: (row: T) => Promise<void>;
}): Promise<ScanCursor> {
	let cursor = opts.start;
	let examined = 0;
	// The replay set is drained below, so this is read ONCE: the allowance is
	// "a full budget of forward rows, plus however many replays were owed".
	const allowance = opts.budget + opts.replay.size;
	while (examined < allowance) {
		const take = Math.min(opts.pageSize, allowance - examined);
		const page = await opts.fetch(cursor, [...opts.replay], take);
		for (const row of page) {
			opts.replay.delete(row.id);
			// The cursor advances BEFORE the handler runs, and must: the
			// handler can move the row out of the scan entirely, so re-reading
			// its position afterwards would read a row that is no longer
			// there. MONOTONIC, so a replayed row from behind the cursor is
			// examined without costing the forward scan its place.
			cursor = advanceCursor(cursor, row);
			examined += 1;
			await opts.handle(row);
		}
		if (page.length < take) {
			// The tail. Next tick starts from the head again.
			return null;
		}
	}
	return cursor;
}

/**
 * How many re-armed ids one scan may carry into the next tick (* review #356 v2).
 *
 * The cap exists because the set is merged into a query and read back as
 * rows: unbounded, a deployment-wide outage would build an `IN (...)` list
 * as long as the due table and a tick would materialise all of it. At the
 * cap, a tick's worst case is `budget + cap` rows — bounded, and the same
 * order of work the budget already sanctions.
 *
 * Equal to the due budget on purpose: replays never displace forward rows
 * (they ride an allowance of their own — see `pageScan`), so the only thing
 * the cap trades away is how many re-arms get the fast path in one tick, and
 * a tick cannot produce more than `budget + cap` of them anyway.
 */
export const REARM_REPLAY_CAP = DUE_SCAN_BUDGET;

/**
 * The bounded, insertion-ordered set of ids owed a re-examination.
 *
 * OLDEST-WINS on overflow: the ids already queued have waited longest, and a
 * newcomer that is dropped is still ARMED and still due, so the cursor's lap
 * reaches it — the pre-replay behaviour, never worse. The alternative
 * (evicting the oldest for the newest) would starve exactly the row that has
 * been waiting the longest, which is the failure this whole row is about.
 */
function createReplayQueue(cap: number = REARM_REPLAY_CAP) {
	const ids = new Set<string>();
	let dropped = 0;
	return {
		add(id: string): void {
			if (ids.has(id)) {
				return;
			}
			if (ids.size >= cap) {
				dropped += 1;
				return;
			}
			ids.add(id);
		},
		/** Hand the whole set to the tick and start collecting afresh. */
		drain(): Set<string> {
			const owed = new Set(ids);
			ids.clear();
			return owed;
		},
		/** Read-and-reset, so a drop is reported by exactly one tick. */
		takeDropped(): number {
			const total = dropped;
			dropped = 0;
			return total;
		},
		get size(): number {
			return ids.size;
		},
	};
}

export type ScheduleSweepStats = {
	fired: number;
	missed: number;
	completed: number;
	waiting: number;
	capStops: number;
	errors: number;
	/** : FIRED rows whose lost queue handoff this tick recovered. */
	redispatched: number;
	/**
	 *  (review #356 v2): re-armed ids that did not fit the replay cap
	 * and so lost their fast path back. NOT lost work — they are examined on
	 * the cursor's next lap — but a non-zero count means re-arms are arriving
	 * faster than a tick can replay them, which in practice means the queue
	 * is refusing work.
	 */
	rearmsDropped: number;
	/** : rows refused because they were armed for a different airing. */
	skippedStale: number;
	/** : FEEDER_SWITCH rows whose pre-stage this tick dispatched. */
	staged: number;
};

/**
 * The sweep tick, with the outbox dispatcher exposed for the BOOT pass —
 * a worker that was killed mid-handoff must recover on restart, not 30s
 * later, and the boot pass is deliberately NOT a whole tick (booting must
 * not also fire every due row a beat earlier than the cadence says).
 */
export type ScheduleSweep = (() => Promise<ScheduleSweepStats>) & {
	dispatchPending(): Promise<number>;
};

type SweepDeps = {
	prisma: AppPrismaClient;
	allowNewWork?: () => Promise<boolean>;
	enqueue(job: LiveChannelJob, dedupeId: string): Promise<void>;
	emitEvent?: EmitProductEvent;
	now(): Date;
	startGraceMinutes?: number;
};

type ScheduleRow = {
	id: string;
	liveChannelId: string;
	/** : the airing this row was armed for (null = not yet bound). */
	liveChannelRunId: string | null;
	action: "START" | "STOP" | "SLATE_IN" | "FEEDER_START" | "FEEDER_SWITCH";
	fireAt: Date;
	insertableContentId: string | null;
	slateDurationSeconds: number | null;
	/** : creation-time rows carry a source + a fire-time bound. */
	slateSource: unknown;
	slateUntil: Date | null;
	contentClaimedAt: Date | null;
	/** : the file a FEEDER_START/FEEDER_SWITCH row pushes. */
	feederSource: unknown;
	/**  PR3: fireAt was derived (airAt − lead) at arm time. */
	autoLeadTime?: boolean;
	airAt?: Date | null;
	/**
	 * : the session a FEEDER_SWITCH row's pre-stage created (stamped
	 * by the stage action), and the stage claim itself. Optional because the
	 * other actions never carry them.
	 */
	feederSessionId?: string | null;
	stagedAt?: Date | null;
};

/**
 * (row 266): stamp WHICH airing a scheduled job is
 * FOR onto its payload, so the processor can refuse a job the queue delivered
 * after the channel re-aired onto a new run. Omitted when the row is not
 * bound to a run (a creation-time row with no run yet) — there is nothing to
 * fence against, and the processor fails open on an ABSENT id exactly as core
 * `isStaleGeneration` does on a null one. A bound row's id is written by the
 * arm route (eager) or by `refuseStaleGeneration`'s lazy bind, which mutates
 * the local row so this stamp sees the just-bound value.
 */
function plannedRunStamp(runId: string | null): {
	plannedLiveChannelRunId?: string;
} {
	return runId !== null ? { plannedLiveChannelRunId: runId } : {};
}

export function createScheduleSweep(deps: SweepDeps): ScheduleSweep {
	const runs = createRunMirror(deps.prisma);
	const grace =
		(deps.startGraceMinutes ?? DEFAULT_START_GRACE_MINUTES) * 60_000;
	let inFlight = false;
	/**
	 * : where each ARMED scan stopped last tick. Per-sweep state, not
	 * per-process global, so two sweeps in one process (tests) do not inherit
	 * each other's position — and deliberately in MEMORY, not in the row: a
	 * cursor lost to a restart costs one pass from the head, which is the
	 * safe direction. Losing it can only make the sweep MORE eager.
	 */
	let dueCursor: ScanCursor = null;
	let registrationCursor: ScanCursor = null;
	let dispatchCursor: ScanCursor = null;
	let stageDispatchCursor: ScanCursor = null;
	let dispatchInFlight: Promise<number> | null = null;
	/**
	 *  (review #356 v2): ids this tick put BACK into an ARMED scan's
	 * population — `rearm`'s successful CAS, and the registration pass
	 * releasing a claim it could not enqueue. The NEXT tick merges them into
	 * its page query (`scanWindow`) so the row is re-examined without the
	 * cursor rewinding; see `pageScan` for why rewinding was the wrong shape.
	 *
	 * Ordered, oldest first, and capped: on overflow the OLDEST are kept,
	 * because they have waited longest, and the newcomer is dropped. A
	 * dropped id is not lost — it is simply examined when the cursor's lap
	 * reaches it, which is exactly the behaviour before any replay existed,
	 * so overflow degrades to the baseline and never below it.
	 */
	const dueRearmed = createReplayQueue();
	const registrationRearmed = createReplayQueue();

	async function effectIntentFor(
		row: Pick<ScheduleRow, "id" | "liveChannelId" | "liveChannelRunId">,
		action: LiveEffectAction,
		targetId?: string,
		generationOffset = 0,
	): Promise<LiveEffectIntent | null> {
		if (row.liveChannelRunId === null) {
			return null;
		}
		const [channel, currentRun] = await Promise.all([
			deps.prisma.liveChannel.findUnique({
				where: { id: row.liveChannelId },
				select: {
					bitmovinEncodingId: true,
					liveEffectFenceVersion: true,
				},
			}),
			deps.prisma.liveChannelRun.findFirst({
				where: { liveChannelId: row.liveChannelId },
				orderBy: { seq: "desc" },
				select: { id: true, bitmovinEncodingId: true },
			}),
		]);
		const providerEncodingId =
			currentRun?.bitmovinEncodingId ?? channel?.bitmovinEncodingId ?? null;
		if (
			!channel ||
			currentRun?.id !== row.liveChannelRunId ||
			providerEncodingId === null
		) {
			return null;
		}
		return {
			idempotencyKey: `schedule:${row.id}:${action.toLowerCase()}`,
			liveChannelRunId: currentRun.id,
			providerEncodingId,
			admissionFenceVersion:
				(channel.liveEffectFenceVersion ?? 0) + generationOffset,
			action,
			scheduleId: row.id,
			...(targetId ? { targetId } : {}),
		};
	}

	/** Schedule-ROW terminal transition (guarded claim from ARMED). */
	async function rowTo(
		row: ScheduleRow,
		status:
			| "FIRED"
			| "MISSED"
			| "ERROR"
			| "COMPLETED"
			| "SKIPPED_STALE_GENERATION",
		extra: { note?: string; error?: string; firedAt?: Date } = {},
	): Promise<boolean> {
		const { count } = await deps.prisma.liveSchedule.updateMany({
			where: { id: row.id, status: "ARMED" },
			data: {
				status,
				// : FIRED means CLAIMED, never "handed to the
				// queue" — the stamp comes only after `add` resolves. Set
				// here, in the ONE place the claim is written, so a fire path
				// cannot forget to open the outbox.
				...(status === "FIRED"
					? { dispatchedAt: null, dispatchJobId: null }
					: {}),
				...extra,
			},
		});
		return count === 1;
	}

	async function failUnfencedArmedEffect(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
		label: string,
	): Promise<void> {
		const at = deps.now();
		const reason = `${label} refused: no exact current live run/provider identity was available for a durable effect claim`;
		const { count } = await deps.prisma.liveSchedule.updateMany({
			where: { id: row.id, status: "ARMED" },
			data: {
				status: "ERROR",
				error: reason,
				outcome: "UNKNOWN",
				outcomeAt: at,
				outcomeNote: reason,
				outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
				outcomeEvidenceAt: at,
			},
		});
		if (count === 1) {
			stats.errors += 1;
			await emitMissed(row, reason);
		}
	}

	/**
	 * : record the handoff, AFTER `queue.add` resolved. The CAS on
	 * `dispatchedAt: null` keeps the stamp at exactly one — a dispatcher
	 * re-add that deduped against an already-running job stamps the row it
	 * found, and never overwrites an earlier truthful stamp.
	 */
	async function markDispatched(rowId: string, jobId: string): Promise<void> {
		await deps.prisma.liveSchedule.updateMany({
			where: { id: rowId, status: "FIRED", dispatchedAt: null },
			data: { dispatchedAt: deps.now(), dispatchJobId: jobId },
		});
	}

	/** Release a FIRED claim back to ARMED (enqueue failed / channel moved). */
	async function rearm(row: ScheduleRow): Promise<void> {
		const { count } = await deps.prisma.liveSchedule.updateMany({
			where: { id: row.id, status: "FIRED" },
			data: {
				status: "ARMED",
				firedAt: null,
				// The outbox closes WITH the claim it belonged to: an ARMED
				// row is not a lost handoff, and leaving a stamp behind would
				// make the next firing look already-dispatched.
				dispatchedAt: null,
				dispatchJobId: null,
			},
		});
		if (count === 1) {
			//  (review #356 v2): the row is back in the due scan's
			// population at its OWN fireAt, which the cursor has already
			// passed. Enrol it for the next tick's query. The ACTUAL
			// transition, not the attempt — a CAS that matched nothing
			// released nothing and has no re-examination to owe.
			dueRearmed.add(row.id);
		}
	}

	async function emitFired(row: { id: string; liveChannelId: string }) {
		await deps.emitEvent?.({
			kind: "SCHEDULE_FIRED",
			scheduleId: row.id,
			liveChannelId: row.liveChannelId,
			path: `/live/${row.liveChannelId}`,
		});
	}

	async function emitMissed(
		row: { id: string; liveChannelId: string },
		reason: string,
	) {
		await deps.emitEvent?.({
			kind: "SCHEDULE_MISSED",
			scheduleId: row.id,
			liveChannelId: row.liveChannelId,
			reason,
			path: `/live/${row.liveChannelId}`,
		});
	}

	/**
	 *  — WHICH AIRING was this row armed for? (audit 2026-08-29 HIGH-4)
	 *
	 * A `LiveSchedule` carried only `liveChannelId`, so it outlived the run it
	 * was meant for. After a re-air, a STOP armed for last night's programme
	 * could take today's off the air, a SLATE_IN could try to splice an
	 * insertable-content id that died with the previous encoding, and a FEEDER
	 * row could push its pre-air filler over the new run's programme. The
	 * ledger could not even say afterwards which generation a row belonged to.
	 *
	 * The check runs at the TOP of each fire path, before any claim, and
	 * returns `true` when it has already terminated the row.
	 *
	 * TWO deliberate exclusions:
	 *
	 *  - `fireStart` does NOT consult this. A START row is what CREATES a
	 *    generation, not one that acts on it; refusing a scheduled airing
	 *    because an unrelated test run happened in between would take a
	 *    broadcast off the schedule for a bookkeeping reason.
	 *
	 *  - A row with no bind at all fires and binds LAZILY, here. This is where
	 *    the bind is written for every creation-time row (the create route
	 *    writes them inside the channel's own transaction, before any run
	 *    exists) and for any row armed against a channel that has never aired.
	 *    Binding them in the START path instead — nailing them to run 1 the
	 *    moment provisioning mints it — would be the dangerous direction: a
	 *    channel that errored and was re-aired as run 2 would then have its
	 *    OWN programme's feeder, slate and STOP rows refused as stale.
	 *
	 * A bound row on a channel with NO run rows fails OPEN (fires). Runs are
	 * never deleted, so the state is unreachable today; if it ever occurs it
	 * means the evidence is gone, and refusing a STOP on missing evidence is
	 * how an encoding bills forever.
	 */
	async function refuseStaleGeneration(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
	): Promise<boolean> {
		const current = await runs.latest(row.liveChannelId);
		if (row.liveChannelRunId === null) {
			if (current) {
				// CAS on `liveChannelRunId: null` — two overlapping ticks must
				// not both stamp, and a bind that lost the race wrote the same
				// value anyway.
				await deps.prisma.liveSchedule.updateMany({
					where: { id: row.id, status: "ARMED", liveChannelRunId: null },
					data: { liveChannelRunId: current.id },
				});
				// (row 266): reflect the just-written
				// bind on the LOCAL row, so the enqueue that follows this call
				// stamps the payload's `plannedLiveChannelRunId` with the run
				// this dispatch is FOR — not the null the row was read as. The
				// CAS above may match nothing under a race, but the value it
				// (or the winner) wrote is this same `current.id`.
				row.liveChannelRunId = current.id;
			}
			return false;
		}
		// The comparison itself lives in core (`isStaleGeneration`) so the ARM
		// routes and this fire path cannot drift into disagreeing about what
		// "stale" means — and so a route test can pin the CONSEQUENCE of its
		// own write, not merely its shape.
		if (!current || !isStaleGeneration(row.liveChannelRunId, current.id)) {
			return false;
		}
		// BOTH ids in the note: "stale" is only auditable if the row says which
		// airing it wanted and which one it found.
		const note = `armed for run ${row.liveChannelRunId}, but this channel is now on run ${current.id} (seq ${current.seq}) — refused rather than fired into a different airing`;
		if (
			await transitionScheduleToStale(deps.prisma, {
				scheduleId: row.id,
				note,
				at: deps.now(),
			})
		) {
			stats.skippedStale += 1;
			// The existing MISSED event, not a new kind: what an operator needs
			// to know is that a scheduled action did not happen, and why, which
			// is exactly this event's contract. The reason carries the detail.
			await emitMissed(
				row,
				`${row.action} was armed for a different airing of this channel (run ${row.liveChannelRunId}) and was not fired`,
			);
		}
		return true;
	}

	/** The route's enqueue-failure pattern: mark the channel, release the row. */
	async function onEnqueueFailure(
		row: ScheduleRow,
		message: string,
		markChannel: boolean,
	): Promise<void> {
		if (markChannel) {
			await deps.prisma.liveChannel.updateMany({
				where: { id: row.liveChannelId },
				data: { status: "ERROR", error: message },
			});
			// Dual-write .
			await runs.mirror(row.liveChannelId, { status: "ERROR", error: message });
		}
		await rearm(row);
	}

	/**
	 * The channel claim and the run-row write commit or fail TOGETHER
	 * (review-284 M2→N2, the class-deleting form): the first cut created
	 * the run row after a committed claim, so a failed create — P2002 race
	 * or a plain DB blip — left the channel claimed with a step log whose
	 * rebased paths named a run row that did not exist, and a bare catch
	 * labelled both causes "a race". With one transaction there is nothing
	 * to mislabel: any failure rolls the claim back untouched, the schedule
	 * row re-arms, and the next tick re-decides against the real world (a
	 * P2002's racing live run is then simply visible to the guard).
	 * Returns false when the channel claim matched zero rows (caller
	 * re-arms as WAITING) and throws nothing to the caller's happy path.
	 */
	async function claimWithRun(
		row: ScheduleRow,
		expectedFenceVersion: number,
		claim: {
			where: Prisma.LiveChannelWhereInput;
			data: Prisma.LiveChannelUpdateManyMutationInput;
		},
		runWrite:
			| { kind: "create"; id: string; seq: number; outputPrefix: string }
			| { kind: "revive"; runId: string; outputPrefix?: string }
			| { kind: "none" },
	): Promise<boolean> {
		const liveChannelId = row.liveChannelId;
		return deps.prisma.$transaction(async (tx) => {
			const claimed = await tx.liveChannel.updateMany({
				where: {
					...claim.where,
					liveEffectFenceVersion: expectedFenceVersion,
					runs: { none: { cancelRequested: true, status: { not: "STOPPED" } } },
					effectClaims: {
						none: {
							state: { in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"] },
						},
					},
				},
				data: {
					...claim.data,
					liveEffectFenceVersion: { increment: 1 },
				},
			});
			if (claimed.count === 0) {
				return false;
			}
			let runId: string;
			if (runWrite.kind === "create") {
				runId = runWrite.id;
				await tx.liveChannelRun.create({
					data: {
						id: runWrite.id,
						liveChannelId,
						seq: runWrite.seq,
						status: "PROVISIONING",
						outputPrefix: runWrite.outputPrefix,
					},
				});
			} else if (runWrite.kind === "revive") {
				runId = runWrite.runId;
				// Same airing, same row (#108 PR3); endedAt clears WITH the
				// revival (review-259 116-A2), and the corpse arm stamps the
				// prefix its recompiled log writes under (#155). The heartbeat
				// summary clears with endedAt too — BOTH columns: the lock, so
				// the resumed airing is re-summarized over ALL its rows when it
				// finally ends, and the JSON, so a RUNNING revived run does not
				// serve the aborted airing's figures meanwhile (rev405 R4).
				await tx.liveChannelRun.update({
					where: { id: runWrite.runId },
					data: {
						status: "PROVISIONING",
						error: null,
						endedAt: null,
						// rev431 R3: the revived run restarts the SAME encoding — a
						// stop/CREATED confirmation for its pointer is void from here
						// (route parity: actions/route.ts revive).
						encoderStoppedConfirmedFor: null,
						heartbeatSummary: DB_NULL,
						heartbeatSummaryAt: null,
						...(runWrite.outputPrefix !== undefined
							? { outputPrefix: runWrite.outputPrefix }
							: {}),
					},
				});
			} else {
				// First-start/join must bind the same generation while the
				// channel claim still holds its row lock, before any enqueue.
				const claimedRuns = createRunMirror(tx);
				runId = await claimedRuns.ensureCurrentRun(liveChannelId);
				await claimedRuns.mirror(liveChannelId, {
					status: "PROVISIONING",
					encoderStoppedConfirmedFor: null,
				});
			}
			const bound = await tx.liveSchedule.updateMany({
				where: {
					id: row.id,
					liveChannelId,
					action: "START",
					status: "FIRED",
					liveChannelRunId: row.liveChannelRunId,
				},
				data: { liveChannelRunId: runId },
			});
			if (bound.count !== 1) throw new Error("START schedule run binding lost");
			return true;
		});
	}

	async function fireStart(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
	): Promise<void> {
		const channel = await deps.prisma.liveChannel.findUnique({
			where: { id: row.liveChannelId },
			select: {
				status: true,
				bitmovinEncodingId: true,
				liveEffectFenceVersion: true,
				stepLog: true,
				// #155: the STOPPED and empty-log arms compile the run's step
				// log here — provision EXECUTES the row's log, never compiles.
				plan: true,
			},
		});
		if (!channel) {
			if (await rowTo(row, "ERROR", { error: "channel no longer exists" })) {
				stats.errors += 1;
				await emitMissed(row, "channel no longer exists");
			}
			return;
		}
		switch (channel.status) {
			case "RUNNING": {
				// Design §3.1: already up is COMPLETED with a note — not an
				// error, and never a duplicate provision.
				if (
					await rowTo(row, "COMPLETED", {
						note: "channel already RUNNING at fire time",
					})
				) {
					stats.completed += 1;
				}
				return;
			}
			case "PROVISIONING":
			case "STOPPING": {
				// Transient: WAIT (review-190 re-verify N1 — an in-flight
				// provision can still FAIL, and a row already COMPLETED could
				// never retry inside its grace; RUNNING is the only state
				// that proves the start happened). Grace bounds the wait.
				stats.waiting += 1;
				return;
			}
			case "CREATED":
			case "ERROR": {
				// Route-symmetric start decisions (#155; review-284 M1/M3/m6/m7
				// closed the sweep⇔route asymmetries instead of ledgering them):
				//   latest LIVE  × CREATED → wait (mid-write world, #48)
				//   latest LIVE  × ERROR   → join-heal: the stranded-enqueue
				//                            shape (the route's enqueue-failure
				//                            marks the channel ERROR while its
				//                            committed run stays PROVISIONING) —
				//                            reseed and rejoin, unattended
				//   latest ERROR × ERROR   → revive the SAME airing (an empty
				//                            log recompiles at the run's own
				//                            coordinates, prefix restamped)
				//   latest STOPPED         → RE-AIR: that airing ENDED, and
				//                            resuming its log would restart a
				//                            FINISHED encoding (C30) — fresh
				//                            compiled log, fresh run row, same
				//                            answer the route's isReair gives
				//   latest absent          → first start (CREATED keeps its
				//                            create-compiled log; an ERROR
				//                            corpse with an empty log compiles
				//                            seq 1 fresh)
				// Every fresh compile stamps its run's prefix, so a run row can
				// no longer claim "" while the channel log walks rebased paths.
				const latest = await runs.latest(row.liveChannelId);
				const latestLive = latest ? isLiveRunStatus(latest.status) : false;
				if (
					latestLive &&
					(channel.status === "CREATED" || latest?.status === "RUNNING")
				) {
					// CREATED × live: a mid-write world (#48). ERROR × RUNNING
					// (review-284 Note A): the boot reconciler explicitly
					// refuses this signature — a RUNNING run under an ERROR
					// channel may point at an encoder genuinely live at
					// Bitmovin, and re-provisioning onto it risks a second
					// encoding beside it. The sweep takes the reconciler's
					// position and waits for the operator; only the
					// TRANSITIONAL trio (CREATED/PROVISIONING/STOPPING) gets
					// the unattended stranded-enqueue heal below.
					stats.waiting += 1;
					return;
				}
				const providerLifecycle = latest
					? deriveProviderLifecycle(latest, deps.now().getTime())
					: "UNOBSERVED";
				const isReair =
					latest?.status === "STOPPED" || providerLifecycle === "TERMINAL";
				const isRevive =
					channel.status === "ERROR" && latest?.status === "ERROR" && !isReair;
				const freshRunId = randomUUID();
				let stepLogData: Prisma.InputJsonValue | undefined;
				let revive: { runId: string; outputPrefix?: string } | null =
					isRevive && latest ? { runId: latest.id } : null;
				let createRun: {
					id: string;
					seq: number;
					outputPrefix: string;
				} | null = null;
				if (channel.status === "ERROR" || isReair) {
					try {
						// A re-air never reads the old log (that airing ended;
						// its log is not an input) — parsing it here would
						// refuse a valid re-air over an unparsable leftover
						// and misblame the plan (review-284 N3 nit).
						const reseeded = isReair
							? []
							: reseedFailedSteps(stepLogSchema.parse(channel.stepLog));
						if (latestLive && !isReair && reseeded.length === 0) {
							// A live run beside an EMPTY channel log is a torn
							// read of a mid-write world — joining it with []
							// would be the zero-step death inside someone
							// else's run. Wait for the writer to finish.
							stats.waiting += 1;
							return;
						}
						if (isReair || reseeded.length === 0) {
							const runForCompile =
								revive && latest
									? { seq: latest.seq, runId: latest.id }
									: { seq: (latest?.seq ?? 0) + 1, runId: freshRunId };
							const compiled = compileLiveRunStepLog(
								liveChannelPlanSchema.parse(channel.plan),
								runForCompile,
							);
							stepLogData =
								compiled.entries as unknown as Prisma.InputJsonValue;
							if (revive && latest) {
								revive = {
									runId: latest.id,
									outputPrefix: compiled.outputPrefix,
								};
							} else {
								createRun = {
									id: runForCompile.runId,
									seq: runForCompile.seq,
									outputPrefix: compiled.outputPrefix,
								};
							}
						} else if (channel.status === "ERROR") {
							stepLogData = reseeded as unknown as Prisma.InputJsonValue;
						}
					} catch (err) {
						// One failure, one name per arm (review-284 N3): a
						// re-air compiles the PLAN, a resume reseeds the LOG.
						const failure =
							err instanceof MslEncoderVersionError
								? err.message
								: isReair
									? "channel plan does not compile — cannot re-air"
									: "step log or plan unusable — cannot resume";
						if (await rowTo(row, "ERROR", { error: failure })) {
							stats.errors += 1;
							await emitMissed(row, failure);
						}
						return;
					}
				}
				if (!(await rowTo(row, "FIRED", { firedAt: deps.now() }))) {
					return; // another sweep claimed the row
				}
				let claimed: boolean;
				try {
					claimed = await claimWithRun(
						row,
						channel.liveEffectFenceVersion ?? 0,
						{
							where: {
								id: row.liveChannelId,
								status: { in: ["CREATED", "ERROR"] },
							},
							data: {
								status: "PROVISIONING",
								error: null,
								// Release the previous run's provisioning lease in
								// the SAME claim — see PROVISION_LEASE_RELEASE.
								...PROVISION_LEASE_RELEASE,
								...(stepLogData !== undefined ? { stepLog: stepLogData } : {}),
								// A re-air frees the per-run channel columns exactly
								// as the STOPPED arm does (review-244 K1): the fresh
								// encoding must not display the ended airing's
								// encoder pointers or ingest sample.
								...(isReair
									? {
											bitmovinEncodingId: null,
											encoderIp: null,
											streamKey: null,
											lastHeartbeat: DB_NULL,
											liveToVod: DB_NULL,
										}
									: {}),
							},
						},
						revive
							? { kind: "revive", ...revive }
							: createRun
								? { kind: "create", ...createRun }
								: { kind: "none" },
					);
				} catch {
					// Rolled back whole — no claim, no orphan log (N2). The row
					// re-arms and the next tick re-decides against the world
					// (: the re-arm enrols the id in the next tick's
					// query, so "next tick" holds under a backlog too, not only
					// an empty one).
					await rearm(row);
					stats.errors += 1;
					return;
				}
				if (!claimed) {
					// Channel moved under us; re-dispatched next tick — the
					// re-arm enrols the id in the next tick's query, so the
					// backlog ahead of this row cannot defer it .
					await rearm(row);
					stats.waiting += 1;
					return;
				}
				try {
					await deps.enqueue(
						{ liveChannelId: row.liveChannelId, action: "provision" },
						scheduleJobId(row.id),
					);
				} catch {
					await onEnqueueFailure(row, "Enqueue failed — start again", true);
					stats.errors += 1;
					return;
				}
				await markDispatched(row.id, scheduleJobId(row.id));
				stats.fired += 1;
				await emitFired(row);
				return;
			}
			case "STOPPED": {
				//  CLOSED here (#108 PR3): a scheduled START on a
				// STOPPED channel begins a NEW RUN with a FRESH encoding —
				// never the restart C30 forbids (the finished encoding is
				// unrecoverable and untouched; #107 removed the button, this
				// removes the unattended path that kept firing it).
				//
				// #155: the re-air's step log is compiled HERE, into the new
				// run's own subtree — provision EXECUTES the row's log and
				// never compiles. The first cut wrote [] under a comment
				// claiming provision compiles (the same false belief the
				// route's first cut had, which the first real re-air killed
				// on 2026-08-21): a SCHEDULED re-air would have provisioned
				// zero steps and stranded the channel at ERROR.
				const latest = await runs.latest(row.liveChannelId);
				if (latest && isLiveRunStatus(latest.status)) {
					// A live run beside a STOPPED channel is a mid-write world
					// — wait, never a second encoding (#48; route parity).
					stats.waiting += 1;
					return;
				}
				const runId = randomUUID();
				const seq = (latest?.seq ?? 0) + 1;
				let compiled: ReturnType<typeof compileLiveRunStepLog>;
				try {
					compiled = compileLiveRunStepLog(
						liveChannelPlanSchema.parse(channel.plan),
						{ seq, runId },
					);
				} catch (err) {
					const failure =
						err instanceof MslEncoderVersionError
							? err.message
							: "channel plan does not compile — cannot re-air";
					if (await rowTo(row, "ERROR", { error: failure })) {
						stats.errors += 1;
						await emitMissed(
							row,
							err instanceof MslEncoderVersionError
								? failure
								: "channel plan does not compile — cannot re-air",
						);
					}
					return;
				}
				if (!(await rowTo(row, "FIRED", { firedAt: deps.now() }))) {
					return;
				}
				let claimed: boolean;
				try {
					claimed = await claimWithRun(
						row,
						channel.liveEffectFenceVersion ?? 0,
						{
							// `error: null` is part of the CLAIM, not just of the
							// write . A channel
							// whose stop never confirmed is STOPPED WITH an error,
							// and this claim would clear that error, the encoder
							// pointer and the step log in one write — deleting the
							// warning, deleting the only in-app way to retry the
							// stop (the stop path reads the column and the step
							// log, both just cleared), and then starting a SECOND
							// encoding while the first may still be up. Unattended,
							// off an armed START row. So it refuses until the stop
							// confirms or the operator retries it.
							where: {
								id: row.liveChannelId,
								status: "STOPPED",
								error: null,
							},
							data: {
								status: "PROVISIONING",
								error: null,
								// Release the previous run's provisioning lease in
								// the SAME claim — see PROVISION_LEASE_RELEASE.
								...PROVISION_LEASE_RELEASE,
								// The fresh COMPILED log (#155 — rebased for seq ≥ 2);
								// freeing the per-run columns stays: provision creates
								// a fresh encoding, the old run row keeps the history
								// (already mirrored). review-244 K1:
								// lastHeartbeat/liveToVod too — the detail page is
								// deliberately value-level for display, which is only
								// sound if re-air CLEANS the channel column; without
								// this the unattended path showed the previous
								// airing's sample as ingest-connected while the new
								// run was still provisioning.
								stepLog: compiled.entries as unknown as Prisma.InputJsonValue,
								bitmovinEncodingId: null,
								encoderIp: null,
								streamKey: null,
								lastHeartbeat: DB_NULL,
								liveToVod: DB_NULL,
							},
						},
						// The run row the compiled log's paths already name — id,
						// seq and prefix are baked into the entries above, so it
						// commits WITH the claim, never lazily minted (#155/N2).
						{
							kind: "create",
							id: runId,
							seq,
							outputPrefix: compiled.outputPrefix,
						},
					);
				} catch {
					// Rolled back whole — no claim, no orphan log (N2). The row
					// re-arms and the next tick re-decides against the world
					// (: the re-arm enrols the id in the next tick's
					// query, so "next tick" holds under a backlog too, not only
					// an empty one).
					await rearm(row);
					stats.errors += 1;
					return;
				}
				if (!claimed) {
					await rearm(row);
					stats.waiting += 1;
					return;
				}
				try {
					await deps.enqueue(
						{ liveChannelId: row.liveChannelId, action: "provision" },
						scheduleJobId(row.id),
					);
				} catch {
					await onEnqueueFailure(row, "Enqueue failed — start again", true);
					stats.errors += 1;
					return;
				}
				await markDispatched(row.id, scheduleJobId(row.id));
				stats.fired += 1;
				await emitFired(row);
				return;
			}
			default:
				return;
		}
	}

	async function fireStop(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
	): Promise<void> {
		// : before the channel state is even read — a STOP armed for
		// last night's airing must not take tonight's off the air.
		if (await refuseStaleGeneration(row, stats)) {
			return;
		}
		const channel = await deps.prisma.liveChannel.findUnique({
			where: { id: row.liveChannelId },
			select: { status: true },
		});
		if (!channel) {
			if (await rowTo(row, "ERROR", { error: "channel no longer exists" })) {
				stats.errors += 1;
				await emitMissed(row, "channel no longer exists");
			}
			return;
		}
		switch (channel.status) {
			case "STOPPED":
			case "CREATED": {
				if (
					await rowTo(row, "COMPLETED", {
						note: `nothing to stop (channel ${channel.status})`,
					})
				) {
					stats.completed += 1;
				}
				return;
			}
			case "PROVISIONING":
			case "STOPPING": {
				// Mid-transition: WAIT. Stop has no grace, so the row retries
				// every tick until the channel is stoppable — "fires no matter
				// how late" means eventually, never into a broken transition
				// (review-190 C2: an unclaimed stop on PROVISIONING threw AND
				// the dead-job handler corrupted the channel to ERROR).
				stats.waiting += 1;
				return;
			}
			case "RUNNING":
			case "ERROR": {
				const effect = await effectIntentFor(row, "STOP", undefined, 1);
				if (!effect) {
					await failUnfencedArmedEffect(row, stats, "Scheduled STOP");
					return;
				}
				if (!(await rowTo(row, "FIRED", { firedAt: deps.now() }))) {
					return;
				}
				const claim = await deps.prisma.liveChannel.updateMany({
					where: {
						id: row.liveChannelId,
						status: { in: ["RUNNING", "ERROR"] },
						liveEffectFenceVersion: effect.admissionFenceVersion - 1,
					},
					data: {
						status: "STOPPING",
						liveEffectFenceVersion: { increment: 1 },
					},
				});
				if (claim.count > 0) {
					await runs.mirror(row.liveChannelId, { status: "STOPPING" });
				}
				if (claim.count === 0) {
					await rearm(row);
					stats.waiting += 1;
					return;
				}
				try {
					await deps.enqueue(
						{
							liveChannelId: row.liveChannelId,
							action: "stop",
							// (row 266): the airing this
							// STOP was armed for. A stop re-delivered after a
							// re-air must not take the NEW run off the air.
							...plannedRunStamp(row.liveChannelRunId),
							effect,
						},
						scheduleJobId(row.id),
					);
				} catch {
					// Channel ERROR (the route's mark) + row back to ARMED:
					// next tick claims ERROR→STOPPING again (: the
					// re-arm enrols the id, so the retry is genuinely the next
					// tick even mid-backlog, and even mid-OUTAGE — the replay
					// set never competes with forward progress) — self-healing,
					// and the alarm no longer shares the failed dependency
					// (review-190 C3).
					await onEnqueueFailure(row, "Enqueue failed — stop again", true);
					stats.errors += 1;
					return;
				}
				await markDispatched(row.id, scheduleJobId(row.id));
				stats.fired += 1;
				await emitFired(row);
				return;
			}
			default:
				return;
		}
	}

	async function fireSlate(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
	): Promise<void> {
		// review-190 I4: a row missing its content fields must never become a
		// doomed queue job — refuse BEFORE any claim. Two legal shapes now
		// : an armed-with-content row (panel path) and a
		// creation-time row whose content is still being registered
		// (slateSource + slateUntil, no id yet).
		// : an insertable-content id dies with its encoding, so a slate
		// armed for run N is not merely wrong for run N+1 — it names a resource
		// that no longer exists.
		if (await refuseStaleGeneration(row, stats)) {
			return;
		}
		const pendingRegistration =
			!row.insertableContentId && row.slateSource !== null;
		const armedWithContent =
			row.insertableContentId !== null &&
			(row.slateDurationSeconds !== null || row.slateUntil !== null);
		if (!pendingRegistration && !armedWithContent) {
			if (
				await rowTo(row, "ERROR", {
					error: "slate row missing insertableContentId/slateDurationSeconds",
				})
			) {
				stats.errors += 1;
				await emitMissed(row, "slate row missing content fields");
			}
			return;
		}
		const channel = await deps.prisma.liveChannel.findUnique({
			where: { id: row.liveChannelId },
			select: {
				status: true,
				lastHeartbeat: true,
				//  PR2b: the RUN's heartbeat is the authority; the
				// channel column stays as the dual-write fallback until the
				// column drop.
				runs: {
					orderBy: { seq: "desc" },
					take: 1,
					select: { lastHeartbeat: true },
				},
			},
		});
		if (channel?.status !== "RUNNING") {
			// A slate can only cut into a RUNNING program; wait out the grace.
			stats.waiting += 1;
			return;
		}
		if (
			!ingestConnectedFresh(
				// review-243 R1: run-PRESENCE-level, not value-level. A run
				// row's null means "no sample THIS run" — a meaningful null
				// that ?? would treat as absence, letting run N's final
				// sample prove ingest for run N+1 in the finalize→first-poll
				// window (the 2026-08-15 failure, reconstructed on a re-air).
				// The channel fallback applies ONLY where no run row exists
				// (pre-#108 channels — what the dual-write fallback is for).
				//  closes the REVIVE variant of the same incident:
				// the run row is reused, its pre-error CONNECTED sample is
				// present, and only its AGE says the proof expired.
				channel.runs?.[0]
					? channel.runs[0].lastHeartbeat
					: channel.lastHeartbeat,
				deps.now().getTime(),
			)
		) {
			//  (2026-08-15 incident): RUNNING is not ENOUGH. An
			// insertable-content splice against an encoder with no input was
			// ACCEPTED (200) and rendered nothing — there is no output
			// timeline to splice into — and had ingest arrived later, the
			// already-scheduled duration would have covered the wrong
			// wall-clock minutes (the program, not the pre-air gap). Fire
			// only into a PROVEN-connected input; the F2 window deadline
			// bounds this wait, and window-close lands MISSED, which is the
			// truth: a slate no one could see was not delivered.
			stats.waiting += 1;
			return;
		}
		if (pendingRegistration) {
			// Registration (registerPendingSlates) has not delivered a READY
			// content id yet — the id only appears once the content IS ready,
			// so this wait doubles as the READY gate. Grace decides the limit.
			stats.waiting += 1;
			return;
		}
		// Fire-time duration : a slateUntil row covers UNTIL the
		// program starts, however late provisioning made this fire. A fixed
		// duration would overrun into the program it exists to protect.
		let durationSeconds = row.slateDurationSeconds;
		if (row.slateUntil !== null) {
			// floor, not round (review-223 F6): rounding 5.6s up to 6 overruns
			// the program by 0.4s — the whole point of fire-time computation is
			// never to cover the program itself.
			const remaining = Math.floor(
				(row.slateUntil.getTime() - deps.now().getTime()) / 1000,
			);
			if (remaining < MIN_SLATE_FIRE_SECONDS) {
				if (
					await rowTo(row, "MISSED", {
						note: `program start already passed — ${remaining}s of slate window left (minimum ${MIN_SLATE_FIRE_SECONDS}s)`,
					})
				) {
					stats.missed += 1;
					await emitMissed(row, "slate window already over at fire time");
				}
				return;
			}
			durationSeconds = remaining;
		}
		const effect = await effectIntentFor(
			row,
			"SLATE_INSERT",
			row.insertableContentId ?? undefined,
		);
		if (!effect) {
			await failUnfencedArmedEffect(row, stats, "Scheduled slate insertion");
			return;
		}
		if (!(await rowTo(row, "FIRED", { firedAt: deps.now() }))) {
			return;
		}
		try {
			await deps.enqueue(
				{
					liveChannelId: row.liveChannelId,
					action: "insert-content",
					// (row 266): the airing this slate
					// was armed for. A slate insertion re-delivered after a re-air must
					// not splice content bound to the previous encoding onto the
					// new run.
					...plannedRunStamp(row.liveChannelRunId),
					effect,
					params: {
						insertableContentId: row.insertableContentId,
						durationSeconds,
						// ALWAYS, not only for windowed rows (review-299): the
						// insert record is the operator's trace of which schedule
						// row aired, and a skip is only traceable if it names one.
						scheduleId: row.id,
						// review-223 F6: the queue retries with backoff, so the
						// insert can run ~75s after this computation. The
						// processor re-derives the duration from the window at
						// the moment it calls the SDK; durationSeconds above is
						// the fallback for rows without a window.
						...(row.slateUntil !== null
							? { slateUntil: row.slateUntil.toISOString() }
							: {}),
					},
				},
				scheduleJobId(row.id),
			);
		} catch {
			// No channel mark — a slate enqueue failure does not own channel
			// status; the row re-arms and the grace machinery decides.
			await onEnqueueFailure(row, "", false);
			stats.errors += 1;
			return;
		}
		await markDispatched(row.id, scheduleJobId(row.id));
		stats.fired += 1;
		await emitFired(row);
	}

	/**
	 * : fire a FEEDER row — validate the source, require a RUNNING
	 * channel (the processor also needs the encoder IP; a pending IP is the
	 * processor's own retry), claim FIRED via the row CAS, and enqueue the
	 * liveChannel action. The processor owns session creation and, for
	 * SWITCH, stopping the active sessions first — the sweep never touches
	 * the feeder subsystem directly (same principle as provision/stop).
	 */
	async function fireFeeder(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
	): Promise<void> {
		// : pushing a previous airing's filler over the current
		// programme is the audit's own case.
		if (await refuseStaleGeneration(row, stats)) {
			return;
		}
		// : the SEALED shape — a bare `slateSourceSchema` is strict and
		// would reject (and so ERROR) every row whose source carries a version.
		const parsed = sealedFeederSourceSchema.safeParse(row.feederSource);
		if (!parsed.success) {
			if (
				await rowTo(row, "ERROR", {
					error: "feeder row has no valid source — cannot start a feed",
				})
			) {
				stats.errors += 1;
				await emitMissed(row, "feeder row missing its source");
			}
			return;
		}
		const channel = await deps.prisma.liveChannel.findUnique({
			where: { id: row.liveChannelId },
			select: { status: true },
		});
		if (channel?.status !== "RUNNING") {
			// The START row provisions at the same instant; wait for RUNNING —
			// the window deadline (useful-until) bounds this wait.
			stats.waiting += 1;
			return;
		}
		if (row.action === "FEEDER_SWITCH") {
			await commitSwitch(row, stats);
			return;
		}
		const effect = await effectIntentFor(row, "FEEDER_START");
		if (!effect) {
			await failUnfencedArmedEffect(row, stats, "Scheduled feeder start");
			return;
		}
		if (!(await rowTo(row, "FIRED", { firedAt: deps.now() }))) {
			return;
		}
		try {
			await deps.enqueue(
				{
					liveChannelId: row.liveChannelId,
					action: "feeder-start",
					// (row 266): the airing this feed
					// was armed for — the audit's own case. A feeder-start
					// re-delivered after a re-air must not push this row's
					// pre-air filler over the NEW run's programme.
					...plannedRunStamp(row.liveChannelRunId),
					effect,
					params: { scheduleId: row.id, source: parsed.data },
				},
				scheduleJobId(row.id),
			);
		} catch {
			await onEnqueueFailure(row, "", false);
			stats.errors += 1;
			return;
		}
		await markDispatched(row.id, scheduleJobId(row.id));
		stats.fired += 1;
		await emitFired(row);
	}

	/**
	 *  — Phase B at fireAt: COMMIT a switch whose session is READY,
	 * or refuse it. The readiness read is of the SESSION, never of the row's
	 * mirrored `readyAt`: a takeover re-stages a session and clears its
	 * readiness, and a source nobody holds must not be committed to.
	 *
	 * A switch that is not READY at fire time does NOT fire. The row lands
	 * MISSED with outcome FAILED and a note that says which of the three
	 * things happened — no pre-stage ran (the channel was not RUNNING inside
	 * the lead window, or the row was armed too close to its fire time), the
	 * stage is still downloading, or the staged session already failed its
	 * gates — and the previous feed keeps pushing, because a switch that
	 * starts its download at air time is the seam the audit measured.
	 */
	async function commitSwitch(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
	): Promise<void> {
		const now = deps.now();
		const verdict = await switchReadiness(row);
		if (!verdict.ready) {
			const note = `not staged — ${verdict.reason}`;
			if (await rowTo(row, "MISSED", { note })) {
				stats.missed += 1;
				await recordScheduleOutcomeBestEffort(
					deps.prisma,
					{ scheduleId: row.id },
					"FAILED",
					note,
					now,
					"EFFECT_FAILED",
				);
				await emitMissed(
					row,
					`feeder switch was not staged by its fire time — ${verdict.reason}; the previous feed keeps pushing`,
				);
			}
			return;
		}
		const effect = await effectIntentFor(
			row,
			"FEEDER_COMMIT",
			verdict.sessionId,
		);
		if (!effect) {
			await failUnfencedArmedEffect(row, stats, "Scheduled feeder commit");
			return;
		}
		if (!(await rowTo(row, "FIRED", { firedAt: now }))) {
			return;
		}
		try {
			await deps.enqueue(
				{
					liveChannelId: row.liveChannelId,
					action: "feeder-commit",
					// (row 266): the airing this switch
					// was armed for — a commit re-delivered after a re-air must
					// not cut a stale staged source into the new run.
					...plannedRunStamp(row.liveChannelRunId),
					effect,
					params: { scheduleId: row.id, feederSessionId: verdict.sessionId },
				},
				scheduleJobId(row.id),
			);
		} catch {
			await onEnqueueFailure(row, "", false);
			stats.errors += 1;
			return;
		}
		await markDispatched(row.id, scheduleJobId(row.id));
		stats.fired += 1;
		await emitFired(row);
	}

	async function switchReadiness(
		row: ScheduleRow,
	): Promise<
		{ ready: true; sessionId: string } | { ready: false; reason: string }
	> {
		const sessionId = row.feederSessionId ?? null;
		if (sessionId === null) {
			return {
				ready: false,
				reason: row.stagedAt
					? "the pre-stage job has not created a session yet"
					: "no pre-stage ran (the channel was not RUNNING inside the lead window, or the row was armed too close to its fire time)",
			};
		}
		const session = await deps.prisma.feederSession.findUnique({
			where: { id: sessionId },
			select: { status: true, readyAt: true, error: true },
		});
		if (!session) {
			return { ready: false, reason: "the staged session no longer exists" };
		}
		if (session.status !== "DOWNLOADING") {
			return {
				// Row 259 review (spelled without `#` — `session.status` above sits
				// inside the ledger-pointer regex's window): `session.error` is the
				// STRUCTURED payload on the row, and this reason becomes a MISSED note
				// and a SCHEDULE_MISSED Slack event, both locale-less — so render the
				// English sentence here.
				ready: false,
				reason: `the staged session is ${session.status}${session.error ? `: ${feederErrorEnglish(session.error)}` : ""}`,
			};
		}
		if (session.readyAt === null) {
			return {
				ready: false,
				reason:
					"the staged session has not finished downloading and probing its source",
			};
		}
		return { ready: true, sessionId };
	}

	/**
	 *  — Phase A, at fireAt − lead: hand a FEEDER_SWITCH row's
	 * pre-stage to the queue. The lead is estimated from the sealed source's
	 * size (`estimateStageLeadMs`), so the scan window is the maximum lead
	 * and each row decides for itself whether its own lead has begun. The
	 * row stays ARMED — staging is not firing — and the claim is its own
	 * outbox pair (`stagedAt` / `stageDispatchedAt`), recovered by
	 * `dispatchPending` exactly like a lost fire.
	 *
	 * Requires a RUNNING channel, like the fire path: the staged session
	 * needs the run's ingest reference for its compatibility gate, and a
	 * channel that is not up cannot be switched anyway. A row whose channel
	 * only comes up after its fire time is then refused at fire time as
	 * "not staged", which is the honest answer — the alternative was to
	 * start a download at air time, which is the seam this exists to end.
	 */
	async function stageDueSwitches(stats: ScheduleSweepStats): Promise<void> {
		const now = deps.now();
		const rows = await deps.prisma.liveSchedule.findMany({
			where: {
				status: "ARMED",
				action: "FEEDER_SWITCH",
				stagedAt: null,
				// rev367 I-3: a row already past its fire time is the DUE
				// scan's to refuse ("not staged") this same tick — staging it
				// would download a whole source for a switch that can no longer
				// happen, and the two passes would race over one row.
				fireAt: {
					gt: now,
					lte: new Date(now.getTime() + STAGE_LEAD_MAX_MS),
				},
			},
			orderBy: [{ fireAt: "asc" }, { id: "asc" }],
			take: STAGE_SCAN_BUDGET,
		});
		for (const row of rows) {
			if (row.action !== "FEEDER_SWITCH" || row.stagedAt !== null) {
				continue;
			}
			const parsed = sealedFeederSourceSchema.safeParse(row.feederSource);
			if (!parsed.success) {
				// The fire path refuses it as ERROR with the source message.
				continue;
			}
			const lead = estimateStageLeadMs(parsed.data.identity?.size ?? null);
			if (row.fireAt.getTime() - lead > now.getTime()) {
				continue;
			}
			if (await refuseStaleGeneration(row, stats)) {
				continue;
			}
			const channel = await deps.prisma.liveChannel.findUnique({
				where: { id: row.liveChannelId },
				select: { status: true },
			});
			if (channel?.status !== "RUNNING") {
				continue;
			}
			if (row.fireAt.getTime() <= now.getTime()) {
				continue;
			}
			const claimed = await deps.prisma.liveSchedule.updateMany({
				where: { id: row.id, status: "ARMED", stagedAt: null },
				data: { stagedAt: now, stageDispatchedAt: null },
			});
			if (claimed.count !== 1) {
				continue;
			}
			// The id carries the claim instant just written (rev367 I-2).
			const jobId = scheduleStageJobId(row.id, now);
			try {
				await deps.enqueue(
					{
						liveChannelId: row.liveChannelId,
						action: "feeder-stage",
						// (row 266): the airing this
						// pre-stage is for. A stage re-delivered after a re-air
						// must not download a whole source for a dead run.
						...plannedRunStamp(row.liveChannelRunId),
						params: {
							scheduleId: row.id,
							source: parsed.data,
							commitAt: row.fireAt.toISOString(),
						},
					},
					jobId,
				);
			} catch (err) {
				// Release the claim: a synchronous add failure is not a lost
				// handoff, and the next tick re-stages while the lead lasts.
				await deps.prisma.liveSchedule.updateMany({
					where: { id: row.id, status: "ARMED", stageDispatchedAt: null },
					data: { stagedAt: null },
				});
				stats.errors += 1;
				console.error(
					`[scheduler] pre-stage enqueue for schedule ${row.id} failed (next tick retries):`,
					err instanceof Error ? err.message : err,
				);
				continue;
			}
			await markStageDispatched(row.id);
			stats.staged += 1;
		}
	}

	/** : the stage handoff's stamp — once, after `add` resolved. */
	async function markStageDispatched(rowId: string): Promise<void> {
		await deps.prisma.liveSchedule.updateMany({
			where: { id: rowId, status: "ARMED", stageDispatchedAt: null },
			data: { stageDispatchedAt: deps.now() },
		});
	}

	/**
	 * : creation-time slates carry a SOURCE, not a content id —
	 * content is per-encoding and did not exist at creation. Once the channel
	 * is RUNNING, claim the row (contentClaimedAt CAS — two ticks and two
	 * workers must not register twice) and hand registration to the live
	 * queue; the processor writes insertableContentId only when the content
	 * is READY, which is what the fire path waits on. Runs ahead of fireAt on
	 * purpose: registration + processing takes real time.
	 */
	async function registerPendingSlates(
		stats: ScheduleSweepStats,
	): Promise<void> {
		// A claim older than the registration timeout (+ a scheduling slack)
		// belongs to a job that died without releasing — the liveChannel queue
		// runs maxStalledCount 1 , so a STALLED registration job is
		// never retried by BullMQ and its claim would otherwise pin the row
		// until the F2 window closes. Stale claims are re-claimable.
		const staleBefore = new Date(deps.now().getTime() - STALE_CLAIM_MS);
		// : paged with a resuming cursor, for the same reason the due
		// scan is — a row whose channel is not RUNNING is skipped WITHOUT
		// being changed, so it holds its place at the head of the window
		// until the channel moves. See REGISTRATION_SCAN_BUDGET.
		const replay = registrationRearmed.drain();
		registrationCursor = await pageScan({
			start: registrationCursor,
			replay,
			budget: REGISTRATION_SCAN_BUDGET,
			pageSize: REGISTRATION_PAGE_SIZE,
			fetch: (cursor, replayIds, take) =>
				deps.prisma.liveSchedule.findMany({
					where: {
						status: "ARMED",
						action: "SLATE_IN",
						insertableContentId: null,
						// The scan's OWN top-level OR. `scanWindow` deliberately
						// spreads an `AND` element rather than a second `OR:`
						// key, which would silently replace this one.
						OR: [
							{ contentClaimedAt: null },
							{ contentClaimedAt: { lt: staleBefore } },
						],
						NOT: { slateSource: { equals: DB_NULL } },
						...scanWindow(cursor, replayIds),
					},
					orderBy: [{ fireAt: "asc" }, { id: "asc" }],
					take,
				}),
			handle: (row) => registerPendingSlate(row, stats),
		});
		stats.rearmsDropped += registrationRearmed.takeDropped();
	}

	/** One registration candidate — the body of the paged scan above. */
	async function registerPendingSlate(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
	): Promise<void> {
		const parsedSource = slateSourceSchema.safeParse(row.slateSource);
		if (!parsedSource.success) {
			await deps.prisma.liveSchedule.updateMany({
				where: { id: row.id, status: "ARMED" },
				data: { error: "slate source failed validation — cannot register" },
			});
			return;
		}
		const channel = await deps.prisma.liveChannel.findUnique({
			where: { id: row.liveChannelId },
			select: { status: true },
		});
		if (channel?.status !== "RUNNING") {
			// Registration needs an encoding; RUNNING is the measured-safe
			// state. The grace machinery bounds how long we hold out.
			return;
		}
		const registrationRun = await deps.prisma.liveChannelRun.findFirst({
			where: { liveChannelId: row.liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true },
		});
		if (!registrationRun) {
			return;
		}
		if (row.liveChannelRunId === null) {
			const bound = await deps.prisma.liveSchedule.updateMany({
				where: { id: row.id, status: "ARMED", liveChannelRunId: null },
				data: { liveChannelRunId: registrationRun.id },
			});
			if (bound.count === 0) {
				return;
			}
			row.liveChannelRunId = registrationRun.id;
		} else if (row.liveChannelRunId !== registrationRun.id) {
			return;
		}
		const effect = await effectIntentFor(row, "SLATE_REGISTER");
		if (!effect) {
			await failUnfencedArmedEffect(row, stats, "Scheduled slate registration");
			return;
		}
		// CAS against the value we READ (null or the stale timestamp) — two
		// ticks and two workers must not both claim, and a FRESH claim by a
		// racing worker must not be stolen as "stale".
		const claimedAt = deps.now();
		const claim = await deps.prisma.liveSchedule.updateMany({
			where: {
				id: row.id,
				contentClaimedAt: row.contentClaimedAt,
				status: "ARMED",
			},
			data: { contentClaimedAt: claimedAt },
		});
		if (claim.count === 0) {
			return;
		}
		const source: SlateSource = parsedSource.data;
		try {
			await deps.enqueue(
				{
					liveChannelId: row.liveChannelId,
					action: "register-slate-content",
					effect,
					params: { scheduleId: row.id, source },
				},
				// review-223 F1 (CRITICAL): BullMQ's jobId dedupe consults the
				// COMPLETED/FAILED sets too — `sched-content-<row>` alone means
				// a re-registration after a released claim is accepted and then
				// silently never run (verified against real Redis). The claim
				// epoch scopes dedupe to ONE claim: within a claim, redeliveries
				// dedupe; a new claim (new epoch) is a runnable job. The CAS
				// above guarantees claims are serial, so epochs never collide.
				`sched-content-${row.id}-${claimedAt.getTime()}`,
			);
		} catch {
			// Release the claim so the next tick retries (: the
			// release enrols the id in this scan's next query, which is what
			// makes "next tick" true rather than "whenever the cursor comes
			// round"); the row itself stays ARMED and the grace machinery
			// still owns the deadline.
			const { count } = await deps.prisma.liveSchedule.updateMany({
				where: { id: row.id, insertableContentId: null },
				data: { contentClaimedAt: null },
			});
			if (count === 1) {
				//  (review #356 v2): a released claim puts the row back
				// in THIS scan's population, behind a cursor that has already
				// passed it — the registration analogue of `rearm`.
				registrationRearmed.add(row.id);
			}
		}
	}

	/**
	 *  — the OUTBOX dispatcher (audit 2026-08-29 CRITICAL-1).
	 *
	 * Every fire path above commits its CLAIM first (the row to FIRED, and
	 * where one exists the channel too: START→PROVISIONING, STOP and the
	 * runtime cap→STOPPING) and calls `queue.add` second. A synchronous add
	 * failure is caught and released, but SIGKILL / OOM / a lost pod is not:
	 * the claim stands, no job exists, and NOTHING re-reads it — `fireDue`
	 * selects ARMED, the boot reconciler only touches ERROR channels, and
	 * BullMQ's retry count applies to jobs that were created. A START or a
	 * feeder then never runs while its row reads FIRED, and a STOP or a cap
	 * is lost while the encoding keeps billing.
	 *
	 * `dispatchedAt` closes it: FIRED + null is a claim whose handoff is
	 * unaccounted for, and this pass re-adds it under the same deterministic
	 * job id. That id is what makes the recovery safe rather than a
	 * double-fire — if the add HAD landed before the process died, BullMQ
	 * returns the existing job and this pass only writes the stamp.
	 *
	 * The claims themselves are deliberately NOT released: PROVISIONING and
	 * STOPPING are the states the re-dispatched job expects to run against
	 * (provision accepts CREATED|PROVISIONING under its lease;
	 * `stopChannel` accepts RUNNING|STOPPING|ERROR), so recovery lands in
	 * exactly the world a healthy dispatch produces.
	 */
	async function dispatchPending(): Promise<number> {
		// Boot recovery may overlap the first tick. Share that pass so a late
		// caller cannot overwrite either cursor with an older scan position.
		if (dispatchInFlight) return dispatchInFlight;
		dispatchInFlight = dispatchPendingOnce();
		try {
			return await dispatchInFlight;
		} finally {
			dispatchInFlight = null;
		}
	}

	async function dispatchPendingOnce(): Promise<number> {
		const now = deps.now();
		let redispatched = 0;
		// Outbox failures retain their rows. Resume in stable schedule order,
		// not from the same oldest 100 every tick; after the tail, retry the
		// head. Grace and deterministic queue ids remain unchanged (#245).
		dispatchCursor = await pageScan({
			start: dispatchCursor,
			replay: new Set(),
			budget: 100,
			pageSize: 100,
			fetch: (cursor, replay, take) =>
				deps.prisma.liveSchedule.findMany({
					where: {
						status: "FIRED",
						dispatchedAt: null,
						firedAt: { lt: new Date(now.getTime() - DISPATCH_GRACE_MS) },
						...scanWindow(cursor, replay),
					},
					orderBy: [{ fireAt: "asc" }, { id: "asc" }],
					take,
				}),
			handle: async (row) => {
				if (
					row.action !== "STOP" &&
					deps.allowNewWork &&
					!(await deps.allowNewWork())
				) {
					const channel =
						row.action === "START"
							? await deps.prisma.liveChannel.findUnique({
									where: { id: row.liveChannelId },
									select: { bitmovinEncodingId: true, stepLog: true },
								})
							: null;
					const committed =
						channel?.bitmovinEncodingId &&
						hasCommittedStart(channel.stepLog, "START_LIVE_ENCODING");
					if (!committed) {
						await admitInactiveOrganization(deps.prisma, "liveChannel", {
							liveChannelId: row.liveChannelId,
							action: row.action === "START" ? "provision" : "insert-content",
							params: { scheduleId: row.id },
						});
						await deps.prisma.liveSchedule.updateMany({
							where: { id: row.id, status: "FIRED", dispatchedAt: null },
							data: {
								status: "CANCELED",
								note: "Organization is inactive; new work was suppressed",
							},
						});
						return;
					}
				}
				const job = await jobForStrandedRow(row, now);
				if (!job) {
					return;
				}
				const jobId = scheduleJobId(row.id);
				try {
					await deps.enqueue(job, jobId);
				} catch (err) {
					// Leave FIRED + unstamped and retry on the next cursor lap.
					// Re-arming would be wrong here in a way it is not in the fire
					// paths: the claim this row belongs to was committed by a
					// process that is GONE, so there is no channel state to hand
					// back — releasing the row while the channel sits STOPPING
					// would strand the channel instead of the row.
					console.error(
						`[scheduler] re-dispatch of schedule ${row.id} failed (next scan lap retries):`,
						err instanceof Error ? err.message : err,
					);
					return;
				}
				await markDispatched(row.id, jobId);
				redispatched += 1;
				// The notification is the LAST thing and cannot stall the pass: a
				// notify channel that throws for one row would otherwise abort the
				// loop before the rows behind it — every tick, forever, while a
				// capped encoding kept billing.
				try {
					await emitFired(row);
				} catch (err) {
					console.error(
						`[scheduler] re-dispatch notification for ${row.id} failed:`,
						err instanceof Error ? err.message : err,
					);
				}
			},
		});
		redispatched += await redispatchStrandedStages(now);
		return redispatched;
	}

	/**
	 *  — the pre-stage's half of the outbox. A stage claim
	 * (`stagedAt`) with no handoff stamp (`stageDispatchedAt`) older than the
	 * grace is a crash between the claim and `queue.add`; re-adding it under
	 * the same deterministic id is safe for the same reason the fire's
	 * recovery is — an add that DID land dedupes. Only ARMED rows: once the
	 * row fired (or ended) the stage is moot.
	 */
	async function redispatchStrandedStages(now: Date): Promise<number> {
		let redispatched = 0;
		stageDispatchCursor = await pageScan({
			start: stageDispatchCursor,
			replay: new Set(),
			budget: 100,
			pageSize: 100,
			fetch: (cursor, replay, take) =>
				deps.prisma.liveSchedule.findMany({
					where: {
						status: "ARMED",
						action: "FEEDER_SWITCH",
						stagedAt: {
							not: null,
							lt: new Date(now.getTime() - DISPATCH_GRACE_MS),
						},
						stageDispatchedAt: null,
						// rev367 I-3: a claim stranded PAST its fire time is not
						// recovered — this pass runs before the due scan, which lands
						// the row MISSED ("not staged") in the same tick; re-adding the
						// stage would download a whole source for a switch that can no
						// longer happen and then overwrite the refused row's story.
						fireAt: { gt: now },
						...scanWindow(cursor, replay),
					},
					orderBy: [{ fireAt: "asc" }, { id: "asc" }],
					take,
				}),
			handle: async (row) => {
				if (
					row.action !== "FEEDER_SWITCH" ||
					row.stagedAt === null ||
					row.fireAt.getTime() <= now.getTime()
				) {
					return;
				}
				const parsed = sealedFeederSourceSchema.safeParse(row.feederSource);
				if (!parsed.success) {
					await rowTo(row, "ERROR", {
						error: "feeder row has no valid source — cannot stage a feed",
					});
					return;
				}
				// The SAME claim instant, so a handoff that DID land dedupes.
				const jobId = scheduleStageJobId(row.id, row.stagedAt);
				try {
					await deps.enqueue(
						{
							liveChannelId: row.liveChannelId,
							action: "feeder-stage",
							// (row 266): a bound stranded
							// row carries that airing through the recovery add too —
							// the fence must see the SAME planned run a healthy
							// dispatch would have stamped.
							...plannedRunStamp(row.liveChannelRunId),
							params: {
								scheduleId: row.id,
								source: parsed.data,
								commitAt: row.fireAt.toISOString(),
							},
						},
						jobId,
					);
				} catch (err) {
					console.error(
						`[scheduler] re-dispatch of pre-stage ${row.id} failed (next scan lap retries):`,
						err instanceof Error ? err.message : err,
					);
					return;
				}
				await markStageDispatched(row.id);
				redispatched += 1;
			},
		});
		return redispatched;
	}

	/**
	 * Rebuild the queue payload for a stranded row, or refuse it.
	 *
	 * Refusals write the row's outcome rather than dropping it silently, and
	 * they re-apply the SAME rules the fire path applied — a windowed slate
	 * or feeder whose useful-until has passed while the handoff was lost was
	 * not delivered, and an insert-content job built from a closed window
	 * would carry a duration the worker's own schema rejects.
	 */
	async function jobForStrandedRow(
		row: ScheduleRow & { note?: string | null },
		now: Date,
	): Promise<LiveChannelJob | null> {
		if (row.action === "START") {
			return { liveChannelId: row.liveChannelId, action: "provision" };
		}
		if (row.action === "STOP") {
			// Includes the runtime cap's synthetic row — same action, same
			// claim, same recovery. (row 266): a
			// stranded STOP was FIRED, so its bind is set — carry it so the
			// recovery add fences on the SAME airing a healthy dispatch would.
			const effect = await effectIntentFor(row, "STOP");
			if (!effect) {
				await failUnfencedStrandedEffect(row.id, "Stranded STOP");
				return null;
			}
			return {
				liveChannelId: row.liveChannelId,
				action: "stop",
				...plannedRunStamp(row.liveChannelRunId),
				effect,
			};
		}
		const windowClosed =
			row.slateUntil !== null &&
			Math.floor((row.slateUntil.getTime() - now.getTime()) / 1000) <
				MIN_SLATE_FIRE_SECONDS;
		if (windowClosed) {
			const reason = `${row.action === "SLATE_IN" ? "slate" : "feeder"} window closed while the queue handoff was lost`;
			// rev346 LOW-1: the notification follows the TRANSITION, never the
			// decision. Two passes can reach this branch for one row — the
			// boot `dispatchPending` is NOT under the tick's `inFlight`
			// latch, so it can overlap the first tick, and in a rolling
			// deploy two workers' boot passes overlap each other. The loser's
			// CAS matches nothing; emitting anyway would page an operator
			// twice for one missed slate. Only the writer speaks.
			if (await strandedRowTo(row.id, "MISSED", { note: reason })) {
				await emitMissed(row, reason);
			}
			return null;
		}
		if (
			row.action === "FEEDER_SWITCH" &&
			typeof row.feederSessionId === "string"
		) {
			// : a fired switch is a lost COMMIT for the session the
			// stage created — the same payload the fire path built. audit
			// (row 266): plus the airing it was armed for.
			const effect = await effectIntentFor(
				row,
				"FEEDER_COMMIT",
				row.feederSessionId,
			);
			if (!effect) {
				await failUnfencedStrandedEffect(row.id, "Stranded feeder commit");
				return null;
			}
			return {
				liveChannelId: row.liveChannelId,
				action: "feeder-commit",
				...plannedRunStamp(row.liveChannelRunId),
				effect,
				params: { scheduleId: row.id, feederSessionId: row.feederSessionId },
			};
		}
		if (row.action === "FEEDER_START" || row.action === "FEEDER_SWITCH") {
			// : same sealed shape the fire path parses — the recovery
			// must rebuild the SAME payload, version and all. A FEEDER_SWITCH
			// with no session was fired before the two-phase model and comes
			// back as the immediate form.
			const parsed = sealedFeederSourceSchema.safeParse(row.feederSource);
			if (!parsed.success) {
				await strandedRowTo(row.id, "ERROR", {
					error: "feeder row has no valid source — cannot start a feed",
				});
				return null;
			}
			const effect = await effectIntentFor(
				row,
				row.action === "FEEDER_SWITCH" ? "FEEDER_COMMIT" : "FEEDER_START",
			);
			if (!effect) {
				await failUnfencedStrandedEffect(row.id, "Stranded feeder start");
				return null;
			}
			return {
				liveChannelId: row.liveChannelId,
				action:
					row.action === "FEEDER_SWITCH" ? "feeder-switch" : "feeder-start",
				// (row 266): carry the armed airing.
				...plannedRunStamp(row.liveChannelRunId),
				effect,
				params: { scheduleId: row.id, source: parsed.data },
			};
		}
		if (row.insertableContentId === null) {
			// Unreachable through the fire path (it refuses before claiming),
			// so this is a corrupted row rather than a lost handoff.
			await strandedRowTo(row.id, "ERROR", {
				error: "slate row missing insertableContentId",
			});
			return null;
		}
		// The duration is re-derived from the window at THIS instant, not the
		// one the dead process computed — every second of the outage would
		// otherwise be slate on top of the program (review-223 F6's rule,
		// applied to the recovery path).
		const durationSeconds =
			row.slateUntil !== null
				? Math.floor((row.slateUntil.getTime() - now.getTime()) / 1000)
				: row.slateDurationSeconds;
		if (durationSeconds === null) {
			await strandedRowTo(row.id, "ERROR", {
				error: "slate row missing slateDurationSeconds",
			});
			return null;
		}
		const effect = await effectIntentFor(
			row,
			"SLATE_INSERT",
			row.insertableContentId,
		);
		if (!effect) {
			await failUnfencedStrandedEffect(row.id, "Stranded slate insertion");
			return null;
		}
		return {
			liveChannelId: row.liveChannelId,
			action: "insert-content",
			// (row 266): carry the armed airing.
			...plannedRunStamp(row.liveChannelRunId),
			effect,
			params: {
				insertableContentId: row.insertableContentId,
				durationSeconds,
				scheduleId: row.id,
				...(row.slateUntil !== null
					? { slateUntil: row.slateUntil.toISOString() }
					: {}),
			},
		};
	}

	/**
	 * Terminal transition for a row the dispatcher refuses (CAS on FIRED).
	 * Returns whether THIS caller made the transition — `rowTo`'s contract,
	 * for the same reason: a notification belongs to the writer, not to
	 * everyone who reached the decision (rev346 LOW-1).
	 */
	async function strandedRowTo(
		rowId: string,
		status: "MISSED" | "ERROR",
		extra: { note?: string; error?: string },
	): Promise<boolean> {
		const { count } = await deps.prisma.liveSchedule.updateMany({
			where: { id: rowId, status: "FIRED", dispatchedAt: null },
			data: { status, ...extra },
		});
		return count === 1;
	}

	async function failUnfencedStrandedEffect(
		rowId: string,
		label: string,
	): Promise<boolean> {
		const at = deps.now();
		const reason = `${label} refused: legacy outbox row has no exact current run/provider identity`;
		const { count } = await deps.prisma.liveSchedule.updateMany({
			where: { id: rowId, status: "FIRED", dispatchedAt: null },
			data: {
				status: "ERROR",
				error: reason,
				outcome: "UNKNOWN",
				outcomeAt: at,
				outcomeNote: reason,
				outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
				outcomeEvidenceAt: at,
			},
		});
		return count === 1;
	}

	/**
	 * : page the whole due set instead of re-reading its first 100
	 * rows every tick. `now` is still read ONCE for the tick, so every row a
	 * tick examines is judged against the same instant no matter which page
	 * it arrived on.
	 */
	async function fireDue(stats: ScheduleSweepStats): Promise<void> {
		const now = deps.now();
		// Drain LAST tick's re-arms into this tick's window before any handler
		// can enrol a new one — the two must never be the same collection, or
		// a row re-arming inside this tick would be replayed inside it too.
		const replay = dueRearmed.drain();
		dueCursor = await pageScan({
			start: dueCursor,
			replay,
			budget: DUE_SCAN_BUDGET,
			pageSize: DUE_PAGE_SIZE,
			fetch: (cursor, replayIds, take) =>
				deps.prisma.liveSchedule.findMany({
					where: {
						status: "ARMED",
						fireAt: { lte: now },
						...scanWindow(cursor, replayIds),
					},
					// The `id` tiebreaker is what makes the cursor CORRECT, not
					// merely tidy: rows sharing a fireAt (a chain armed at one
					// instant) have no stable order without it, so a page
					// boundary inside such a group would drop or repeat rows.
					orderBy: [{ fireAt: "asc" }, { id: "asc" }],
					take,
				}),
			handle: (row) => fireDueRow(row, stats, now),
		});
		// AFTER the pass, not before: the drops this tick's handlers caused
		// belong to THIS tick's stats, or the operator reads them one tick
		// late and against the wrong `waiting` count.
		stats.rearmsDropped += dueRearmed.takeDropped();
	}

	async function fireDueRow(
		row: ScheduleRow,
		stats: ScheduleSweepStats,
		now: Date,
	): Promise<void> {
		if (
			row.action !== "STOP" &&
			deps.allowNewWork &&
			!(await deps.allowNewWork())
		) {
			await deps.prisma.liveSchedule.updateMany({
				where: { id: row.id, status: "ARMED" },
				data: {
					status: "CANCELED",
					note: "Organization is inactive; new work was suppressed",
				},
			});
			return;
		}
		const overdueMs = now.getTime() - row.fireAt.getTime();
		const startLike =
			row.action === "START" ||
			row.action === "SLATE_IN" ||
			row.action === "FEEDER_START" ||
			row.action === "FEEDER_SWITCH";
		// review-223 F2: a slate that covers UNTIL program start is worth
		// firing for as long as the window has MIN_SLATE_FIRE_SECONDS left —
		// its deadline is the window itself, not fireAt+grace. The fixed
		// grace (10m) sat INSIDE a 51-minute pre-air window: provisioning
		// that took 12 minutes killed a slate that still had 48 minutes of
		// cover to give. Rows without slateUntil keep the fixed grace.
		// #96 rides the same machinery: a FEEDER row's slateUntil is its
		// USEFUL-UNTIL (pre-air feeder until air, program feeder until
		// end) — one deadline rule for every windowed row.
		const windowed =
			(row.action === "SLATE_IN" ||
				row.action === "FEEDER_START" ||
				row.action === "FEEDER_SWITCH") &&
			row.slateUntil !== null;
		// #160 PR3: an auto-lead START's fireAt is EARLY on purpose
		// (airAt − lead), so fireAt+grace would expire the row while the
		// whole lead window — and the air time itself — still lay ahead.
		// Its useful-until is the AIR time; grace runs from there.
		const autoLead =
			row.action === "START" && row.autoLeadTime === true && row.airAt;
		const deadline =
			windowed && row.slateUntil !== null
				? row.slateUntil.getTime() - MIN_SLATE_FIRE_SECONDS * 1000
				: autoLead && row.airAt
					? row.airAt.getTime() + grace
					: row.fireAt.getTime() + grace;
		if (startLike && now.getTime() > deadline) {
			// review-pr34 m3: an auto-lead row's overdue is measured from
			// the AIR time — its fireAt is early BY DESIGN (airAt − lead),
			// so "overdue by 18m" from fireAt would report the lead window
			// itself as lateness in the operator's note.
			const autoLeadOverdueMs =
				autoLead && row.airAt ? now.getTime() - row.airAt.getTime() : null;
			if (
				await rowTo(row, "MISSED", {
					note: windowed
						? `${row.action === "SLATE_IN" ? "slate" : "feeder"} window closed (${row.slateUntil?.toISOString()}) before the row could fire`
						: autoLeadOverdueMs !== null
							? `air time passed ${Math.round(autoLeadOverdueMs / 60_000)}m ago — grace is ${grace / 60_000}m`
							: `overdue by ${Math.round(overdueMs / 60_000)}m — grace is ${grace / 60_000}m`,
				})
			) {
				stats.missed += 1;
				await emitMissed(
					row,
					windowed
						? `${row.action === "SLATE_IN" ? "slate" : "feeder"} window closed before the row could fire`
						: autoLeadOverdueMs !== null
							? `${row.action} air time passed ${Math.round(autoLeadOverdueMs / 60_000)}m ago`
							: `${row.action} overdue by ${Math.round(overdueMs / 60_000)}m`,
				);
			}
			return;
		}
		if (row.action === "START") {
			await fireStart(row, stats);
		} else if (row.action === "STOP") {
			await fireStop(row, stats);
		} else if (
			row.action === "FEEDER_START" ||
			row.action === "FEEDER_SWITCH"
		) {
			await fireFeeder(row, stats);
		} else {
			await fireSlate(row, stats);
		}
	}

	/**
	 * The runtime cap: RUNNING longer than maxRunMinutes ⇒ stop, once per
	 * epoch. Atomicity is layered (review-190 I1 proved the first cut's
	 * check-then-create raced): the channel claim RUNNING→STOPPING is the
	 * lock; the synthetic row's fireAt IS the epoch deadline (deterministic
	 * across workers) under a partial unique index, so a second creator
	 * loses on P2002; and the queue jobId derives from the same deadline,
	 * so a crash-retry re-enqueue dedupes instead of double-stopping.
	 */
	async function enforceCaps(stats: ScheduleSweepStats): Promise<void> {
		const now = deps.now();
		const capped = await deps.prisma.liveChannel.findMany({
			where: {
				status: "RUNNING",
				maxRunMinutes: { not: null },
				runningSince: { not: null },
			},
			select: {
				id: true,
				maxRunMinutes: true,
				runningSince: true,
				liveEffectFenceVersion: true,
			},
		});
		for (const channel of capped) {
			if (channel.maxRunMinutes === null || channel.runningSince === null) {
				continue;
			}
			const deadline = new Date(
				channel.runningSince.getTime() + channel.maxRunMinutes * 60_000,
			);
			if (now.getTime() < deadline.getTime()) {
				continue;
			}
			// The lock: only one actor can move RUNNING→STOPPING.
			const claim = await deps.prisma.liveChannel.updateMany({
				where: {
					id: channel.id,
					status: "RUNNING",
					liveEffectFenceVersion: channel.liveEffectFenceVersion,
				},
				data: {
					status: "STOPPING",
					liveEffectFenceVersion: { increment: 1 },
				},
			});
			if (claim.count === 0) {
				continue;
			}
			await runs.mirror(channel.id, { status: "STOPPING" });
			// The cap's synthetic row records WHICH airing it capped.
			// Provenance only  — the row is born FIRED and dispatched
			// in the same breath, so it never passes the generation guard that
			// the ARMED fire paths run.
			const cappedRun = await runs.latest(channel.id);
			// EVERYTHING after the claim sits in ONE try whose catch releases
			// it (review-190 re-verify I1: the first cut released only around
			// the enqueue, so a non-P2002 create failure — pool exhaustion, a
			// statement timeout — threw with the channel wedged STOPPING and
			// NO way out: no job exists for the dead-job reaper, stop/restart
			// routes 409 on STOPPING, and the next tick selects RUNNING only.
			// Probed by the reviewer: the channel stayed STOPPING forever
			// while the encoding billed).
			let rowId: string | null = null;
			try {
				try {
					const created = await deps.prisma.liveSchedule.create({
						data: {
							liveChannelId: channel.id,
							...(cappedRun ? { liveChannelRunId: cappedRun.id } : {}),
							action: "STOP",
							fireAt: deadline,
							status: "FIRED",
							firedAt: now,
							// : the cap's synthetic row is born with an
							// OPEN outbox exactly like an armed row's claim — the
							// channel is already STOPPING here, so a death before
							// the add below is the billing-forever case.
							dispatchedAt: null,
							note: CAP_NOTE,
						},
					});
					rowId = created.id;
				} catch (err) {
					// P2002 on the epoch index: BACKSTOP, not a live path — both
					// RUNNING writers rewrite runningSince, so a RUNNING channel
					// with an epoch row at the SAME deadline cannot occur today
					// (review-190 re-verify I2 corrected the first story here,
					// which claimed crash-healing through this branch). It
					// guards a future writer that sets RUNNING without touching
					// runningSince.
					if (
						typeof err === "object" &&
						err !== null &&
						(err as { code?: string }).code === "P2002"
					) {
						const existing = await deps.prisma.liveSchedule.findFirst({
							where: {
								liveChannelId: channel.id,
								note: CAP_NOTE,
								fireAt: deadline,
							},
							select: { id: true },
						});
						rowId = existing?.id ?? null;
					} else {
						throw err;
					}
				}
				// : ONE id rule for every scheduled action — derived
				// from the row, so the dispatcher can rebuild it after a crash
				// without re-reading a stamp the crash never wrote. The epoch
				// id below survives only for the P2002 backstop's torn read,
				// where there is no row to derive from AND no outbox record to
				// keep, so it behaves exactly as it did before this change.
				const effect =
					rowId && cappedRun
						? await effectIntentFor(
								{
									id: rowId,
									liveChannelId: channel.id,
									liveChannelRunId: cappedRun.id,
								},
								"STOP",
							)
						: null;
				if (!effect) {
					throw new Error(
						"runtime-cap STOP has no exact run/provider effect identity",
					);
				}
				await deps.enqueue(
					{
						liveChannelId: channel.id,
						action: "stop",
						// (row 266): the run this cap is
						// stopping. If the cap-stop job is re-delivered after a
						// re-air, the fence refuses it rather than cutting the
						// new airing off at the old one's deadline.
						...plannedRunStamp(cappedRun?.id ?? null),
						effect,
					},
					rowId
						? scheduleJobId(rowId)
						: `sched-cap-${channel.id}-${deadline.getTime()}`,
				);
				if (rowId) {
					await markDispatched(rowId, scheduleJobId(rowId));
				}
			} catch (err) {
				const reason = `runtime-cap STOP handoff failed: ${err instanceof Error ? err.message : String(err)}`;
				if (rowId) {
					// A durable FIRED STOP intent exists. Leave STOPPING and its
					// open outbox intact; dispatchPending will recover it. Minting
					// RUNNING here without a fresh provider observation was the
					// false-green rollback from audit SC-01.
					await deps.prisma.liveSchedule.updateMany({
						where: { id: rowId, status: "FIRED", dispatchedAt: null },
						data: { note: reason },
					});
				} else {
					// No durable stop intent exists, so fail closed. The provider may
					// still be running; ERROR says exactly that and never fabricates a
					// RUNNING observation.
					await deps.prisma.liveChannel.updateMany({
						where: { id: channel.id, status: "STOPPING" },
						data: { status: "ERROR", error: reason },
					});
					await runs.mirror(channel.id, { status: "ERROR", error: reason });
				}
				stats.errors += 1;
				continue;
			}
			stats.capStops += 1;
			if (rowId) {
				await deps.emitEvent?.({
					kind: "SCHEDULE_FIRED",
					scheduleId: rowId,
					liveChannelId: channel.id,
					path: `/live/${channel.id}`,
				});
			}
		}
	}

	/**
	 *  PR2 — the #94-F11 gap closed: a channel that never reaches
	 * RUNNING by its intended AIR time used to surface as two separate
	 * things (the row's MISSED state and a channel error), neither of them
	 * an alert. A START row with `airAt` set arms deadline monitoring: if
	 * its channel is not RUNNING by `airAt − deadlineMarginSeconds`, ONE
	 * `SCHEDULE_NOT_RUNNING_AT_DEADLINE` event fires (deduped by the
	 * `deadlineNotifiedAt` stamp) while there is still margin to act. The
	 * check is independent of the row's own lifecycle on purpose — a FIRED
	 * row whose provision is stuck in the queue is exactly the case.
	 */
	async function fireDeadlines(): Promise<void> {
		const now = deps.now();
		// The arm schema caps deadlineMarginSeconds at 3600, so any row whose
		// airAt is further out than that cannot be due yet — bounding the
		// query keeps the scanned population to actually-decidable rows:
		// an unbounded scan over far-future rows plus
		// take:100 could starve the row whose deadline is NOW.
		const horizon = new Date(now.getTime() + 3600 * 1000);
		const due = await deps.prisma.liveSchedule.findMany({
			where: {
				action: "START",
				airAt: { not: null, lte: horizon },
				deadlineNotifiedAt: null,
				// A CANCELED row is the operator saying this broadcast will not
				// happen — alerting "not running at deadline" for it is noise.
				// Every OTHER status stays in scope on purpose: FIRED-but-stuck
				// is the motivating case, and MISSED/ERROR still mean "air time
				// approaches and you are not live" — they alert here even
				// though SCHEDULE_MISSED already fired, because that event said
				// "the start did not run" and this one says "air time is upon
				// you and the channel is still not live", which is the one an
				// operator can still act on.
				status: { not: "CANCELED" },
			},
			select: {
				id: true,
				liveChannelId: true,
				airAt: true,
				deadlineMarginSeconds: true,
			},
			// Most-urgent first, so a backlog past `take` cannot starve the
			// row whose deadline is NOW.
			orderBy: { airAt: "asc" },
			take: 100,
		});
		for (const row of due) {
			const airAt = row.airAt as Date;
			const deadline = airAt.getTime() - row.deadlineMarginSeconds * 1000;
			if (now.getTime() < deadline) {
				continue;
			}
			const channel = await deps.prisma.liveChannel.findUnique({
				where: { id: row.liveChannelId },
				select: { status: true },
			});
			if (!channel || channel.status === "RUNNING") {
				// RUNNING in time (or the channel is gone): stamp silently so
				// the row never re-enters this scan.
				await deps.prisma.liveSchedule.updateMany({
					where: { id: row.id, deadlineNotifiedAt: null },
					data: { deadlineNotifiedAt: now },
				});
				continue;
			}
			// CAS on the stamp: two overlapping sweeps notify once (the same
			// claim discipline every other transition here uses).
			const { count } = await deps.prisma.liveSchedule.updateMany({
				where: { id: row.id, deadlineNotifiedAt: null },
				data: { deadlineNotifiedAt: now },
			});
			if (count === 0) {
				continue;
			}
			try {
				await deps.emitEvent?.({
					kind: "SCHEDULE_NOT_RUNNING_AT_DEADLINE",
					scheduleId: row.id,
					liveChannelId: row.liveChannelId,
					airAt: airAt.toISOString(),
					channelStatus: channel.status,
					path: `/live/${row.liveChannelId}`,
				});
			} catch (err) {
				// stamp-then-emit loses the alert forever on
				// a throw, and silent loss is worse than a duplicate for an
				// alert whose whole value is "while there is still margin".
				// Roll the stamp back so the next tick retries (at-least-once).
				await deps.prisma.liveSchedule
					.updateMany({
						where: { id: row.id },
						data: { deadlineNotifiedAt: null },
					})
					.catch(() => {});
				console.error(
					"deadline alert emit failed (will retry):",
					err instanceof Error ? err.message : err,
				);
			}
		}
	}

	async function runOnce(): Promise<ScheduleSweepStats> {
		const stats: ScheduleSweepStats = {
			fired: 0,
			missed: 0,
			completed: 0,
			waiting: 0,
			capStops: 0,
			errors: 0,
			redispatched: 0,
			rearmsDropped: 0,
			skippedStale: 0,
			staged: 0,
		};
		// review-190 I2: a tick that outruns the interval must not overlap
		// itself — that self-overlap was what made the cap race reachable
		// in ONE process.
		if (inFlight) {
			return stats;
		}
		inFlight = true;
		try {
			const allowNewWork = !deps.allowNewWork || (await deps.allowNewWork());
			if (!allowNewWork)
				await deps.prisma.liveSchedule.updateMany({
					where: { status: "ARMED", action: { not: "STOP" } },
					data: {
						status: "CANCELED",
						note: "Organization is inactive; new work was suppressed",
					},
				});
			// : FIRST, and best-effort like every other pass — a
			// lost handoff from the previous process is older work than
			// anything this tick is about to claim, and a broken recovery
			// must not stop the tick from firing what is due.
			try {
				stats.redispatched = await dispatchPending();
			} catch (err) {
				console.error(
					"schedule dispatch recovery failed:",
					err instanceof Error ? err.message : err,
				);
			}
			if (allowNewWork) await registerPendingSlates(stats);
			// : the pre-stage runs BEFORE the due scan, so a switch
			// row inside its lead window is staged on the tick it enters it,
			// and a row that is due this tick is judged against a stage that
			// has already been dispatched.
			try {
				if (allowNewWork) await stageDueSwitches(stats);
			} catch (err) {
				console.error(
					"feeder switch pre-stage failed:",
					err instanceof Error ? err.message : err,
				);
			}
			await fireDue(stats);
			await enforceCaps(stats);
			// Own try/catch: a throw here must not skip
			// the reconcile below, and a broken deadline pass must not break
			// the tick's fired/missed work either.
			try {
				await fireDeadlines();
			} catch (err) {
				console.error(
					"deadline sweep failed:",
					err instanceof Error ? err.message : err,
				);
			}
			//  PR1 (review-160 M10): the in-job FAILED sample dies
			// with a stalled job, so the worst region would read 0% failures —
			// this sweep-side reconciler records the stuck runs. Best-effort:
			// a statistics write must never break the tick.
			try {
				await reconcileStartupSamples(deps.prisma, deps.now());
			} catch (err) {
				console.error(
					"startup-sample reconcile failed:",
					err instanceof Error ? err.message : err,
				);
			}
		} finally {
			inFlight = false;
		}
		return stats;
	}

	// The tick IS the sweep (every call site calls it directly); the boot
	// pass rides along as a property so adding it did not have to rewrite
	// every caller into an object destructure.
	return Object.assign(runOnce, { dispatchPending });
}
