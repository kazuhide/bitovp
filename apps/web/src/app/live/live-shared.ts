import type {
	LiveChannelDerivedStatus,
	ManifestPlaybackLink,
	ProviderLifecycleView,
} from "@bitovp/core";
import { ApiError } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import type { Translator } from "@/lib/i18n/context";
import {
	type LiveToVodViewRecord,
	normalizeLiveToVodView,
} from "@/lib/live-to-vod-public";

/** Which live-to-VOD families the current recording can carry . */
export type LiveToVodFamiliesWire = {
	supported: ("HLS" | "DASH")[];
	unsupported: { family: "HLS" | "DASH"; technicalDetail?: string }[];
};

/**
 * Shared live-channel UI contracts: list/detail wire shapes (mirroring the
 * /api/live-channels projections), status tones, and the action-failure
 * mapping that turns route 409s into operator-readable messages.
 */

export const LIVE_CHANNEL_STATUSES = [
	"CREATED",
	"PROVISIONING",
	"RUNNING",
	"STOPPING",
	"STOPPED",
	"ERROR",
] as const;
export type LiveChannelStatus = (typeof LIVE_CHANNEL_STATUSES)[number];

export const LIVE_STATUS_TONE: Record<
	//  PR2b: keyed by the DERIVED status, so tsc itself demands
	// the IDLE entry — the review-242 post-merge note's failure shape (an
	// enum-keyed Record silently lacking the new value) cannot compile here.
	LiveChannelDerivedStatus,
	"neutral" | "ok" | "error"
> = {
	IDLE: "neutral",
	CREATED: "neutral",
	PROVISIONING: "neutral",
	RUNNING: "ok",
	STOPPING: "neutral",
	STOPPED: "neutral",
	ERROR: "error",
};

export type LiveStatusPresentation = {
	tone: "neutral" | "ok" | "warn" | "error";
	/** The local run says RUNNING, but Bitmovin has not confirmed it. */
	providerUnconfirmed: boolean;
};

/**
 * The status badge's single safety rule for both the detail header and fleet.
 *
 * `LiveChannelRun.status = RUNNING` is the orchestrator's state. It becomes a
 * reassuring green claim only when the current run also carries a fresh
 * Bitmovin RUNNING observation. UNKNOWN (a failed/stale read) and UNOBSERVED
 * (no read yet, including legacy rows immediately after migration) remain the
 * truthful local word, but amber and explicitly unconfirmed.
 *
 * Other local states keep their ordinary presentation: provider confirmation
 * qualifies an on-air claim, not a stopped channel's post-mortem label.
 */
export function liveStatusPresentation(
	status: LiveChannelDerivedStatus,
	providerLifecycle: ProviderLifecycleView,
): LiveStatusPresentation {
	const providerUnconfirmed =
		status === "RUNNING" &&
		(providerLifecycle === "UNKNOWN" || providerLifecycle === "UNOBSERVED");
	return {
		tone: providerUnconfirmed ? "warn" : LIVE_STATUS_TONE[status],
		providerUnconfirmed,
	};
}

/** Transitional/steady states that justify list/detail auto-refresh. */
export function isActiveChannelStatus(status: LiveChannelStatus): boolean {
	return (
		status === "PROVISIONING" || status === "RUNNING" || status === "STOPPING"
	);
}

/** Lean list projection — never plan/stepLog/lastHeartbeat/streamKey. */
export type LiveChannelListItem = {
	id: string;
	name: string;
	status: LiveChannelStatus;
	error: string | null;
	bitmovinEncodingId: string | null;
	bitmovinAccountId: string | null;
	createdAt: string;
	updatedAt: string;
	/**
	 * Soonest ARMED schedule  — the list's next-fire badge.
	 * Optional: the create route's lean projection does not compute it.
	 */
	nextSchedule?: { fireAt: string; action: string } | null;
	/**
	 * Operations-cockpit health digest .
	 * Optional: the create route's lean projection does not compute it, and a
	 * response cached from before the field existed still renders.
	 */
	health?: LiveChannelHealthDigest | null;
};

/**
 * What the list route derives per channel so an operator can compare a fleet
 * without opening every detail page.
 *
 * This is NOT the lean-list contract's `lastHeartbeat` under another name.
 * What crosses is a DIGEST: the sample's poll time plus its ingest verdict,
 * the origin observer's verdict COUNTS, and two feeder tallies. The
 * per-stream arrays, the playlist cursors and the raw JSON columns stay on
 * the server, which is what that contract exists to keep off the wire.
 */
