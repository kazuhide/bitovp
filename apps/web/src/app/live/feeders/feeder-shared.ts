import type { LoopProfile, RedundantRtmpStaticIngestPoint } from "@bitovp/core";
import {
	feederOccupiesChannel,
	feederProcessMayBeAlive,
	feederPublisherClaimHeld,
	STATIC_INGEST_URL,
} from "@bitovp/core";
import { localizedCustomerError } from "@/lib/customer-error";
import type { MessageKey } from "@/lib/i18n";
import type { Translator } from "@/lib/i18n/context";

/** Shared feeder-session UI contracts mirroring the API projections. */

export const FEEDER_STATUSES = [
	"CREATED",
	"DOWNLOADING",
	"PUSHING",
	"STOPPED",
	"ERROR",
] as const;
export type FeederStatus = (typeof FEEDER_STATUSES)[number];

export const FEEDER_STATUS_TONE: Record<
	FeederStatus,
	"neutral" | "ok" | "error"
> = {
	CREATED: "neutral",
	DOWNLOADING: "neutral",
	PUSHING: "ok",
	STOPPED: "neutral",
	ERROR: "error",
};

export function isActiveFeederStatus(status: FeederStatus): boolean {
	return (
		status === "CREATED" || status === "DOWNLOADING" || status === "PUSHING"
	);
}

/**
 * Can this session still be stopped? (audit 2026-08-29 CRITICAL-2)
 *
 * Not the same question as "is it active". A START job that dies outside the
 * worker leaves the row ERROR with its pid KEPT — and a `-stream_loop -1`
 * ffmpeg still pushing into a live ingest. Gating the stop button on the
 * status alone hid the only control that reaches the worker's kill ladder,
 * exactly when an operator most needs it; the API's own guards use the same
 * predicate, so the button and the route agree by construction.
 */
export function isStoppableFeederSession(
	session: Pick<
		FeederSessionListItem,
		| "status"
		| "pid"
		| "processGoneAt"
		| "publisherClaimedAt"
		| "publisherReleasedAt"
	>,
): boolean {
	return (
		isActiveFeederStatus(session.status) ||
		feederProcessMayBeAlive(session) ||
		feederPublisherClaimHeld({
			publisherClaimedAt: session.publisherClaimedAt ?? null,
			publisherReleasedAt: session.publisherReleasedAt ?? null,
		})
	);
}

/**
 * Does this session OCCUPY its channel's single publisher slot, as the server's
 * admission counts it? The panel used `status` alone
 * to decide whether to offer the switch checkbox, so a channel occupied by a
 * terminal row whose ffmpeg was not proven gone had the create refused by
 * the route (correctly) with no switch on offer — a dead end. Core's
 * predicate reads the same three facts the route's `feederOccupancyWhere`
 * counts. The fields remain optional for wire compatibility, but the LC-02
 * rollout forbids mixed-version publisher execution and the claim-aware list
 * route always projects both; an omitted pair therefore means pre-claim UI
 * data, not a durable assertion that no claim exists.
 */
export function isOccupyingFeederSession(
	session: Pick<
		FeederSessionListItem,
		| "status"
		| "pid"
		| "processGoneAt"
		| "commitAt"
		| "publisherClaimedAt"
		| "publisherReleasedAt"
	>,
): boolean {
	return feederOccupiesChannel({
		status: session.status,
		pid: session.pid,
		processGoneAt: session.processGoneAt,
		commitAt: session.commitAt ?? null,
		publisherClaimedAt: session.publisherClaimedAt ?? null,
		publisherReleasedAt: session.publisherReleasedAt ?? null,
	});
}

