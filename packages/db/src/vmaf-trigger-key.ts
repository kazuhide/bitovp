/**
 * `VmafJob.triggerKey` — the provenance of a measurement, as a column.
 *
 * Producers and readers share it; before this file
 * they spelled the prefix inline: `vmaf/trigger.ts`
 * (create), `vmaf-jobs/route.ts` (create), `orchestrator/processor.ts` (the
 * gate decision), `reconcile-stranded.ts` (which parked job to wake), and —
 * the one that made this worth extracting — the QC evidence report, which had
 * to agree with the orchestrator about which row gated delivery and could only
 * do so by re-spelling a literal owned by nobody.
 *
 * Only the exact AUTO key may evaluate the linked job's gate, mirror its verdict
 * or wake delivery. Manual runs remain measurements. Historical manual rows can
 * still carry verdicts from the old writer, so readers must select AUTO rather
 * than "the newest row carrying a verdict"; this fix does not rewrite history.
 */

/** The AUTO measurement's key. One per encoding job (unique constraint). */
export function autoTriggerKey(encodingJobId: string): string {
	return `vod-auto:${encodingJobId}`;
}

/** The prefix every lab-manual key for a job starts with (`startsWith` scans). */
export function labManualTriggerPrefix(encodingJobId: string): string {
	return `lab-manual:${encodingJobId}:`;
}

/** A lab-manual key: one row per (job, model, ordinal) — a re-measure is new. */
export function labManualTriggerKey(
	encodingJobId: string,
	model: string,
	ordinal: number,
): string {
	return `${labManualTriggerPrefix(encodingJobId)}${model}:${ordinal}`;
}

/**
 * What a stored key says about a row, relative to ONE encoding job.
 *
 * `OTHER` is deliberately not `LAB_MANUAL`'s default: a null key (pre-#122
 * rows, and Postgres' unique index ignores nulls so they were always allowed),
 * or a key naming a DIFFERENT job, is unknown provenance — not a lab run — and
 * a reader that called it one would be asserting something it cannot see.
 */
export type VmafTriggerKind = "VOD_AUTO" | "LAB_MANUAL" | "OTHER";

export function vmafTriggerKind(
	triggerKey: string | null,
	encodingJobId: string,
): VmafTriggerKind {
	// Falsy, not `=== null`: the column is nullable (pre-#122 rows carry null,
	// and Postgres' unique index ignores nulls so they were always legal), and
	// an empty string is unknown provenance for the same reason a null is. The
	// loose test also survives a JSON round-trip that spells absence as
	// `undefined` — the parameter type forbids it, a wire payload does not.
	if (!triggerKey) {
		return "OTHER";
	}
	if (triggerKey === autoTriggerKey(encodingJobId)) {
		return "VOD_AUTO";
	}
	if (triggerKey.startsWith(labManualTriggerPrefix(encodingJobId))) {
		return "LAB_MANUAL";
	}
	return "OTHER";
}
