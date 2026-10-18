import type { EncodingMessage } from "./sdk-ops";

/**
 * WHY did the provider's scheduled insertion reach ERROR? (WP-A3)
 *
 * A `ScheduledInsertableContent` entry carries a status and nothing else —
 * no error text, no reason. The encoding's own status messages
 * (`GET /encoding/encodings/{id}/status` → `messages[]`) are the only reason
 * channel Bitmovin offers, and until now nothing read them: the 2026-09-02
 * failure was recorded as "reached ERROR — the slate did not cover the
 * program" with no line in any log, and the operator had to guess.
 *
 * Selection is by SEVERITY and TIME, both necessary. An encoding accumulates
 * INFO/DEBUG messages over its whole life, so only ERROR and WARNING count;
 * and a long-running channel carries earlier warnings (a previous slate, an
 * ingest hiccup an hour ago), so only messages dated at or after the fire
 * are attributed to THIS insertion — with a tolerance for the two clocks
 * (ours stamps `firedAt`, Bitmovin stamps the message) disagreeing by a few
 * seconds. An UNDATED message is kept: it cannot be excluded honestly, and a
 * surplus line is cheaper than a missing reason.
 *
 * Pure, so the selection rule is testable without the action harness.
 */

export const REASON_CLOCK_SKEW_MS = 30_000;

/** How many messages ride the step-log payload (the first is the note). */
export const REASON_MESSAGE_CAP = 10;

const REASON_TYPES: ReadonlySet<string> = new Set(["ERROR", "WARNING"]);

export type ProviderFailureReason = {
	/** The first attributable ERROR/WARNING — what the outcome note quotes. */
	first: EncodingMessage | null;
	/** Every attributable message, first included, newest last, capped. */
	messages: EncodingMessage[];
};

export function selectProviderFailureReason(
	messages: readonly EncodingMessage[],
	firedAtMs: number,
): ProviderFailureReason {
	const floor = firedAtMs - REASON_CLOCK_SKEW_MS;
	const kept = messages
		.filter((m) => REASON_TYPES.has(m.type.toUpperCase()))
		.filter((m) => {
			if (m.date === null) {
				return true;
			}
			const at = Date.parse(m.date);
			// An unparseable date is treated like a missing one: kept.
			return Number.isNaN(at) || at >= floor;
		})
		.sort((a, b) => {
			// Dated messages oldest first; an undated (or unparseable) one sorts
			// LAST explicitly — a comparator answering 0 for it left the order
			// to the engine (rev406, optional).
			const ta = a.date === null ? Number.NaN : Date.parse(a.date);
			const tb = b.date === null ? Number.NaN : Date.parse(b.date);
			const aUndated = Number.isNaN(ta);
			const bUndated = Number.isNaN(tb);
			if (aUndated && bUndated) {
				return 0;
			}
			if (aUndated) {
				return 1;
			}
			if (bUndated) {
				return -1;
			}
			return ta - tb;
		})
		.slice(0, REASON_MESSAGE_CAP);
	return { first: kept[0] ?? null, messages: kept };
}

/**
 * The clause appended to the verdict note. Three honest answers, never a
 * blank: the provider's own words, "no message", or why they could not be
 * read.
 */
export function providerReasonClause(
	outcome:
		| { kind: "messages"; reason: ProviderFailureReason }
		| { kind: "unreadable"; error: string },
): string {
	if (outcome.kind === "unreadable") {
		return `provider messages could not be read: ${outcome.error}`;
	}
	const first = outcome.reason.first;
	if (first === null) {
		return "provider reported no message";
	}
	return `provider: ${first.text}`;
}
