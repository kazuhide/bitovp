import {
	newestManifestUpdateMs,
	newProviderEvents,
	type ProviderHeartbeatEvent,
} from "@bitovp/core";

/**
 * Defensive parsing of the persisted heartbeat column ({ at, raw, deltas }
 * — live-processor contract). The SDK packet counters in `raw` are
 * CUMULATIVE since encoding start; `deltas` are per-poll differences
 * computed by the worker (first poll = zero deltas). The dashboard always
 * labels which is which so a lifetime total is never read as a spike.
 */

export type HeartbeatStreamRow = {
	id: string;
	mediaType: string;
	codec: string;
	resolution: string;
	rate: string;
	bitrate: string;
	/** Raw measured bytes/sec; never substitute the nominal bitrate (bits/sec). */
	incomingBitrate: number | null;
	/**
	 * The provider's FOUR key-frame figures (`LiveEncodingHeartbeatIngestStream`:
	 * keyFrameIntervalAvg / Max, and the rolling-minute pair). The column used
	 * to read `keyFrameInterval`, a field the wire never carries, and rendered
	 * "—" on every sample while the provider was reporting 3957 ms average /
	 * 8334 ms max against a 2000 ms threshold (2026-09-02).
	 */
	keyframeAvg: string;
	keyframeMax: string;
	/** "avg / max" over the last minute — absent until the window has a sample. */
	keyframeLastMinute: string;
};

export type HeartbeatCounters = {
	droppedPacketsVideo?: number;
	droppedPacketsAudio?: number;
	corruptPacketsVideo?: number;
	corruptPacketsAudio?: number;
};

export type HeartbeatEventRow = {
	time: string;
	/** The wire word (FIRST_CONNECT / DISCONNECT / RECONNECT / WARNING / ERROR). */
	eventType: string;
	text: string;
};

export type HeartbeatView = {
	at: string | null;
	ingestStatus: string;
	healthy: boolean | null;
	deltas: HeartbeatCounters;
	totals: HeartbeatCounters;
	streams: HeartbeatStreamRow[];
	events: HeartbeatEventRow[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Display only: incomingBitrate is bytes/sec; nominal bitrate is bits/sec.
 * https://developer.bitmovin.com/encoding/docs/live-heartbeat#payload
 * SDK 1.278.0's pull model says bits/sec instead. Sep 7
 * run 7/8 pull samples corroborate bytes/sec: ~569k for normalized ~4.55 Mbps
 * video, ~16.9k for ~132 kbps audio. Keep persisted/raw/parsed values intact.
 */
export function incomingMbps(bytesPerSecond: unknown): string {
	const value = asNumber(bytesPerSecond);
	return value === undefined ? "—" : ((value / 1_000_000) * 8).toFixed(2);
}

function show(value: unknown, suffix = ""): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return `${value}${suffix}`;
	}
	if (typeof value === "string" && value !== "") {
		return value;
	}
	return "—";
}

const COUNTER_KEYS = [
	"droppedPacketsVideo",
	"droppedPacketsAudio",
	"corruptPacketsVideo",
	"corruptPacketsAudio",
] as const;

