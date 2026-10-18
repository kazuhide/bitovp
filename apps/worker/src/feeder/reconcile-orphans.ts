import {
	FEEDER_PROCESS_MAY_BE_ALIVE_WHERE,
	feederJobId,
	QUEUE_NAMES,
	redactSecrets,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type { Queue } from "bullmq";
import type { EmitProductEvent } from "../notify/emitter";
import { recordScheduleOutcomeBestEffort } from "../scheduler/schedule-outcome";
import {
	createKillLadder,
	type KillPid,
	looksLikeFeederFfmpeg,
	type ReadProcessCommand,
} from "./orphan-pid";
import { feederLeaseIsFresh } from "./ownership";
import { KILL_GRACE_MS } from "./supervisor";

/**
 * Feeder orphan reconcile (audit 2026-08-29 CRITICAL-2, boot half).
 *
 * The feeder pushes with `-stream_loop -1` inside ONE long-lived START job.
 * When that job's worker dies — OOM, SIGKILL, a lost lock — the ffmpeg child
 * is NOT killed with it: it is reparented and keeps pushing into a live
 * ingest, forever, billing the whole time. The in-process failed handler can
 * record the pid, but a worker that is itself being killed may not even run
 * it, and nothing at startup ever looked at what the last incarnation left
 * behind.
 *
 * So this sweep asks, per row that still records an unreclaimed pid: is
 * anybody supervising this push? Three gates must ALL pass before a signal is
 * sent, and each of them exists because the alternative is killing something
 * that is not ours:
 *
 * 1. HOST — a pid is only signallable where it was minted. Rows owned by
 *    another host are skipped entirely (a null `ownerHost` is pre-column
 *    history, written under the documented single-worker assumption).
 * 1b. LEASE  — a FRESH `ownerLeaseAt` means a worker is supervising
 *    this push RIGHT NOW, and after a takeover that worker is not necessarily
 *    the one whose start job this sweep can see. Without this gate the sweep
 *    would find a resumed session (old job dead, new owner running with no job
 *    of its own), match its identity — the ffmpeg genuinely IS this session's
 *    — and SIGKILL a healthy push. A null or stale lease falls through to the
 *    gates below unchanged, so nothing this sweep used to reclaim stops being
 *    reclaimable; the only cost is a DELAY of at most one takeover window for
 *    a row whose owner died with a lease still fresh, and that window is when
 *    the takeover sweep would rather RESUME the session than bury it.
 * 2. QUEUE, NOT CLOCK — the discriminator the VMAF reconciler already
 *    established (`vmaf/reconcile-stranded.ts`): if the START job is still on
 *    the feeder queue in a state nobody has classified as dead, a worker owns
 *    that push. This is what makes a rolling deploy safe: the outgoing
 *    worker's job is `active`, so the incoming worker leaves its ffmpeg alone.
 * 3. IDENTITY — the recorded pid is a bare number, and by boot time the
 *    kernel may have handed it to something else. The command line must
 *    positively look like this session's feeder ffmpeg. Unreadable = no
 *    information = do not kill, which is why this sweep can never be the only
 *    remedy: the operator-issued stop stays the path that acts on the pid
 *    when identity cannot be confirmed.
 *
 * Only a VERIFIED kill (or positive proof the pid is gone / recycled) stamps
 * `processGoneAt`. Everything else leaves the row exactly as it found it, so
 * the next tick — and the DELETE guard — still treat it as possibly alive.
 */

/**
 * The DEAD set, ENUMERATED (the polarity `vmaf/reconcile-stranded.ts` argues
 * for at length): a job state must be known-dead before this sweep decides
 * nobody owns the push. Anything unrecognised — including a live state a
 * BullMQ upgrade adds — leaves the row alone, which costs an operator one
 * stop and costs a live push nothing.
 */
const DEAD_STATES = new Set(["completed", "failed", "unknown"]);

/** Bounded like its siblings; the population strictly shrinks per pass. */
const RECONCILE_BATCH = 500;

export function createFeederOrphanReconciler(deps: {
	prisma: AppPrismaClient;
	queue: Pick<Queue, "getJob" | "name">;
	/** This worker's os.hostname; only rows minted here are touchable. */
	hostname: string;
	killPid: KillPid;
	readProcessCommand: ReadProcessCommand;
	sleep(ms: number): Promise<void>;
	now(): string;
	killGraceMs?: number;
	/**  delivery for rows this sweep lands in ERROR. */
	emitEvent?: EmitProductEvent;
}) {
	// The wrong queue would answer "no job" for every row and turn this into
	// a killer of live pushes, so the name is checked at construction — the
	// review-3 I5 lesson from the VMAF reconciler, same failure shape.
	if (deps.queue.name !== QUEUE_NAMES.feederManager) {
		throw new Error(
			`feeder orphan reconcile needs the ${QUEUE_NAMES.feederManager} queue, got ${deps.queue.name}`,
		);
	}
	const terminateOrphanPid = createKillLadder({
		killPid: deps.killPid,
		sleep: deps.sleep,
		killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS,
	});

	const pidIsAlive = (pid: number): boolean => {
		try {
			deps.killPid(pid, 0); // signal 0 = existence probe (throws ESRCH)
			return true;
		} catch {
			return false;
		}
	};

	return async function reconcileFeederOrphans(): Promise<number> {
		const rows = await deps.prisma.feederSession.findMany({
			where: {
				// The SHARED fragment, pinned to `feederProcessMayBeAlive` in
				// core: this sweep decides who gets SIGKILLed, so its population
				// must be the predicate's, not a hand translation of it that can
				// drift by one key (review MEDIUM-2).
				...FEEDER_PROCESS_MAY_BE_ALIVE_WHERE,
				// Gate 1 (host). Null = written before ownerHost existed, under
				// the single-worker assumption those rows were created with.
				OR: [{ ownerHost: deps.hostname }, { ownerHost: null }],
			},
			// `ownerId` / `ownerGeneration` are the owner token this sweep READS,
			// so the write below can compare-and-swap on it (
			// review-365 I-1). The comment sits ABOVE the projection rather
			// than beside those two keys because `ledger-references.test.ts`'s
			// pointer pattern is case-insensitive about `status`, and a `#N`
			// within sixty characters after the `status: true` line below reads
			// as a ledger reference — a false positive its own docblock warns
			// the pattern can produce.
			select: {
				id: true,
				liveChannelId: true,
				pid: true,
				ownerHost: true,
				status: true,
				error: true,
				ownerLeaseAt: true,
				ownerId: true,
				ownerGeneration: true,
				// The exact claim incarnation whose process tuple was inspected.
				publisherGeneration: true,
			},
			take: RECONCILE_BATCH,
		});
		const nowMs = Date.parse(deps.now());
		let reclaimed = 0;
		for (const row of rows) {
			const pid = row.pid;
			if (pid === null) {
				continue; // Unreachable via the filter; narrows the type.
			}
			// Gate 1b : somebody is supervising this push.
			if (feederLeaseIsFresh(row.ownerLeaseAt, nowMs)) {
				continue;
			}
			// Gate 2 (queue): a start job nobody has classified as dead means a
			// worker owns this push — or is about to be handed it.
			const job = await deps.queue.getJob(
				feederJobId({ feederSessionId: row.id, action: "start" }),
			);
			if (job && !DEAD_STATES.has(await job.getState())) {
				continue;
			}
			let note: string;
			if (!pidIsAlive(pid)) {
				// Proof by absence: nothing to kill, and the row can stop
				// claiming a process (its DELETE is unblocked).
				note = `ffmpeg pid ${pid} was already gone at worker start`;
			} else {
				// Gate 3 (identity). The command line is matched in memory and
				// discarded — it carries the push URL, which carries the key.
				const command = await deps.readProcessCommand(pid).catch(() => null);
				if (command === null) {
					console.warn(
						`[feeder] session ${row.id}: pid ${pid} is alive but its command line could not be read — NOT killing it; stop the session to act on it`,
					);
					continue;
				}
				if (!looksLikeFeederFfmpeg(command, row.id)) {
					note = `pid ${pid} now belongs to an unrelated process — this session's ffmpeg had already exited; nothing was signalled`;
				} else if (await terminateOrphanPid(pid)) {
					note = `orphaned ffmpeg pid ${pid} was killed at worker start (its start job had died)`;
				} else {
					console.error(
						`[feeder] session ${row.id}: orphaned ffmpeg pid ${pid} survived SIGKILL — the row still records it`,
					);
					continue;
				}
			}
			const wasActive =
				row.status === "CREATED" ||
				row.status === "DOWNLOADING" ||
				row.status === "PUSHING";
			const error = redactSecrets(
				row.error === null || row.error.length === 0
					? note
					: `${row.error} — ${note}`,
			);
			/**
			 * Guarded on the exact pid/host tuple and processGoneAt (a concurrent
			 * respawn or operator stop keeps its own write), on the exact publisher
			 * generation, AND on the owner token this pass read (* review-365 I-1).
			 *
			 * `processGoneAt: null` alone is not enough, because a CROSS-HOST
			 * takeover stamps NOTHING — it cannot prove the pid gone from where
			 * it stands — so its freshly claimed row still matches that guard.
			 * The sequence review-365 measured: host A restarts, its stalled
			 * START job is re-run, `start`'s CAS fails (PUSHING ≠ CREATED) and
			 * the job COMPLETES — which puts it in `DEAD_STATES`, so from
			 * lease-stale on both A's sweep and host B's `takeOverStale` are
			 * eligible. If B's claim lands while A is walking its kill ladder,
			 * this write would land ERROR + `pid: null` + a FEEDER_ERROR + a
			 * FAILED schedule row on the session B had just resumed, and B's own
			 * `setPushing` would then count 0 and tear the new push down.
			 *
			 * The owner token moves on every claim, so a takeover between the read
			 * and this write matches zero rows. A supervisor RESTART does not move
			 * either generation; the pid/host terms are therefore indispensable —
			 * they stop an old child's exit proof from clearing its replacement.
			 */
			const goneAt = new Date(deps.now());
			const { count } = await deps.prisma.feederSession.updateMany({
				where: {
					id: row.id,
					// Process identity is part of the proof. The same owner may respawn
					// after this pass reaps the old pid but before this write lands;
					// ownerGeneration and publisherGeneration deliberately stay stable
					// across supervisor restarts, so neither can substitute for pid+host.
					pid: row.pid,
					ownerHost: row.ownerHost,
					processGoneAt: null,
					ownerId: row.ownerId,
					ownerGeneration: row.ownerGeneration,
					publisherGeneration: row.publisherGeneration,
				},
				data: {
					pid: null,
					ownerHost: null,
					processGoneAt: goneAt,
					// a verified kill / ESRCH / recycled pid
					// is one of the three proofs that release the publisher claim
					// the dead owner held. Same instant as the proof it rides on.
					publisherReleasedAt: goneAt,
					error,
					// A row still claiming to push has just had its ffmpeg
					// reclaimed — leaving it PUSHING would be a lie about a
					// process this sweep just proved gone. ERROR, not STOPPED:
					// the session did not end on request, which is exactly what
					// the dead-job handler would have written had its worker
					// lived long enough to write anything.
					...(wasActive ? { status: "ERROR" as const, stoppedAt: goneAt } : {}),
				},
			});
			if (count === 0) {
				continue;
			}
			reclaimed += count;
			if (wasActive) {
				// : a feeder that ends in ERROR notifies, whichever
				// writer lands it. Best-effort by contract.
				await deps
					.emitEvent?.({
						kind: "FEEDER_ERROR",
						feederSessionId: row.id,
						liveChannelId: row.liveChannelId,
						error,
						path: `/live/${row.liveChannelId}`,
					})
					.catch(() => {});
				// Rows #238 and #242: and the schedule row that armed it.
				// This sweep is a THIRD writer of a feeder's terminal ERROR and
				// it was the only one not closing its schedule row — a
				// scheduled feed whose worker was killed left the ledger
				// reading FIRED and green while its session read ERROR, which
				// is the exact shape #238 exists to abolish. FAILED, not
				// UNKNOWN: unlike the dead-job handler, this path has PROOF the
				// push is over — it verified the pid gone before writing
				// anything. No-ops when nothing armed the session.
				await recordScheduleOutcomeBestEffort(
					deps.prisma,
					{ feederSessionId: row.id },
					"FAILED",
					error,
					new Date(deps.now()),
					"EFFECT_FAILED",
				);
			}
		}
		return reclaimed;
	};
}
