import type { AlertMetric, RunHealthPoint } from "@bitovp/core";
import type {
	HeartbeatEventRow,
	HeartbeatStreamRow,
	HeartbeatView,
} from "./heartbeat";

/* Pure delivery-status projections group observations by input, encoder, and output. Each card combines its lane across sources so operators do not have to reconcile contradictory source-specific panels. Functions receive timestamps and persisted records explicitly rather than owning a clock. */

export const DELIVERY_LANES = ["ingest", "encoder", "output"] as const;
export type DeliveryLane = (typeof DELIVERY_LANES)[number];

/* Map every alert metric to its input, encoder, or output card. A stale heartbeat and provider warning belong to the encoder, not the input connection. An exhaustive Record makes newly added metrics a compile error until assigned. */
export const ALERT_LANE: Record<AlertMetric, DeliveryLane> = {
	INPUT_DISCONNECTED: "ingest",
	HEARTBEAT_STALE: "encoder",
	BITRATE_BELOW: "ingest",
	FPS_BELOW: "ingest",
	PROGRAM_START_NO_INGEST: "ingest",
	ORIGIN_MANIFEST_STALE: "output",
	ORIGIN_ENDLIST_PRESENT: "output",
	ORIGIN_EDGE_DELAY_ABOVE: "output",
	PROVIDER_WARNING: "encoder",
};

/** Open-alert count per card; a metric this build does not know counts nowhere. */
export function openAlertsByLane(
	events: readonly { rule: { metric: string } }[],
): Record<DeliveryLane, number> {
	const counts: Record<DeliveryLane, number> = {
		ingest: 0,
		encoder: 0,
		output: 0,
	};
	for (const event of events) {
		if (!Object.hasOwn(ALERT_LANE, event.rule.metric)) {
			continue;
		}
		const lane = ALERT_LANE[event.rule.metric as AlertMetric];
		if (lane !== undefined) {
			counts[lane] += 1;
		}
	}
	return counts;
}

/**
 * `on`/`off` are the derived health point (the same booleans the timeline
 * draws); `unknown` is a live run with no CURRENT point — either nothing
 * yet or a sample past its window, and the timeline's own stale/no-data
 * line says which; `unobservable` is the DASH-only output lane (the
 * heartbeat carries HLS only — grey, never red); `ended` is a finished
 * run, whose cards are a post-mortem and not a claim about now.
 */
export type LampState = "on" | "off" | "unknown" | "unobservable" | "ended";

export function laneLamps(input: {
	mode: "live" | "finished";
	latest: RunHealthPoint | undefined;
	outputObservable: boolean;
}): Record<DeliveryLane, LampState> {
	if (input.mode === "finished") {
		return { ingest: "ended", encoder: "ended", output: "ended" };
	}
	if (!input.latest) {
		return {
			ingest: "unknown",
			encoder: "unknown",
			output: input.outputObservable ? "unknown" : "unobservable",
		};
	}
	return {
		ingest: input.latest.ingest ? "on" : "off",
		encoder: input.latest.encoder ? "on" : "off",
		output: !input.outputObservable
			? "unobservable"
			: input.latest.output
				? "on"
				: "off",
	};
}

/* Last-seen labels expose future timestamps as clock skew, use absolute sample times for finished runs, and treat invalid timestamps as unavailable rather than rendering NaN. */
export type LastSeen =
	| { kind: "never" }
	| { kind: "skew" }
	| { kind: "ago"; seconds: number }
	| { kind: "at"; at: string };

export function lastSeen(
	atIso: string | null,
	nowMs: number,
	live: boolean,
): LastSeen {
	if (atIso === null) {
		return { kind: "never" };
	}
	const atMs = Date.parse(atIso);
	if (!Number.isFinite(atMs)) {
		return { kind: "never" };
	}
	if (!live) {
		return { kind: "at", at: atIso };
	}
	return atMs > nowMs
		? { kind: "skew" }
		: { kind: "ago", seconds: Math.round((nowMs - atMs) / 1000) };
}

/** What the origin observer (#161) last saw, as one word plus its figures. */
export type OriginSummary = {
	state: "none" | "unavailable" | "stale" | "advancing";
	lastFetchAtMs: number | null;
	playlists: number;
	stale: number;
	maxEdgeDelaySeconds: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function summarizeOrigin(observation: unknown): OriginSummary {
	const record = asRecord(observation);
	const lastFetchAtMs =
		typeof record?.lastFetchAtMs === "number" &&
		Number.isFinite(new Date(record.lastFetchAtMs).getTime())
			? record.lastFetchAtMs
			: null;
	const unavailableReason =
		typeof record?.unavailableReason === "string"
			? record.unavailableReason
			: "";
	const verdicts = Object.values(asRecord(record?.lastVerdicts) ?? {})
		.map(asRecord)
		.filter(
			(v): v is Record<string, unknown> =>
				v !== null &&
				typeof v.stale === "boolean" &&
				typeof v.endlist === "boolean",
		);
	const stale = verdicts.filter((v) => v.stale || v.endlist).length;
	const delays = verdicts
		.map((v) => v.edgeDelaySeconds)
		.filter((s): s is number => typeof s === "number" && Number.isFinite(s));
	const maxEdgeDelaySeconds = delays.length > 0 ? Math.max(...delays) : null;
	const state: OriginSummary["state"] =
		!record || (lastFetchAtMs === null && !unavailableReason)
			? "none"
			: unavailableReason
				? "unavailable"
				: verdicts.length === 0
					? "none"
					: stale > 0
						? "stale"
						: "advancing";
	return {
		state,
		lastFetchAtMs,
		playlists: verdicts.length,
		stale,
		maxEdgeDelaySeconds,
	};
}

/** Safe reason classification only: never render stored object keys/driver text. */
export function originReadLimitReached(observation: unknown): boolean {
	const record = asRecord(observation);
	return (
		record?.playlistReadLimitReached === true ||
		(typeof record?.unavailableReason === "string" &&
			record.unavailableReason.includes("PLAYLIST_TRUNCATED_AT_256KIB"))
	);
}

/** The video stream row, for the input card's figures; the first row when none says video. */
export function videoStream(
	view: HeartbeatView | null,
): HeartbeatStreamRow | null {
	if (!view || view.streams.length === 0) {
		return null;
	}
	return (
		view.streams.find((s) => s.mediaType.toLowerCase().includes("video")) ??
		view.streams[0] ??
		null
	);
}

/** The encoder's most recent WARNING/ERROR event, or null when it reported none. */
export function latestWarning(
	view: HeartbeatView | null,
): HeartbeatEventRow | null {
	if (!view) {
		return null;
	}
	let latest: HeartbeatEventRow | null = null;
	let latestMs = Number.NEGATIVE_INFINITY;
	for (let i = view.events.length - 1; i >= 0; i -= 1) {
		const event = view.events[i];
		if (
			event &&
			(event.eventType === "WARNING" || event.eventType === "ERROR")
		) {
			const atMs = Date.parse(event.time);
			if (latest === null || (Number.isFinite(atMs) && atMs > latestMs)) {
				latest = event;
				latestMs = Number.isFinite(atMs) ? atMs : Number.NEGATIVE_INFINITY;
			}
		}
	}
	return latest;
}
