/**
 * How far ahead of air time a scheduled feeder switch is PRE-STAGED
 * .
 *
 * The switch downloads the whole sealed source, ffprobes it and runs the
 * compatibility gate BEFORE it may spawn, and it does that work at
 * `fireAt − lead` so that at `fireAt` the only thing left is the spawn. The
 * lead is therefore an estimate of the staging time, and it is deliberately
 * generous: a lead that is too long costs a spool file held a little longer;
 * a lead that is too short costs the switch itself, because a session that is
 * not READY at fireAt does not fire (the scheduler lands the row MISSED with
 * outcome FAILED, "not staged", and the previous feed keeps the ingest).
 *
 * MEASURED, not guessed. The audit's paid run #5 pushed a 725 MB source:
 * FIRED→PUSHING 29.193 s (download + probe + spawn) and FIRED→CONNECTED
 * 53.488 s (the encoder bound the input). That is an effective ~25 MB/s
 * end-to-end; the bandwidth below assumes 10 MB/s (80 Mbit/s), a 2.5×
 * safety factor on that one measurement, and the base term covers the
 * channel-RUNNING wait, the probe and a compatibility read on a source small
 * enough that transfer time vanishes. `stage-lead.test.ts` checks the run #5
 * numbers against the estimate so a constant edit that stops covering the
 * one real measurement is a red test, not a missed switch.
 */

/** The fixed part: the RUNNING wait, ffprobe, the gate, and a queue hop. */
export const STAGE_LEAD_BASE_MS = 120_000;

/**
 * Bytes per second the transfer is assumed to sustain. Conservative on
 * purpose (see the module note); an operator whose object store is slower
 * than 80 Mbit/s should arm larger switches earlier, and the cap below is
 * the number that tells them how much earlier "earlier" can be.
 */
export const STAGE_LEAD_BANDWIDTH_BYTES_PER_SEC = 10_000_000;

/**
 * The lead never exceeds ten minutes: a source that cannot be staged inside
 * that is a source the operator must know about, and a spool file held for
 * longer against a schedule that may still be cancelled is the wrong default.
 * At the assumed bandwidth the cap is reached by a source of ~4.8 GB.
 */
export const STAGE_LEAD_MAX_MS = 10 * 60_000;

/**
 * The audit's paid run #5, as the module's own sanity check (audit
 * 2026-08-29 §4 HIGH-3 measured these on the live API).
 */
export const PAID_RUN_5 = {
	sourceBytes: 725_000_000,
	firedToPushingMs: 29_193,
	firedToConnectedMs: 53_488,
} as const;

/**
 * Size-based lead: base + size / bandwidth, capped. A null or unreadable
 * size (a source sealed by a driver with no `headObject`, or a row armed
 * before the seal existed) gets the base alone — the honest floor, since
 * nothing is known about the transfer.
 */
export function estimateStageLeadMs(
	sourceSizeBytes: number | bigint | null | undefined,
): number {
	const size =
		typeof sourceSizeBytes === "bigint"
			? Number(sourceSizeBytes)
			: sourceSizeBytes;
	if (
		size === null ||
		size === undefined ||
		!Number.isFinite(size) ||
		size < 0
	) {
		return STAGE_LEAD_BASE_MS;
	}
	const transferMs = Math.ceil(
		(size / STAGE_LEAD_BANDWIDTH_BYTES_PER_SEC) * 1000,
	);
	return Math.min(STAGE_LEAD_MAX_MS, STAGE_LEAD_BASE_MS + transferMs);
}
