/**
 * Feeder OWNERSHIP — who is supervising a push right now (audit
 * 2026-08-29 live-scheduling HIGH-5).
 *
 * The supervisor registry is a `Map` inside one worker process, and until this
 * module the only durable fact about a running push was `ownerHost` + `pid` —
 * which says where a process is *signallable*, never whether anyone is
 * *watching* it. So a session had exactly one liveness signal: the state of its
 * BullMQ start job. That is enough for one worker and nothing else. After a
 * SIGKILL, a rolling deploy, or with a second replica, the push either kept
 * running with nobody able to stop it through the product, or was reclaimed by
 * the one host that happened to have minted its pid.
 *
 * A LEASE is the missing fact. The owner re-stamps `ownerLeaseAt` on a ticker;
 * a lease older than `FEEDER_LEASE_TAKEOVER_MS` belongs to a worker that is
 * gone, and any worker may then claim the session by compare-and-swapping the
 * `(ownerId, ownerGeneration)` pair. The generation is what makes the loser
 * harmless: the superseded owner's next renewal, terminal write or log flush
 * matches ZERO rows and it exits quietly, the way #216's provisioning lease
 * loses.
 *
 * NULL is deliberately NOT stale. `ownerLeaseAt IS NULL` means "nobody has
 * ever claimed this row" — a session created by the route and still waiting for
 * its start job, or a row written before the column existed. Treating that as
 * takeable would have two workers racing to spawn ffmpeg for a session whose
 * own start job is about to arrive. `live/provision-lease.ts` draws the same
 * line for the same reason ("A PROVISIONING row with a NULL lease is
 * deliberately out of scope").
 */

/**
 * How often the owner re-stamps its lease.
 *
 * One tiny UPDATE on a `setInterval`, independent of the download, the probe
 * and ffmpeg (which is a child process) — so a miss means the event loop or the
 * whole process is gone, not that the work is slow.
 */
export const FEEDER_LEASE_RENEWAL_MS = 30_000;

/**
 * How stale a lease must be before another worker may claim it: THREE missed
 * renewals.
 *
 * The number is bounded from both sides and neither side is arbitrary.
 *
 *  · Not lower: a takeover that races a live owner is the worst outcome this
 *    module can produce — two ffmpegs pushing at one ingest. Three consecutive
 *    misses of an I/O-free UPDATE is a process that has stopped running.
 *  · Not higher: this window is dead air on a live channel, and it should sit
 *    well under BullMQ's stalled-job cadence — `maxStalledCount` 5
 *    (`stall-policy.ts`) × a 30s stalled interval — so a lost session is
 *    RESUMED rather than left waiting on a postmortem that may never come.
 *    NOT a claimed ORDER between the two (review-365 S-2): a stalled START job
 *    is moved back to WAIT and re-run first, and a re-run finds the row
 *    PUSHING, fails `start`'s CREATED claim and COMPLETES — so on a
 *    multi-worker install the `failed` report usually never happens at all.
 */
export const FEEDER_LEASE_TAKEOVER_MS = 3 * FEEDER_LEASE_RENEWAL_MS;

/**
 * A worker INSTANCE id — the thing a lease is held by.
 *
 * Not the hostname: two workers on one host are two owners, and `ownerHost`
 * already carries the host for the separate question of where a pid can be
 * signalled. Not the pid alone either: a restarted worker can be handed the
 * same pid, and a lease held by "the process that used to be 4711" is a lease
 * held by nobody. The nonce is what makes each BOOT distinct, so the id is
 * unique across restarts and across hosts, and still readable in a log line.
 */
export function feederOwnerId(parts: {
	hostname: string;
	pid: number;
	nonce: string;
}): string {
	return `${parts.hostname}/${parts.pid}/${parts.nonce}`;
}

/** Accepts what Prisma returns and what a fake hands back. */
export type LeaseStamp = Date | string | null | undefined;

function leaseMs(at: LeaseStamp): number | null {
	if (at == null) {
		return null;
	}
	const ms = at instanceof Date ? at.getTime() : Date.parse(at);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * "Is a live worker supervising this session?"
 *
 * The polarity is chosen for its wrong answers. FALSE for a NULL or unparseable
 * lease, because the readers of a `false` here (the orphan sweep, the dead-job
 * handler) then fall through to their OWN gates — the queue state, the pid
 * identity check, a kill ladder — none of which act without positive proof.
 * A `true` here, by contrast, stops those gates dead, so it is only ever
 * returned for a timestamp we can read that is inside the window.
 *
 * A FUTURE lease reads as fresh, and that is deliberate: a clock skewed forward
 * on the owner's host must not hand its live push to a takeover. The opposite
 * skew is bounded by the window itself.
 *
 * `FEEDER_LEASE_TAKEOVER_MS` is also what an OWNER measures itself against
 * (`processor.ts`'s self-fencing, review-365 I-3): a holder that has not
 * confirmed its lease for longer than this must assume somebody else has taken
 * it, because from every other worker's point of view it already has. Both
 * sides reading the same constant is what makes the two decisions consistent —
 * an owner never stands down before a takeover would be legal, and never keeps
 * pushing after one would.
 */
export function feederLeaseIsFresh(at: LeaseStamp, nowMs: number): boolean {
	const ms = leaseMs(at);
	if (ms === null || !Number.isFinite(nowMs)) {
		return false;
	}
	// `<=`, not `<`, and the boundary is not a detail: the sweep's filter is
	// `ownerLeaseAt < now - window` (strictly older), so a lease sitting
	// EXACTLY on the window must read as fresh here or the two instruments
	// disagree for one tick — a row that is neither takeable nor protected.
	// `ownership.test.ts` evaluates both over one truth table and would not let
	// that stand.
	return nowMs - ms <= FEEDER_LEASE_TAKEOVER_MS;
}

/**
 * The same question as a Prisma filter, for the sweep that has to SELECT the
 * population rather than test one row — the `FEEDER_PROCESS_MAY_BE_ALIVE_WHERE`
 * idiom (`packages/core/src/feeder/orphan-process.ts`, review MEDIUM-2): a
 * hand-translated `where` that drifts by one key does not fail, it silently
 * selects the wrong rows, and for a takeover sweep that means either a session
 * nobody resumes or a live push taken from under its owner.
 *
 * `not: null` is a DECLARATION, not the mechanism — measured, because the
 * first version of this comment called it "the half that matters most" and
 * that is not what happens (review-365 S-1). SQL's `NULL < x` is never true,
 * so `lt` already excludes an unclaimed row all by itself: dropping `not:
 * null` leaves the behavioural arm ("never resumes a session nobody has
 * claimed") GREEN. What goes red is `tsc` — `FeederLeaseStaleWhere` REQUIRES
 * the key — and the shape pin in `ownership.test.ts`. So the compiler is the
 * guard, and the key is here to say out loud which population this sweep
 * takes, because "an unclaimed row is not an abandoned one" is the fact a
 * future edit is most likely to lose.
 *
 * `ownership.test.ts` evaluates this fragment and `feederLeaseIsFresh` against
 * one truth table and asserts they are exact negations FOR EVERY READABLE
 * TIMESTAMP — and that NULL is the deliberate exception, matching neither.
 */
export type FeederLeaseStaleWhere = {
	ownerLeaseAt: { not: null; lt: Date };
};

export function feederLeaseStaleWhere(nowMs: number): FeederLeaseStaleWhere {
	return {
		ownerLeaseAt: { not: null, lt: new Date(nowMs - FEEDER_LEASE_TAKEOVER_MS) },
	};
}