export type FeederSessionListItem = {
	id: string;
	liveChannelId: string;
	/** Name-only list projection; older responses may omit it. */
	liveChannel?: { name: string };
	status: FeederStatus;
	protocol: "RTMP" | "SRT_CALLER";
	sourceBucket: string;
	sourceKey: string;
	/** ffmpeg pid the row still points at, or null once released. */
	pid: number | null;
	/** When that pid was PROVEN gone; null = never proven, not "alive". */
	processGoneAt: string | null;
	/**
	 * : the two-phase columns. Optional on the type so a response
	 * from a server that predates them still parses; absent reads as an
	 * ordinary single-phase session.
	 */
	commitAt?: string | null;
	readyAt?: string | null;
	committedAt?: string | null;
	switchSeamMs?: number | null;
	/**
	 * the publisher claim. Optional for the same reason
	 * as the two-phase columns; absent reads as "unknown", which occupancy
	 * treats as not-held (the pid/status facts still decide).
	 */
	publisherClaimedAt?: string | null;
	publisherReleasedAt?: string | null;
	startedAt: string | null;
	stoppedAt: string | null;
	error: string | null;
	/** True when the raw stored error is available only through Diagnostics. */
	internalFailure?: boolean;
	createdAt: string;
	updatedAt: string;
};

/**
 * : what a two-phase session is doing while its status still reads
 * DOWNLOADING. `STAGING` = the source is being downloaded and gated; `READY`
 * = staged and HOLDING for the commit (no ffmpeg yet). Null for a session
 * that is not two-phase, or has moved past the hold — PUSHING says the rest.
 */
export type FeederSwitchPhase = "STAGING" | "READY" | null;

/** The phase chip's copy — both catalogues, exhaustive over the phases. */
export const FEEDER_PHASE_KEY: Record<
	Exclude<FeederSwitchPhase, null>,
	MessageKey
> = {
	STAGING: "feeder.phaseStaging",
	READY: "feeder.phaseReady",
};

export function feederSwitchPhase(
	session: Pick<
		FeederSessionListItem,
		"status" | "commitAt" | "readyAt" | "committedAt"
	>,
): FeederSwitchPhase {
	if (!session.commitAt || session.status !== "DOWNLOADING") {
		return null;
	}
	if (session.committedAt) {
		return null;
	}
	return session.readyAt ? "READY" : "STAGING";
}

/**
 * The POST /api/feeder-sessions body the panel sends — built here so the
 * switch flag  is pinned by a test that does not have to drive the
 * storage picker to reach the submit button.
 */
export function feederCreateBody(form: {
	channelId: string;
	source: { credentialId: string; bucket: string; key: string };
	protocol: "RTMP" | "SRT_CALLER";
	rtmpUrl: string;
	streamKey: string;
	srtHost: string;
	srtPort: string;
	passphraseCredentialId: string;
	/** The operator's choice, only meaningful while a feeder is active. */
	switchFromActive: boolean;
	hasActiveFeeder: boolean;
}): Record<string, unknown> {
	return {
		liveChannelId: form.channelId,
		source: form.source,
		protocol: form.protocol,
		target:
			form.protocol === "RTMP"
				? { url: form.rtmpUrl, streamKey: form.streamKey }
				: {
						host: form.srtHost,
						port: form.srtPort === "" ? 0 : Number(form.srtPort),
						...(form.passphraseCredentialId
							? { passphraseCredentialId: form.passphraseCredentialId }
							: {}),
					},
		...(form.switchFromActive && form.hasActiveFeeder
			? { switchFromActive: true }
			: {}),
	};
}

export type LoopBoundary = {
	loopIndex: number;
	wallClock: string;
	streamTimeSec: number;
};

/** Customer-facing detail: no process, host, log or loop telemetry. */
export type FeederSessionDetail = Pick<
	FeederSessionListItem,
	| "id"
	| "liveChannelId"
	| "status"
	| "protocol"
	| "sourceBucket"
	| "sourceKey"
	| "startedAt"
	| "stoppedAt"
	| "error"
	| "createdAt"
	| "updatedAt"
> & {
	/** Immutable source identity recorded for this file-input run. */
	sourceEtag?: string | null;
	sourceVersionId?: string | null;
	sourceGeneration?: string | null;
	sourceSize?: string | null;
	sourceSha256?: string | null;
	/** : the normalized loop that was pushed (null until START normalized it). */
	loopProfile?: LoopProfile | null;
	/** Redacted by the route — target.streamKey arrives masked. */
	target: unknown;
	/** Server-derived stop/delete complement; internal ownership stays hidden. */
	stoppable: boolean;
	/** Raw diagnostic text was withheld from this customer projection. */
	internalFailure: boolean;
};