export type LiveChannelHealthDigest = {
	/**
	 * The CURRENT run's heartbeat sample, reduced to the two things a
	 * freshness verdict needs — and kept in the SHAPE core's helpers read
	 * (`{ at, raw: { ingest } }`), so the browser calls
	 * `heartbeatSampleFresh` / `ingestConnectedTriState` unchanged. One
	 * freshness rule for this list and the detail page, not two that drift.
	 * Null = the current run has never been polled (or there is no run).
	 */
	heartbeat: {
		at: string;
		raw: { ingest: { status: string | null; healthy: boolean | null } };
	} | null;
	/**
	 * Open alert events, or `"unknown"` when that read failed — never a
	 * green zero for a list we never read (audit 4403130 IMPORTANT-2, the
	 * status strip's rule applied to the fleet view).
	 */
	openAlerts: number | "unknown";
	/** Feeder sessions in CREATED/DOWNLOADING/PUSHING (channel-wide). */
	activeFeeders: number;
	/**
	 * Feeder sessions in ERROR **on the current run**. Run-scoped for the
	 * #108/#127/#155 reason: a re-air provisions a fresh encoder, and the
	 * previous airing's dead feeder is not this airing's fault.
	 */
	erroredFeeders: number;
	/**
	 * The origin observer's per-run verdicts (#161), counted. Null = nothing
	 * observed and no reason recorded — unknown, which is not "no output".
	 */
	origin: {
		observed: number;
		stale: number;
		endlist: number;
		unavailableReason: string | null;
	} | null;
	/** The CURRENT run's observed-RUNNING epoch — the elapsed anchor. */
	runningSince: string | null;
	/** …and its end, so a finished run's elapsed stops growing. */
	endedAt: string | null;
	/** Runtime cap  — the remaining half of the same cell. */
	maxRunMinutes: number | null;
	/**
	 * The newest run's provider observation columns. The browser derives
	 * freshness on its server-anchored ticking clock, so a response that stops
	 * refreshing still ages from confirmed RUNNING to UNKNOWN. Optional only
	 * for a cached response from before this field existed; missing is treated
	 * as UNOBSERVED, never green.
	 */
	provider?: {
		providerStatus: string | null;
		providerStatusObservedAt: string | null;
		providerUnknownSince: string | null;
		providerTerminalAt: string | null;
	} | null;
};

export type HeartbeatSample = {
	receivedAt: string;
	sampledAt: string | null;
	/** Server-redacted, signature-verified and bound to this exact run. */
	raw: unknown;
};
export type PushTimelineEvent = {
	kind: "FIRST_CONNECT" | "DISCONNECT" | "RECONNECT";
	eventAt: string;
	/** Earliest receipt carrying this event within the fetched window, not all history. */
	observedReceivedAt: string;
};
export type PushTimeline = {
	events: PushTimelineEvent[];
	coverage: "recent-receipts";
	/** Conservative: the receipt or event cap was reached; completeness is unknown. */
	truncated: boolean;
};

/** Verified Push telemetry, deliberately separate from the Poll health mirror. */
export type HeartbeatReception =
	| {
			state: "available";
			runId: string | null;
			configuredIntervalS: number | null;
			registration?: {
				mode:
					| "PER_ENCODING"
					| "LEGACY_ACCOUNT"
					| "PENDING_VERSION"
					| "POLL_ONLY";
				requestedEncoderVersion: string | null;
				resolvedEncoderVersion: string | null;
				status: string;
			};
			latest: HeartbeatSample | null;
			previous?: HeartbeatSample | null;
			timeline?: PushTimeline;
			previousReceivedAt: string | null;
	  }
	| { state: "unavailable"; runId: string | null };

