import { liveChannelJobSchema, redactSecrets } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { feederLeaseIsFresh } from "../feeder/ownership";
import { HEARTBEAT_SWEEP_JOB } from "../handlers";
import type { EmitProductEvent } from "../notify/emitter";
import {
	recordScheduleOutcomeBestEffort,
	type ScheduleOutcome,
	type ScheduleOutcomeTarget,
} from "../scheduler/schedule-outcome";

/**
 *  — what a liveChannel job that died OUTSIDE its processor means
 * for the schedule row that fired it.
 *
 * WHY THIS IS A MODULE AND NOT FOUR MORE `if`s IN `index.ts`.
 *
 * The `worker.on("failed", …)` body is a closure inside a `map` over the queue
 * keys in `apps/worker/src/index.ts`, and nothing imports that file: it is the
 * process entry point, so importing it starts workers, opens Redis and reads
 * the environment. Review of the first cut proved the consequence rather than
 * asserting it — flipping the insert-content branch's verdict from UNKNOWN to
 * FAILED left the ENTIRE worker suite green. Every branch below was therefore
 * unreachable by any test, which is how the provision/stop branch came to flip
 * the channel to ERROR while writing nothing at all to the schedule row: a
 * scheduled STOP whose job died sat FIRED/PENDING forever, rendering "Fired —
 * outcome not confirmed yet" beside a channel that was a confirmed ERROR, and
 * the dangling row was then resolved later by an unrelated stop.
 *
 * So the DECISION is a pure function over the job, and `index.ts` keeps one
 * call per handler.
 *
 * WHY EVERY BRANCH IS `UNKNOWN`.
 *
 * A job dying outside its processor is evidence about the JOB, never about
 * the world the job was acting on. The provider may have accepted the slate
 * (the whole slate idempotency guard exists because a POST can land and its
 * response be lost); the channel may have reached RUNNING a moment before the
 * lock was lost; and per the 2026-08-29 audit's CRITICAL-2 a dead feeder-start
 * job can leave an ORPHANED ffmpeg still pushing — a feed that is live and
 * billing. `FAILED` on any of those is a claim we cannot make. `UNKNOWN` is
 * the true one: it fired, and nobody is coming back to look. What will later
 * tell the truth about the orphaned process is the reclaim work tracked
 * separately , not this handler.
 *
 * The channel-status side of the same handler is deliberately NOT here: a dead
 * provision/stop job DOES prove the channel is wedged mid-transition, so
 * flipping it to ERROR is a claim about the row this handler owns. Only the
 * schedule row's DELIVERY is unknowable from here.
 */

/** The job shape this reads — BullMQ's `Job`, narrowed to what matters. */
export type DeadLiveJob =
	| {
			name?: string;
			data?: unknown;
			attemptsMade?: number;
			finishedOn?: number;
			opts?: { attempts?: number };
	  }
	| undefined;

function manualStopIntent(job: DeadLiveJob) {
	const parsed = liveChannelJobSchema.safeParse(job?.data);
	if (
		!parsed.success ||
		parsed.data.action !== "stop" ||
		parsed.data.effect?.action !== "STOP" ||
		!parsed.data.effect.idempotencyKey.startsWith("manual:stop:") ||
		parsed.data.effect.scheduleId
	) {
		return null;
	}
	return {
		liveChannelId: parsed.data.liveChannelId,
		...parsed.data.effect,
	};
}

/** BullMQ emits `failed` after incrementing attemptsMade on every delivery. */
export function isManualStopJob(job: DeadLiveJob): boolean {
	return manualStopIntent(job) !== null;
}

export function isFinalManualStopFailure(job: DeadLiveJob): boolean {
	if (!manualStopIntent(job)) return false;
	// BullMQ stamps finishedOn before emitting `failed` for every terminal
	// failure, including stalled-limit, UnrecoverableError, discard and a
	// backoff strategy that refuses another delivery. Those paths may stop
	// before attemptsMade reaches opts.attempts.
	if (typeof job?.finishedOn === "number" && Number.isFinite(job.finishedOn)) {
		return true;
	}
	const configured = job?.opts?.attempts;
	const attempts =
		typeof configured === "number" && Number.isFinite(configured)
			? Math.max(1, Math.floor(configured))
			: 1;
	return (job?.attemptsMade ?? 0) >= attempts;
}

/**
 * A manual STOP that exhausts every delivery before crossing the provider
 * boundary must not disappear behind the route's earlier 202. Project an
 * operator-visible ERROR only while this exact run/provider/fence still owns
 * the channel. A newer run, generation, ACK or unresolved send boundary wins
 * and is never overwritten by this failed-job callback.
 */
