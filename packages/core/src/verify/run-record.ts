/**
 * The VerificationRun contract, shared by the harness (which WRITES the row)
 * and the Dashboard (which READS it).
 *
 * It lives in core rather than in either side because both sides render the
 * same two value sets: the worker writes `status`/`kind` as plain strings and
 * the web catalogue maps each member to a label. A union declared twice drifts
 * the day someone adds a member to one copy — the failure this repo keeps
 * paying for — so the union is declared ONCE and each consumer derives from it
 * (`satisfies Record<VerificationRunStatus, …>` makes a forgotten member a
 * compile error rather than a blank cell).
 */

/**
 * RUNNING — reserved and not yet sealed. It is also the honest state of a run
 * whose process died: nothing rewrites it, so a stale RUNNING row IS the
 * evidence that the run never produced a sealed report. That reading depends
 * on the seal write having been RETRIED before it gave up — the harness's
 * SEAL_WRITE_ATTEMPTS — because a row that says "never sealed" over one lost
 * database round trip is not evidence, it is noise.
 * SEALED — the report was written and sealed; this row carries its digest.
 * INCOMPLETE — the run threw and the harness got far enough to say so.
 */
export const VERIFICATION_RUN_STATUSES = [
	"RUNNING",
	"SEALED",
	"INCOMPLETE",
] as const;
export type VerificationRunStatus = (typeof VERIFICATION_RUN_STATUSES)[number];

/** What tier(s) the run actually selected — derived, never declared. */
export const VERIFICATION_RUN_KINDS = ["VOD", "LIVE", "MIXED"] as const;
export type VerificationRunKind = (typeof VERIFICATION_RUN_KINDS)[number];

export function isVerificationRunStatus(
	value: unknown,
): value is VerificationRunStatus {
	return (VERIFICATION_RUN_STATUSES as readonly unknown[]).includes(value);
}

export function isVerificationRunKind(
	value: unknown,
): value is VerificationRunKind {
	return (VERIFICATION_RUN_KINDS as readonly unknown[]).includes(value);
}

/**
 * The run's kind, from the kinds of the scenarios it actually selected.
 *
 * `null` for an empty selection on purpose: a run that selected nothing has no
 * kind, and defaulting it to VOD would put a name on a population that was
 * never there. The column is nullable for exactly this window — a run that
 * dies during preflight never learns its kind either.
 */
export function verificationRunKind(
	scenarioKinds: readonly string[],
): VerificationRunKind | null {
	const vod = scenarioKinds.some((kind) => kind === "VOD");
	const live = scenarioKinds.some((kind) => kind === "LIVE");
	if (vod && live) {
		return "MIXED";
	}
	if (live) {
		return "LIVE";
	}
	if (vod) {
		return "VOD";
	}
	return null;
}
