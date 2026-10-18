import type { MessageKey } from "@/lib/i18n";

/**
 *  — which StatusStrip changes are MATERIAL enough to say out loud.
 *
 * A pure function, apart from the component, because it is the whole safety
 * property of the live region: delete the comparison and the page announces the
 * ingest state on every 15s poll for as long as it is open. A rule that can be
 * stated in a test — "same sample twice ⇒ nothing" — cannot be quietly lost the
 * way an inline `if` inside an effect can.
 */

export type LiveStatusSignal = {
	/**
	 * RUNNING, and ONLY running — the one state in which a change to any value
	 * below is news rather than a consequence of what the operator just did.
	 *
	 * The field was `active` and the caller passed `isActiveChannelStatus`,
	 * which is PROVISIONING | RUNNING | STOPPING (review-366 S2). Both samples
	 * therefore stayed true across RUNNING → STOPPING, so the ingest disconnect
	 * a Stop causes was announced — the exact pair the rule below says the
	 * operator need not hear. Renamed rather than re-guarded, because the bug
	 * was the word: `active` reads as "the channel is doing something", and the
	 * question here is narrower.
	 */
	onAir: boolean;
	ingestConnected: boolean;
	/** The heartbeat sample is inside the vouching window (core's predicate). */
	heartbeatFresh: boolean;
	/** Open alerts, or `"unknown"` when the alert read FAILED (audit IMPORTANT-2). */
	openAlerts: number | "unknown";
};

/**
 * Which SIGNAL an announcement is about — not which message it is.
 *
 * The live region coalesces per signal (review-366 S1), and the unit of
 * coalescing has to be the thing that flaps: an ingest that goes down, up and
 * down again inside one window is three messages under two different message
 * keys, and they must contend for ONE hold slot. A heartbeat message must not
 * evict them, and they must not evict it.
 */
export type LiveSignalKind = "ingest" | "heartbeat" | "alerts";

export type LiveAnnouncement = {
	signal: LiveSignalKind;
	key: MessageKey;
	values?: Record<string, string | number>;
};

/**
 * The announcements one poll earned. Empty for an unchanged sample — which is
 * every poll on a healthy channel.
 *
 * Three signals, and they are the three §5.6 names: ingest connected ↔
 * disconnected, heartbeat fresh ↔ stale, an alert opened or resolved.
 *
 * Two deliberate silences:
 *
 *  - **Either sample not ON AIR.** Starting and stopping a channel disconnect
 *    the ingest and stale the heartbeat BY DEFINITION, and the operator who
 *    pressed Stop does not need to be told that stopping worked. Announcing
 *    them would put two guaranteed messages on every lifecycle transition,
 *    which is how a live region trains its listener to ignore it. This is why
 *    `onAir` is RUNNING alone and not `isActiveChannelStatus` — see the field.
 *  - **`"unknown"` on either side of the alert count.** That value means the
 *    alert READ failed, not that the channel changed; a flaky network would
 *    otherwise narrate itself. The strip already renders it in amber, and
 *    `role="alert"` still carries the alerts themselves.
 */
export function liveStatusAnnouncements(
	prev: LiveStatusSignal,
	next: LiveStatusSignal,
): LiveAnnouncement[] {
	if (!prev.onAir || !next.onAir) {
		return [];
	}
	const out: LiveAnnouncement[] = [];
	if (prev.ingestConnected !== next.ingestConnected) {
		out.push({
			signal: "ingest",
			key: next.ingestConnected
				? "liveAnnounce.ingestConnected"
				: "liveAnnounce.ingestDisconnected",
		});
	}
	if (prev.heartbeatFresh !== next.heartbeatFresh) {
		out.push({
			signal: "heartbeat",
			key: next.heartbeatFresh
				? "liveAnnounce.heartbeatFresh"
				: "liveAnnounce.heartbeatStale",
		});
	}
	if (
		typeof prev.openAlerts === "number" &&
		typeof next.openAlerts === "number" &&
		prev.openAlerts !== next.openAlerts
	) {
		out.push({
			signal: "alerts",
			key:
				next.openAlerts > prev.openAlerts
					? "liveAnnounce.alertOpened"
					: "liveAnnounce.alertResolved",
			values: { count: next.openAlerts },
		});
	}
	return out;
}