/** ADMIN/owner-only payload, fetched only after opening Diagnostics. */
export type FeederSessionDiagnostics = {
	pid: number | null;
	ownerHost: string | null;
	processGoneAt: string | null;
	logTail: unknown;
	error: string | null;
	loopBoundaryCount: number;
	recentLoopBoundaries: unknown[];
};

export function parseLoopBoundary(value: unknown): LoopBoundary | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.loopIndex !== "number" ||
		typeof record.wallClock !== "string" ||
		typeof record.streamTimeSec !== "number"
	) {
		return null;
	}
	return {
		loopIndex: record.loopIndex,
		wallClock: record.wallClock,
		streamTimeSec: record.streamTimeSec,
	};
}

export function feederFailureMessage(
	t: Translator,
	verb: string,
	err: unknown,
): string {
	return t("live.actionFailed", {
		label: verb,
		message: localizedCustomerError(t, err, "common.requestFailed"),
	});
}

/**
 * Target prefill derived from the channel's ingest coordinates: RTMP push
 * URL from encoderIp (Bitmovin's RTMP app is "live") and the channel
 * streamKey suggested as the feeder stream key; SRT prefills host (the
 * encoder IP) and the channel's listener port when the input is an SRT
 * LISTENER. Everything stays editable in the form.
 */
export function defaultFeederTarget(channel: {
	encoderIp: string | null;
	streamKey: string | null;
	srtListenerPort?: number;
	/**
	 * A REDUNDANT_RTMP channel's ingest points, when it has them.
	 *
	 * `rtmp://<ip>/live` is the simple-RTMP convention and it is WRONG for a redundant input: its
	 * points declare their own application names and stream keys — `liveA/primaryFeed`,
	 * `liveB/backupFeed` — and an encoder listening on those receives nothing at `/live`.
	 *
	 * Measured, not deduced: `live-redundant-rtmp` provisioned, reached RUNNING, accepted a feeder
	 * session, and wrote **zero objects** to its output bucket. `ingest-coordinates.ts` already
	 * builds `rtmp://<ip>/<applicationName>/<streamKey>` for the details screen, so the product
	 * knew the right shape and the feeder prefill did not — an operator clicking "feed this
	 * channel" got the same dead URL the harness did.
	 */
	ingestPoints?: {
		applicationName?: string | null;
		streamKey?: string | null;
	}[];
	/**
	 * A REDUNDANT_RTMP channel's STATIC points, when it has them (the schema
	 * allows exactly one of the two lists). These do not ride the encoder IP at
	 * all — they are a fixed Bitmovin FQDN, so the URL half of the prefill is
	 * complete before the channel reaches RUNNING, unlike every other target
	 * shape here. Only the URL half: a static point carries no literal key
	 * (`redundantRtmpStaticIngestPointSchema` has `streamKeyConfiguration`, an
	 * account-level id, not a key), so the key still comes from the channel and
	 * is "" until one lands. An earlier revision of this comment said "the
	 * prefill is complete", which review-213 disproved by running it.
	 */
	staticIngestPoints?: Partial<RedundantRtmpStaticIngestPoint>[];
}): {
	rtmpUrl: string;
	streamKey: string;
	srtHost: string;
	srtPort: number | undefined;
} {
	const primary = channel.ingestPoints?.[0];
	const application = primary?.applicationName?.trim();
	const staticPoint = (channel.staticIngestPoints?.length ?? 0) > 0;
	return {
		rtmpUrl: staticPoint
			? STATIC_INGEST_URL
			: channel.encoderIp
				? `rtmp://${channel.encoderIp}/${application || "live"}`
				: "",
		/*
		 * A dynamic redundant point carries its OWN stream key; the
		 * channel-level one is the fallback.
		 *
		 * A STATIC point gets NEITHER, and that is a correction (measured
		 * 2026-08-21, ). This used to fall through to
		 * `channel.streamKey` — which is the PLAN's `start.streamKey`, our own
		 * value, and is never what the static ingest accepts. Bitmovin answers
		 * `streamKeyConfiguration: GENERATE` by minting a TEMPORARY StreamKey
		 * resource whose `value` is a 22-character string, reachable only
		 * through the per-key reveal GET. Pushing with anything else is refused:
		 *
		 *   Server error: stream with rtmpApp='live' and streamkey='…'
		 *   is not ingestible or doesn't exist
		 *
		 * Measured with our value AND with the key resource's id — both
		 * refused, both with the encoder sitting in
		 * WAITING_FOR_FIRST_CONNECT until ffmpeg exhausted its restarts. The
		 * revealed value connected immediately, everything else unchanged.
		 *
		 * So: empty. An operator copying a plausible-looking key that cannot
		 * work is worse off than one who sees a blank field and goes to the
		 * stream-keys screen — this is 's lesson (the prefill handed
		 * out a dead URL) applied to the half that fix did not cover.
		 */
		streamKey: staticPoint
			? ""
			: primary?.streamKey?.trim() || channel.streamKey || "",
		srtHost: channel.encoderIp ?? "",
		srtPort: channel.srtListenerPort,
	};
}

