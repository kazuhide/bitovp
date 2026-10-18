/**
 * "Does this feeder row still point at a process nobody has accounted for?"
 * — the ONE predicate behind the stop route, the DELETE guard, the worker's
 * reclaim path and the boot reconciler (audit 2026-08-29 CRITICAL-2).
 *
 * The defect it exists for: the feeder pushes with `-stream_loop -1` and the
 * START job owns that push for its whole life. When the job dies OUTSIDE the
 * worker (OOM, SIGKILL, lost lock) the failed handler marks the session ERROR
 * and DELIBERATELY keeps the pid — it is the operator's only pointer to a
 * possibly-orphaned ffmpeg. Every product path then treated ERROR as "nothing
 * to do here": stop 409'd, the worker's stop returned before its kill ladder,
 * and DELETE happily removed the row — erasing the last reference to a process
 * still pushing into a live ingest.
 *
 * So a pid alone is not the question. The question is a pid that has never
 * been PROVEN gone, and proof is a positive timestamp (`processGoneAt`),
 * written only after a verified kill ladder or an existence probe that came
 * back ESRCH. Absence of evidence (`pid = null`, the normal terminal shape —
 * see the schema's "nulled on terminal states") and evidence of absence
 * (`processGoneAt`) are different facts, and the delete guard needs the second.
 *
 * Polarity is deliberate: a row whose `processGoneAt` is missing or unknown
 * reads as "may be alive" — refusing a delete costs an operator one stop,
 * while the other direction costs an unattended 24h push nobody can find.
 */
export type FeederProcessRef = {
	/** ffmpeg pid recorded while PUSHING; null once the row released it. */
	pid: number | null;
	/** When the pid was PROVEN gone. Null = never proven, not "still alive". */
	processGoneAt: Date | string | null;
};

export function feederProcessMayBeAlive(row: FeederProcessRef): boolean {
	return row.pid != null && row.processGoneAt == null;
}

/**
 * The same question as a database filter — because three call sites were
 * asking it in hand-translated Prisma `where` shapes with nothing tying them
 * to the predicate above (review MEDIUM-2). A `where` that drifts by one key
 * does not fail: it silently selects the wrong population, and for the sweep
 * that means an orphan nobody visits again.
 *
 * Structurally typed, so `packages/core` stays Prisma-free while Prisma
 * accepts them: plain (non-readonly) objects spread into a larger `where`.
 * Treat them as frozen — never mutate a shared fragment in place.
 *
 * `orphan-process.test.ts` evaluates BOTH fragments against a truth table of
 * rows and asserts they agree with `feederProcessMayBeAlive` (and its
 * negation) row for row, so a fragment can no longer drift from the predicate
 * without a test going red.
 */
export type FeederProcessAliveWhere = {
	pid: { not: null };
	processGoneAt: null;
};

/** Rows that still point at a process nobody has proven gone. */
export const FEEDER_PROCESS_MAY_BE_ALIVE_WHERE: FeederProcessAliveWhere = {
	pid: { not: null },
	processGoneAt: null,
};

export type FeederProcessReclaimedWhere = {
	OR: ({ pid: null } | { processGoneAt: { not: null } })[];
};

/**
 * The negation, as Prisma must spell it: no pid at all, OR a pid with proof.
 * Spread into a DELETE guard so the row is only removable once nothing can
 * still be pushing under it.
 */
export const FEEDER_PROCESS_RECLAIMED_WHERE: FeederProcessReclaimedWhere = {
	OR: [{ pid: null }, { processGoneAt: { not: null } }],
};