export async function recordFinalManualStopFailure(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
	message: string,
	emitEvent?: EmitProductEvent,
): Promise<boolean> {
	const intent = manualStopIntent(job);
	if (!intent || !isFinalManualStopFailure(job)) return false;
	const error = redactSecrets(
		`Manual stop delivery exhausted before the provider send was confirmed — retry Stop. ${message}`,
	);

	const result = await prisma.$transaction(async (tx) => {
		const [channel, currentRun, claim] = await Promise.all([
			tx.liveChannel.findUnique({
				where: { id: intent.liveChannelId },
				select: {
					name: true,
					status: true,
					liveEffectFenceVersion: true,
					bitmovinEncodingId: true,
				},
			}),
			tx.liveChannelRun.findFirst({
				where: { liveChannelId: intent.liveChannelId },
				orderBy: { seq: "desc" },
				select: { id: true, bitmovinEncodingId: true },
			}),
			tx.liveEffectClaim.findUnique({
				where: { idempotencyKey: intent.idempotencyKey },
				select: {
					state: true,
					generation: true,
					liveChannelId: true,
					liveChannelRunId: true,
					providerEncodingId: true,
					action: true,
				},
			}),
		]);
		if (
			!channel ||
			currentRun?.id !== intent.liveChannelRunId ||
			(currentRun.bitmovinEncodingId ?? channel.bitmovinEncodingId) !==
				intent.providerEncodingId
		) {
			return { projected: false as const };
		}

		let ownedFence = intent.admissionFenceVersion;
		if (claim) {
			if (
				claim.state !== "FAILED" ||
				claim.action !== "STOP" ||
				claim.liveChannelId !== intent.liveChannelId ||
				claim.liveChannelRunId !== intent.liveChannelRunId ||
				claim.providerEncodingId !== intent.providerEncodingId
			) {
				return { projected: false as const };
			}
			ownedFence = claim.generation;
		}
		if (channel.liveEffectFenceVersion !== ownedFence) {
			return { projected: false as const };
		}

		const projected = await tx.liveChannel.updateMany({
			where: {
				id: intent.liveChannelId,
				status: { in: ["RUNNING", "STOPPING"] },
				liveEffectFenceVersion: ownedFence,
			},
			data: {
				status: "ERROR",
				error,
			},
		});
		return projected.count === 1
			? { projected: true as const, channelName: channel.name }
			: { projected: false as const };
	});
	if (!result.projected) return false;
	await emitEvent?.({
		kind: "CHANNEL_ERROR",
		liveChannelId: intent.liveChannelId,
		name: result.channelName,
		error,
		path: `/live/${intent.liveChannelId}`,
	});
	return true;
}

export type DeadJobScheduleWrite = {
	target: ScheduleOutcomeTarget;
	outcome: Exclude<ScheduleOutcome, "PENDING">;
	/**
	 * Operator-facing, and RAW here so the decision stays exactly testable —
	 * `recordDeadJobScheduleOutcomes` redacts on the way to the column, which
	 * is the one place that can neither be skipped nor duplicated.
	 */
	note: string;
};

type LiveJobData = {
	liveChannelId?: string;
	action?: string;
	params?: { scheduleId?: string };
};

/**
 * Which schedule rows a dead liveChannel job closes, and how.
 *
 * Returns an array so a future action can close more than one row, and an
 * EMPTY array for every job that closes none — which is the common case:
 * the heartbeat sweep, parameter actions (reset-timeshift / scte35 /
 * heartbeat), live-to-VOD, and any manual action on a channel that has no
 * fired row (the reverse lookups simply match nothing).
 */