/** Full detail row (GET /api/live-channels/[id]). */
export type LiveChannelDetailRow = LiveChannelListItem & {
	liveEffectFenceVersion?: number;
	/** Absent on older responses; absence never proves no Push was received. */
	heartbeatReception?: HeartbeatReception;
	/** Server clock at response time (review-260 127-A5): the client anchors
	 * heartbeat freshness to THIS, never to the viewer's clock. */
	serverNow?: string;
	plan: unknown;
	stepLog: unknown;
	/** Readable ingest coordinates — the ledgered redaction exception. */
	streamKey: string | null;
	encoderIp: string | null;
	/** : the creation-time broadcast slot, when scheduled. */
	programStartAt: string | null;
	programEndAt: string | null;
	lastHeartbeat: unknown;
	/** live-to-VOD record (our own workflow state; null = never run). */
	liveToVod: LiveToVodRecord | null;
	liveToVodFamilies?: LiveToVodFamiliesWire | null;
	/** Trusted server projection; raw workflow diagnostics are absent otherwise. */
	technicalDetailsAllowed?: boolean;
	/**
	 * Derived by the route, not the browser .
	 * Optional so a response cached from before the field existed still renders.
	 */
	playbackLinks?: ManifestPlaybackLink[];
	/** Runtime cap  — the schedule panel edits it via PATCH. */
	maxRunMinutes?: number | null;
	/**
	 *  PR2b: the CURRENT run (newest by seq; null = never ran).
	 * Panels read run-first with the dual-written channel columns as the
	 * fallback; optional so a cached pre-#108 response still renders.
	 */
	currentRun?: {
		cancelRequested?: boolean;
		id: string;
		seq: number;
		status: LiveChannelStatus;
		bitmovinEncodingId: string | null;
		encoderIp: string | null;
		streamKey: string | null;
		outputPrefix: string;
		runningSince: string | null;
		endedAt: string | null;
		programStartAt: string | null;
		programEndAt: string | null;
		error: string | null;
		lastHeartbeat: unknown;
		lastHeartbeatAt: string | null;
		stepLog: unknown;
		liveToVod: LiveToVodRecord | null;
		/** #161 — the origin observer's cursor + last verdicts. */
		originObservation: unknown;
		createdAt: string;
		/**
		 * : the provider's view of this run's encoding (core
		 * `deriveProviderLifecycle` reads these). Optional so a response cached
		 * from before the columns existed still renders — absent = UNOBSERVED.
		 */
		providerStatus?: string | null;
		providerStatusObservedAt?: string | null;
		providerUnknownSince?: string | null;
		providerTerminalAt?: string | null;
	} | null;
};

/**
 * What the channel worker writes to LiveChannel.liveToVod — core's contract
 * since  (per-family status + id/url/error, overall status
 * FINISHED | PARTIAL | ERROR derived from them, `manifests[]` the FINISHED
 * projection). The web side used to keep its own three-status copy; one
 * contract, in `packages/core`, so the route's claim, the worker's record and
 * this page cannot drift.
 */
export type LiveToVodRecord = LiveToVodViewRecord;

/**
 * Boundary normalizer for the wire value. Internal/admin records use core's
 * strict shape; role-projected browser DTOs use the narrower public schema.
 * The underlying DB column's REAL population is wider than the type: one production row
 * carried a bare `{}` (writer unknown — every current writer clears with
 * Prisma.DbNull), and `record.manifests.length` took the whole channel-detail
 * page down with it (found by the 2026-08-22 real-browser pass; 3,900+ jsdom
 * tests were green because fixtures only ever carry today's complete shape).
 * A record without a `status` the union knows is no record (the union is
 * ENFORCED, not just narrowed — review-uibatch #6); `manifests` and
 * `families` are filtered ELEMENT-WISE (review-uibatch #7: `[null]` reaches
 * `manifest.manifestId` and reproduces the crash class one level down).
 */
export function normalizeLiveToVod(raw: unknown): LiveToVodRecord | null {
	return normalizeLiveToVodView(raw);
}

export type LiveChannelAction =
	| "start"
	| "stop"
	| "restart"
	| "reset-timeshift"
	| "scte35";

/* Toast frames require dedicated action nouns in both locales. Button verb phrases cannot be inserted into a localized rejection sentence without breaking its grammar. */
export const ACTION_LABEL_KEYS: Record<
	LiveChannelAction,
	Parameters<Translator>[0]
> = {
	start: "live.actionLabelStart",
	stop: "live.actionLabelStop",
	restart: "live.actionLabelRestart",
	"reset-timeshift": "live.actionLabelResetTimeshift",
	scte35: "live.actionLabelScte35",
};

/**
 * Action failures → locale-owned copy. Stable route codes preserve the
 * operator's recovery step; unknown API/provider prose and non-ApiError
 * failures degrade to a generic line instead of entering customer DOM.
 */
export function actionFailureMessage(
	t: Translator,
	action: LiveChannelAction,
	err: unknown,
): string {
	const label = t(ACTION_LABEL_KEYS[action]);
	if (err instanceof ApiError) {
		const message = localizedCustomerError(t, err, "live.actionReasonUnknown");
		if (err.status === 409) {
			return t("live.actionRejected", { label, message });
		}
		return t("live.actionFailed", { label, message });
	}
	return t("live.actionFailedGeneric", { label });
}
