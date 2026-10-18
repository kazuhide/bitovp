import { rm } from "node:fs/promises";
import {
	DEFAULT_LOOP_FPS,
	deriveProviderLifecycle,
	FEEDER_ACTIVE_STATUSES,
	FEEDER_MAX_ACTIVE_SESSIONS,
	FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
	type FeederErrorOriginKind,
	type FeederJob,
	feederError,
	feederErrorEnglish,
	feederJobSchema,
	feederOccupancyWhere,
	feederProcessMayBeAlive,
	feederPublisherClaimHeld,
	feederRtmpTargetSchema,
	feederSrtTargetSchema,
	heartbeatSampleFresh,
	INGEST_CONNECTED_MAX_AGE_MS,
	ingestConnectedFromHeartbeat,
	loopProfileSchema,
	persistedHeartbeatAtMs,
	providerEffectIdentityRefusal,
	providerEffectRefusal,
	redactSecrets,
	type SourceIdentity,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	assertLiveEffectCurrent,
	beginLiveEffect,
	type LiveEffectClaimHandle,
	loadLiveEffectTargetClaim,
	markLiveEffectAcked,
	markLiveEffectAmbiguous,
	markLiveEffectFailed,
	type Prisma,
} from "@bitovp/db";
import type { EmitProductEvent } from "../notify/emitter";
import type { ResolvedCredential } from "../orchestrator/executor";
import { recordScheduleOutcomeBestEffort } from "../scheduler/schedule-outcome";
import {
	buildFeederCommand,
	buildLineRedactor,
	buildNormalizeCommand,
	checkSourceSatisfiesIngest,
	compareSourceCompatibility,
	decideCodecMode,
	expectedIngestMedia,
	type FeederTarget,
	heartbeatIngestMedia,
	loopProfileFromProbe,
	type MediaAttributes,
	normalisationTargets,
	normalizedSpoolPath,
	type ProbeResult,
	parseMediaAttributes,
	parseProbeJson,
	probeArgs,
	pushedMediaAttributes,
	sourceMediaAttributes,
	sourceVideoSpan,
} from "./command";
import {
	createDefaultFetchSource,
	type FetchedSource,
	type FetchSource,
} from "./fetch-source";
import {
	createKillLadder,
	type KillPid,
	looksLikeFeederFfmpeg,
	type ReadProcessCommand,
} from "./orphan-pid";
import {
	FEEDER_LEASE_RENEWAL_MS,
	FEEDER_LEASE_TAKEOVER_MS,
	feederLeaseStaleWhere,
} from "./ownership";
import {
	createFeederSupervisor,
	type FeederSupervisor,
	type IngestBindStatus,
	KILL_GRACE_MS,
	type LoopBoundary,
	type ProcessRunner,
} from "./supervisor";

/**
 * Feeder session processor (P3-PR3): runs one FeederSession lifecycle
 * inside ONE long-lived BullMQ "start" job —
 * claim CREATED → DOWNLOADING → wait for the channel to reach RUNNING
 * (lifecycle coupling) → spool the source MP4 from object storage →
 * ffprobe + copy/transcode decision → resolve push secrets from the
 * vault (spawn-time only) → supervised ffmpeg push (PUSHING) → STOPPED
 * or ERROR.
 *
 * "stop" jobs signal the running supervisor through the in-process
 * registry (the worker raises feeder-queue concurrency so stop jobs run
 * while start jobs hold their slots). A registry miss (worker restarted —
 * the ffmpeg child does not survive supervision) runs a VERIFIED kill
 * ladder at the recorded pid (probe → SIGTERM → grace polling → SIGKILL),
 * and the row's landing state is the ladder's ANSWER, never the attempt:
 * STOPPED with the pid released and `processGoneAt` stamped when the pid is
 * provably gone, ERROR with the pid KEPT when it is not (review HIGH —
 * releasing the pid on an unconfirmed kill hid the process from the DELETE
 * guard and from the boot sweep, which is CRITICAL-2's end-state reached by
 * another road).
 *
 * That ladder now also runs for a TERMINAL row that still carries an
 * unreclaimed pid (audit 2026-08-29 CRITICAL-2). The dead-job handler in
 * index.ts marks a session ERROR when its START job dies outside the
 * processor and KEEPS the pid, because a `-stream_loop -1` ffmpeg outlives
 * the worker that spawned it. Returning early on ERROR — as this function
 * did — meant the only code that can kill that process was unreachable from
 * the product, while DELETE was free to erase the last reference to it.
 * A terminal reclaim never rewrites `status` (an ERROR run did fail); it
 * stamps `processGoneAt` as proof and releases the pid.
 *
 * Multi-worker ownership. The registry is
 * still per-process — a stop consumed by a different worker than the one
 * pushing takes the fallback path, which checks `ownerHost` first because a
 * pid from another host is a bare number some unrelated local process is
 * wearing — but the registry is no longer the only record of who owns a push.
 *
 * A session now carries an OWNER LEASE (`ownership.ts`): this process claims
 * `(ownerId, ownerGeneration)`, re-stamps `ownerLeaseAt` on a ticker for as
 * long as it supervises the push, and EVERY write it makes to the row is
 * fenced on that pair. When the lease is taken — because this process stopped
 * renewing long enough for `takeOverStale` on another worker to claim it —
 * the fenced writes match zero rows, the push is torn down, and nothing
 * terminal is written: the row belongs to the new owner, exactly as #216's
 * provisioning loser leaves the winner's channel alone.
 *
 * `takeOverStale` is the other half: any worker may resume a session whose
 * lease has expired, re-spawning ffmpeg from the SEALED source at
 * the same target and through the same compatibility gate. It is a
 * recovery, not a seamless failover — the source is downloaded again, so the
 * gap is a download plus a handshake.
 *
 * THE TWO-PHASE SWITCH. A session whose
 * `commitAt` is set does not spawn when its staging completes. Phase A —
 * everything above the spawn: the RUNNING wait, the sealed download, ffprobe,
 * the ingest and compatibility gates — ends by recording `readyAt` (fenced)
 * and HOLDING the spooled file. Phase B begins when `commitRequestedAt` is
 * written on the row (the scheduler's commit at fireAt, or creation itself
 * for an immediate switch): this process stops every predecessor on the
 * channel, waits until each is PROVEN gone — `processGoneAt` from a kill
 * ladder, or the clean stop that releases pid and lease — and only then
 * takes the commit point, a fenced compare-and-swap on `committedAt`, and
 * spawns. The seam, first push minus the last predecessor's gone instant, is
 * measured and written to the session and its schedule row.
 *
 * POLICY, written down because the old path had none: dead air is preferred
 * over overlap. The ingest is single-owner — a second publisher on one stream
 * key is the jammed-socket class recorded — so a predecessor that cannot
 * be confirmed gone within `PREDECESSOR_GONE_TIMEOUT_MS` lands THIS session
 * ERROR and never spawns; the schedule row reads FAILED with the reason.
 * What the ingest is left with is stated honestly (rev367 I-4): the
 * predecessors were ASKED to stop, and a cross-host stop retires the SESSION
 * while its process stays unverified from here — so after this refusal the
 * ingest may still be fed by a process this worker cannot see, or not fed at
 * all. Never fed twice; that is the whole guarantee. The seam is the
 * measured cost of that choice, not a number to be hidden.
 *
 * A staged session is OWNED from the moment it is claimed, so the lease above
 * covers the hold: a holder that stops renewing is taken over like any other
 * session, the new owner re-stages under its own generation (the claim
 * clears `readyAt` and `committedAt`), and the commit is fenced on the same
 * `(ownerId, ownerGeneration)` pair as the staging — a superseded holder
 * that wakes up to a commit request matches zero rows at the commit point and
 * never spawns.
 *
 * THE PUBLISHER CLAIM. Everything
 * above bounds who may WRITE a row; none of it bounded how many ffmpegs may
 * PUSH at one ingest, because the single-pusher rule lived in `status`: the
 * DB index and both admission doors counted CREATED/DOWNLOADING/PUSHING, and
 * three writers leave a row TERMINAL with its process alive — the cross-host
 * refusal below (ERROR, pid kept), `stop`'s not-ours arm (STOPPED, pid
 * kept), the dead-job handler (ERROR, pid kept). Until the old owner's next
 * renewal failed and it self-fenced, a new session could be admitted, spawned
 * and pushing beside it. So a run now CLAIMS the channel's publisher slot
 * (`publisherClaimedAt`, status-independent, one held claim per channel by
 * partial unique index) BEFORE it spawns — an ordinary session just before
 * the supervisor starts, a two-phase switch inside the fenced commit CAS —
 * and `setPushing` refuses to record a pid on a row that holds no claim. The
 * claim is RELEASED only by positive proof that the process is gone: this
 * supervisor observing its child's exit (`markTerminal`, the lease-lost proof
 * write), a verified kill ladder or ESRCH (`stop`, `claimStaleSession`,
 * the boot reconciler). A terminal status, a lease expiry or a pid-null
 * rewrite releases nothing. Admission, the pre-spawn check and the
 * predecessor barrier all read ONE occupancy fragment (`feederOccupancyWhere`,
 * core): a held claim, a process nobody has proven gone, or an active
 * uncoordinated session — a staged hold for a later switch is none of these.
 */

/**
 * The #95 bind-watchdog's tri-state provider probe. Fresh explicit evidence
 * is CONNECTED or DISCONNECTED; stale, missing, clock-broken or excessively
 * future-skewed input is UNKNOWN. UNKNOWN is neither success nor an immediate
 * kill: the supervisor re-probes it until the attempt deadline, then stops the
 * unproven process. This distinction prevents both a DB blip from shooting a
 * healthy push and an unreadable provider from leaving a publisher billing
 * forever. The supervisor separately requires the heartbeat poll to have
 * started strictly after this spawn/switch boundary.
 */
export function mayKeepPushing(
	sample: unknown,
	nowMs: number,
): IngestBindStatus {
	if (!Number.isFinite(nowMs)) {
		return "UNKNOWN";
	}
	// the freshness gate must be SYMMETRIC.
	// The old inline check `nowMs - at <= INGEST_CONNECTED_MAX_AGE_MS` had NO
	// lower bound, so a FUTURE-dated stamp (clock skew on the worker that wrote
	// the sample) scored a NEGATIVE age, counted as "fresh", and a future
	// WAITING_FOR_FIRST_CONNECT then read as a fresh explicit failure — the
	// watchdog RESTARTED a healthy feeder. Share the alert engine's ONE
	// symmetric bound (heartbeatSampleFresh, [-HEARTBEAT_FUTURE_SKEW_TOLERANCE,
	// maxAge]) so a stamp far enough ahead is no-information → keep pushing,
	// exactly as the slate fire gate (ingestConnectedFresh) already treats it.
	// A stale sample cannot vouch for either direction.
	if (!heartbeatSampleFresh(sample, nowMs, INGEST_CONNECTED_MAX_AGE_MS)) {
		return "UNKNOWN";
	}
	return ingestConnectedFromHeartbeat(sample) ? "CONNECTED" : "DISCONNECTED";
}

export type FeederDeps = {
	/** Product-event emit ; never throws. */
	emitEvent?: EmitProductEvent;
	prisma: AppPrismaClient;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	runner: ProcessRunner;
	ffmpegPath: string;
	ffprobePath: string;
	/** Local spool directory for downloaded sources. */
	spoolDir: string;
	/**
	 * This worker's host identity (os.hostname), persisted next to the pid
	 * so a later stop knows whether the recorded number is signallable HERE.
	 * Required, not defaulted: a silently-wrong host would make every reclaim
	 * either a no-op or a kill of somebody else's process.
	 */
	hostname: string;
	/**
	 * this worker INSTANCE's id — the holder of every lease it
	 * claims. Distinct from `hostname`, which answers a different question
	 * (where a pid can be signalled): two workers on one host are two owners,
	 * and a restart that reuses a pid is a different owner. Required, not
	 * defaulted, for the same reason `hostname` is — a silently shared id
	 * would let two processes renew each other's leases forever, which is
	 * precisely the state this row exists to make impossible.
	 */
	ownerId: string;
	sleep(ms: number): Promise<void>;
	now(): string;
	/** Channel-coupling wait (start pushes only into a RUNNING channel). */
	channelPollIntervalMs?: number;
	channelWaitTimeoutMs?: number;
	/**
	 * Injectable source download (tests run without fs/network). Default
	 * implementation streams browser.getObject → spool file, aborts with
	 * the passed signal and removes partial files on failure.
	 */
	fetchSource?: FetchSource;
	/**
	 * Process signalling for registry-miss stops (see stop): "SIGTERM" /
	 * "SIGKILL" deliver, 0 probes existence (throws ESRCH when gone) — the
	 * node `process.kill` contract.
	 */
	killPid?: KillPid;
	/**
	 * Optional pid-reuse veto for the reclaim ladder: reads the live pid's
	 * command line so a recycled number is recognised as NOT our ffmpeg (and
	 * therefore as proof our ffmpeg is gone). Unwired — or unobtainable —
	 * leaves the ladder exactly as it was: an operator-issued stop still acts
	 * on the recorded pid, which is what it has always done. The boot
	 * reconciler, which acts unbidden, requires a positive match instead.
	 */
	readProcessCommand?: ReadProcessCommand;
	/** Lease renewal cadence (tests shrink it to observe renewals). */
	leaseRenewalIntervalMs?: number;
	/**
	 * how often a HELD session re-reads its row for the commit
	 * request, and how often the commit re-checks its predecessors. Tests
	 * shrink it; the arms resolve on the writes they observe, never on it.
	 */
	commitPollIntervalMs?: number;
	/** : how long the commit waits for every predecessor to be gone. */
	predecessorGoneTimeoutMs?: number;
	/** : how long past `commitAt` a held session waits for a commit. */
	stageHoldTimeoutMs?: number;
	/** Supervisor tuning passthrough (tests shrink these). */
	maxRestarts?: number;
	backoffBaseMs?: number;
	backoffCapMs?: number;
	killGraceMs?: number;
	bindTimeoutMs?: number;
	bindProbeIntervalMs?: number;
	maxBindKills?: number;
	logTailSize?: number;
	logFlushEveryLines?: number;
	/** Persisted loop-boundary window (default LOOP_BOUNDARY_CAP). */
	loopBoundaryCap?: number;
};

export type FeederResult = {
	acknowledged: true;
	feederSessionId: string;
	action: FeederJob["action"];
	status: string;
};

const CHANNEL_POLL_INTERVAL_MS = 5_000;
const CHANNEL_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
/**
 *  — the switch's clocks. The hold polls its own row once a second:
 * every second of poll interval is a second of seam once the commit lands,
 * so this is deliberately shorter than the channel poll above. The
 * predecessor wait is bounded by one kill ladder (SIGTERM → `KILL_GRACE_MS`
 * → SIGKILL → probe) plus the queue and database hops around it, with room
 * for a predecessor that is still DOWNLOADING to notice its stop; a
 * predecessor not gone by then is refused, not waited on forever. The hold
 * timeout is the backstop for a commit that never arrives — a sweep that
 * stopped ticking — measured from the planned commit instant.
 */
export const COMMIT_POLL_INTERVAL_MS = 1_000;
export const PREDECESSOR_GONE_TIMEOUT_MS = 60_000;
export const STAGE_HOLD_TIMEOUT_MS = 30 * 60_000;
/**
 * Non-terminal feeder statuses (claimable by stop) — core's list, so this
 * file, the doors and the occupancy fragment cannot hold three copies.
 */
