/**
 * . The channel detail used to open with twelve equal sections and
 * let the operator work out what mattered; the owner's ask is the inverse —
 * "show what I should do at minimum first, then let me monitor, then let me
 * drill down". This is the first layer: ONE derived next action.
 *
 * Core owns the derivation and returns a CODE, never prose (the UI-free rule —
 * the same split `ingestCoordinates` and `dvrGaugeModel` use). The web layer
 * maps the code to copy and to the control that performs it.
 */
/**
 * The channel's orchestration status — OUR state machine, mirroring the Prisma
 * `LiveChannelStatus` enum. Core is the canonical home for a cross-package
 * contract; `next-action.test.ts` pins this list byte-for-byte against BOTH
 * `schema.prisma` and the web layer's `LIVE_CHANNEL_STATUSES`, so a fork in
 * either direction fails rather than silently narrowing this function.
 */
export const LIVE_CHANNEL_STATUS_VALUES = [
	"CREATED",
	"PROVISIONING",
	"RUNNING",
	"STOPPING",
	"STOPPED",
	"ERROR",
] as const;
export type LiveChannelStatus = (typeof LIVE_CHANNEL_STATUS_VALUES)[number];

export type LiveNextActionCode =
	/** No encoder yet — the channel exists only as a plan. */
	| "START_ENCODER"
	/** A previous start failed; the encoder may or may not be up on Bitmovin. */
	| "RECOVER_FROM_ERROR"
	/** Boot in progress — nothing to do but wait (measured 2m29s–2m53s, n=4). */
	| "WAIT_FOR_BOOT"
	/** Shutting down. NOT boot: review-234 I2 caught STOPPING rendering the
	 *  boot copy, complete with the boot measurement attached to a stop. */
	| "WAIT_FOR_STOP"
	/** Encoder up, ingest not connected: the incident's stage ③. */
	| "CONNECT_INPUT"
	/** Input flowing but no playable manifest yet — output is still forming. */
	| "WAIT_FOR_OUTPUT"
	/** Everything is live; the open alert is the thing to look at. */
	| "REVIEW_ALERTS"
	/**
	 * The alert list could not be READ. Distinct
	 * from `REVIEW_ALERTS`, which asserts an alert exists: here we know
	 * nothing, and the one thing this layer must never do is turn "no answer"
	 * into `ON_AIR`. Points at the alerts card, whose own panel carries the
	 * fetch error.
	 */
	| "ALERTS_UNKNOWN"
	/**
	 * the PROVIDER's status for the
	 * current run's encoding cannot be confirmed — the read is timing out or
	 * failing, or the last confirmed reading is older than the freshness TTL.
	 * Outranks every other RUNNING question: nobody can say the channel is on
	 * air, so the page must not paint it so. Stop stays available; start,
	 * restart, slate, SCTE-35 and timeshift wait for a fresh reading.
	 */
	| "PROVIDER_UNKNOWN"
	/** Live and healthy — the action is to stop when the programme ends. */
	| "ON_AIR"
	/** A schedule will act on its own; the operator does not have to. */
	| "SCHEDULED_ONLY"
	/** A STOPPED channel's honest verb : begin a NEW run —
	 *  never a restart, which the vendor cannot do (C30, #107, #110). */
	| "START_NEW_RUN"
	/** Terminal: nothing is running and nothing is armed. */
	| "NOTHING_TO_DO";

export type LiveNextAction = {
	code: LiveNextActionCode;
	/**
	 * How to paint it. `act` = the operator must do something, `wait` = the
	 * system is working, `watch` = live and healthy, `idle` = terminal.
	 */
	tone: "act" | "wait" | "watch" | "idle";
	/** Which accordion card answers this action, for a "take me there" link. */
	section:
		| "sec-actions"
		| "sec-feeders"
		| "sec-schedule"
		| "sec-alerts"
		| "sec-manifests"
		| "sec-steps";
};

export type LiveNextActionInput = {
	status: LiveChannelStatus | "IDLE";
	/** From the composed #127 predicate: active status AND
	 * `ingestConnectedFresh` — a frozen sample no longer vouches (review-260
	 * 127-A10 retired the raw-predicate wording here). */
	ingestConnected: boolean;
	hasEncoding: boolean;
	/** Manifest links the player can actually play right now. */
	playableCount: number;
	/**
	 * ARMED rows that would BRING THE CHANNEL UP (START, and the feeder/slate
	 * actions that imply one). Only these justify "the schedule will act".
	 *
	 * review-234 C1: this was one undifferentiated `armedScheduleCount`, so a
	 * channel whose only armed row was a STOP — the everyday leftover when a
	 * START is marked MISSED, or an operator arming a cap on a manual run —
	 * was told "you do not have to start anything by hand" while off air.
	 */
	armedStartCount: number;
	/**
	 * ARMED rows that are DUE (fireAt in the past by more than the sweep's
	 * grace) and therefore evidence the sweep is not running. A schedule the
	 * worker cannot fire must never be presented as automation.
	 */
	overdueArmedCount: number;
	/**
	 * Open alerts, or `"unknown"` when the caller could not read the list at
	 * all. This was a plain `number` and the web
	 * layer passed `alerts.data?.open.length ?? 0`, so a failing alerts query
	 * arrived here as a measured zero — the healthiest possible reading — and
	 * an otherwise-fine channel was told `ON_AIR` on evidence nobody had.
	 * A `number` is a MEASUREMENT; `"unknown"` is the absence of one.
	 */
	openAlerts: number | "unknown";
	/**
	 * : `deriveProviderLifecycle(currentRun) === "UNKNOWN"`. Optional
	 * (absent = not unknown) so callers without a run view — and the pre-#280
	 * fixtures — keep their answers.
	 */
	providerUnknown?: boolean;
};

