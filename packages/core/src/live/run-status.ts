import type { LiveChannelStatus } from "./next-action";

/**
 *  §2 — the run model's status derivation.
 *
 * A RUN carries `LiveChannelStatus` (the byte-pinned enum stays; renaming it
 * for the new referent would churn the three-file pin for a cosmetic gain —
 * recorded in the design as deliberate debt). The CHANNEL's status is
 * DERIVED, never stored: it is `RUNNING` iff its latest run is, otherwise the
 * latest run's state, or `IDLE` for a channel that has never run. Storing it
 * twice is how the two drift.
 */
export type LiveChannelDerivedStatus = LiveChannelStatus | "IDLE";

/**
 * The four states the partial unique index treats as "live" — the migration
 * (`LiveChannelRun_one_live_per_channel`, 20260817024758) lists EXACTLY these
 * in its WHERE clause. If this set changes, the index must change in the same
 * PR: the DB invariant "at most one non-terminal run per channel" (closes
 * 's duplicate-encoding half) is only as good as this agreement.
 * Probed against real Postgres both directions (2026-08-17): a terminal run
 * beside a CREATED insert is allowed; a second live run violates the index.
 */
export const LIVE_RUN_LIVE_STATUSES = [
	"CREATED",
	"PROVISIONING",
	"RUNNING",
	"STOPPING",
] as const satisfies readonly LiveChannelStatus[];

export function isLiveRunStatus(status: LiveChannelStatus): boolean {
	return (LIVE_RUN_LIVE_STATUSES as readonly LiveChannelStatus[]).includes(
		status,
	);
}

/**
 * Is this schedule row armed for a DIFFERENT airing than the one that is
 * current now? The audited defect  was that
 * nothing could answer it: a schedule bound only to its channel outlived the
 * run it was meant for.
 *
 * The sweep's fire paths refuse a stale row rather than firing it; the arm
 * routes decide what to write into `rowRunId` in the first place. Stating the
 * rule ONCE, here, is what lets a route test pin the CONSEQUENCE of its own
 * write instead of only its shape — the two layers cannot drift into
 * disagreeing about what "stale" means.
 *
 * Two falses that are not "same generation" and are deliberate:
 *
 *  - `rowRunId === null` — the row was armed before any run existed
 *    (creation-time, or a channel that has never aired). It binds lazily to
 *    whatever is current when it first fires; nailing it earlier would make a
 *    re-aired channel refuse its own programme's rows.
 *  - `currentRunId === null` — the channel has no run rows at all. FAIL OPEN:
 *    that is missing evidence, not evidence of a mismatch, and refusing a
 *    STOP on missing evidence is how an encoding bills forever.
 */
export function isStaleGeneration(
	rowRunId: string | null,
	currentRunId: string | null,
): boolean {
	return (
		rowRunId !== null && currentRunId !== null && rowRunId !== currentRunId
	);
}

/**
 * Derive the channel's status from its LATEST run (by seq), or null when the
 * channel has never run. Callers pass the latest run's status, not the list —
 * the query already orders by seq desc take 1, and passing the scalar keeps
 * the function honest about what it depends on.
 */
export function deriveLiveChannelStatus(
	latestRunStatus: LiveChannelStatus | null,
): LiveChannelDerivedStatus {
	return latestRunStatus ?? "IDLE";
}
