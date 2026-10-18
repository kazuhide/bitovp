import { soleEncodingStepId } from "@bitovp/core";

/**
 * Last known BITMOVIN encoding status, derived from a job's persisted step log.
 *
 * Bitmovin's `Status` is NOT our `EncodingJob.status` (the prisma enum is our
 * own orchestration state machine — see the schema comment: "the raw Bitmovin
 * status lives in snapshots/stepLog"). Only one thing in the system ever
 * observes the remote status: the orchestrator's AWAIT_ENCODING step (and
 * START_ENCODING's crash-window resume probe), and it records what it saw in
 * that step-log entry. That entry is therefore the single local source of truth
 * for "what did Bitmovin last say about this encoding", and it is what the job
 * detail renders and what the job detail's status readout shows.
 *
 * Where the status lives, per entry state:
 *  - DONE   → `response` is the awaited task ⇒ `response.status` ("FINISHED",
 *             or the resumed START_ENCODING probe's status).
 *  - FAILED → the step THREW, so there is no task snapshot; the status is
 *             embedded in the (redacted) error message the executor formats:
 *               `<step> ended <STATUS>[: messages]`                  (terminal)
 *               `<step> timed out after Ns (last status <STATUS>)`   (timeout)
 *             — apps/worker/src/orchestrator/executor.ts `awaitTask`. That
 *             coupling is deliberate and asserted by tests on both sides; a
 *             TRANSFER_ERROR reaches us no other way today (there is no
 *             `bitmovinStatus` column).
 *
 * Scoped to the plan's SOLE encoding: only entries whose `refs.encodingId` is the
 * compiler's `ENCODING_STEP` are considered, because that is the one encoding
 * whose id is denormalized onto `EncodingJob.bitmovinEncodingId` (a
 * multi-encoding Dolby plan names its steps `encoding:<key>` and leaves the
 * column null, so its runtime actions are refused earlier for want of an id).
 * Without the scope a sibling ladder encoding's TRANSFER_ERROR could enable a
 * retry against a different encoding.
 *
 * Client-safe: the job detail imports it to decide whether the transfer-retry
 * action is offered at all, so the disabled set cannot drift from the route's
 * 409 set.
 */

/** `Status` — @bitmovin/api-sdk 1.269.0 (dist/models/Status.d.ts). */
const BITMOVIN_ENCODING_STATUSES = [
	"CREATED",
	"QUEUED",
	"RUNNING",
	"FINISHED",
	"ERROR",
	"CANCELED",
	"TRANSFER_ERROR",
] as const;

type BitmovinEncodingStatus = (typeof BITMOVIN_ENCODING_STATUSES)[number];

/** Step kinds that observe the ENCODING's own status (not a manifest's). */
const ENCODING_STATUS_KINDS = new Set(["AWAIT_ENCODING", "START_ENCODING"]);

function isBitmovinStatus(value: unknown): value is BitmovinEncodingStatus {
	return (BITMOVIN_ENCODING_STATUSES as readonly unknown[]).includes(value);
}

/** `<step> ended TRANSFER_ERROR: …` / `… (last status RUNNING)` — see above. */
function statusFromErrorMessage(
	message: string,
): BitmovinEncodingStatus | null {
	const match =
		/\bended ([A-Z_]+)/.exec(message) ??
		/\blast status ([A-Z_]+)\)/.exec(message);
	const candidate = match?.[1];
	return isBitmovinStatus(candidate) ? candidate : null;
}

type LooseEntry = {
	kind?: unknown;
	status?: unknown;
	refs?: unknown;
	response?: unknown;
	error?: unknown;
};

/**
 * Newest-wins scan of the step log. Deliberately structural (no
 * `stepLogSchema.parse`): a strict-schema rejection anywhere in the log must
 * not hide a TRANSFER_ERROR and silently disable the operator's only recovery
 * action. Returns null when nothing local ever observed the encoding.
 */
export function lastKnownBitmovinStatus(
	stepLog: unknown,
): BitmovinEncodingStatus | null {
	if (!Array.isArray(stepLog)) {
		return null;
	}
	// ONE definition, in core, shared with the worker's denormalization — the
	// two disagreeing is what produced the bug this replaces.
	const scope = soleEncodingStepId(stepLog);
	if (scope === null) {
		return null;
	}
	for (let i = stepLog.length - 1; i >= 0; i -= 1) {
		const entry = stepLog[i] as LooseEntry | null;
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.kind !== "string" ||
			!ENCODING_STATUS_KINDS.has(entry.kind)
		) {
			continue;
		}
		const refs = entry.refs as { encodingId?: unknown } | null | undefined;
		if (refs?.encodingId !== scope) {
			continue;
		}
		// FAILED first: the failure path also writes a `response`
		// (`{stoppedSiblings}` from the stop-siblings contract) that carries no
		// status, so reading the response first would miss the real answer.
		if (entry.status === "FAILED" && typeof entry.error === "string") {
			const fromError = statusFromErrorMessage(entry.error);
			if (fromError) {
				return fromError;
			}
		}
		const response = entry.response as { status?: unknown } | null | undefined;
		if (isBitmovinStatus(response?.status)) {
			return response.status;
		}
		// STOP at the newest entry that observed the encoding, even if it told us
		// nothing. Walking further back returns a STALE answer as if it were
		// current: when a poll THROWS (Bitmovin 5xx/429, a network errno) the
		// error text carries no `ended X`, and continuing landed on
		// START_ENCODING's resume probe — whose status can only be
		// QUEUED/RUNNING/FINISHED — so an encoding genuinely in TRANSFER_ERROR
		// reported FINISHED, the retry 409'd, and the UI told the operator "last
		// known: FINISHED" (review catch). "Unknown" is the honest answer.
		return null;
	}
	return null;
}