export function deadJobScheduleWrites(
	job: DeadLiveJob,
	message: string,
): DeadJobScheduleWrite[] {
	// Durable manual STOP has its own run/provider/fence-bound failure
	// projection. It never owns a LiveSchedule row; reverse-looking up the
	// channel here could corrupt an unrelated FIRED scheduled STOP as UNKNOWN.
	if (manualStopIntent(job)) {
		return [];
	}
	// The repeatable heartbeat sweep rides the same queue with no channel id
	// and no action; it owns no schedule row and must never close one.
	if (job?.name === HEARTBEAT_SWEEP_JOB) {
		return [];
	}
	const data = (job?.data ?? {}) as LiveJobData;
	// `liveChannelJobSchema.action` defaults to "provision" (packages/core
	// queues.ts), and the create path enqueues without one — so an absent
	// action IS a provision here, exactly as the channel-status arm reads it.
	const action = data.action ?? "provision";
	const scheduleId = data.params?.scheduleId;

	switch (action) {
		case "provision": {
			// A scheduled START enqueues `action: "provision"` with no params
			// (sweep.ts, both the first-start and the re-air site), so the FIRED
			// START row is found by reverse lookup.
			if (!data.liveChannelId) {
				return [];
			}
			return [
				{
					target: { channelStart: data.liveChannelId },
					outcome: "UNKNOWN",
					note: `the scheduled start's job died before it could report a result: ${message}`,
				},
			];
		}
		case "stop": {
			if (!data.liveChannelId) {
				return [];
			}
			return [
				{
					target: { channelStop: data.liveChannelId },
					outcome: "UNKNOWN",
					note: `the scheduled stop's job died before it could report a result: ${message}`,
				},
			];
		}
		case "insert-content": {
			if (!scheduleId) {
				return [];
			}
			return [
				{
					target: { scheduleId },
					outcome: "UNKNOWN",
					note: `the slate job died before the provider's answer could be read: ${message}`,
				},
			];
		}
		case "feeder-start":
		case "feeder-switch":
		// : a dead COMMIT is the same shape — the request may or may
		// not have been written before the job died, and the held session's
		// own transitions will say DELIVERED or FAILED over this UNKNOWN.
		case "feeder-commit": {
			if (!scheduleId) {
				return [];
			}
			return [
				{
					target: { scheduleId },
					outcome: "UNKNOWN",
					// CRITICAL-2 is why this is not FAILED: the ffmpeg the dead job
					// spawned can outlive it and keep pushing.
					note: `the scheduled feeder job died; its push may have been orphaned rather than stopped: ${message}`,
				},
			];
		}
		// : a dead PRE-STAGE closes no row — the row has not fired.
		// Its stage claim is released by `releaseDeadStageClaim` so the next
		// tick can stage again while the lead lasts.
		case "feeder-stage":
			return [];
		// restart is never scheduled (the sweep enqueues provision/stop/
		// insert-content/feeder-*/register-slate-content and nothing else), and
		// the remaining actions own no schedule row.
		default:
			return [];
	}
}

/**
 * Apply the decision above through the shared precedence writer. Best-effort
 * per write, like every other outcome writer: this runs in an event handler
 * that must not throw, and the row it could not write stays amber, which is
 * the honest reading of "we do not know".
 */
export async function recordDeadJobScheduleOutcomes(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
	message: string,
	at: Date,
): Promise<void> {
	for (const write of deadJobScheduleWrites(job, message)) {
		await recordScheduleOutcomeBestEffort(
			prisma,
			write.target,
			write.outcome,
			// The note embeds `err.message`, which is arbitrary provider or
			// driver text — redacted here like every other persisted error
			// string, once, at the only site that writes it.
			redactSecrets(write.note),
			at,
			write.outcome === "FAILED" ? "EFFECT_FAILED" : "JOB_TERMINAL_UNKNOWN",
		);
	}
}

/**
 *  — a dead PRE-STAGE job releases its claim. The stage claim
 * (`stagedAt` with no `stageDispatchedAt`) is the outbox's half; a job that
 * WAS handed off and then died (the channel had no encoder IP for the whole
 * retry ladder, the database blinked) leaves a stamped claim and no session,
 * and nothing would ever stage the row again — it would reach its fire time
 * and be refused as "not staged" for a reason that had already passed.
 * Releasing both stamps puts the row back in the next tick's stage scan.
 * Guarded on `feederSessionId: null`: a stage that DID create its session
 * before dying has done its work, and releasing it would create a second one
 * .
 */
export async function releaseDeadStageClaim(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
): Promise<number> {
	const data = (job?.data ?? {}) as LiveJobData;
	if (data.action !== "feeder-stage" || !data.params?.scheduleId) {
		return 0;
	}
	try {
		const { count } = await prisma.liveSchedule.updateMany({
			where: {
				id: data.params.scheduleId,
				status: "ARMED",
				feederSessionId: null,
			},
			data: { stagedAt: null, stageDispatchedAt: null },
		});
		return count;
	} catch (err) {
		console.error(
			`[worker:liveChannel] failed to release the pre-stage claim of ${data.params.scheduleId}:`,
			err instanceof Error ? err.message : err,
		);
		return 0;
	}
}

/**
 * THE FEEDER QUEUE's dead START job — moved here from `index.ts` for the same
 * reason as everything above, and carrying a second defect of its own
 * (review-351).
 *
 * What it always did: a start job that died OUTSIDE the processor lands the
 * session ERROR and KEEPS the recorded pid, because that pid is the only
 * forensic pointer to the ffmpeg that may still be pushing (audit CRITICAL-2).
 *
 * What it never did: NOTIFY. `markTerminal` in `feeder/processor.ts` emits
 * `FEEDER_ERROR` at the feeder's one in-process terminal-error choke point,
 * and this — the out-of-process death, which is the most common trigger of the
 * orphan-ffmpeg case — emitted nothing. 's instrument could not see
 * the hole either: `notify/emit-sites.test.ts` walks the worker source for
 * emit calls and set-equals what it finds against its own table, and
 * `index.ts` was in neither, so a terminal write with no emit lived in the one
 * file the guard's population excluded. This module IS in that table now.
 */
