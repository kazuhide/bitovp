import type { MessageKey } from "@/lib/i18n";
import {
	SCHEDULED_CONTENT_STATUSES,
	type ScheduledContentStatus,
} from "@/lib/live-runtime/schemas";

const KNOWN_RESERVATION_STATUSES: ReadonlySet<string> = new Set(
	SCHEDULED_CONTENT_STATUSES,
);

/**
 * Provider payloads cross an untyped JSON boundary. Keep a newly introduced or
 * omitted status out of the exhaustive presentation maps until this client
 * explicitly understands it.
 */
export function parseReservationStatus(
	value: unknown,
): ScheduledContentStatus | null {
	return typeof value === "string" && KNOWN_RESERVATION_STATUSES.has(value)
		? (value as ScheduledContentStatus)
		: null;
}

/**
 * Each provider reservation state → the customer's word for it, and how it is
 * painted — the two tables
 * replaced the green `SCHEDULED` chip with.
 *
 * A `.ts` module apart from the panel, for the reason `channel-detail.tsx`'s
 * node map is annotated rather than `satisfies`-checked: inside a `.tsx`,
 * `} as const satisfies Record<…>` reads to the untranslated-JSX-text scanner
 * (`untranslated-jsx-text.test.ts`) as a bare English text node. Here it is
 * plain TypeScript, and `satisfies Record<ScheduledContentStatus, …>` keeps
 * its job: a value added to the wire enum is a compile error in both tables,
 * not a raw token rendered to an operator (the rule set for alert
 * metrics).
 */
export const RESERVATION_STATUS_LABEL_KEYS = {
	CREATED: "contentInsertion.statusCreated",
	SCHEDULED: "contentInsertion.statusScheduled",
	TO_BE_DESCHEDULED: "contentInsertion.statusToBeDescheduled",
	DESCHEDULED: "contentInsertion.statusDescheduled",
	ERROR: "contentInsertion.statusError",
} as const satisfies Record<ScheduledContentStatus, MessageKey>;

/* Reservation status never implies successful playback. SCHEDULED is pending and blue; completed or removed reservations are muted. No reservation status receives a success tone. */
export type ReservationTone = "neutral" | "reserved" | "muted" | "error";

export const RESERVATION_STATUS_TONE = {
	CREATED: "neutral",
	SCHEDULED: "reserved",
	TO_BE_DESCHEDULED: "neutral",
	DESCHEDULED: "muted",
	ERROR: "error",
} as const satisfies Record<ScheduledContentStatus, ReservationTone>;
