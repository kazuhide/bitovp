import {
	type AppPrismaClient,
	CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
	type Prisma,
} from "@bitovp/db";

/**
 *  — the ONE writer of `LiveSchedule.outcome`.
 *
 * `status = FIRED` says the request left this system. It never said the
 * provider accepted it, the session connected, or the picture changed. The
 * 2026-08-29 live audit's paid run #4 is the proof: a SLATE_IN fired, the
 * provider's scheduled entry went ERROR, the program kept airing uncovered,
 * and the row read FIRED — rendered green — with a DONE step beside it.
 *
 * Delivery therefore has its own column, and this module owns the rule for
 * writing it. Four different callers learn the answer at four different
 * moments (the slate poll, the feeder session's own transitions, the stop
 * confirmation, the dead-job handler), so "who wins" cannot live in any one
 * of them.
 */
export type ScheduleOutcome =
	| "PENDING"
	| "PROCESS_PUSHING"
	| "INGEST_CONNECTED"
	| "SLATE_ARMED"
	| "DELIVERED"
	| "FAILED"
	| "UNKNOWN";

export { CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION };

export type ScheduleOutcomeEvidenceKind =
	| "PROVIDER_RUNNING"
	| "PROVIDER_TERMINAL"
	| "PROVIDER_STATUS_UNKNOWN"
	| "HEARTBEAT_INGEST_CONNECTED"
	| "FEEDER_PROCESS_PUSHING"
	| "SLATE_ARMED"
	| "EFFECT_FAILED"
	| "JOB_TERMINAL_UNKNOWN"
	| "STALE_GENERATION_REFUSAL";

/**
 * Which prior outcomes each write is allowed to replace — the precedence, as
 * data, applied inside the UPDATE's own WHERE so two writers race in Postgres
 * rather than in a read-modify-write.
 *
 * P1-4 split the single PENDING→DELIVERED leap into a
 * media-witnessed progression, so this ladder now has middle rungs:
 *
 * PENDING → PROCESS_PUSHING → INGEST_CONNECTED → DELIVERED (feeder/lifecycle)
 * PENDING → SLATE_ARMED (slate — no witness)
 *
 * `PROCESS_PUSHING` may replace only `PENDING`. A restart's fresh push must
 * NOT drag an already-`INGEST_CONNECTED` row back down (a downgrade), and it
 * must not un-fail a `FAILED` one — so it climbs from PENDING and nowhere else.
 *
 * `INGEST_CONNECTED` may replace `PENDING` or `PROCESS_PUSHING`: the provider
 * confirming the ingest is strictly more than our ffmpeg merely running.
 *
 * `SLATE_ARMED` may replace only `PENDING`. It is not on the feeder ladder;
 * it is the slate's own honest ceiling — the provider armed an insertion we
 * cannot witness airing — so it climbs from PENDING and is never a green.
 *
 * `DELIVERED` may replace every non-terminal positive below it
 * (`PENDING`/`PROCESS_PUSHING`/`INGEST_CONNECTED`/`SLATE_ARMED`) — a START that
 * reached RUNNING, or a STOP observed terminal, outranks any in-progress read.
 * It DELIBERATELY no longer replaces `UNKNOWN` (audit MODERATE-2): a manual
 * START hours after a scheduled one gave up would otherwise reverse-look-up the
 * old FIRED row and relabel its `UNKNOWN` as `DELIVERED`. `UNKNOWN` means "no
 * answer is coming", and a later, unrelated positive is not that answer. The
 * commoner case the old rule protected — a job's OWN in-flight retry recording
 * the success it achieved — never touches UNKNOWN: UNKNOWN is written by the
 * dead-job handler only once a job is terminally dead, after which the only
 * writer of a positive is a NEW action, which is exactly what must not upgrade
 * it.
 *
 * `FAILED` is STICKY, and that is the requirement this whole column exists
 * for: a feeder that connects (`INGEST_CONNECTED`) and dies twenty minutes
 * later writes FAILED over it, but nothing writes a positive back — a schedule
 * whose airing failed must not be un-failed by a later, weaker observation. It
 * is also idempotent on itself, which keeps the FIRST failure's reason: that is
 * the causal one, and a retry ladder's fifth message is the least informative.
 *
 * `UNKNOWN` may only replace `PENDING`. It means "no answer is coming", so it
 * is never an upgrade over an answer we already hold; downgrading any positive
 * or a known FAILED to UNKNOWN would hide the evidence we do have.
 */
const MAY_REPLACE: Record<
	Exclude<ScheduleOutcome, "PENDING">,
	readonly ScheduleOutcome[]
> = {
	PROCESS_PUSHING: ["PENDING"],
	INGEST_CONNECTED: ["PENDING", "PROCESS_PUSHING"],
	SLATE_ARMED: ["PENDING"],
	DELIVERED: ["PENDING", "PROCESS_PUSHING", "INGEST_CONNECTED", "SLATE_ARMED"],
	FAILED: [
		"PENDING",
		"PROCESS_PUSHING",
		"INGEST_CONNECTED",
		"SLATE_ARMED",
		"DELIVERED",
		"UNKNOWN",
	],
	UNKNOWN: ["PENDING"],
};