const ACTIVE_STATUSES = FEEDER_ACTIVE_STATUSES;

/**
 * A P2002 from `FeederSession_one_publisher_claim_per_channel` — the DB's
 * atomic single-PUBLISHER guarantee. Matched
 * structurally, like the web route's `isActivePusherViolation`: the only
 * unique a claim write can violate is that index (it changes neither `status`
 * nor `commitAt`, so the active-pusher index cannot fire), and the name check
 * keeps a future unique from borrowing this refusal. Tolerates both
 * `meta.target` shapes and an adapter that omits `target`.
 */
export function isPublisherClaimViolation(err: unknown): boolean {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const e = err as { code?: unknown; meta?: { target?: unknown } };
	if (e.code !== "P2002") {
		return false;
	}
	const target = String(e.meta?.target ?? "");
	return (
		target === "" ||
		target.includes("FeederSession_one_publisher_claim_per_channel") ||
		target.includes("liveChannelId")
	);
}
/**
 * Persisted loop-boundary window. Every boundary rewrites the full array,
 * so an uncapped pathological source (~1s loop over hours) would generate
 * O(n²) write traffic and an unbounded row. Most-recent entries win; the
 * strictly increasing loopIndex keeps a trimmed head detectable.
 */
const LOOP_BOUNDARY_CAP = 10_000;

/**
 * What a run returns when it lost its lease .
 *
 * DELIBERATELY not a `FeederStatus`: no row is ever in this state. It names
 * what happened to the JOB — this process stopped supervising a session that
 * another worker now owns — and it exists so the return value cannot be
 * mistaken for a status this run wrote. Nothing branches on it; it reaches the
 * queue result, the worker log and the tests.
 */
const TAKEN_OVER = "TAKEN_OVER";

/**
 * How long a graceful shutdown waits for the sessions this process RESUMED
 *
 *
 * `drainTakeovers` is not a bookkeeping sweep: it waits for a PROCESS TO
 * DIE. Stopping one resumed session is SIGTERM → `KILL_GRACE_MS` → SIGKILL →
 * the terminal write and its emit, so the shutdown default of 5s is shorter
 * than the grace window alone — the drain would have timed out precisely in
 * the case it was added for, and the container runtime's SIGKILL would then
 * have left the ffmpeg it was waiting on.
 *
 * DERIVED from `KILL_GRACE_MS` rather than spelled as a number, so raising the
 * grace cannot silently outgrow the budget that has to contain it. The margin
 * covers the terminal write; it is not a second grace window, because the
 * timeout is a bound and not a target — a healthy stop returns in milliseconds
 * after the child exits.
 */
export const FEEDER_TAKEOVER_DRAIN_MS = KILL_GRACE_MS + 5_000;

/**
 * the session's SEAL, rebuilt from its columns (audit 2026-08-29
 * HIGH-4).
 *
 * `sourceSize` is the discriminator, not the selectors: every driver reports a
 * size, so a row that has one was sealed, and a row that has none was written
 * before the seal existed (or by a driver with no `headObject`). Returning
 * null for those is what keeps the pre-seal behaviour intact instead of
 * refusing every historical session.
 *
 * `sourceSize` is a Prisma `BigInt`; the identity's size is a plain number
 * because that is what `headObject` returns and what `assertCompleteTransfer`
 * compares against. Media sizes are far below `Number.MAX_SAFE_INTEGER`
 * (2^53 ≈ 9 PB), so the narrowing is lossless for anything that could be fed.
 */
function sealedIdentity(row: {
	sourceEtag: string | null;
	sourceVersionId: string | null;
	sourceGeneration: string | null;
	sourceSize: bigint | null;
}): SourceIdentity | null {
	if (row.sourceSize === null) {
		return null;
	}
	return {
		...(row.sourceEtag !== null ? { etag: row.sourceEtag } : {}),
		...(row.sourceVersionId !== null ? { versionId: row.sourceVersionId } : {}),
		...(row.sourceGeneration !== null
			? { generation: row.sourceGeneration }
			: {}),
		size: Number(row.sourceSize),
	};
}

/**
 * the loop boundaries a previous owner already recorded.
 *
 * `appendBoundary` rewrites the WHOLE array (single writer, race-free), so a
 * taken-over session starting from an empty list would ERASE the loop ledger
 * that P4's live VMAF alignment reads. Anything not shaped like a boundary is
 * dropped rather than carried: the column is `Json`, and a value nobody can
 * interpret must not stop a push.
 */
function persistedBoundaries(value: unknown): LoopBoundary[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(entry): entry is LoopBoundary =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as LoopBoundary).loopIndex === "number" &&
			typeof (entry as LoopBoundary).wallClock === "string" &&
			typeof (entry as LoopBoundary).streamTimeSec === "number",
	);
}

/** Stop arrived between stages (before/while no ffmpeg was running). */
class FeederStopError extends Error {
	constructor() {
		super("Feeder stop requested");
		this.name = "FeederStopError";
	}
}

/**
 * a HELD session let go of its staged source without ever being
 * asked to push — its schedule row ended (cancelled, missed, refused) or no
 * commit arrived inside the hold window. Not a stop (nobody asked) and not a
 * failure of the feed (nothing was fed): the row lands STOPPED with the
 * reason in `error`, so the operator can read why a staged session stood
 * down on its own.
 */
class FeederReleasedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "FeederReleasedError";
	}
}

/** Per-run controller: carries the stop intent across lifecycle stages. */
class RunController {
	stopRequested = false;
	/**
	 * this run was superseded — another worker holds the lease now.
	 *
	 * A SEPARATE flag from `stopRequested` because the two demand opposite
	 * endings, the distinction #216's `ProvisionLeaseLostError` draws. A stop
	 * means the session is over and the row must say so; a lost lease means the
	 * session is FINE and somebody else owns it, so every terminal write, every
	 * notification and every schedule outcome this run would produce is aimed
	 * at another worker's healthy row.
	 */
	leaseLost = false;
	private supervisor: FeederSupervisor | undefined;
	private readonly aborter = new AbortController();

	/** Aborts in-flight stage work (the spool download) on stop. */
	get signal(): AbortSignal {
		return this.aborter.signal;
	}

	attach(supervisor: FeederSupervisor): void {
		this.supervisor = supervisor;
		if (this.stopRequested) {
			supervisor.requestStop();
		}
	}

	requestStop(): void {
		this.stopRequested = true;
		this.aborter.abort();
		this.supervisor?.requestStop();
	}

	/**
	 * Lease lost: tear the push down like a stop (the ffmpeg must not keep
	 * pushing beside the new owner's), and remember WHY so the run lands
	 * nothing on a row it no longer owns.
	 */
	requestTakeover(): void {
		this.leaseLost = true;
		this.requestStop();
	}

	throwIfStopped(): void {
		if (this.stopRequested) {
			throw new FeederStopError();
		}
	}
}

type FeederSessionRow = NonNullable<
	Awaited<ReturnType<AppPrismaClient["feederSession"]["findUnique"]>>
>;