function counters(source: Record<string, unknown> | null): HeartbeatCounters {
	const out: HeartbeatCounters = {};
	if (!source) {
		return out;
	}
	for (const key of COUNTER_KEYS) {
		const value = asNumber(source[key]);
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

/** Millisecond figure rounded to whole ms — the provider reports fractions. */
function showMs(value: unknown): string {
	const n = asNumber(value);
	return n === undefined ? "—" : `${Math.round(n)}`;
}

export function streamRow(value: unknown, index: number): HeartbeatStreamRow {
	const record = asRecord(value) ?? {};
	const width = asNumber(record.width);
	const height = asNumber(record.height);
	const mediaType =
		typeof record.mediaType === "string"
			? record.mediaType
			: width !== undefined || height !== undefined
				? "VIDEO"
				: "—";
	const lastAvg = asNumber(record.keyFrameIntervalAvgLastMinute);
	const lastMax = asNumber(record.keyFrameIntervalMaxLastMinute);
	return {
		// The wire field is `streamId` ("0", "1"); `id` is kept for older
		// persisted samples.
		id:
			typeof record.streamId === "string"
				? record.streamId
				: typeof record.id === "string"
					? record.id
					: `stream ${index + 1}`,
		mediaType,
		codec: show(record.codec),
		resolution:
			width !== undefined && height !== undefined ? `${width}×${height}` : "—",
		rate: show(record.rate ?? record.sampleRate ?? record.samplingRate),
		bitrate: show(record.bitrate),
		incomingBitrate: asNumber(record.incomingBitrate) ?? null,
		keyframeAvg: showMs(record.keyFrameIntervalAvg),
		keyframeMax: showMs(record.keyFrameIntervalMax),
		keyframeLastMinute:
			lastAvg === undefined && lastMax === undefined
				? "—"
				: `${showMs(lastAvg)} / ${showMs(lastMax)}`,
	};
}

/**
 * One `events[]` entry as the wire carries it — `{ time, details: {
 * eventType, message } }` (SDK `LiveEncodingHeartbeatEvent`). The first cut
 * read `message` at the top level, which the wire never has, so every event
 * rendered as the JSON of its `details` object.
 */
export function eventRow(value: unknown, index: number): HeartbeatEventRow {
	const record = asRecord(value);
	if (!record) {
		return {
			time: "—",
			eventType: "—",
			text: String(value ?? `event ${index + 1}`),
		};
	}
	const time =
		typeof record.time === "string"
			? record.time
			: typeof record.timestamp === "string"
				? record.timestamp
				: "—";
	const details = asRecord(record.details) ?? record;
	const eventType =
		typeof details.eventType === "string" && details.eventType !== ""
			? details.eventType
			: "—";
	if (typeof details.message === "string" && details.message !== "") {
		return { time, eventType, text: details.message };
	}
	if (eventType !== "—") {
		// The connect family carries no message: the type IS the event.
		return { time, eventType, text: eventType };
	}
	const { time: _t, timestamp: _ts, ...rest } = record;
	return { time, eventType, text: JSON.stringify(rest) };
}

/**
 * One row of the per-run heartbeat LOG (the diagnostics table), projected
 * from a persisted `{ at, raw, deltas }` row. Every column names its source
 * field so a reader can find it again in the raw drawer:
 *  - `incomingBitrate` / `fps` come from the FIRST video stream's
 *    `incomingBitrate` (raw bytes/sec, not the container's nominal `bitrate`)
 *    and `rate`;
 *  - `keyframeAvg` / `keyframeMax` are that stream's `keyFrameIntervalAvg` /
 *    `keyFrameIntervalMax` (ms);
 *  - `manifestAgeMs` is poll time minus the newest HLS
 *    `manifestUpdateWallClockTime` (`newestManifestUpdateMs`, the run-health
 *    field) — null when the sample carries no manifest update at all;
 *  - `segmentMeanMs` is `output.segments.totalProcessingStatsMs.mean`;
 *  - `events` is the difference against the PREVIOUS row (`newProviderEvents`
 *    — the provider's list is cumulative), so a row lists only what
 *    appeared at that poll.
 */
export type HeartbeatLogView = {
	id: string;
	at: string;
	ingestStatus: string;
	healthy: boolean | null;
	incomingBitrate: number | null;
	fps: number | null;
	keyframeAvg: number | null;
	keyframeMax: number | null;
	deltas: HeartbeatCounters;
	manifestAgeMs: number | null;
	segmentMeanMs: number | null;
	events: ProviderHeartbeatEvent[];
};

export function heartbeatLogView(
	row: { id: string; at: string; raw: unknown; deltas: unknown },
	previousRaw: unknown,
): HeartbeatLogView {
	const raw = asRecord(row.raw) ?? {};
	const ingest = asRecord(raw.ingest);
	const streams = Array.isArray(ingest?.streams) ? ingest.streams : [];
	const video =
		streams.map(asRecord).find((stream) => {
			if (!stream) {
				return false;
			}
			const type = typeof stream.mediaType === "string" ? stream.mediaType : "";
			return (
				type.toLowerCase() === "video" ||
				asNumber(stream.width) !== undefined ||
				asNumber(stream.height) !== undefined
			);
		}) ?? null;
	const atMs = Date.parse(row.at);
	const newestUpdate = newestManifestUpdateMs(row.raw);
	const segments = asRecord(asRecord(raw.output)?.segments);
	const stats = asRecord(segments?.totalProcessingStatsMs);
	return {
		id: row.id,
		at: row.at,
		ingestStatus:
			typeof ingest?.status === "string" && ingest.status !== ""
				? ingest.status
				: "UNKNOWN",
		healthy: typeof ingest?.healthy === "boolean" ? ingest.healthy : null,
		incomingBitrate: asNumber(video?.incomingBitrate) ?? null,
		fps: asNumber(video?.rate) ?? null,
		keyframeAvg: asNumber(video?.keyFrameIntervalAvg) ?? null,
		keyframeMax: asNumber(video?.keyFrameIntervalMax) ?? null,
		deltas: counters(asRecord(row.deltas)),
		manifestAgeMs:
			newestUpdate !== undefined && Number.isFinite(atMs)
				? atMs - newestUpdate
				: null,
		segmentMeanMs: asNumber(stats?.mean) ?? null,
		events: newProviderEvents(previousRaw, row.raw),
	};
}

/** Null when the channel has never been heartbeat-polled. */
export function parseHeartbeat(lastHeartbeat: unknown): HeartbeatView | null {
	const persisted = asRecord(lastHeartbeat);
	if (!persisted) {
		return null;
	}
	const raw = asRecord(persisted.raw) ?? {};
	const ingest = asRecord(raw.ingest);
	const status =
		typeof ingest?.status === "string" && ingest.status !== ""
			? ingest.status
			: "UNKNOWN";
	return {
		at: typeof persisted.at === "string" ? persisted.at : null,
		ingestStatus: status,
		healthy: typeof ingest?.healthy === "boolean" ? ingest.healthy : null,
		deltas: counters(asRecord(persisted.deltas)),
		totals: counters(ingest),
		streams: Array.isArray(ingest?.streams)
			? ingest.streams.map(streamRow)
			: [],
		events: Array.isArray(raw.events) ? raw.events.map(eventRow) : [],
	};
}
