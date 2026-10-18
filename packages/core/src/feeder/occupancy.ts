/**
 * "Does this feeder row OCCUPY its channel's single publisher slot?" — the ONE
 * predicate behind every feeder admission and spawn decision
 *
 *
 * The defect it exists for: the single-pusher rule lived in `status`. The web
 * route, the scheduler and the DB's partial index all asked "is there an
 * ACTIVE (CREATED/DOWNLOADING/PUSHING) row on this channel?", while three
 * writers leave a row TERMINAL with its ffmpeg still pushing — the cross-host
 * takeover refusal (ERROR, pid kept), a stop the owner's host could not verify
 * (STOPPED/ERROR, pid kept) and the dead-job handler (ERROR, pid kept). Each of
 * those rows was invisible to admission for up to a lease renewal plus a kill
 * grace, and a second publisher could open at the same ingest in that window.
 *
 * Occupancy is therefore THREE facts, any one of which holds the slot:
 *
 * 1. a PUBLISHER CLAIM is held (`publisherClaimedAt` set, `publisherReleasedAt`
 * null) — the owning worker reserved the slot before spawning, and only
 * positive proof that the process is gone releases it. The DB enforces at
 * most one per channel (`FeederSession_one_publisher_claim_per_channel`);
 * 2. a PROCESS MAY BE ALIVE (`feederProcessMayBeAlive`) — a recorded pid nobody
 * has proven gone, whatever the status. Rows written before the claim
 * existed, or by a writer that could not prove anything, land here;
 * 3. the row is ACTIVE and UNCOORDINATED — a CREATED/DOWNLOADING/PUSHING
 * SINGLE-PHASE session (`commitAt` null), which claims and spawns on its
 * own the moment its gates pass. A TWO-PHASE session (`commitAt` set)
 * is never counted by status: while it stages or holds it
 * cannot spawn, and when its commit is requested it competes for the slot
 * INSIDE its commit CAS, which is the claim — so it appears here through
 * fact 1 once it has committed, and through fact 2 once it has a pid,
 * never before. Several holds therefore coexist on one channel and
 * serialise only at their commits (rev367 I-1), and two commits requested
 * at once are decided by the index rather than by each barrier stopping
 * the other (which could stop both).
 *
 * Polarity is deliberate, as in `orphan-process.ts`: an unknown reads as
 * occupied. Refusing an admission costs an operator one stop or one switch;
 * the other direction is two ffmpegs at one ingest (video jam + double billing).
 *
 * `occupancy.test.ts` evaluates the `where` fragment and the row predicate
 * against an EXHAUSTIVE truth table and asserts they agree row for row, so the
 * fragment cannot drift from the predicate without a test going red.
 */

import {
	FEEDER_PROCESS_MAY_BE_ALIVE_WHERE,
	type FeederProcessAliveWhere,
	type FeederProcessRef,
	feederProcessMayBeAlive,
} from "./orphan-process";

/** Non-terminal feeder statuses — the rows whose START job holds a slot. */
export const FEEDER_ACTIVE_STATUSES = [
	"CREATED",
	"DOWNLOADING",
	"PUSHING",
] as const;
export type FeederActiveStatus = (typeof FEEDER_ACTIVE_STATUSES)[number];

export function isFeederActiveStatus(
	status: string,
): status is FeederActiveStatus {
	return (FEEDER_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Accepts what Prisma returns and what a JSON API hands back. */
export type FeederPublisherClaimRef = {
	/** The owning worker took the channel's publisher slot (before spawning). */
	publisherClaimedAt: Date | string | null;
	/** The slot was given back on POSITIVE proof the process is gone. */
	publisherReleasedAt: Date | string | null;
};

/** Held = claimed and never released. */
export function feederPublisherClaimHeld(
	row: FeederPublisherClaimRef,
): boolean {
	return row.publisherClaimedAt != null && row.publisherReleasedAt == null;
}

export type FeederPublisherClaimHeldWhere = {
	publisherClaimedAt: { not: null };
	publisherReleasedAt: null;
};

/** Rows holding a publisher claim — the partial unique index's population. */
export const FEEDER_PUBLISHER_CLAIM_HELD_WHERE: FeederPublisherClaimHeldWhere =
	{
		publisherClaimedAt: { not: null },
		publisherReleasedAt: null,
	};

export type FeederPublisherClaimReleasedWhere = {
	OR: ({ publisherClaimedAt: null } | { publisherReleasedAt: { not: null } })[];
};

/**
 * The negation, as Prisma must spell it: never claimed, OR claimed and
 * released. Spread into the DELETE guard (via `AND`, beside the process
 * guard's own `OR`) so a row goes only once nothing can still be publishing
 * under its claim.
 */
export const FEEDER_PUBLISHER_CLAIM_RELEASED_WHERE: FeederPublisherClaimReleasedWhere =
	{
		OR: [{ publisherClaimedAt: null }, { publisherReleasedAt: { not: null } }],
	};

export type FeederOccupancyRef = FeederProcessRef &
	FeederPublisherClaimRef & {
		status: string;
		/** Set = a two-phase switch session (never counted by status alone). */
		commitAt: Date | string | null;
	};

export function feederOccupiesChannel(row: FeederOccupancyRef): boolean {
	return (
		feederPublisherClaimHeld(row) ||
		feederProcessMayBeAlive(row) ||
		(isFeederActiveStatus(row.status) && row.commitAt == null)
	);
}

export type FeederActiveUncoordinatedWhere = {
	status: { in: FeederActiveStatus[] };
	commitAt: null;
};

export type FeederOccupancyWhere = {
	liveChannelId?: string;
	OR: [
		FeederPublisherClaimHeldWhere,
		FeederProcessAliveWhere,
		FeederActiveUncoordinatedWhere,
	];
};

/**
 * The same question as a Prisma filter, for the callers that must SELECT or
 * COUNT the population rather than test one row: the web create route's
 * per-channel admission, the scheduler's feeder-start admission, the feeder
 * processor's pre-spawn check and its two-phase predecessor barrier. One
 * source, so a hand translation cannot drift by one key and silently admit a
 * second publisher (the review MEDIUM-2 lesson `orphan-process.ts` records).
 *
 * Fresh objects on every call (callers spread `id: { not }` beside them);
 * treat the returned value as frozen all the same.
 */
export function feederOccupancyWhere(
	liveChannelId?: string,
): FeederOccupancyWhere {
	return {
		...(liveChannelId === undefined ? {} : { liveChannelId }),
		OR: [
			{ ...FEEDER_PUBLISHER_CLAIM_HELD_WHERE },
			{ ...FEEDER_PROCESS_MAY_BE_ALIVE_WHERE },
			{ status: { in: [...FEEDER_ACTIVE_STATUSES] }, commitAt: null },
		],
	};
}