export function createFeederProcessor(deps: FeederDeps) {
	const registry = new Map<string, RunController>();
	/**
	 * sessions this process resumed through `takeOverStale`.
	 *
	 * They run with NO BullMQ job — the job that started them died with the
	 * worker that held it — so `worker.close` cannot wait for them the way it
	 * waits for a start job. Graceful shutdown drains this set instead, or a
	 * rolling deploy would re-orphan exactly the pushes it had just rescued.
	 */
	const takeovers = new Set<Promise<unknown>>();
	const pollIntervalMs = deps.channelPollIntervalMs ?? CHANNEL_POLL_INTERVAL_MS;
	const waitTimeoutMs = deps.channelWaitTimeoutMs ?? CHANNEL_WAIT_TIMEOUT_MS;
	const commitPollMs = deps.commitPollIntervalMs ?? COMMIT_POLL_INTERVAL_MS;
	const predecessorGoneTimeoutMs =
		deps.predecessorGoneTimeoutMs ?? PREDECESSOR_GONE_TIMEOUT_MS;
	const stageHoldTimeoutMs = deps.stageHoldTimeoutMs ?? STAGE_HOLD_TIMEOUT_MS;
	const boundaryCap = deps.loopBoundaryCap ?? LOOP_BOUNDARY_CAP;
	const defaultFetchSource = createDefaultFetchSource(deps.spoolDir);

	/**
	 * Verified kill ladder (shared with the boot reconciler): existence probe
	 * → SIGTERM → grace-window polling → SIGKILL → re-poll. TRUE only when
	 * the pid is provably gone — an unkillable D-state pid returns false and
	 * the caller must not stamp proof it does not have.
	 */
	const terminateOrphanPid = createKillLadder({
		killPid: deps.killPid,
		sleep: deps.sleep,
		killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS,
	});

	/**
	 * What a stop is allowed to CLAIM about the pid a row records.
	 *
	 * - `gone`      — proven absent: the ladder verified it, or the number is
	 *                 now worn by an unrelated process (which proves OUR
	 *                 ffmpeg ended, since a pid is the identity).
	 * - `unverified`— we signalled and could not prove absence (SIGKILL did
	 *                 not take, or nothing to signal with).
	 * - `not-ours`  — we never signalled: the pid belongs to another host.
	 *                 Marking such a row stopped would be a lie about a
	 *                 process still pushing somewhere else.
	 */
	type ReclaimOutcome =
		| { kind: "gone"; note: string }
		| { kind: "unverified"; note: string }
		| { kind: "not-ours"; note: string };

	/** Existence probe (signal 0 throws ESRCH when the pid is gone). */
	function pidIsAlive(pid: number): boolean {
		if (!deps.killPid) {
			return true;
		}
		try {
			deps.killPid(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async function reclaimRecordedProcess(
		feederSessionId: string,
		pid: number,
		ownerHost: string | null,
		/**
		 * : `requireIdentity` switches this ladder from the
		 * OPERATOR-ISSUED polarity to the UNBIDDEN one, the same split
		 * `reconcile-orphans.ts` argues for. A stop was asked for by a person,
		 * so an unreadable command line still acts on the recorded pid. A
		 * takeover was asked for by a timer, so an unreadable command line is
		 * NO INFORMATION and must not become a second pusher — the ladder
		 * refuses instead, and the session stays with its old owner until an
		 * operator stops it.
		 */
		opts?: { requireIdentity?: boolean },
	): Promise<ReclaimOutcome> {
		// A pid is only a number outside the host that minted it. `null` is
		// pre-column history, read as "the single-worker assumption held" —
		// which is what those rows were written under.
		if (ownerHost !== null && ownerHost !== deps.hostname) {
			return {
				kind: "not-ours",
				note: `the recorded ffmpeg pid ${pid} was spawned on host ${ownerHost}; this worker (${deps.hostname}) cannot signal it — stop the session from that host, or confirm the process is gone there`,
			};
		}
		if (!deps.killPid) {
			return {
				kind: "unverified",
				note: `this worker cannot signal processes, so ffmpeg pid ${pid} was left alone`,
			};
		}
		// Pid-reuse veto. The command line is matched in memory and dropped:
		// it carries the push URL, and an RTMP push URL carries the stream key.
		const command = deps.readProcessCommand
			? await deps.readProcessCommand(pid).catch(() => null)
			: null;
		if (command !== null && !looksLikeFeederFfmpeg(command, feederSessionId)) {
			return {
				kind: "gone",
				note: `pid ${pid} now belongs to an unrelated process — this session's ffmpeg had already exited; nothing was signalled`,
			};
		}
		if (opts?.requireIdentity && command === null) {
			// Absence is itself proof, and it is the common case after a host
			// reboot — so probe BEFORE refusing, or every session whose owner
			// died with its machine would be unresumable.
			if (!pidIsAlive(pid)) {
				return {
					kind: "gone",
					note: `ffmpeg pid ${pid} was already gone when this worker took the session over`,
				};
			}
			return {
				kind: "unverified",
				note: `pid ${pid} is alive but its command line could not be read — it was NOT signalled; stop the session to act on it`,
			};
		}
		const verified = await terminateOrphanPid(pid);
		return verified
			? { kind: "gone", note: `ffmpeg pid ${pid} was signalled and is gone` }
			: {
					kind: "unverified",
					note: `ffmpeg pid ${pid} was still alive after SIGKILL — it was NOT confirmed gone`,
				};
	}

	/**
	 * Appends a reclaim note to the row's error text without stacking copies:
	 * a stop can be retried, and an unbounded column is its own defect.
	 *
	 *  (S1): `existing` is always null or a prior English note here —
	 * NEVER a structured `{code, params}` payload. Those are written only by
	 * `markTerminal`, which sets a TERMINAL status and nulls the lease, while
	 * every reclaim path acts on ACTIVE rows. If a future writer ever stores a
	 * structured error on an active row, this ` — <note>` append would corrupt
	 * it into unparseable JSON — parse and re-serialize (or note-on-a-side-field)
	 * before appending then.
	 */
	function withReclaimNote(existing: string | null, note: string): string {
		if (existing === null || existing.length === 0) {
			return redactSecrets(note);
		}
		return existing.includes(note)
			? existing
			: redactSecrets(`${existing} — ${note}`);
	}

	/**
	 * Lifecycle coupling: the feeder starts pushing only once its channel
	 * reaches RUNNING. CREATED/PROVISIONING are en-route (allowlist mindset
	 * — AWAIT_LIVE_RUNNING precedent); any other status fails fast instead
	 * of pushing at a stopping/stopped ingest.
	 */
	async function waitForChannelRunning(
		liveChannelId: string,
		controller: RunController,
	): Promise<void> {
		const startedAt = Date.now();
		for (;;) {
			controller.throwIfStopped();
			const channel = await deps.prisma.liveChannel.findUnique({
				where: { id: liveChannelId },
				select: { status: true },
			});
			if (!channel) {
				throw new Error("Live channel no longer exists");
			}
			if (channel.status === "RUNNING") {
				return;
			}
			if (channel.status !== "CREATED" && channel.status !== "PROVISIONING") {
				throw new Error(
					`Live channel is ${channel.status} — the feeder only pushes into a RUNNING channel`,
				);
			}
			if (Date.now() - startedAt > waitTimeoutMs) {
				throw new Error(
					`Live channel did not reach RUNNING within ${waitTimeoutMs}ms`,
				);
			}
			await deps.sleep(pollIntervalMs);
		}
	}

	/**
	 * a fenced write matched nothing at a phase boundary. Either a
	 * stop landed on the row (from this registry, or STOPPED written by a
	 * registry-miss stop on another worker) or the lease was taken. The two
	 * demand opposite endings — a stop must land STOPPED, a lost lease must
	 * write NOTHING — so the row is re-read to tell them apart before the
	 * ordinary catch decides. Returns the error to throw.
	 */
	async function lostFence(
		feederSessionId: string,
		controller: RunController,
	): Promise<Error> {
		if (controller.stopRequested) {
			return new FeederStopError();
		}
		const current = await deps.prisma.feederSession.findUnique({
			where: { id: feederSessionId },
			select: { status: true, ownerId: true },
		});
		if (
			current &&
			current.ownerId === deps.ownerId &&
			(current.status === "STOPPED" || current.status === "ERROR")
		) {
			// Still ours, already terminal: a stop got there first.
			controller.requestStop();
			return new FeederStopError();
		}
		controller.requestTakeover();
		return new FeederStopError();
	}

	/**
	 *  — the HOLD. Re-reads the row until the commit is requested,
	 * and stands down on the three things that mean it never will be: the
	 * lease moved (another owner re-stages), a stop landed, or the schedule
	 * row that armed this session ended without firing. The hold timeout is
	 * the backstop for a sweep that stopped ticking; it is measured from the
	 * planned commit instant, not from now, so a session staged early does
	 * not time out early.
	 */
	async function awaitCommitRequest(
		feederSessionId: string,
		commitAt: Date,
		fence: OwnerFence,
		controller: RunController,
	): Promise<Date> {
		for (;;) {
			controller.throwIfStopped();
			const current = await deps.prisma.feederSession.findUnique({
				where: { id: feederSessionId },
				select: {
					status: true,
					ownerId: true,
					ownerGeneration: true,
					commitRequestedAt: true,
				},
			});
			if (
				!current ||
				current.ownerId !== fence.ownerId ||
				current.ownerGeneration !== fence.ownerGeneration
			) {
				controller.requestTakeover();
				throw new FeederStopError();
			}
			if (current.status !== "DOWNLOADING") {
				// A registry-miss stop on another worker lands STOPPED on a
				// held row directly (it has no pid to signal).
				controller.requestStop();
				throw new FeederStopError();
			}
			if (current.commitRequestedAt !== null) {
				return current.commitRequestedAt;
			}
			const schedule = await deps.prisma.liveSchedule.findFirst({
				where: { feederSessionId },
				select: { status: true },
			});
			if (
				schedule &&
				schedule.status !== "ARMED" &&
				schedule.status !== "FIRED"
			) {
				throw new FeederReleasedError(
					`released without pushing: the schedule row that armed this session is ${schedule.status}, so the switch will not be committed`,
				);
			}
			if (Date.parse(deps.now()) - commitAt.getTime() > stageHoldTimeoutMs) {
				throw new FeederReleasedError(
					`released without pushing: no commit arrived within ${stageHoldTimeoutMs}ms of the planned commit instant ${commitAt.toISOString()}`,
				);
			}
			await deps.sleep(commitPollMs);
		}
	}

	/**
	 *  — the BARRIER. Stops every other session on the channel that
	 * may still hold a process (active, or terminal with an unproven pid —
	 * the same population `stopChannel` stops), then waits until none is
	 * left, and reports the instant the last one was proven gone. The stop
	 * is issued in-process rather than through the queue: a queue hop on the
	 * seam is unmeasured dead air, and `stop` already runs the registry
	 * signal or the verified kill ladder exactly as the queued job would.
	 * A session that ENTERS the population during the wait — a competing
	 * switch whose commit CAS just took the channel's claim, a CREATED row
	 * whose start job just claimed it — is stopped when it appears (rev367
	 * S-4): the stop set is re-derived on every poll, never computed once.
	 *
	 * EXCLUDED by construction (rev367 I-1, sharpened by LC-02): a two-phase
	 * session on this channel that has NOT committed — staged, holding, or
	 * with its commit requested but not yet taken. It cannot spawn before its
	 * own commit CAS, holds no claim and no pid until then, and stopping it
	 * would cancel the programme it is holding for: two switches armed 90 s
	 * apart had the first commit STOP the second's staged source, and the
	 * second then refused at its fire time as "not staged". Two switches whose
	 * commits are requested at once are decided by the publisher index inside
	 * their commit CAS (exactly one claim lands; the other is refused), not by
	 * each barrier stopping the other — which could stop both and leave the
	 * ingest dark. Once a switch has committed it holds the claim and enters
	 * this population on the next poll, like any other publisher.
	 *
	 * A predecessor that is not gone by the timeout — a pid on another host
	 * this worker cannot signal, a process that survived SIGKILL — is a
	 * refusal, never a wait-and-hope: the throw lands this session ERROR
	 * through the ordinary catch (schedule FAILED, FEEDER_ERROR emitted).
	 * The refusal text says what is actually known (rev367 I-4): the
	 * predecessors were ASKED to stop — a cross-host stop retires the row
	 * and revokes its owner (review-365 I-4), so by now the old push may
	 * already be gone without anything here able to prove it — and the
	 * ingest is NOT confirmed fed either way. Dead air over overlap.
	 */
	async function awaitPredecessorsGone(
		row: { id: string; liveChannelId: string },
		controller: RunController,
	): Promise<{ predecessorGoneAt: Date | null; predecessorIds: string[] }> {
		// the population is the channel's OCCUPANCY — a
		// held publisher claim, a process nobody has proven gone, or an active
		// single-phase session — read from the ONE fragment both admission
		// doors count, so the barrier and the doors cannot disagree about who
		// holds the ingest. An uncommitted two-phase session is excluded by the
		// fragment itself (rev367 I-1, see the docblock): it cannot spawn before
		// its own commit CAS and holds no claim until then.
		const mayHoldIngest = {
			...feederOccupancyWhere(row.liveChannelId),
			id: { not: row.id },
		};
		const stopped = new Set<string>();
		const everSeen = new Set<string>();
		const startedMs = Date.now();
		for (;;) {
			controller.throwIfStopped();
			const alive = await deps.prisma.feederSession.findMany({
				where: mayHoldIngest,
				select: { id: true, status: true, pid: true, ownerHost: true },
			});
			for (const session of alive) {
				everSeen.add(session.id);
			}
			// rev367 S-4: stop ARRIVALS too, not only the first snapshot.
			for (const session of alive) {
				if (!stopped.has(session.id)) {
					stopped.add(session.id);
					await stop(session.id);
				}
			}
			if (alive.length === 0) {
				break;
			}
			if (Date.now() - startedMs > predecessorGoneTimeoutMs) {
				const named = alive
					.map((session) => {
						const pid =
							session.pid === null
								? ""
								: session.ownerHost !== null &&
										session.ownerHost !== deps.hostname
									? `, pid ${session.pid} on host ${session.ownerHost} — unverified from this worker, confirm it there`
									: `, pid ${session.pid} on this host`;
						return `${session.id} (${session.status}${pid})`;
					})
					.join("; ");
				throw new Error(
					`predecessor feeder session(s) ${named} were asked to stop but not confirmed gone within ${predecessorGoneTimeoutMs}ms — refusing to spawn a second push at the same ingest (dead air is preferred over overlap); the ingest is NOT confirmed fed`,
				);
			}
			await deps.sleep(commitPollMs);
		}
		if (everSeen.size === 0) {
			return { predecessorGoneAt: null, predecessorIds: [] };
		}
		const gone = await deps.prisma.feederSession.findMany({
			where: { id: { in: [...everSeen] } },
			select: { processGoneAt: true, stoppedAt: true },
		});
		let latest: Date | null = null;
		for (const session of gone) {
			const at = session.processGoneAt ?? session.stoppedAt;
			if (at && (latest === null || at.getTime() > latest.getTime())) {
				latest = at;
			}
		}
		return {
			predecessorGoneAt: latest ?? new Date(deps.now()),
			predecessorIds: [...everSeen],
		};
	}

	/**
	 * Builds the FeederTarget, resolving the SRT passphrase from the vault
	 * at spawn time only (DRM S1–S5 pattern: provider-type gate + no
	 * empty-string fallback — an empty passphrase fails open).
	 */
	async function resolveTarget(
		row: FeederSessionRow,
	): Promise<{ target: FeederTarget; secrets: (string | undefined)[] }> {
		if (row.protocol === "RTMP") {
			const t = feederRtmpTargetSchema.parse(row.target);
			return {
				target: { protocol: "RTMP", url: t.url, streamKey: t.streamKey },
				secrets: [t.streamKey],
			};
		}
		const t = feederSrtTargetSchema.parse(row.target);
		let passphrase: string | undefined;
		if (t.passphraseCredentialId !== undefined) {
			const cred = await deps.resolveCredential(t.passphraseCredentialId);
			if (cred.provider !== "SRT_PASSPHRASE") {
				throw new Error(
					`feeder session needs an SRT_PASSPHRASE credential but got provider "${cred.provider}"`,
				);
			}
			passphrase = cred.secret.passphrase;
			if (!passphrase) {
				throw new Error("SRT_PASSPHRASE credential carries no passphrase");
			}
		}
		return {
			target: {
				protocol: "SRT_CALLER",
				host: t.host,
				port: t.port,
				passphrase,
			},
			secrets: [passphrase],
		};
	}

	/**
	 * The FENCE : the `where` every write this run makes must carry.
	 *
	 * `(id, ownerId, ownerGeneration)` — the PAIR is the token and the
	 * timestamp is the payload, which is the one place this lease is simpler
	 * than #216's. There the token WAS `provisionClaimedAt`, so two renewals in
	 * flight raced each other into a false "lease lost" and needed a mutex.
	 * Here a renewal does not move the token at all: concurrent renewals are
	 * idempotent, and the token moves only when someone TAKES the session,
	 * which is exactly when this process must stop.
	 */
	type OwnerFence = {
		id: string;
		ownerId: string;
		ownerGeneration: number;
	};

	function ownerFence(feederSessionId: string, generation: number): OwnerFence {
		return {
			id: feederSessionId,
			ownerId: deps.ownerId,
			ownerGeneration: generation,
		};
	}

	/**
	 * `evidence` is what THIS run can prove at its end:
	 * `childReaped` — the supervisor observed the exit of every child it
	 * spawned (`run` resolves only after the exit event), which is the
	 * owning supervisor's positive process-gone proof and stamps
	 * `processGoneAt` so a clean stop no longer reads like a lost pointer
	 * (audit §6.4); `releaseClaim` — this run held the publisher claim, which
	 * that same proof releases. A claimed run that never reached spawn has the
	 * other positive proof: no process was created, so it releases the claim
	 * without fabricating `processGoneAt`.
	 */
	async function markTerminal(
		fence: OwnerFence,
		liveChannelId: string,
		status: "STOPPED" | "ERROR",
		error?: string,
		evidence?: {
			childReaped: boolean;
			releaseClaim: boolean;
			claimGeneration: number | null;
		},
	): Promise<void> {
		const at = new Date(deps.now());
		const releaseClaimGeneration =
			evidence?.releaseClaim === true ? evidence.claimGeneration : null;
		const { count } = await deps.prisma.feederSession.updateMany({
			where: {
				...fence,
				// An owner-fence alone identifies the run, but the release belongs
				// to one exact publisher claim. Never let a late postmortem release
				// a newer incarnation on the same row.
				...(releaseClaimGeneration !== null
					? { publisherGeneration: releaseClaimGeneration }
					: {}),
			},
			data: {
				status,
				// The supervisor has already reaped its child by the time this
				// runs, so the pid reference goes with the row's active life —
				// and the host identity goes with the pid (they are one fact).
				pid: null,
				ownerHost: null,
				// : the lease goes with them. A terminal row has no
				// owner, and a lease left behind would keep answering "a live
				// worker holds this" to the orphan sweep and the dead-job
				// handler beside it. The GENERATION stays — it only counts up,
				// so no superseded owner can ever match it again.
				ownerId: null,
				ownerLeaseAt: null,
				stoppedAt: at,
				error: error === undefined ? null : redactSecrets(error),
				// One instant for the stop and the proof, so a switch's seam is
				// measured from the same moment whichever column it reads.
				...(evidence?.childReaped ? { processGoneAt: at } : {}),
				...(releaseClaimGeneration !== null ? { publisherReleasedAt: at } : {}),
			},
		});
		if (count === 0) {
			// : another worker owns this session now. The outcome we
			// are holding describes a push that has been SUPERSEDED, so landing
			// it — and notifying about it, and writing its schedule outcome —
			// would bury a healthy session under its predecessor's postmortem.
			// #216's loser leaves the winner's row alone in exactly this shape.
			console.warn(
				`[feeder] session ${fence.id}: not writing ${status} — the owner lease was taken by another worker (generation ${fence.ownerGeneration} is no longer ours)`,
			);
			return;
		}
		if (status === "ERROR") {
			/**
			 * a SCHEDULED feed that failed must say so on its
			 * schedule row.
			 *
			 * Before this, the only writer of a feeder schedule's failure was the
			 * out-of-process dead-job handler, which fires when the JOB dies — so
			 * every ordinary feeder failure (source unreachable, ingest never
			 * bound, ffmpeg exhausted its restarts) left the row FIRED and green.
			 * This is the in-process half, and it is the common one. No-ops when
			 * the session was started by hand: nothing bound a row to it.
			 */
			await recordScheduleOutcomeBestEffort(
				deps.prisma,
				{ feederSessionId: fence.id },
				"FAILED",
				//  review: the schedule-outcome NOTE is rendered verbatim
				// (not through the panel's localizer), so it takes the default-locale
				// English sentence, never the `{code, params}` JSON. The DB `error`
				// column above keeps the structured value for the panels.
				redactSecrets(feederErrorEnglish(error ?? "feeder failed")),
				new Date(deps.now()),
				"EFFECT_FAILED",
			);
			// : the feeder's one terminal-error choke point. The
			// emitter is best-effort by contract — this cannot fail the run.
			await deps.emitEvent?.({
				kind: "FEEDER_ERROR",
				feederSessionId: fence.id,
				liveChannelId,
				//  review: the event reaches the Slack body (and other
				// locale-less consumers) verbatim, so it carries the English
				// sentence, never the `{code, params}` JSON stored on the row.
				error: redactSecrets(feederErrorEnglish(error ?? "feeder failed")),
				path: `/live/${liveChannelId}`,
			});
		}
	}

	async function start(feederSessionId: string): Promise<string> {
		const row = await deps.prisma.feederSession.findUnique({
			where: { id: feederSessionId },
		});
		if (!row) {
			console.warn(`[feeder] session ${feederSessionId} not found — skipping`);
			return "MISSING";
		}
		// Atomic claim CREATED → DOWNLOADING — the transition is the lock
		// (live-channel pattern): a stale duplicate start matches zero rows
		// and skips instead of double-spawning ffmpeg.
		//
		// : the SAME write takes the owner lease, so a claimed session
		// is never momentarily ownerless. `ownerGeneration` joins the `where`
		// for the reason every CAS in this file has one — the generation this
		// claim writes must be one past the generation it READ, or a takeover
		// landing between the read and this write would be overwritten with a
		// stale number and two owners would share a token.
		const generation = row.ownerGeneration + 1;
		const { count } = await deps.prisma.feederSession.updateMany({
			where: {
				id: feederSessionId,
				status: "CREATED",
				ownerGeneration: row.ownerGeneration,
			},
			data: {
				status: "DOWNLOADING",
				error: null,
				ownerId: deps.ownerId,
				ownerGeneration: generation,
				ownerLeaseAt: new Date(deps.now()),
			},
		});
		if (count === 0) {
			return row.status;
		}
		return runSession(row, generation);
	}

	/**
	 * One supervised push, from a CLAIMED row .
	 *
	 * Two callers reach it and they differ only in how the claim was won:
	 * `start` claims a CREATED session out of its BullMQ job, and
	 * `takeOverStale` claims a session whose owner stopped renewing. From
	 * here on the two are identical by construction — a takeover re-downloads
	 * the SEALED source , re-probes it and re-runs the ingest and
	 * compatibility gates (rows #46 / #239), because a resumed push is a new
	 * push at the wire and the encoder judges it as one.
	 */
	/**
	 * the CLAIM an ordinary (single-phase) session takes
	 * just before it spawns, after every gate has passed. Two steps, both
	 * refusals rather than waits (the doors already refused an occupied
	 * channel; reaching here occupied means a race, or a row written by a
	 * door that predates the claim):
	 *
	 * 1. the OCCUPANCY read — any other row that holds a claim, may still own
	 * a process, or is an active uncoordinated session. This is the half
	 * the index cannot see: a may-be-alive row from before the claim
	 * existed holds no claim, and spawning beside it is exactly the finding;
	 * 2. the CLAIM itself — one fenced compare-and-swap that the partial unique
	 * index turns into a P2002 when another row on the channel already holds
	 * the slot. The generation bump makes a re-claim (a takeover's resumed
	 * push) distinguishable from the claim it replaces; `processGoneAt` is
	 * cleared because the claim is for a NEW process (a stale proof on the
	 * row described its predecessor, the rev367 I-4 rule `setPushing` also
	 * applies).
	 *
	 * Either refusal lands the session ERROR through the ordinary catch — the
	 * schedule row reads FAILED with the holder named, FEEDER_ERROR is emitted —
	 * and nothing is spawned. Dead air over overlap.
	 */
	async function assertNoUnprovenPriorPublisher(
		feederSessionId: string,
	): Promise<void> {
		const current = await deps.prisma.feederSession.findUnique({
			where: { id: feederSessionId },
			select: {
				startedAt: true,
				processGoneAt: true,
				publisherClaimedAt: true,
				publisherReleasedAt: true,
				publisherGeneration: true,
			},
		});
		if (
			current?.processGoneAt === null &&
			(current.startedAt !== null ||
				(current.publisherClaimedAt !== null &&
					current.publisherReleasedAt === null))
		) {
			const held = feederPublisherClaimHeld(current) ? "held " : "";
			throw new Error(
				`this session's prior publisher ${held}claim generation ${current.publisherGeneration} is not proven gone — refusing to overwrite it and spawn another process; establish processGoneAt first`,
			);
		}
	}

	async function claimPublisherBeforeSpawn(
		fence: OwnerFence,
		liveChannelId: string,
		controller: RunController,
	): Promise<void> {
		await assertNoUnprovenPriorPublisher(fence.id);
		// This ordinary row is already counted by core's active-uncoordinated
		// arm, so claiming changes its identity but does not add occupancy. More
		// than the cap means a racing/direct admission got through the soft doors.
		const globalOccupancies = await deps.prisma.feederSession.count({
			where: feederOccupancyWhere(),
		});
		if (globalOccupancies > FEEDER_MAX_ACTIVE_SESSIONS) {
			throw new Error(
				`Feeder publisher occupancy limit reached (${globalOccupancies}/${FEEDER_MAX_ACTIVE_SESSIONS}) before spawn`,
			);
		}
		const occupants = await deps.prisma.feederSession.findMany({
			where: { ...feederOccupancyWhere(liveChannelId), id: { not: fence.id } },
			select: { id: true, status: true, pid: true, ownerHost: true },
			take: 5,
		});
		if (occupants.length > 0) {
			throw new Error(publisherSlotHeldMessage(occupants));
		}
		try {
			const { count } = await deps.prisma.feederSession.updateMany({
				where: { ...fence, status: "DOWNLOADING" },
				data: {
					publisherClaimedAt: new Date(deps.now()),
					publisherReleasedAt: null,
					publisherGeneration: { increment: 1 },
					processGoneAt: null,
				},
			});
			if (count === 0) {
				throw await lostFence(fence.id, controller);
			}
		} catch (err) {
			if (isPublisherClaimViolation(err)) {
				throw new Error(
					publisherSlotHeldMessage(await claimHolders(liveChannelId, fence.id)),
				);
			}
			throw err;
		}
	}

	/** The rows holding the channel's claim right now, for the refusal text. */
	async function claimHolders(
		liveChannelId: string,
		selfId: string,
	): Promise<
		{
			id: string;
			status: string;
			pid: number | null;
			ownerHost: string | null;
		}[]
	> {
		return await deps.prisma.feederSession.findMany({
			where: {
				liveChannelId,
				id: { not: selfId },
				...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
			},
			select: { id: true, status: true, pid: true, ownerHost: true },
			take: 5,
		});
	}

	function publisherSlotHeldMessage(
		holders: {
			id: string;
			status: string;
			pid: number | null;
			ownerHost: string | null;
		}[],
	): string {
		const named =
			holders.length === 0
				? "another session that took it between admission and this spawn"
				: holders
						.map((holder) => {
							const pid =
								holder.pid === null
									? ""
									: holder.ownerHost !== null &&
											holder.ownerHost !== deps.hostname
										? `, pid ${holder.pid} on host ${holder.ownerHost} — unverified from this worker, confirm it there`
										: `, pid ${holder.pid} on this host`;
							return `${holder.id} (${holder.status}${pid})`;
						})
						.join("; ");
		return `the channel's publisher slot is held by feeder session ${named} — refusing to spawn a second push at the same ingest (dead air is preferred over overlap); stop that session, or prove its process gone from the host that owns it, then create a new session or stage a switch`;
	}

	/**
	 * The switch commit point also takes the CLAIM:
	 * ONE transaction releases every predecessor already proven gone that
	 * still holds a claim (a legacy shape — every claim-aware proof writer
	 * releases in its own write, so this is the guarded safety net, never the
	 * mechanism) and takes the successor's publisher claim TOGETHER with
	 * `committedAt`, so the spawn that follows rests on a claim the DB
	 * accepted. The barrier has already waited for every occupant — held
	 * claims included — to leave the channel, so a P2002 here is a race with
	 * another switch's commit: the loser is refused, never queued.
	 */
	async function commitAndClaimPublisher(
		fence: OwnerFence,
		liveChannelId: string,
		predecessorIds: string[],
		predecessorGoneAt: Date | null,
		at: Date,
	): Promise<number> {
		await assertNoUnprovenPriorPublisher(fence.id);
		// A staged switch is deliberately not occupancy. Its claim would add one,
		// so a full global population refuses here, at the effect boundary, even
		// if a soft admission check raced earlier.
		const globalOccupancies = await deps.prisma.feederSession.count({
			where: feederOccupancyWhere(),
		});
		if (globalOccupancies >= FEEDER_MAX_ACTIVE_SESSIONS) {
			throw new Error(
				`Feeder publisher occupancy limit reached (${globalOccupancies}/${FEEDER_MAX_ACTIVE_SESSIONS}) at switch commit`,
			);
		}
		const releaseProvenPredecessors = deps.prisma.feederSession.updateMany({
			where: {
				id: { in: predecessorIds },
				liveChannelId,
				...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
				processGoneAt: { not: null },
			},
			data: { publisherReleasedAt: at },
		});
		const commitAndClaim = deps.prisma.feederSession.updateMany({
			where: {
				...fence,
				status: "DOWNLOADING",
				readyAt: { not: null },
				committedAt: null,
			},
			data: {
				committedAt: at,
				...(predecessorGoneAt ? { predecessorGoneAt } : {}),
				publisherClaimedAt: at,
				publisherReleasedAt: null,
				publisherGeneration: { increment: 1 },
				processGoneAt: null,
			},
		});
		try {
			const [, committed] = await deps.prisma.$transaction([
				releaseProvenPredecessors,
				commitAndClaim,
			]);
			return committed.count;
		} catch (err) {
			if (isPublisherClaimViolation(err)) {
				throw new Error(
					publisherSlotHeldMessage(await claimHolders(liveChannelId, fence.id)),
				);
			}
			throw err;
		}
	}

	async function runSession(
		row: FeederSessionRow,
		generation: number,
	): Promise<string> {
		const feederSessionId = row.id;
		const fence = ownerFence(feederSessionId, generation);
		/**
		 * The pid THIS run last spawned (rev367 I-4's residual fix): when the
		 * run ends because the lease was lost, the supervisor has already
		 * reaped that child, and the row — which a cross-host stop or a
		 * takeover may now own — still points at it. The proof write below is
		 * what lets a switch on another host complete instead of timing out on
		 * a pid nobody could verify. Hoisted above the try (LC-02) because
		 * the lease-lost proof uses it when the OS exposes one. Spawn occurrence
		 * is tracked separately because a real child may have no numeric pid;
		 * either way, supervisor settlement proves every spawned child exited.
		 */
		let lastSpawnedPid: number | null = null;
		/** `setPushing` is called only after spawn, even when the OS exposes no pid. */
		let publisherSpawnOccurred = false;
		/** LC-02: did THIS run take the publisher claim (so its proof releases it)? */
		let claimedPublisher = false;
		/**
		 * The exact CLAIM incarnation this run took. PID and host do not identify
		 * it: a same-host successor can receive the same numeric pid before this
		 * supervisor observes its old child's exit. The monotonic generation is
		 * the release fence that keeps that late proof on its own claim.
		 */
		let claimedPublisherGeneration: number | null = null;
		const terminalEvidence = () => ({
			// `supervisor.run` settles only after every spawned child exits. If
			// no spawn occurred, releasing is still safe but no process-gone stamp
			// is fabricated: the proof is "there never was a process".
			childReaped: publisherSpawnOccurred,
			releaseClaim: claimedPublisher,
			claimGeneration: claimedPublisherGeneration,
		});

		async function assertPublisherEffectBoundary(): Promise<void> {
			if (claimedPublisherGeneration === null) {
				controller.requestTakeover();
				throw new FeederStopError();
			}
			const exactClaims = await deps.prisma.feederSession.count({
				where: {
					...fence,
					...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
					publisherGeneration: claimedPublisherGeneration,
				},
			});
			if (exactClaims !== 1) {
				throw await lostFence(feederSessionId, controller);
			}
		}

		/**
		 * Release THIS run's claim when its final effect-boundary check proves it
		 * lost the lease before `runner.spawn` was called. That ordering is
		 * positive proof that no publisher process ever existed for the claim, so
		 * the claim may be released without inventing a `processGoneAt` timestamp.
		 * The claim generation is the release fence: a successor that claimed the
		 * same row after revoking this owner is a different incarnation and cannot
		 * be released by this write.
		 */
		async function releaseClaimAfterNoSpawn(): Promise<void> {
			if (
				!claimedPublisher ||
				publisherSpawnOccurred ||
				claimedPublisherGeneration === null
			) {
				return;
			}
			await deps.prisma.feederSession
				.updateMany({
					where: {
						id: feederSessionId,
						...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
						publisherGeneration: claimedPublisherGeneration,
					},
					data: { publisherReleasedAt: new Date(deps.now()) },
				})
				.catch(() => {});
		}

		/**
		 * Compare the probed source against the channel plan's ingest positions.
		 *
		 * Reads the plan fresh rather than threading it down: the check is a
		 * preflight, and a channel whose plan cannot be read is not a reason to
		 * refuse a push — an unreadable or unparseable plan yields `ok` and the
		 * session proceeds exactly as it did before this existed.
		 */
		async function checkChannelIngest(
			liveChannelId: string,
			probe: ProbeResult,
		): Promise<{ ok: true } | { ok: false; reason: string }> {
			const channel = await deps.prisma.liveChannel.findUnique({
				where: { id: liveChannelId },
				select: { plan: true },
			});
			const plan = channel?.plan as
				| {
						ingest?: { key: string; position: number }[];
						renditions?: { ingestKey?: string; codec?: string }[];
				  }
				| null
				| undefined;
			if (!plan?.ingest?.length || !plan.renditions?.length) {
				return { ok: true };
			}
			return checkSourceSatisfiesIngest(
				probe,
				expectedIngestMedia(plan.ingest, plan.renditions),
			);
		}

		/**
		 * What this RUN is already ingesting, if anything .
		 *
		 * Two instruments, in order of what they can prove:
		 *  1. `LiveChannelRun.ingestMedia` — the attributes the first feeder of
		 *     this run actually put on the wire, recorded below. ffprobe-derived,
		 *     so it carries profile, level and pixel format.
		 *  2. the run's last heartbeat — Bitmovin's own report of the bound
		 *     input. Narrower (resolution, frame rate, channel count) but it is
		 *     the ONLY reference for a channel fed by an external contribution,
		 *     which is most of the slate insertion product.
		 *
		 * Run-first with NO channel fallback when the session names a run
		 * (review-243 R1): a run's silence means "no proof for THIS run", never
		 * the previous airing's final sample. A session with no run id — a
		 * manual feeder against a channel that has never run — reads the channel
		 * column, which is the only thing it could mean.
		 *
		 * Freshness is deliberately NOT checked. A live encoding binds its input
		 * format for the whole encoding, so the last sample speaks for the bind
		 * even when the ingest has since disconnected — which is exactly the
		 * moment a switch is preparing its replacement push.
		 */
		async function loadIngestReference(row: {
			liveChannelId: string;
			liveChannelRunId: string | null;
		}): Promise<{
			media: MediaAttributes;
			originKind: FeederErrorOriginKind;
		} | null> {
			// : `originKind` is a STABLE discriminant, not the English
			// phrase it used to be ("the source this run started on" / "the
			// encoder's last heartbeat") — the phrase moved into the catalogue
			// (`feederError.origin.*`) so the refusal sentence localizes.
			if (row.liveChannelRunId !== null) {
				const run = await deps.prisma.liveChannelRun.findUnique({
					where: { id: row.liveChannelRunId },
					select: { ingestMedia: true, lastHeartbeat: true },
				});
				const recorded = parseMediaAttributes(run?.ingestMedia);
				if (recorded) {
					return { media: recorded, originKind: "runSource" };
				}
				const beat = heartbeatIngestMedia(run?.lastHeartbeat);
				return beat ? { media: beat, originKind: "heartbeat" } : null;
			}
			const channel = await deps.prisma.liveChannel.findUnique({
				where: { id: row.liveChannelId },
				select: { lastHeartbeat: true },
			});
			const beat = heartbeatIngestMedia(channel?.lastHeartbeat);
			return beat ? { media: beat, originKind: "heartbeat" } : null;
		}

		const controller = new RunController();
		registry.set(feederSessionId, controller);
		/**
		 * hold the lease for as long as this process supervises the
		 * push. On a TICKER rather than at the stage seams, for the reason #216
		 * learned the hard way — a push spends hours inside one `await`, and a
		 * lease that only renews between stages expires under a perfectly
		 * healthy worker.
		 *
		 * A renewal that THROWS is not a lost lease: a database blip must not
		 * hand a live push to a takeover. Only a CAS that matched ZERO rows is,
		 * because that is somebody else's generation on the row.
		 *
		 * SELF-FENCING (review-365 I-3) is what keeps that tolerance from
		 * becoming a dual push. Tolerating failed renewals forever is only safe
		 * while nobody else can take the session; the cross-host takeover this
		 * row added is exactly somebody else, and it does NOT kill first — it
		 * cannot signal a pid on another machine. So a worker that is alive and
		 * pushing but unable to reach Postgres for longer than the takeover
		 * window is, from every other worker's point of view, gone: B claims at
		 * 90s, spawns its own ffmpeg, and both push until A's next SUCCESSFUL
		 * renewal — which may be minutes away, or never.
		 *
		 * The standard lease semantics close it: a holder that has not
		 * CONFIRMED its lease for longer than the takeover window must assume
		 * it no longer holds one, and stop. `lastRenewedOkMs` is that
		 * confirmation — the last tick whose compare-and-swap actually landed —
		 * and the check uses the SAME constant a takeover uses, so the owner
		 * only ever stands down once a takeover is already legal. Blips shorter
		 * than the window keep pushing exactly as before.
		 *
		 * THE COST, stated rather than hidden: on a SINGLE-worker install,
		 * where no takeover could ever happen, a database outage longer than
		 * the window now tears the push down instead of riding it out. That is
		 * the price of not being able to tell "nobody else is running" from
		 * "I cannot see anybody else". The window is a named constant, so an
		 * operator who knows their deployment is single-worker can raise it.
		 */
		let lastRenewedOkMs = Date.parse(deps.now());
		const leaseTicker = setInterval(() => {
			if (controller.leaseLost) {
				return;
			}
			const tickMs = Date.parse(deps.now());
			// A clock we cannot read is NO INFORMATION, not a stale lease.
			if (
				Number.isFinite(tickMs) &&
				Number.isFinite(lastRenewedOkMs) &&
				tickMs - lastRenewedOkMs > FEEDER_LEASE_TAKEOVER_MS
			) {
				console.warn(
					`[feeder] session ${feederSessionId}: the owner lease has not been renewed for over ${FEEDER_LEASE_TAKEOVER_MS}ms — another worker may already have taken this session; stopping this push`,
				);
				controller.requestTakeover();
				return;
			}
			void deps.prisma.feederSession
				.updateMany({
					where: fence,
					data: { ownerLeaseAt: new Date(deps.now()) },
				})
				.then(({ count }) => {
					if (count === 0) {
						console.warn(
							`[feeder] session ${feederSessionId}: owner lease lost to another worker — stopping this push`,
						);
						controller.requestTakeover();
						return;
					}
					// The tick's OWN timestamp, not a fresh read: the write
					// landed at some moment at or after it, so this is the
					// conservative half of the interval and self-fencing errs
					// early rather than late.
					lastRenewedOkMs = tickMs;
				})
				.catch(() => {});
		}, deps.leaseRenewalIntervalMs ?? FEEDER_LEASE_RENEWAL_MS);
		leaseTicker.unref?.();

		/**
		 * Prove this owner generation still controls the session, then bind the
		 * ingest effect to the session's exact run and that run's exact encoding.
		 * Only a fresh provider RUNNING observation passes.
		 */
		async function assertProviderEffectBoundary(effect: string): Promise<void> {
			controller.throwIfStopped();
			const checkedAt = new Date(deps.now());
			const held = await deps.prisma.feederSession.findUnique({
				where: { id: feederSessionId },
				select: {
					liveChannelRunId: true,
					ownerId: true,
					ownerGeneration: true,
					status: true,
				},
			});
			if (
				!held ||
				held.liveChannelRunId !== row.liveChannelRunId ||
				held.ownerId !== fence.ownerId ||
				held.ownerGeneration !== fence.ownerGeneration ||
				(held.status !== "DOWNLOADING" && held.status !== "PUSHING")
			) {
				throw await lostFence(feederSessionId, controller);
			}

			const [sessionRun, currentRun, channel] = await Promise.all([
				row.liveChannelRunId === null
					? Promise.resolve(null)
					: deps.prisma.liveChannelRun.findUnique({
							where: { id: row.liveChannelRunId },
							select: { bitmovinEncodingId: true },
						}),
				deps.prisma.liveChannelRun.findFirst({
					where: { liveChannelId: row.liveChannelId },
					orderBy: { seq: "desc" },
					select: {
						id: true,
						bitmovinEncodingId: true,
						providerStatus: true,
						providerStatusObservedAt: true,
						providerUnknownSince: true,
						providerTerminalAt: true,
					},
				}),
				deps.prisma.liveChannel.findUnique({
					where: { id: row.liveChannelId },
					select: { status: true, bitmovinEncodingId: true },
				}),
			]);
			const identityRefusal = providerEffectIdentityRefusal({
				expectedRunId: row.liveChannelRunId,
				expectedEncodingId: sessionRun?.bitmovinEncodingId ?? null,
				currentRunId: currentRun?.id ?? null,
				currentEncodingId: currentRun?.bitmovinEncodingId ?? null,
			});
			const channelRefusal =
				channel?.status !== "RUNNING"
					? `the live channel is not RUNNING (${channel?.status ?? "missing"})`
					: channel.bitmovinEncodingId !== currentRun?.bitmovinEncodingId
						? "the channel encoding no longer matches the current live run"
						: null;
			const lifecycleRefusal = providerEffectRefusal(
				deriveProviderLifecycle(currentRun, checkedAt.getTime()),
			);
			const refusal = identityRefusal ?? channelRefusal ?? lifecycleRefusal;
			if (refusal) {
				throw new Error(`${effect} refused: ${refusal}`);
			}
		}

		let activeEffectClaim: LiveEffectClaimHandle | null = null;
		let crossedEffectBoundary = false;
		const effectNow = (): Date => {
			const parsed = new Date(deps.now());
			return Number.isFinite(parsed.getTime()) ? parsed : new Date();
		};

		async function acquireSpawnClaim(
			spawnOrdinal: number,
		): Promise<LiveEffectClaimHandle> {
			if (activeEffectClaim) return activeEffectClaim;
			const handed = await loadLiveEffectTargetClaim(deps.prisma, {
				liveChannelId: row.liveChannelId,
				targetId: feederSessionId,
				now: effectNow(),
			});
			if (handed.kind === "DISPATCHING") {
				activeEffectClaim = handed.claim;
				return handed.claim;
			}
			if (handed.kind === "BLOCKED") {
				throw new Error(
					`Feeder spawn refused: durable effect ${handed.claimId} is ${handed.state}; ${handed.reason}`,
				);
			}

			const [channel, currentRun] = await Promise.all([
				deps.prisma.liveChannel.findUnique({
					where: { id: row.liveChannelId },
					select: {
						status: true,
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
				currentRun?.bitmovinEncodingId ?? channel?.bitmovinEncodingId;
			if (
				!channel ||
				!currentRun ||
				row.liveChannelRunId === null ||
				currentRun.id !== row.liveChannelRunId ||
				!providerEncodingId
			) {
				throw new Error(
					"Feeder spawn refused: the session has no exact current run/provider identity",
				);
			}
			const begun = await beginLiveEffect(deps.prisma, {
				idempotencyKey: `feeder-spawn:${feederSessionId}:${fence.ownerGeneration}:${spawnOrdinal}`,
				liveChannelId: row.liveChannelId,
				liveChannelRunId: currentRun.id,
				providerEncodingId,
				expectedFenceVersion: channel.liveEffectFenceVersion,
				action: "FEEDER_SPAWN",
				targetId: feederSessionId,
				ownerId: `${deps.ownerId}:spawn:${fence.ownerGeneration}`,
				now: effectNow(),
				expiresAt: new Date(effectNow().getTime() + 20 * 60_000),
				allowedChannelStatuses: ["RUNNING"],
			});
			if (begun.kind !== "EXECUTE") {
				throw new Error(
					`Feeder spawn refused: durable effect claim is ${begun.kind}${"reason" in begun ? ` (${begun.reason})` : ""}`,
				);
			}
			activeEffectClaim = begun.claim;
			return begun.claim;
		}

		async function crossSpawnBoundary(
			spawnOrdinal: number,
			label: string,
		): Promise<void> {
			const claim = await acquireSpawnClaim(spawnOrdinal);
			if (!(await assertLiveEffectCurrent(deps.prisma, claim, effectNow()))) {
				await markLiveEffectFailed(
					deps.prisma,
					claim,
					`${label} lost its exact run/generation fence before spawn`,
				);
				throw new Error(
					`${label} refused: the exact run/generation fence is no longer current`,
				);
			}
			// This is set immediately before predecessor-stop dispatch or spawn.
			// From here a thrown response is uncertain and cannot be retried blind.
			crossedEffectBoundary = true;
		}

		async function settleOpenEffectFailure(reason: string): Promise<void> {
			let claim = activeEffectClaim;
			if (!claim) {
				const handed = await loadLiveEffectTargetClaim(deps.prisma, {
					liveChannelId: row.liveChannelId,
					targetId: feederSessionId,
					now: effectNow(),
				});
				if (handed.kind === "DISPATCHING") claim = handed.claim;
			}
			if (!claim) return;
			if (crossedEffectBoundary) {
				await markLiveEffectAmbiguous(
					deps.prisma,
					claim,
					`${reason}; the feeder effect crossed its stop/spawn boundary, so operator resolution is required`,
				);
			} else {
				await markLiveEffectFailed(deps.prisma, claim, reason);
			}
		}
		try {
			await waitForChannelRunning(row.liveChannelId, controller);

			const credential = await deps.resolveCredential(row.sourceCredentialId);
			const sealed = sealedIdentity(row);
			const fetch = deps.fetchSource ?? defaultFetchSource;
			let fetched: FetchedSource;
			try {
				// The controller's signal cancels the in-flight transfer when a
				// stop lands during DOWNLOADING (fetch-source removes partials).
				fetched = await fetch({
					sessionId: feederSessionId,
					credential,
					bucket: row.sourceBucket,
					key: row.sourceKey,
					signal: controller.signal,
					// : DEMAND the version this session was armed
					// against. Absent on rows written before the seal existed
					// and on drivers with no `headObject` — "nothing to demand"
					// is the pre-seal behaviour, named. A mismatch throws and
					// lands the session ERROR through the ordinary catch, which
					// is also what writes the schedule outcome FAILED and emits
					// FEEDER_ERROR (`markTerminal`).
					...(sealed ? { expect: sealed } : {}),
				});
			} catch (err) {
				// An abort-induced failure is a clean stop, not an error.
				controller.throwIfStopped();
				throw err;
			}
			try {
				controller.throwIfStopped();

				// : what actually arrived, for the audit trail. Written
				// before ffprobe so the record survives a source that downloads
				// cleanly and then fails every later gate.
				await deps.prisma.feederSession.updateMany({
					where: fence,
					data: { sourceSha256: fetched.sha256 },
				});

				const probeRun = await deps.runner.run(
					deps.ffprobePath,
					probeArgs(fetched.path),
				);
				if (probeRun.code !== 0) {
					throw new Error(
						`ffprobe failed (code ${probeRun.code}): ${probeRun.stderr.trim().split("\n").at(-1) ?? "no output"}`,
					);
				}
				const probe = parseProbeJson(probeRun.stdout);

				// : refuse a source that cannot satisfy the channel's
				// declared ingest BEFORE spawning ffmpeg. Pushing a video-only
				// source at a channel expecting audio at stream 1 completed the
				// RTMP handshake, reported PUSHING, and published nothing — the
				// failure was invisible at every layer that had a status.
				const ingestCheck = await checkChannelIngest(row.liveChannelId, probe);
				if (!ingestCheck.ok) {
					// : store the refusal STRUCTURED (code + the problem
					// detail as a param) so the panel translates the wrapper
					// sentence; `ingestCheck.reason` is the dynamic detail only.
					throw new Error(
						feederError("ingestUnsatisfied", { detail: ingestCheck.reason }),
					);
				}

				// review-227 I3: the decision needs the OUTPUT protocol — the
				// >2ch refusal is FLV-scoped (MPEG-TS carries 5.1 natively),
				// so the target resolves first.
				const { target, secrets } = await resolveTarget(row);
				const reference = await loadIngestReference(row);
				//  (PR-C): every pushed source is NORMALIZED first — one
				// transcode into a CFR, pts-0, co-terminous loop that the encoder
				// sees exactly as the VMAF side models it (`loopProfile`). The push
				// itself then runs in copy mode against that loop. The normalizer is
				// the transcode, so the reference targets are computed for it.
				const normalise = reference
					? normalisationTargets(reference.media, "transcode", target.protocol)
					: undefined;
				// The compatibility gate judges what the normalizer WILL push — the
				// transcode's prediction pinned to the reference — before any
				// transcoding is spent; an attribute the normalizer cannot pin (an
				// unpinnable profile) is refused here exactly as before.
				if (reference) {
					const compatibility = compareSourceCompatibility(
						reference.media,
						pushedMediaAttributes(
							sourceMediaAttributes(probe),
							{ mode: "transcode", reasons: ["normalized loop"] },
							target.protocol,
							normalise,
						),
						"transcode",
						normalise,
					);
					if (!compatibility.compatible) {
						throw new Error(
							feederError(
								"sourceMismatch",
								{ originKind: reference.originKind },
								compatibility.differences,
							),
						);
					}
				}
				const loopFps = normalise?.frameRate ?? DEFAULT_LOOP_FPS;
				const span = sourceVideoSpan(probe);
				const loopPath = normalizedSpoolPath(deps.spoolDir, feederSessionId);
				// rev429 R1: the transcode can run for minutes on a long source;
				// a STOP (or a lost lease) aborts it through the controller's
				// signal instead of waiting for ffmpeg to finish, and the
				// `throwIfStopped` below turns the aborted exit into a clean STOP.
				const normalizeRun = await deps.runner.run(
					deps.ffmpegPath,
					buildNormalizeCommand({
						sourcePath: fetched.path,
						destPath: loopPath,
						fps: loopFps,
						protocol: target.protocol,
						...(normalise ? { normalise } : {}),
						videoStartSec: span.videoStartSec,
						videoDurationSec: span.videoDurationSec,
					}),
					{ signal: controller.signal },
				);
				controller.throwIfStopped();
				if (normalizeRun.code !== 0) {
					throw new Error(
						`normalizing the source loop failed (code ${normalizeRun.code}): ${normalizeRun.stderr.trim().split("\n").at(-1) ?? "no output"}`,
					);
				}
				const loopProbeRun = await deps.runner.run(
					deps.ffprobePath,
					probeArgs(loopPath),
				);
				if (loopProbeRun.code !== 0) {
					throw new Error(
						`ffprobe failed on the normalized loop (code ${loopProbeRun.code}): ${loopProbeRun.stderr.trim().split("\n").at(-1) ?? "no output"}`,
					);
				}
				const loopProbe = parseProbeJson(loopProbeRun.stdout);
				const nowMs = Date.parse(deps.now());
				const loopProfile = loopProfileFromProbe(
					loopProbe,
					loopFps,
					fetched.sha256,
					new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
					normalise,
				);
				// A takeover (#242) re-stages on another worker: the encoder is
				// bound to the period the first owner pushed, so a loop that does
				// not reproduce it is refused rather than pushed.
				const priorProfile = loopProfileSchema.safeParse(row.loopProfile);
				if (
					priorProfile.success &&
					(priorProfile.data.frames !== loopProfile.frames ||
						priorProfile.data.fps !== loopProfile.fps)
				) {
					throw new Error(
						`the normalized loop (${loopProfile.frames} frames at ${loopProfile.fps} fps) does not reproduce the profile this session already pushed (${priorProfile.data.frames} at ${priorProfile.data.fps})`,
					);
				}
				await deps.prisma.feederSession.updateMany({
					where: fence,
					data: {
						loopProfile: loopProfile as unknown as Prisma.InputJsonValue,
					},
				});
				const decision = decideCodecMode(loopProbe, target.protocol);
				if (decision.mode !== "copy") {
					throw new Error(
						`the normalized loop is not copy-compatible with the ${target.protocol} push: ${decision.reasons.join("; ")}`,
					);
				}
				// What the encoder sees is the loop itself — recorded as the run's
				// ingest reference from the loop's own probe.
				const sourceAttributes = sourceMediaAttributes(loopProbe);
				const { argv, redactedArgv } = buildFeederCommand({
					sourcePath: loopPath,
					decision,
					target,
				});

				let seamBase: Date | null = null;
				let attemptEvidenceNotBefore: Date | null = null;
				const commitAt = row.commitAt ?? null;
				if (commitAt !== null) {
					const readyAt = new Date(deps.now());
					const ready = await deps.prisma.feederSession.updateMany({
						where: { ...fence, status: "DOWNLOADING" },
						data: { readyAt },
					});
					if (ready.count === 0) {
						throw await lostFence(feederSessionId, controller);
					}
					// The RECORD on the schedule row — write-once, so a takeover's
					// re-staging keeps the first time the switch became ready.
					await deps.prisma.liveSchedule.updateMany({
						where: { feederSessionId, readyAt: null },
						data: { readyAt },
					});
					const commitRequestedAt = await awaitCommitRequest(
						row.id,
						commitAt,
						fence,
						controller,
					);
					// Commit is the point after which predecessors are stopped. Refuse
					// before touching them unless this exact session generation is still
					// attached to its exact fresh-RUNNING provider run.
					await assertProviderEffectBoundary("Feeder switch commit");
					await crossSpawnBoundary(0, "Feeder switch commit");
					const gone = await awaitPredecessorsGone(row, controller);
					seamBase = gone.predecessorGoneAt ?? commitRequestedAt;
					// A stop or a lost lease that landed during the predecessor
					// wait ends the run here, before the commit is even attempted
					// — an owner that cannot prove its lease must not commit.
					controller.throwIfStopped();
					// THE COMMIT POINT, which is also the CLAIM (LC-02). Fenced on
					// the pair that staged the source, so a superseded holder that
					// wakes up to the same request matches nothing here and spawns
					// nothing; and a second switch committing at the same instant
					// loses on the publisher index and is refused, not queued.
					const committedAt = new Date(deps.now());
					const committedCount = await commitAndClaimPublisher(
						fence,
						row.liveChannelId,
						gone.predecessorIds,
						gone.predecessorGoneAt,
						committedAt,
					);
					if (committedCount === 0) {
						throw await lostFence(feederSessionId, controller);
					}
					claimedPublisher = true;
					claimedPublisherGeneration = row.publisherGeneration + 1;
					attemptEvidenceNotBefore = committedAt;
				} else {
					// LC-02: an ordinary session claims the channel's publisher
					// slot HERE — after every gate, before the spawn — or is
					// refused. Nothing below runs without a claim the DB accepted.
					await claimPublisherBeforeSpawn(fence, row.liveChannelId, controller);
					claimedPublisher = true;
					claimedPublisherGeneration = row.publisherGeneration + 1;
				}
				// Record what the encoder will bind to, ONCE per run: the first
				// push defines the format every later one has to match, and a
				// switch must never redefine the reference it was just checked
				// against.
				//
				// The lock is `ingestMediaRecordedAt`, NOT the Json column it
				// guards.  (PR #349) measured `{ equals: Prisma.DbNull }`
				// matching NOTHING against a SQL-NULL Json column in the
				// deployed bundled image, while the same predicate matched from
				// a plain process — the sentinel is an object identity, and an
				// identity does not survive every build. This worker is not
				// bundled today, but the failure mode if it ever is would be
				// SILENT: zero rows matched reads exactly like "someone else
				// won the race", so the reference would simply never be
				// recorded and the gate would stand down forever on a channel
				// it was built to protect. A DateTime `null` filter is an
				// ordinary IS NULL that no bundler can reinterpret. Both
				// columns are written in ONE update, so they cannot disagree.
				if (row.liveChannelRunId !== null) {
					await deps.prisma.liveChannelRun.updateMany({
						where: {
							id: row.liveChannelRunId,
							ingestMediaRecordedAt: null,
						},
						data: {
							ingestMedia: pushedMediaAttributes(
								sourceAttributes,
								decision,
								target.protocol,
							) as unknown as Prisma.InputJsonValue,
							ingestMediaRecordedAt: new Date(deps.now()),
						},
					});
				}

				// : a takeover RESUMES the session, so it inherits the
				// boundaries the previous owner recorded — `appendBoundary`
				// rewrites the whole array, so starting empty would erase them
				// — and its loop numbering continues past the highest one, so
				// the array stays strictly increasing across the handover.
				const boundaries: LoopBoundary[] = persistedBoundaries(
					row.loopBoundaries,
				);
				const baseLoopIndex = boundaries.reduce(
					(highest, boundary) => Math.max(highest, boundary.loopIndex + 1),
					0,
				);
				let droppedBoundaries = 0;
				// has THIS session already recorded the
				// provider-confirmed ingest? A once-per-session latch so a
				// restart's re-probe does not re-issue the (idempotent) write.
				let ingestConfirmed = false;
				const attemptSchedule = await deps.prisma.liveSchedule.findFirst({
					where: { feederSessionId },
					orderBy: { createdAt: "desc" },
					select: { id: true },
				});
				const supervisor = createFeederSupervisor({
					runner: deps.runner,
					ffmpegPath: deps.ffmpegPath,
					argv,
					baseLoopIndex,
					redactedArgv: [
						`[codec ${decision.mode}: ${decision.reasons.join("; ")}]`,
						...redactedArgv,
					],
					redactLine: buildLineRedactor(secrets),
					sourceDurationSec: loopProfile.loopSeconds,
					now: deps.now,
					sleep: deps.sleep,
					...(attemptEvidenceNotBefore
						? { bindEvidenceNotBefore: attemptEvidenceNotBefore.toISOString() }
						: {}),
					beforeSpawn: async (spawnOrdinal) => {
						await assertProviderEffectBoundary("Feeder process spawn");
						// Re-prove both the DB-enforced publisher slot and the exact
						// run-bound effect immediately before every initial spawn/respawn.
						await assertPublisherEffectBoundary();
						await crossSpawnBoundary(spawnOrdinal, "Feeder process spawn");
					},
					onSpawnError: async (error) => {
						if (!activeEffectClaim) return;
						await markLiveEffectAmbiguous(
							deps.prisma,
							activeEffectClaim,
							`ffmpeg spawn threw after durable dispatch: ${error instanceof Error ? error.message : String(error)}`,
						);
					},
					afterSpawnPersisted: async (persisted) => {
						if (!activeEffectClaim) return;
						if (!persisted) {
							await markLiveEffectAmbiguous(
								deps.prisma,
								activeEffectClaim,
								"ffmpeg exists but the exact feeder owner/pid write did not land",
							);
							controller.requestStop();
							return;
						}
						const acknowledged = await markLiveEffectAcked(
							deps.prisma,
							activeEffectClaim,
							effectNow(),
						);
						if (!acknowledged) {
							controller.requestStop();
							return;
						}
						activeEffectClaim = null;
						crossedEffectBoundary = false;
					},
					// #95 bind-watchdog probe: the channel's persisted heartbeat
					// is the encoder's own word on whether ANY input is bound —
					// a push the encoder never binds looks healthy from ffmpeg's
					// side forever (the 2026-08-15 incident).
					mayKeepPushing: async () => {
						const [held, sessionRun, channel] = await Promise.all([
							deps.prisma.feederSession.findUnique({
								where: { id: feederSessionId },
								select: {
									liveChannelRunId: true,
									ownerId: true,
									ownerGeneration: true,
									status: true,
								},
							}),
							row.liveChannelRunId === null
								? Promise.resolve(null)
								: deps.prisma.liveChannelRun.findUnique({
										where: { id: row.liveChannelRunId },
										select: {
											liveChannelId: true,
											bitmovinEncodingId: true,
											lastHeartbeat: true,
										},
									}),
							deps.prisma.liveChannel.findUnique({
								where: { id: row.liveChannelId },
								select: { status: true, bitmovinEncodingId: true },
							}),
						]);
						if (
							!held ||
							!sessionRun ||
							!channel ||
							held.liveChannelRunId !== row.liveChannelRunId ||
							held.ownerId !== fence.ownerId ||
							held.ownerGeneration !== fence.ownerGeneration ||
							(held.status !== "DOWNLOADING" && held.status !== "PUSHING") ||
							sessionRun.liveChannelId !== row.liveChannelId ||
							sessionRun.bitmovinEncodingId === null ||
							channel.status !== "RUNNING" ||
							channel.bitmovinEncodingId !== sessionRun.bitmovinEncodingId
						) {
							// This callback belongs to the old owner. Make the supervisor
							// converge immediately instead of waiting for the lease ticker;
							// UNKNOWN cannot accidentally satisfy the bind gate meanwhile.
							controller.requestTakeover();
							return {
								status: "UNKNOWN" as const,
								sampledAt: null,
								probeStartedAt: null,
							};
						}
						// Presence-level: a bound run's null means "no proof THIS run".
						// Never inherit a predecessor/successor or channel-level sample.
						const sample = sessionRun.lastHeartbeat;
						const nowMs = Date.parse(deps.now());
						const probeStartedAtMs = persistedHeartbeatAtMs(sample);
						const providerTimestamp = (
							sample as { raw?: { timestamp?: unknown } } | null
						)?.raw?.timestamp;
						const providerSampleAtMs =
							typeof providerTimestamp === "string"
								? Date.parse(providerTimestamp)
								: Number.NaN;
						return {
							status: mayKeepPushing(sample, nowMs),
							sampledAt: Number.isFinite(providerSampleAtMs)
								? new Date(providerSampleAtMs).toISOString()
								: null,
							probeStartedAt:
								probeStartedAtMs === null
									? null
									: new Date(probeStartedAtMs).toISOString(),
						};
					},
					maxRestarts: deps.maxRestarts,
					backoffBaseMs: deps.backoffBaseMs,
					backoffCapMs: deps.backoffCapMs,
					killGraceMs: deps.killGraceMs,
					bindTimeoutMs: deps.bindTimeoutMs,
					bindProbeIntervalMs: deps.bindProbeIntervalMs,
					maxBindKills: deps.maxBindKills,
					logTailSize: deps.logTailSize,
					logFlushEveryLines: deps.logFlushEveryLines,
					store: {
						beginAttempt: async ({ attemptNo, startedAt }) => {
							if (claimedPublisherGeneration === null) {
								throw new Error(
									"cannot record feeder attempt without a publisher claim",
								);
							}
							const created = await deps.prisma.feederPushAttempt.create({
								data: {
									liveScheduleId: attemptSchedule?.id ?? null,
									liveChannelRunId: row.liveChannelRunId,
									feederSessionId,
									ownerGeneration: generation,
									publisherGeneration: claimedPublisherGeneration,
									attemptNo,
									startedAt: new Date(startedAt),
									sanitizedTarget:
										redactedArgv.at(-1) ?? `[${target.protocol} target]`,
									codecDecision: {
										mode: decision.mode,
										reasons: decision.reasons,
										normalise: normalise ?? null,
									} as Prisma.InputJsonValue,
									sourceSha256: fetched.sha256,
								},
								select: { id: true },
							});
							return created.id;
						},
						attachAttemptProcess: async (attemptId, process) => {
							const attached = await deps.prisma.feederPushAttempt.updateMany({
								where: {
									id: attemptId,
									pid: null,
									processSpawnedAt: null,
									evidenceNotBefore: null,
									endedAt: null,
								},
								data: {
									pid: process.pid ?? null,
									processSpawnedAt: new Date(process.processSpawnedAt),
									evidenceNotBefore: new Date(process.evidenceNotBefore),
								},
							});
							if (attached.count !== 1) {
								throw new Error(`feeder attempt ${attemptId} no longer active`);
							}
						},
						recordAttemptObservation: async (
							attemptId,
							observation,
							accepted,
						) => {
							const observedAt = new Date(deps.now());
							const written = await deps.prisma.feederPushAttempt.updateMany({
								where: { id: attemptId, endedAt: null },
								data: {
									providerStatus: observation.status,
									providerSampleAt: observation.sampledAt
										? new Date(observation.sampledAt)
										: null,
									...(accepted ? { providerAcceptedAt: observedAt } : {}),
								},
							});
							if (written.count !== 1) {
								throw new Error(`feeder attempt ${attemptId} no longer active`);
							}
							if (accepted && !ingestConfirmed) {
								ingestConfirmed = true;
								await recordScheduleOutcomeBestEffort(
									deps.prisma,
									{ feederSessionId },
									"INGEST_CONNECTED",
									`feeder attempt ${attemptId} — provider CONNECTED evidence advanced across two post-spawn polls`,
									observedAt,
									"HEARTBEAT_INGEST_CONNECTED",
								);
							}
						},
						finishAttempt: async (attemptId, result) => {
							const finished = await deps.prisma.feederPushAttempt.updateMany({
								where: { id: attemptId, endedAt: null },
								data: {
									endedAt: new Date(result.endedAt),
									exitCode: result.code,
									exitSignal: result.signal,
								},
							});
							if (finished.count !== 1) {
								throw new Error(
									`feeder attempt ${attemptId} was not closed once`,
								);
							}
						},
						setPushing: async (pid) => {
							publisherSpawnOccurred = true;
							lastSpawnedPid = pid ?? null;
							// Guarded transition (lost-stop race): a registry-miss
							// stop can land STOPPED between the DOWNLOADING claim
							// and this first PUSHING flip — an unguarded update
							// would resurrect the row and push forever with the
							// stop already consumed. Zero matched rows means a
							// stop won; tear the fresh ffmpeg down instead.
							//
							//  adds the owner fence to the same `where`,
							// so zero rows now means "a stop won OR the lease was
							// taken" — and the response is right for both: stop
							// pushing. Which of the two it was is settled later by
							// `markTerminal`, whose own fence writes STOPPED for
							// the first and nothing at all for the second.
							const { count } = await deps.prisma.feederSession.updateMany({
								where: {
									...fence,
									status: { in: ["DOWNLOADING", "PUSHING"] },
									// LC-02: no pid is ever recorded on a row that holds
									// no publisher claim. A spawn that somehow reached
									// here unclaimed counts zero rows and is torn down
									// like a lost stop — the invariant, enforced at the
									// write that would otherwise put a second publisher
									// on the books.
									...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
								},
								data: {
									status: "PUSHING",
									pid: pid ?? null,
									// The host is written WITH the pid: a bare number is
									// only signallable where it was minted, and a later
									// stop (or the boot reconciler) has to know where
									// that was before it sends anything.
									ownerHost: pid == null ? null : deps.hostname,
									// A fresh pid is a fresh PROCESS: any gone-proof on
									// the row described its predecessor (a takeover's
									// ladder, or the revoked owner's own proof below)
									// and must not vouch for this one (rev367 I-4).
									processGoneAt: null,
								},
							});
							if (count === 0) {
								controller.requestStop();
								return false;
							}
							// startedAt = first push only; restarts keep the original.
							// : the SEAM rides the same first-push write —
							// this instant minus the last predecessor's gone instant —
							// and is mirrored onto the schedule row only when this
							// write was the one that stamped startedAt.
							const startedAt = new Date(deps.now());
							const seamMs =
								seamBase === null
									? null
									: Math.max(0, startedAt.getTime() - seamBase.getTime());
							const first = await deps.prisma.feederSession.updateMany({
								where: { ...fence, startedAt: null },
								data: {
									startedAt,
									...(seamMs === null ? {} : { switchSeamMs: seamMs }),
								},
							});
							if (first.count > 0 && seamMs !== null) {
								await deps.prisma.liveSchedule.updateMany({
									where: { feederSessionId, switchSeamMs: null },
									data: { switchSeamMs: seamMs },
								});
							}
							/**
							 * our ffmpeg is pushing
							 * bytes now — but that is NOT delivery. The paid run measured
							 * this write landing ~16s BEFORE the provider's first CONNECT
							 * and ~37s before its first persisted CONNECTED sample; a push
							 * whose DNS/TLS/RTMP bind fails looks identical from ffmpeg's
							 * side. So this records `PROCESS_PUSHING`, not `DELIVERED`.
							 * The row climbs to `INGEST_CONNECTED` only once the channel's
							 * own heartbeat says the provider bound the ingest (the
							 * bind-watchdog closure below), and to `FAILED` if the session
							 * dies first.
							 *
							 * Written on every push including restarts, and harmless
							 * there: PROCESS_PUSHING may replace only PENDING, so a restart
							 * cannot un-fail a FAILED row NOR drag an already
							 * INGEST_CONNECTED row back down, and it does not restamp a
							 * later `outcomeAt`.
							 */
							await recordScheduleOutcomeBestEffort(
								deps.prisma,
								{ feederSessionId },
								"PROCESS_PUSHING",
								`feeder session ${feederSessionId} started pushing to the channel ingest (provider not yet confirmed)`,
								new Date(deps.now()),
								"FEEDER_PROCESS_PUSHING",
							);
							return true;
						},
						appendBoundary: async (boundary) => {
							boundaries.push(boundary);
							// Cap the persisted window (most recent wins): every
							// append rewrites the full array, so unbounded growth
							// on a pathological ~1s-loop source means O(n²) write
							// traffic. Drops are worker-logged and ledgered.
							if (boundaries.length > boundaryCap) {
								const excess = boundaries.length - boundaryCap;
								boundaries.splice(0, excess);
								if (droppedBoundaries === 0) {
									console.warn(
										`[feeder] session ${feederSessionId}: loop-boundary cap (${boundaryCap}) reached — dropping oldest boundaries`,
									);
								}
								droppedBoundaries += excess;
							}
							// Single writer (this supervisor) — full-array write is
							// race-free and keeps the column valid JSON at all times.
							//  makes "single writer" true rather than
							// assumed: fenced on the lease, a superseded owner's
							// last flush cannot overwrite the new owner's array.
							await deps.prisma.feederSession.updateMany({
								where: fence,
								data: {
									loopBoundaries:
										boundaries as unknown as Prisma.InputJsonValue,
								},
							});
						},
						flushLogTail: async (lines) => {
							await deps.prisma.feederSession.updateMany({
								where: fence,
								data: { logTail: lines as unknown as Prisma.InputJsonValue },
							});
						},
					},
				});
				controller.attach(supervisor);
				controller.throwIfStopped();

				const result = await supervisor.run();
				const reapedAt = new Date(deps.now());
				if (controller.leaseLost) {
					// rev367 I-4 (the review's design option): the supervisor has
					// REAPED its child by here — `run` resolves only after the
					// exit event — so this process holds real proof the pid is
					// gone, and it is the only process that ever will: its own
					// fenced writes match nothing now, and the worker that
					// revoked it cannot signal a pid on this host. The proof is
					// a fact about the PROCESS, not ownership of the session, so
					// it does not use the (already lost) owner fence. It is guarded
					// on the exact claim generation plus the pid/host when present,
					// so it cannot erase a successor after pid reuse or overwrite a
					// newer ladder's stamp. This is what lets a cross-host switch's barrier
					// complete instead of refusing on a pid nobody could verify.
					if (publisherSpawnOccurred && claimedPublisherGeneration !== null) {
						await deps.prisma.feederSession
							.updateMany({
								where: {
									id: feederSessionId,
									OR:
										lastSpawnedPid === null
											? [{ pid: null }]
											: [
													{
														pid: lastSpawnedPid,
														ownerHost: deps.hostname,
													},
													// A storage/write failure may have lost the pointer.
													// The exact claim generation still binds this
													// supervisor's child-exit proof to its own claim.
													{ pid: null },
												],
									// rev367 re-review P2: the pid AND the host are one
									// fact (setPushing writes them together). A pod's
									// PID namespace starts at 1, so a cross-host takeover
									// that re-spawns can be handed the SAME numeric pid
									// on a DIFFERENT host — the pid guard alone then
									// matches the new owner's LIVE row and nulls a pushing
									// ffmpeg. The host pins the proof to the process this
									// run actually spawned: the row carries THIS host in
									// every case that reaches here (our own setPushing, a
									// not-ours stop, an unproven cross-host claim — all
									// keep it; a proven same-host claim already nulled the
									// pid and never reaches this write).
									processGoneAt: null,
									// LC-02: the pid/host tuple can be reused by a
									// newer spawn on this same row. Only the exact claim
									// incarnation whose child we reaped may be released.
									publisherClaimedAt: { not: null },
									publisherGeneration: claimedPublisherGeneration,
								},
								data: {
									pid: null,
									ownerHost: null,
									processGoneAt: reapedAt,
									// LC-02: the same proof releases the publisher claim
									// this run held — the owning supervisor observed its
									// child's exit, which is one of the three release
									// proofs and the only one a revoked owner can give.
									publisherReleasedAt: reapedAt,
								},
							})
							.catch(() => {});
					}
					return TAKEN_OVER;
				}
				await markTerminal(
					fence,
					row.liveChannelId,
					result.outcome,
					result.error,
					terminalEvidence(),
				);
				return result.outcome;
			} finally {
				await fetched.cleanup().catch(() => {});
				await rm(normalizedSpoolPath(deps.spoolDir, feederSessionId), {
					force: true,
				}).catch(() => {});
			}
		} catch (err) {
			// A remote stop can revoke the owner generation while leaving ownerId
			// unchanged, so `lostFence` correctly classifies the row as an already
			// terminal stop rather than a takeover. Claim cleanup cannot depend on
			// that classification: this run still has the stronger local fact that
			// its final effect-boundary check failed before it ever spawned.
			await releaseClaimAfterNoSpawn();
			const message = err instanceof Error ? err.message : "feeder failed";
			//  FIRST, because a takeover tears the push down THROUGH
			// the stop path — `requestTakeover` calls `requestStop`, so what
			// arrives here is usually a `FeederStopError`. Reading that as an
			// operator stop would land STOPPED on a row another worker is
			// actively pushing on.
			if (controller.leaseLost) {
				return TAKEN_OVER;
			}
			await settleOpenEffectFailure(message).catch((settleErr) => {
				console.error(
					`[feeder] session ${feederSessionId}: could not settle durable effect failure`,
					settleErr instanceof Error ? settleErr.message : settleErr,
				);
			});
			if (err instanceof FeederStopError) {
				// Stop during a pre-push stage is a clean stop, not a failure.
				await markTerminal(
					fence,
					row.liveChannelId,
					"STOPPED",
					undefined,
					terminalEvidence(),
				);
				return "STOPPED";
			}
			if (err instanceof FeederReleasedError) {
				// : a held source let go without a commit — STOPPED, with
				// the reason readable, and no FEEDER_ERROR (nothing was fed).
				await markTerminal(
					fence,
					row.liveChannelId,
					"STOPPED",
					err.message,
					terminalEvidence(),
				);
				return "STOPPED";
			}
			await markTerminal(
				fence,
				row.liveChannelId,
				"ERROR",
				message,
				terminalEvidence(),
			);
			throw err;
		} finally {
			clearInterval(leaseTicker);
			registry.delete(feederSessionId);
		}
	}

	/**
	 *  — the TAKEOVER sweep (audit 2026-08-29 HIGH-5).
	 *
	 * A feeder session whose owner stopped renewing is a live channel with no
	 * one feeding it. Before the lease there was nothing to notice that from
	 * another process: the supervisor registry is per-process, the BullMQ job
	 * state is the only other liveness signal, and the boot reconciler
	 *  can only act on pids MINTED ON ITS OWN
	 * HOST. So a rolling deploy, a crashed replica or a lost pod left the push
	 * unrecoverable except by hand — which is exactly the generalisation the
	 * audit refused to grant the single-worker current run.
	 *
	 * The population is NON-NULL stale leases only. A NULL lease is a session
	 * nobody has claimed yet — created by the route, its start job still in the
	 * queue — and racing that job to spawn ffmpeg would manufacture the double
	 * push this whole module exists to prevent. `provision-lease.ts` draws the
	 * identical line ("A PROVISIONING row with a NULL lease is deliberately out
	 * of scope").
	 *
	 * What happens to the OLD owner's ffmpeg decides whether the takeover is
	 * safe, and there are only two kinds of answer:
	 *
	 *  · SAME HOST — we can look. The reclaim ladder runs with
	 *    `requireIdentity`, so an alive pid whose command line cannot be read
	 *    is refused rather than killed, and a pid that survives SIGKILL is
	 *    refused too: a takeover we cannot prove is a second pusher, on the
	 *    one host where we could have known better.
	 *  · ANOTHER HOST — we cannot look, and the stale lease is the evidence we
	 *    have. We take it, we do NOT stamp `processGoneAt` (we proved nothing),
	 *    and the old `(host, pid)` goes into the row's note BEFORE `setPushing`
	 *    overwrites those columns — otherwise the takeover would erase the last
	 *    reference to a process that might still be pushing, which is
	 *    CRITICAL-2's end state reached by a new road.
	 *
	 * Bounded by `FEEDER_MAX_ACTIVE_SESSIONS` minus what this process already
	 * runs: a resumed session has no BullMQ slot to be admitted through, so
	 * without this a host that lost a sibling would take on every one of its
	 * sessions at once, on top of its own.
	 */
	async function takeOverStale(): Promise<string[]> {
		const nowMs = Date.parse(deps.now());
		if (!Number.isFinite(nowMs)) {
			return [];
		}
		const capacity = FEEDER_MAX_ACTIVE_SESSIONS - registry.size;
		if (capacity <= 0) {
			return [];
		}
		const rows = await deps.prisma.feederSession.findMany({
			where: {
				status: { in: [...ACTIVE_STATUSES] },
				...feederLeaseStaleWhere(nowMs),
			},
			// Oldest lease first: the session that has been unfed longest is
			// the one whose channel has been dark longest.
			orderBy: { ownerLeaseAt: "asc" },
			take: capacity,
		});
		const taken: string[] = [];
		for (const row of rows) {
			// Our OWN registry answers first. A row we are running whose lease
			// looks stale means our ticker is wedged, not that the push is
			// abandoned — resuming it here would have this process fight
			// itself.
			if (registry.has(row.id)) {
				continue;
			}
			const claimed = await claimStaleSession(row, new Date(nowMs));
			if (!claimed) {
				continue;
			}
			taken.push(row.id);
			const running: Promise<unknown> = runSession(
				claimed.row,
				claimed.generation,
			)
				.catch((err: unknown) => {
					// `runSession` has already landed the row ERROR and emitted
					// through `markTerminal`; there is no BullMQ failed handler
					// behind this call, so the rethrow would be an unhandled
					// rejection and nothing more.
					console.error(
						`[feeder] resumed session ${row.id} failed:`,
						err instanceof Error ? err.message : err,
					);
				})
				.finally(() => {
					takeovers.delete(running);
				});
			takeovers.add(running);
		}
		return taken;
	}

	/**
	 * Win one stale session, or decline it. Returns the re-read row and the
	 * generation this process now holds.
	 */
	async function claimStaleSession(
		row: { id: string } & Pick<
			FeederSessionRow,
			| "pid"
			| "ownerHost"
			| "ownerId"
			| "ownerGeneration"
			| "error"
			| "liveChannelId"
			| "processGoneAt"
			| "startedAt"
			| "publisherClaimedAt"
			| "publisherReleasedAt"
			| "publisherGeneration"
		>,
		now: Date,
	): Promise<{ row: FeederSessionRow; generation: number } | null> {
		const from = row.ownerId ?? "an unnamed owner";
		let note: string;
		let proven = false;
		if (row.pid === null) {
			// A null pointer is not proof. It is safe only when the row positively
			// says the old process is gone, when it never crossed either durable
			// spawn marker, or when a claim was positively released before the first
			// spawn (`publisherReleasedAt` with no `startedAt`). Losing the pid while
			// a held claim or a recorded start remains is exactly the false-open shape:
			// excluding self from the occupancy read would let this takeover
			// overwrite its own held claim and spawn beside an unknown old process.
			if (
				row.processGoneAt === null &&
				(row.startedAt !== null ||
					(row.publisherClaimedAt !== null && row.publisherReleasedAt === null))
			) {
				const claim = feederPublisherClaimHeld(row)
					? `publisher claim generation ${row.publisherGeneration} remains held`
					: row.publisherClaimedAt !== null
						? `publisher claim generation ${row.publisherGeneration} was recorded`
						: "a publisher start was recorded";
				const note = `refusing to resume from ${from}: ${claim}, but its pid pointer is missing and no processGoneAt proof says the old publisher stopped — refusing to add a second push at the same ingest (dead air over overlap); confirm the process is gone on its former host, then retry`;
				return await refuseUnprovenPublisherTakeover(row, now, note);
			}
			// Safe to resume: it never spawned ffmpeg, or its previous owner tore
			// down and PROVED the process gone. The revoked owner's lease-lost
			// path nulls the pid AND stamps `processGoneAt` in one write, so a
			// proven-gone cross-host push lands HERE rather than in the not-ours
			// branch below.
			note =
				row.processGoneAt !== null
					? `taken over from ${from} after its lease expired — its previous push was proven gone (processGoneAt ${row.processGoneAt.toISOString()})`
					: `taken over from ${from} after its lease expired; it had not spawned ffmpeg yet`;
		} else {
			const reclaim = await reclaimRecordedProcess(
				row.id,
				row.pid,
				row.ownerHost,
				{ requireIdentity: true },
			);
			if (reclaim.kind === "unverified") {
				console.warn(
					`[feeder] session ${row.id}: NOT taking over — ${reclaim.note}`,
				);
				return null;
			}
			if (reclaim.kind === "not-ours") {
				// BLOCKER-5: another host minted this
				// pid and NOTHING here can prove that push stopped. This branch
				// used to take the session over on a bare note — keeping the old
				// (host, pid) pointer and spawning a SECOND ffmpeg
				// (DOWNLOADING → push). A network-partitioned old owner still
				// pushing, plus this new push, is a dual publish at one ingest
				// (video jam + double billing). A replacement may spawn ONLY once
				// the old push is provably gone; the one cross-host proof — the
				// revoked owner stamping `processGoneAt`  — already
				// nulls the pid, so a proven-gone session took the `pid === null`
				// branch above. Reaching HERE with a live pid means no such proof,
				// so mirror #240's switch barrier: refuse, do not spawn.
				const note = `refusing to resume from ${from}: host ${row.ownerHost} recorded ffmpeg pid ${row.pid}, which ${deps.hostname} cannot prove has stopped — refusing to add a second push at the same ingest (dead air over overlap); stop the session from that host, or confirm the process is gone there`;
				return await refuseUnprovenPublisherTakeover(row, now, note);
			}
			// `gone`: the kill ladder verified the pid absent, or the number now
			// wears an unrelated process. `not-ours` returns first for any
			// cross-host pid, so this proof is same-host only — the #242 kill
			// ladder, unchanged.
			proven = true;
			note = `taken over from ${from} after its lease expired — ${reclaim.note}`;
		}
		const generation = row.ownerGeneration + 1;
		const { count } = await deps.prisma.feederSession.updateMany({
			where: {
				id: row.id,
				// The kill/absence proof describes this exact process tuple. A
				// still-running owner can respawn after the old child exits while
				// retaining both owner and publisher generations; without pid+host
				// this stale proof would clear and take over the replacement.
				pid: row.pid,
				ownerHost: row.ownerHost,
				processGoneAt: row.processGoneAt,
				// The exact token that was READ. A renewal by a live owner, or
				// another worker's takeover, moves it and this matches nothing —
				// #216's `reconcileAbandonedLeases` in one line.
				ownerId: row.ownerId,
				ownerGeneration: row.ownerGeneration,
				publisherGeneration: row.publisherGeneration,
				status: { in: [...ACTIVE_STATUSES] },
			},
			data: {
				ownerId: deps.ownerId,
				ownerGeneration: generation,
				ownerLeaseAt: now,
				// The row IS downloading again — the resumed run re-fetches the
				// sealed source before it can spawn anything, and a row reading
				// PUSHING while nothing pushes is the lie this whole audit
				// finding is about.
				status: "DOWNLOADING",
				// Two-phase switch: a resumed switch re-stages under the new
				// generation. The old owner's readiness and commit point
				// described a spool file that died with it; clearing both is
				// what lets the new owner's fenced commit CAS win, and what
				// stops a sweep from judging a source nobody holds as READY.
				readyAt: null,
				committedAt: null,
				error: withReclaimNote(row.error, note),
				// Proof, only where there is proof: a pid this worker verified
				// gone is released and stamped — and the publisher claim the
				// dead owner held goes with it (LC-02: a verified kill ladder is
				// a release proof; the resumed run re-claims before it spawns).
				// A pid on another host is neither, so the DELETE guard keeps
				// refusing the row until somebody accounts for it.
				...(proven
					? {
							pid: null,
							ownerHost: null,
							processGoneAt: now,
							publisherReleasedAt: now,
						}
					: {}),
			},
		});
		if (count === 0) {
			return null;
		}
		// RE-READ after winning (#216's lesson, measured there): the claim
		// above CHANGED the row, and everything the run needs — target, sealed
		// source, run id — must come from after the claim, not from the sweep's
		// snapshot.
		const claimedRow = await deps.prisma.feederSession.findUnique({
			where: { id: row.id },
		});
		if (!claimedRow) {
			return null;
		}
		console.warn(
			`[feeder] session ${row.id}: ${note} — resuming the push as ${deps.ownerId}`,
		);
		return { row: claimedRow, generation };
	}

	/**
	 * Decline a cross-host stale session whose old push cannot be proven gone
	 * Do NOT spawn a
	 * replacement — mirror #240's predecessor barrier and the stop `not-ours`
	 * arm: dead air over overlap.
	 *
	 * · REVOKE the old owner with a generation bump — NOT an ownership transfer
	 * (no `ownerId` of ours): its next fenced renewal then matches zero rows
	 * and it self-fences its own ffmpeg down. The exact-token
	 * `where` means an owner that just healed and renewed, or another worker
	 * that got there first, has already moved the token — this matches
	 * nothing and theirs stands.
	 * · KEEP pid/ownerHost (and stamp NO `processGoneAt`): this worker proved
	 * nothing, so `feederProcessMayBeAlive` stays true and DELETE keeps
	 * refusing the row until that host accounts for the process.
	 * · Land ERROR, not STOPPED — ERROR is the state that NOTIFIES (ledger
	 * #88), and an operator whose push could not be safely resumed must be
	 * told rather than left reading a green STOPPED.
	 *
	 * Returns null so `takeOverStale` records no takeover and spawns nothing.
	 */
	async function refuseUnprovenPublisherTakeover(
		row: { id: string; liveChannelId: string } & Pick<
			FeederSessionRow,
			| "pid"
			| "ownerHost"
			| "ownerId"
			| "ownerGeneration"
			| "publisherGeneration"
			| "error"
		>,
		now: Date,
		note: string,
	): Promise<null> {
		const error = withReclaimNote(row.error, note);
		const { count } = await deps.prisma.feederSession.updateMany({
			where: {
				id: row.id,
				// The exact token the sweep read. A live owner that renewed, or
				// another worker's claim/stop, has moved it — theirs stands.
				ownerId: row.ownerId,
				ownerGeneration: row.ownerGeneration,
				publisherGeneration: row.publisherGeneration,
				status: { in: [...ACTIVE_STATUSES] },
			},
			data: {
				status: "ERROR",
				// The fence: revoke the old owner. pid/ownerHost/processGoneAt are
				// deliberately left untouched — the process ledger keeps saying a
				// pid may be alive on that host.
				ownerGeneration: row.ownerGeneration + 1,
				stoppedAt: now,
				error,
			},
		});
		if (count === 0) {
			return null;
		}
		console.warn(`[feeder] session ${row.id}: ${note} — resuming refused`);
		// : a feeder that ends in ERROR notifies, whichever writer
		// lands it. Best-effort by contract — this never fails the sweep.
		await deps.emitEvent?.({
			kind: "FEEDER_ERROR",
			feederSessionId: row.id,
			liveChannelId: row.liveChannelId,
			error: redactSecrets(feederErrorEnglish(error)),
			path: `/live/${row.liveChannelId}`,
		});
		return null;
	}

	async function stop(feederSessionId: string): Promise<string> {
		const controller = registry.get(feederSessionId);
		// review-365 S-4: a controller that has already LOST its lease is not
		// this session's supervisor any more, it is a loser winding down. Its
		// registry entry lives until `runSession`'s `finally`, so a stop
		// arriving in that window would be consumed by the wrong process —
		// answered STOPPING while the NEW owner keeps pushing, with nothing
		// left to retry. Fall through to the database path, which acts on
		// whoever owns the row now.
		if (controller && !controller.leaseLost) {
			// The start job owns persistence: it lands on STOPPED when the
			// supervisor resolves (SIGTERM → grace → SIGKILL inside).
			controller.requestStop();
			return "STOPPING";
		}
		const row = await deps.prisma.feederSession.findUnique({
			where: { id: feederSessionId },
		});
		if (!row) {
			return "MISSING";
		}
		const terminal = row.status === "STOPPED" || row.status === "ERROR";
		if (terminal && !feederProcessMayBeAlive(row)) {
			// Idempotent: route+channel-coupling double stops land here, and
			// so does any terminal row whose pid was released or proven gone.
			//
			// LC-02: a claim that outlived its proof — `processGoneAt` stamped
			// by a writer that did not know about claims — is released on that
			// proof, so a channel is never wedged behind a process everyone
			// agrees is gone. Guarded on the proof; a claim with NO proof stays
			// (a pid-null row without proof is the lost-stop window, and its
			// owner releases it the moment it observes the exit).
			if (feederPublisherClaimHeld(row) && row.processGoneAt !== null) {
				await deps.prisma.feederSession.updateMany({
					where: {
						id: feederSessionId,
						...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
						processGoneAt: { not: null },
						publisherGeneration: row.publisherGeneration,
					},
					data: { publisherReleasedAt: new Date(deps.now()) },
				});
			}
			return row.status;
		}
		if (row.pid === null) {
			// Active row that never reached PUSHING: nothing to signal.
			const { count } = await deps.prisma.feederSession.updateMany({
				where: {
					id: feederSessionId,
					status: { in: [...ACTIVE_STATUSES] },
					ownerId: row.ownerId,
					ownerGeneration: row.ownerGeneration,
					publisherGeneration: row.publisherGeneration,
				},
				data: {
					status: "STOPPED",
					stoppedAt: new Date(deps.now()),
					// A registry-miss stop revokes an out-of-process owner even
					// before it records a pid. Its next fenced write then tears down
					// or refuses the spawn; a held claim remains until positive proof.
					ownerGeneration: { increment: 1 },
				},
			});
			if (count === 0) {
				return (
					(
						await deps.prisma.feederSession.findUnique({
							where: { id: feederSessionId },
						})
					)?.status ?? row.status
				);
			}
			return "STOPPED";
		}
		// Registry miss on a row that records a pid: either an active row
		// whose worker restarted, or (audit 2026-08-29 CRITICAL-2) a TERMINAL
		// row the dead-job handler left holding an unreclaimed pid. Both mean
		// the same thing on this host — a `-stream_loop -1` ffmpeg nobody is
		// supervising — and both get the VERIFIED kill ladder (probe →
		// SIGTERM → grace → SIGKILL, re-probing between rungs) before anything
		// is written: an unverified single SIGTERM could stamp "gone" while
		// the push keeps running.
		const reclaim = await reclaimRecordedProcess(
			feederSessionId,
			row.pid,
			row.ownerHost,
		);
		const goneAt = new Date(deps.now());
		if (terminal) {
			// A terminal row keeps its status — an ERROR run DID fail, and
			// rewriting that to STOPPED would erase the only record of it.
			// What changes is the process ledger: proof, then release.
			const { count } = await deps.prisma.feederSession.updateMany({
				where: {
					id: feederSessionId,
					pid: row.pid,
					ownerHost: row.ownerHost,
					processGoneAt: null,
					publisherGeneration: row.publisherGeneration,
				},
				data:
					reclaim.kind === "gone"
						? {
								pid: null,
								ownerHost: null,
								processGoneAt: goneAt,
								// LC-02: the verified ladder / ESRCH releases the claim.
								publisherReleasedAt: goneAt,
								error: withReclaimNote(row.error, reclaim.note),
							}
						: // Unproven: the pid STAYS, so DELETE keeps refusing the
							// row and the operator can retry the stop.
							{ error: withReclaimNote(row.error, reclaim.note) },
			});
			if (count === 0) {
				return (
					(
						await deps.prisma.feederSession.findUnique({
							where: { id: feederSessionId },
						})
					)?.status ?? row.status
				);
			}
			return row.status;
		}
		if (reclaim.kind === "not-ours") {
			/**
			 * Another host owns this push (review-365 I-4).
			 *
			 * This used to write a NOTE and nothing else, on the reasoning that
			 * "marking it STOPPED here would be a lie about a process still
			 * running there". True of the PROCESS — and it left the operator
			 * with no stop at all: the job completes, nothing retries, and with
			 * N replicas the queue hands the stop to a worker that is not the
			 * owner (N−1)/N of the time. A stop was silently a note.
			 *
			 * The lease is the lever that was missing. Bumping the generation
			 * REVOKES the owner's authority to write this row: its next renewal
			 * (≤ one renewal interval away) matches zero rows, it tears its
			 * ffmpeg down and returns TAKEN_OVER writing nothing. So STOPPED is
			 * true of the SESSION the moment this lands — nobody is authorised
			 * to push it any more — while the process ledger keeps saying what
			 * is actually known: `pid` and `ownerHost` STAY, so
			 * `feederProcessMayBeAlive` is still true and DELETE still refuses
			 * the row until that host proves the pid gone. That split (status =
			 * the session's life, pid/processGoneAt = the process) is the same
			 * one the `unverified` arm below already draws.
			 *
			 * The note stays too: it names the host to check.
			 */
			const { count } = await deps.prisma.feederSession.updateMany({
				where: {
					id: feederSessionId,
					status: { in: [...ACTIVE_STATUSES] },
					pid: row.pid,
					ownerHost: row.ownerHost,
					ownerId: row.ownerId,
					ownerGeneration: row.ownerGeneration,
					publisherGeneration: row.publisherGeneration,
				},
				data: {
					status: "STOPPED",
					stoppedAt: goneAt,
					// The fence, not a re-claim: no `ownerId`, because this
					// worker is not taking the session over — it is retiring it.
					// An increment (rather than a value) is what makes two stops
					// racing each other both correct.
					ownerGeneration: { increment: 1 },
					error: withReclaimNote(row.error, reclaim.note),
				},
			});
			if (count === 0) {
				// Someone else landed a terminal state first; theirs stands.
				return (
					(
						await deps.prisma.feederSession.findUnique({
							where: { id: feederSessionId },
						})
					)?.status ?? row.status
				);
			}
			return "STOPPED";
		}
		if (reclaim.kind === "unverified") {
			// Review HIGH: this arm used to fall through to the STOPPED write
			// below, releasing `pid` and `ownerHost` on a ladder that never
			// confirmed the process died. That reproduced CRITICAL-2's exact
			// end-state by a different trigger — `feederProcessMayBeAlive` went
			// false, DELETE became legal, and the boot sweep (which finds rows
			// by `pid IS NOT NULL`) could never see the pid again. The push
			// would have gone on billing with its last reference erased.
			//
			// So: keep the pid and its host, stamp no proof, and land the row
			// at ERROR rather than STOPPED. The operator asked for a stop and
			// did not get one; ERROR is the state that notifies, and this file
			// already holds that rule ("a feeder that ends in ERROR notifies,
			// whichever writer lands it").
			const error = withReclaimNote(row.error, reclaim.note);
			const { count } = await deps.prisma.feederSession.updateMany({
				where: {
					id: feederSessionId,
					status: { in: [...ACTIVE_STATUSES] },
					pid: row.pid,
					ownerHost: row.ownerHost,
					ownerId: row.ownerId,
					ownerGeneration: row.ownerGeneration,
					publisherGeneration: row.publisherGeneration,
				},
				data: { status: "ERROR", stoppedAt: goneAt, error },
			});
			if (count > 0) {
				// , same contract as markTerminal's ERROR branch: the
				// emitter is best-effort and never throws, so this cannot fail
				// the stop. A stop that could not confirm the kill is the most
				// urgent thing an operator can be told about this feature.
				await deps.emitEvent?.({
					kind: "FEEDER_ERROR",
					feederSessionId,
					liveChannelId: row.liveChannelId,
					error,
					path: `/live/${row.liveChannelId}`,
				});
			}
			if (count === 0) {
				return (
					(
						await deps.prisma.feederSession.findUnique({
							where: { id: feederSessionId },
						})
					)?.status ?? row.status
				);
			}
			return "ERROR";
		}
		const { count } = await deps.prisma.feederSession.updateMany({
			where: {
				id: feederSessionId,
				status: { in: [...ACTIVE_STATUSES] },
				pid: row.pid,
				ownerHost: row.ownerHost,
				ownerId: row.ownerId,
				ownerGeneration: row.ownerGeneration,
				publisherGeneration: row.publisherGeneration,
			},
			data: {
				// Verified gone: the ordinary clean-stop shape, with proof — and
				// the proof releases the publisher claim (LC-02).
				status: "STOPPED",
				pid: null,
				ownerHost: null,
				stoppedAt: goneAt,
				processGoneAt: goneAt,
				publisherReleasedAt: goneAt,
			},
		});
		if (count === 0) {
			return (
				(
					await deps.prisma.feederSession.findUnique({
						where: { id: feederSessionId },
					})
				)?.status ?? row.status
			);
		}
		return "STOPPED";
	}

	return {
		async process(jobData: unknown): Promise<FeederResult> {
			const job = feederJobSchema.parse(jobData);
			const status =
				job.action === "start"
					? await start(job.feederSessionId)
					: await stop(job.feederSessionId);
			return {
				acknowledged: true,
				feederSessionId: job.feederSessionId,
				action: job.action,
				status,
			};
		},

		/** Graceful worker shutdown: signal every running supervisor. */
		stopAll(): string[] {
			const ids = [...registry.keys()];
			for (const controller of registry.values()) {
				controller.requestStop();
			}
			return ids;
		},

		takeOverStale,

		/**
		 * await the sessions this process RESUMED.
		 *
		 * `worker.close` waits for active BullMQ jobs, which is what makes a
		 * graceful stop land every start-job session on STOPPED. A taken-over
		 * session has no job — the one that started it died with its worker —
		 * so it is invisible to that wait, and a deploy would exit with ffmpeg
		 * still running and the row still PUSHING: the orphan the takeover had
		 * just rescued, re-created by the rescue. `stopAll` signals them
		 * first; this is the wait.
		 */
		async drainTakeovers(): Promise<void> {
			while (takeovers.size > 0) {
				await Promise.allSettled([...takeovers]);
			}
		},
	};
}

export type FeederProcessor = ReturnType<typeof createFeederProcessor>;