/**
 * The one thing to do next, in priority order. Deliberately total over
 * `LiveChannelStatus` and deliberately NOT a list: two "most important" items
 * is the layout the owner asked us to replace.
 *
 * Ordering rationale, from the 2026-08-15 incident: an unconnected ingest on a
 * RUNNING channel outranks everything except a failed start, because that is
 * the state where a slate renders nothing and the operator sees black.
 */
export function liveNextAction(input: LiveNextActionInput): LiveNextAction {
	const {
		status,
		ingestConnected,
		hasEncoding,
		playableCount,
		armedStartCount,
		overdueArmedCount,
		openAlerts,
		providerUnknown = false,
	} = input;
	/**
	 * "The schedule will act" is a promise about a WORKER that is running. An
	 * overdue armed row is proof it is not (the sweep reaps due rows within
	 * one 30s tick), so the page must fall back to telling the operator to act
	 * — false reassurance is the failure mode this whole layer exists to kill.
	 */
	const scheduleWillAct = armedStartCount > 0 && overdueArmedCount === 0;

	if (status === "ERROR") {
		return {
			code: "RECOVER_FROM_ERROR",
			tone: "act",
			section: hasEncoding ? "sec-actions" : "sec-steps",
		};
	}
	if (status === "CREATED" || status === "IDLE") {
		// IDLE  and CREATED share the verb:
		// nothing exists yet, start the encoder.
		return scheduleWillAct
			? { code: "SCHEDULED_ONLY", tone: "wait", section: "sec-schedule" }
			: { code: "START_ENCODER", tone: "act", section: "sec-actions" };
	}
	if (status === "PROVISIONING") {
		return { code: "WAIT_FOR_BOOT", tone: "wait", section: "sec-actions" };
	}
	if (status === "RUNNING") {
		// : before any question about ingest, alerts or output — a
		// channel whose provider cannot be seen has no answer to any of them.
		// `act`, never `watch`: the emerald ON_AIR treatment is exactly the
		// green the audit's invariant forbids on a lost observation.
		if (providerUnknown) {
			return { code: "PROVIDER_UNKNOWN", tone: "act", section: "sec-actions" };
		}
		if (!ingestConnected) {
			return { code: "CONNECT_INPUT", tone: "act", section: "sec-feeders" };
		}
		// Unread alerts take the alert slot's priority, ahead of the "> 0"
		// test they replace: not knowing is strictly worse than knowing there
		// is one, because the operator cannot even see how many. It is
		// deliberately an `act` tone — the page must not paint an
		// unmonitored channel with the watch/emerald ON_AIR treatment.
		if (openAlerts === "unknown") {
			return { code: "ALERTS_UNKNOWN", tone: "act", section: "sec-alerts" };
		}
		if (openAlerts > 0) {
			return { code: "REVIEW_ALERTS", tone: "act", section: "sec-alerts" };
		}
		if (playableCount === 0) {
			return {
				code: "WAIT_FOR_OUTPUT",
				tone: "wait",
				section: "sec-manifests",
			};
		}
		return { code: "ON_AIR", tone: "watch", section: "sec-actions" };
	}
	// STOPPING is its own wait: the encoder is coming DOWN, and the boot copy
	// (with its boot measurement) would be wrong twice over (review-234 I2).
	if (status === "STOPPING") {
		return { code: "WAIT_FOR_STOP", tone: "wait", section: "sec-steps" };
	}
	// Terminal states. An armed START is the normal pre-air state — and as
	// of  PR3 that promise is TRUE for STOPPED channels too: the
	// sweep starts a NEW run via provision (#110's unattended 409 is gone).
	if (scheduleWillAct) {
		return { code: "SCHEDULED_ONLY", tone: "wait", section: "sec-schedule" };
	}
	if (status === "STOPPED") {
		// The honest verb the vendor's model allows (design §5): not restart
		// (impossible, C30), not duplicate (a different channel) — a new run
		// of THIS channel.
		return { code: "START_NEW_RUN", tone: "act", section: "sec-actions" };
	}
	return { code: "NOTHING_TO_DO", tone: "idle", section: "sec-actions" };
}