export type DeadFeederJobDeps = {
	prisma: AppPrismaClient;
	/** Best-effort by contract  — absent in tests that ignore it. */
	emitEvent?: EmitProductEvent;
	now?: () => Date;
};

type DeadFeederJobData = { feederSessionId?: string; action?: string };

export async function recordDeadFeederJob(
	deps: DeadFeederJobDeps,
	job: DeadLiveJob,
	message: string,
): Promise<void> {
	const data = (job?.data ?? {}) as DeadFeederJobData;
	const feederSessionId = data.feederSessionId;
	// Scoped to dead START jobs: a failed STOP must never flip status — the
	// session may genuinely still be pushing, and flipping would lie.
	if (!feederSessionId || (data.action ?? "start") !== "start") {
		return;
	}
	const at = deps.now?.() ?? new Date();
	try {
		const row = await deps.prisma.feederSession.findUnique({
			where: { id: feederSessionId },
			select: { pid: true, liveChannelId: true, ownerLeaseAt: true },
		});
		/**
		 *  — the STALENESS GUARD, the shape #216 gave the live failed
		 * handler for the identical reason.
		 *
		 * A dead-START-job report is NOT ordered against a takeover, and the
		 * first version of this comment claimed it was (review-365 S-2). What
		 * is true: BullMQ's stalled ladder runs on its own cadence —
		 * `maxStalledCount` 5 (`stall-policy.ts`) × a 30s stalled interval —
		 * which is far longer than the 90s takeover window, and a stalled START
		 * job is moved back to WAIT and RE-RUN before it is ever failed. A
		 * re-run finds the row PUSHING, fails `start`'s CREATED claim and
		 * COMPLETES, so on a multi-worker install this handler often never
		 * fires for a resumed session at all.
		 *
		 * What the guard is for is the case where it DOES fire late: by then
		 * another worker may own the session, and without this check the report
		 * would flip a push that is fine to ERROR, and — the `count > 0` fence
		 * below being satisfied — raise an incident and write the schedule
		 * off.
		 *
		 * A fresh lease is the one thing that means "somebody owns this now".
		 * Null and stale both fall through to the write, which is exactly what
		 * this handler did before the lease existed.
		 */
		if (feederLeaseIsFresh(row?.ownerLeaseAt, at.getTime())) {
			console.warn(
				`[worker:feederManager] dead START job for session ${feederSessionId} ignored — another worker holds a fresh ownership lease on it`,
			);
			return;
		}
		const orphanNote =
			row?.pid != null
				? `a pushing ffmpeg may be orphaned at pid ${row.pid} — check it`
				: "no ffmpeg pid was recorded (the session never reached PUSHING)";
		const error = redactSecrets(
			`Worker lost the session (${message}) — ${orphanNote}`,
		);
		const { count } = await deps.prisma.feederSession.updateMany({
			where: {
				id: feederSessionId,
				status: { in: ["CREATED", "DOWNLOADING", "PUSHING"] },
			},
			data: {
				status: "ERROR",
				stoppedAt: at,
				error,
			},
		});
		/**
		 * Everything below is fenced on having WON the transition — the same
		 * `if (count === 0) return` the channel arm in `index.ts` learned
		 * (review-336 C3). An unfenced emit here would raise an incident about
		 * a session another worker owns, or a second FEEDER_ERROR for one the
		 * processor already reported; the in-process `markTerminal` emit is
		 * unconditional only because its own write is.
		 */
		if (count === 0) {
			return;
		}
		// Same kind and payload shape as feeder/processor.ts's markTerminal.
		await deps.emitEvent?.({
			kind: "FEEDER_ERROR",
			feederSessionId,
			liveChannelId: row?.liveChannelId ?? "",
			error,
			path: `/live/${row?.liveChannelId ?? ""}`,
		});
		// And the schedule row that armed this session, if any: UNKNOWN, for
		// the CRITICAL-2 reason above — the push may be orphaned rather than
		// stopped, so "it failed to deliver" is not a claim this path can make.
		await recordScheduleOutcomeBestEffort(
			deps.prisma,
			{ feederSessionId },
			"UNKNOWN",
			error,
			at,
			"JOB_TERMINAL_UNKNOWN",
		);
	} catch (err) {
		console.error(
			`[worker:feederManager] failed to close dead session ${feederSessionId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}
