import type {
	EncodingPlan,
	JitDowngrade,
	JitDowngradeResult,
	StepLogEntry,
} from "@bitovp/core";
import {
	downgradeJitManifests,
	initStepLog,
	ridesJitManifests,
} from "@bitovp/core";
import { isStart1004 } from "./start-1004-retry";

/**
 * The runtime half of the JIT→POST_ENCODING downgrade (core computes the
 * transformation; this decides WHEN and applies it to a live step log).
 *
 * Trigger, deliberately narrow: the retry ladder has already exhausted
 * (~11.75 min of escalating retries — see start-1004-retry), the failing step
 * is a START_ENCODING, its refs carry JIT manifest lists, and the error is
 * the measured 500/1004 signature. Anything else fails the job as before: a
 * fallback that fires on unrelated errors would hide real defects behind a
 * plan rewrite, which is worse than the failure it dodges.
 */

export type JitFallbackNote = {
	from: "JUST_IN_TIME";
	reason: "start-1004";
	/** Steps the downgrade added — the manifest generation moved after the encode. */
	appendedSteps: string[];
	/**
	 * Manifest keys whose PREVIEW placement the downgrade dropped: those
	 * artefacts are now generated after the encode, so "watch while encoding"
	 * is gone. Recorded rather than silently changed (review-208 C1).
	 */
	droppedPreview?: string[];
	/** Bitmovin's correlation token for the refusal — support-ticket material. */
	requestId?: string;
};

/**
 * Null when this module's OWN pre-checks say the situation is not ours (not a
 * 1004, or a start that carries no manifest); otherwise core's verdict —
 * including its NAMED refusal, which the caller logs. Collapsing a named
 * refusal back into a bare null was review-208b I1: an operator could not
 * tell "the defence declined because your step log predates this compiler"
 * from "the defence is broken".
 */
export function planJitFallback(
	err: unknown,
	entry: Pick<StepLogEntry, "kind" | "refs">,
	plan: EncodingPlan,
	entries: readonly StepLogEntry[],
): JitDowngradeResult | null {
	if (!isStart1004(err)) {
		return null;
	}
	if (!ridesJitManifests(entry)) {
		return null;
	}
	return downgradeJitManifests(
		plan,
		entries.map((e) => e.step),
	);
}

/**
 * Apply IN PLACE: rewrite the start op(s) and append the manifest steps.
 *
 * In place because the processor is iterating `entries` with `for…of` when
 * this runs: the array iterator re-reads `length` on every step, so entries
 * appended here execute in the SAME attempt, right after the start and its
 * await. Replacing the array instead would leave the loop iterating the old
 * one — the appended steps would silently never run (they would sit PENDING
 * in the persisted log, which reads as a stalled job).
 */
export function applyJitFallback(
	downgrade: JitDowngrade,
	entries: StepLogEntry[],
	requestId?: string,
): JitFallbackNote {
	for (const [step, op] of downgrade.rewritten) {
		const target = entries.find((e) => e.step === step);
		// NEVER rewrite a step that already executed (review-208 I1). Today
		// only one START_ENCODING is reachable (the validator refuses
		// multi-encoding + JIT), but `rewritten` is a Map built for several:
		// if that rail is ever relaxed, rewriting a DONE start would make the
		// step log describe a request the account never received.
		if (!target || target.status === "DONE") {
			continue;
		}
		target.payload = op.payload;
		target.refs = op.refs;
	}
	const appended = initStepLog(downgrade.appended);
	entries.push(...appended);
	return {
		from: "JUST_IN_TIME",
		reason: "start-1004",
		appendedSteps: appended.map((e) => e.step),
		...(downgrade.droppedPreview.length > 0
			? { droppedPreview: downgrade.droppedPreview }
			: {}),
		...(requestId ? { requestId } : {}),
	};
}