/**
 * Which rows to write.
 *
 * `scheduleId` and `feederSessionId` name a row that ALREADY fired by
 * construction — the queue payload carries a schedule id only because the
 * sweep fired that row, and `LiveSchedule.feederSessionId` is stamped by the
 * feeder-start action, which only runs for a fired row. Neither re-checks
 * `status`, so the dead-job handler can flip a row to ERROR and record its
 * outcome in either order without one write silently disqualifying the other.
 *
 * START's legacy job has no schedule id, so it uses the channel and FIRED state.
 * Scheduled STOPs carry their exact row, channel and airing in the durable intent.
 * A manual STOP never owns a schedule.
 */
export type ScheduleOutcomeTarget =
	| { scheduleId: string }
	| { feederSessionId: string }
	| { channelStart: string }
	| {
			canceledChannelStart: { liveChannelId: string; liveChannelRunId: string };
	  }
	| {
			scheduledStop: {
				id: string;
				liveChannelId: string;
				liveChannelRunId?: string;
			};
	  };

function whereOf(target: ScheduleOutcomeTarget): Prisma.LiveScheduleWhereInput {
	if ("scheduleId" in target) {
		return { id: target.scheduleId };
	}
	if ("feederSessionId" in target) {
		return { feederSessionId: target.feederSessionId };
	}
	if ("channelStart" in target) {
		return {
			liveChannelId: target.channelStart,
			action: "START",
			status: "FIRED",
		};
	}
	if ("canceledChannelStart" in target) {
		return { ...target.canceledChannelStart, action: "START", status: "FIRED" };
	}
	return {
		...target.scheduledStop,
		action: "STOP",
		status: "FIRED",
	};
}

/**
 * Record what a fired schedule row actually delivered. Returns the number of
 * rows written — 0 means the precedence refused it (something stronger is
 * already recorded), which is a normal outcome and never an error.
 *
 * `note` is operator-facing prose: the provider's own message, the session's
 * error, the unconfirmed-stop reason. It is stored verbatim on `outcomeNote`,
 * so callers must hand it already redacted.
 */
export async function recordScheduleOutcome(
	prisma: AppPrismaClient,
	target: ScheduleOutcomeTarget,
	outcome: Exclude<ScheduleOutcome, "PENDING">,
	note: string | null,
	at: Date,
	evidenceKind: ScheduleOutcomeEvidenceKind,
): Promise<number> {
	const canceledStart = "canceledChannelStart" in target;
	const scheduledStop = "scheduledStop" in target;
	if (canceledStart && outcome !== "FAILED") {
		throw new Error("a canceled startup can only record FAILED");
	}
	const { count } = await prisma.liveSchedule.updateMany({
		where: {
			...whereOf(target),
			// Cancellation proves only this pending startup failed, not that a
			// previously delivered/unknown START (or another run) failed.
			outcome: {
				in:
					canceledStart || scheduledStop
						? ["PENDING"]
						: [...MAY_REPLACE[outcome]],
			},
		},
		data: {
			outcome,
			outcomeAt: at,
			outcomeNote: note,
			outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
			outcomeEvidenceKind: evidenceKind,
			outcomeEvidenceAt: at,
		},
	});
	return count;
}

/**
 * Refuse a schedule whose run generation is no longer current.
 *
 * Status, outcome, operator note and evidence are deliberately one guarded
 * UPDATE.  Splitting these writes allowed a crash to leave a terminal-looking
 * stale row with PENDING delivery evidence, which the UI could not interpret
 * honestly.
 */
export async function transitionScheduleToStale(
	prisma: AppPrismaClient,
	input: {
		scheduleId: string;
		stop?: { liveChannelId: string; liveChannelRunId: string };
		note: string;
		at: Date;
	},
): Promise<boolean> {
	const { count } = await prisma.liveSchedule.updateMany({
		where: {
			id: input.scheduleId,
			status: { in: ["ARMED", "FIRED"] },
			...(input.stop
				? { ...input.stop, action: "STOP", outcome: { in: ["PENDING"] } }
				: {}),
		},
		data: {
			status: "SKIPPED_STALE_GENERATION",
			note: input.note,
			outcome: "FAILED",
			outcomeAt: input.at,
			outcomeNote: input.note,
			outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
			outcomeEvidenceKind: "STALE_GENERATION_REFUSAL",
			outcomeEvidenceAt: input.at,
		},
	});
	return count === 1;
}

/**
 * The same write, but never allowed to fail its caller.
 *
 * Every call site here sits AFTER the thing it describes has already
 * happened: the slate is on air, the session is pushing, the channel is
 * stopped. Throwing would re-run work that already landed, so a bookkeeping
 * failure is logged loudly and swallowed — loudly because an unwritten
 * outcome leaves the row amber forever, which is the honest reading but not
 * the informative one.
 */
export async function recordScheduleOutcomeBestEffort(
	prisma: AppPrismaClient,
	target: ScheduleOutcomeTarget,
	outcome: Exclude<ScheduleOutcome, "PENDING">,
	note: string | null,
	at: Date,
	evidenceKind: ScheduleOutcomeEvidenceKind,
): Promise<void> {
	try {
		await recordScheduleOutcome(
			prisma,
			target,
			outcome,
			note,
			at,
			evidenceKind,
		);
	} catch (err) {
		console.error(
			`[schedule-outcome] could not record ${outcome} for ${JSON.stringify(target)}:`,
			err instanceof Error ? err.message : err,
		);
	}
}