/**
 * The fixed ingest FQDN a static redundant point pushes to — imported by
 * `ingest-coordinates.ts` for the detail screen .
 *
 * live-INPUT, not live-ingest: the wrong hostname came verbatim from the
 * description in Bitmovin's own template schema (the vendored fixture keeps
 * it — their file, their typo). The March-2024 static-ingest announcement
 * spells live-input, and DNS settles it with STATUS (dig 2026-08-17:
 * live-input NOERROR A 35.240.82.61; live-ingest NXDOMAIN — the name
 * does not exist at all).
 */
// Single source moved to core (2026-08-23) — the verify harness pushes to
// the same FQDN; a drifted copy here would feed the wrong host.
export { STATIC_INGEST_URL };

/** The prefillable target fields in form input-value form (srtPort string). */
export type FeederTargetFields = {
	rtmpUrl: string;
	streamKey: string;
	srtHost: string;
	srtPort: string;
};

/**
 * defaultFeederTarget shaped for the form inputs ("" = unknown port).
 *
 * The ingest-point fields are declared REQUIRED (no `?`), which is the whole
 * point of this signature: 's fix was written into
 * `defaultFeederTarget` — measured evidence and all — while THIS wrapper, the
 * only one the product calls, had no such parameter, so the excess-property
 * check would have rejected the correct call. A documented fix sat one hop
 * from the shipping path for the entire time the channel wrote zero objects.
 * Required means a non-redundant caller passes `undefined` deliberately and
 * the compiler, not a grep, enumerates the population.
 */
export function feederTargetFields(channel: {
	encoderIp: string | null;
	streamKey: string | null;
	srtListenerPort?: number;
	ingestPoints:
		| { applicationName?: string | null; streamKey?: string | null }[]
		| undefined;
	staticIngestPoints: Partial<RedundantRtmpStaticIngestPoint>[] | undefined;
}): FeederTargetFields {
	const target = defaultFeederTarget(channel);
	return {
		rtmpUrl: target.rtmpUrl,
		streamKey: target.streamKey,
		srtHost: target.srtHost,
		srtPort: target.srtPort !== undefined ? String(target.srtPort) : "",
	};
}

/**
 * Reseed decision for when the channel's ingest coordinates arrive late
 * (encoderIp lands only once RUNNING): a field follows the new prefill ONLY
 * while it still equals the previous prefill — i.e. the user has not edited
 * it. In-progress custom targets always survive the reseed.
 */
export function reseedFeederTarget(
	current: FeederTargetFields,
	previousPrefill: FeederTargetFields,
	nextPrefill: FeederTargetFields,
): FeederTargetFields {
	const pick = (field: keyof FeederTargetFields) =>
		current[field] === previousPrefill[field]
			? nextPrefill[field]
			: current[field];
	return {
		rtmpUrl: pick("rtmpUrl"),
		streamKey: pick("streamKey"),
		srtHost: pick("srtHost"),
		srtPort: pick("srtPort"),
	};
}
