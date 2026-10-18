import "server-only";

/**
 * Projection + downsampling for the live heartbeat time-series (the dashboard
 * trend chart). Source rows come from the LiveHeartbeat table ({ at, raw,
 * deltas } — the live-processor contract): `raw` is the cumulative SDK sample,
 * `deltas` are the per-poll counter differences the worker computed. The chart
 * plots the per-poll DELTAS (a spike is an event, not a lifetime total), so the
 * projection lifts the four delta counters, the ingest status, and a
 * representative bitrate/fps when the sample carries them. Secret-free by
 * construction (heartbeat carries none; the column is already redacted).
 */

/** One charted heartbeat point — `at` is the x-axis, the rest are y-series. */
export type HeartbeatHistoryPoint = {
	at: string;
	droppedPacketsVideo: number;
	droppedPacketsAudio: number;
	corruptPacketsVideo: number;
	corruptPacketsAudio: number;
	/** Ingest status at this poll (status-band / reference dots on status change). */
	ingestStatus: string;
	/** Representative stream bitrate (bps) when present in raw — else undefined. */
	bitrate?: number;
	/** Representative stream frame rate (fps) when present in raw — else undefined. */
	fps?: number;
	/**
	 * Representative measured incoming bitrate (bps) when present — the actual
	 * received rate, distinct from the configured `bitrate`. Charted as its own
	 * (right-axis) trend so an input bitrate sag is visible next to packet loss.
	 */
	incomingBitrate?: number;
};

/** A persisted LiveHeartbeat row as projected from Prisma (at is a Date). */
export type HeartbeatRow = {
	at: Date;
	raw: unknown;
	deltas: unknown;
};

/** The four per-poll counter keys plotted as lines. */
const DELTA_KEYS = [
	"droppedPacketsVideo",
	"droppedPacketsAudio",
	"corruptPacketsVideo",
	"corruptPacketsAudio",
] as const;

/**
 * Default point cap shipped to the browser. A 6h window at the 30s sweep is
 * ~720 points (already chartable), but a wide window or a future faster sweep
 * could exceed this — downsample past it, preserving spikes.
 */
export const HEARTBEAT_POINT_CAP = 500;

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

/** Pull a representative bitrate/fps from the first stream that carries one. */
function representativeStream(ingest: Record<string, unknown> | null): {
	bitrate?: number;
	fps?: number;
	incomingBitrate?: number;
} {
	if (!ingest || !Array.isArray(ingest.streams)) {
		return {};
	}
	let bitrate: number | undefined;
	let fps: number | undefined;
	let incomingBitrate: number | undefined;
	for (const entry of ingest.streams) {
		const stream = asRecord(entry);
		if (!stream) {
			continue;
		}
		bitrate ??= asNumber(stream.bitrate);
		fps ??= asNumber(stream.rate ?? stream.fps ?? stream.frameRate);
		incomingBitrate ??= asNumber(stream.incomingBitrate);
		if (
			bitrate !== undefined &&
			fps !== undefined &&
			incomingBitrate !== undefined
		) {
			break;
		}
	}
	return {
		...(bitrate !== undefined ? { bitrate } : {}),
		...(fps !== undefined ? { fps } : {}),
		...(incomingBitrate !== undefined ? { incomingBitrate } : {}),
	};
}

/** Project one persisted row to a chart point (defensive against shape drift). */
export function projectHeartbeatRow(row: HeartbeatRow): HeartbeatHistoryPoint {
	const raw = asRecord(row.raw);
	const ingest = asRecord(raw?.ingest);
	const deltas = asRecord(row.deltas);
	const point: HeartbeatHistoryPoint = {
		at: row.at.toISOString(),
		droppedPacketsVideo: 0,
		droppedPacketsAudio: 0,
		corruptPacketsVideo: 0,
		corruptPacketsAudio: 0,
		ingestStatus:
			typeof ingest?.status === "string" && ingest.status !== ""
				? ingest.status
				: "UNKNOWN",
		...representativeStream(ingest),
	};
	for (const key of DELTA_KEYS) {
		point[key] = asNumber(deltas?.[key]) ?? 0;
	}
	return point;
}

/** A verified push heartbeat: `at` is the provider sample time, `value` the
 * heartbeat body (same shape as a poll row's `raw`). */
export type PushHeartbeatSample = {
	at: Date;
	value: unknown;
};

/** Cumulative counters carried by an ingest record (lifetime totals). */
function cumulativeCounters(
	ingest: Record<string, unknown> | null,
): Record<(typeof DELTA_KEYS)[number], number> {
	const out = {
		droppedPacketsVideo: 0,
		droppedPacketsAudio: 0,
		corruptPacketsVideo: 0,
		corruptPacketsAudio: 0,
	};
	if (ingest) {
		for (const key of DELTA_KEYS) {
			out[key] = asNumber(ingest[key]) ?? 0;
		}
	}
	return out;
}

/**
 * Project push heartbeat samples to chart points. Push carries the SAME
 * cumulative counters as poll, so the per-sample deltas are computed here as
 * the positive difference between consecutive samples (a drop below the prior
 * value — an encoder restart resetting the counter — clamps to 0, since a reset
 * is not packet loss). The first sample has no predecessor, so its deltas are
 * 0. `incomingBitrate`, ingest status and the representative bitrate/fps come
 * straight off each sample. Samples are sorted by `at` first, so caller order
 * does not matter and a run boundary (counter reset) is handled by the clamp.
 */
export function pushHeartbeatPoints(
	samples: PushHeartbeatSample[],
): HeartbeatHistoryPoint[] {
	const sorted = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());
	const points: HeartbeatHistoryPoint[] = [];
	let prev: Record<(typeof DELTA_KEYS)[number], number> | null = null;
	for (const sample of sorted) {
		const value = asRecord(sample.value);
		const ingest = asRecord(value?.ingest);
		const cumulative = cumulativeCounters(ingest);
		const point: HeartbeatHistoryPoint = {
			at: sample.at.toISOString(),
			droppedPacketsVideo: 0,
			droppedPacketsAudio: 0,
			corruptPacketsVideo: 0,
			corruptPacketsAudio: 0,
			ingestStatus:
				typeof ingest?.status === "string" && ingest.status !== ""
					? ingest.status
					: "UNKNOWN",
			...representativeStream(ingest),
		};
		if (prev) {
			for (const key of DELTA_KEYS) {
				const delta = cumulative[key] - prev[key];
				point[key] = delta > 0 ? delta : 0;
			}
		}
		prev = cumulative;
		points.push(point);
	}
	return points;
}

/** The maximum per-poll delta on a point — its "severity" for spike-keeping. */
function severity(point: HeartbeatHistoryPoint): number {
	return Math.max(
		point.droppedPacketsVideo,
		point.droppedPacketsAudio,
		point.corruptPacketsVideo,
		point.corruptPacketsAudio,
	);
}

/**
 * Indices that must survive reduction no matter how aggressive it gets: the
 * FIRST and LAST point of every run of equal `ingestStatus`, plus the final
 * poll. A run's first point is where the status CHANGED, so keeping them all
 * makes the reduced series carry the same change sequence as the full one;
 * keeping each run's last point additionally preserves how long the run
 * lasted, so a disconnect reads as an interval rather than an instant.
 */
function statusRunBoundaries(points: HeartbeatHistoryPoint[]): Set<number> {
	const keep = new Set<number>();
	const n = points.length;
	for (let i = 0; i < n; i++) {
		const status = (points[i] as HeartbeatHistoryPoint).ingestStatus;
		// i === 0 / i === n-1 fall out of these two tests naturally: there is
		// no neighbour to equal, so the endpoint is always a run boundary.
		if (
			i === 0 ||
			(points[i - 1] as HeartbeatHistoryPoint).ingestStatus !== status
		) {
			keep.add(i);
		}
		if (
			i === n - 1 ||
			(points[i + 1] as HeartbeatHistoryPoint).ingestStatus !== status
		) {
			keep.add(i);
		}
	}
	return keep;
}

/**
 * Downsample an ordered point series to at most `cap` points for charting.
 *
 * Two things are preserved, because the chart is read for two different
 * questions:
 *
 * 1. **Packet-loss spikes** — each bucket keeps its WORST point (max delta
 * across the four counters) rather than the mean, so a single bad poll
 * survives reduction instead of being averaged away.
 * 2. **Ingest-status transitions** — every point at which `ingestStatus`
 * differs from its predecessor is kept, along with the last point of each
 * run. The UI derives its status dots by comparing each point with the
 * previous one (`heartbeat-history.tsx`), so without this the reduction
 * could DELETE a disconnect: a short
 * DISCONNECTED → CONNECTED excursion inside a long run vanishing whenever
 * its packet deltas were not the bucket maximum. The guarantee is now
 * exact: the transition sequence derived from the reduced series equals
 * the one derived from the full series, and `healthy` with it (the UI
 * derives healthy FROM the status word, so it cannot diverge).
 *
 * Still lossy, deliberately: per-poll packet DETAIL between the kept points is
 * gone — bucket peaks and run boundaries survive, the samples between them do
 * not, so counts read off the chart are not sums of the window. Timestamps
 * likewise thin out, so the visual gap between two kept points is not a gap in
 * polling.
 *
 * Budgeting: the mandatory points are reserved out of `cap` first and the
 * remaining slots become spike buckets — a count that may legitimately reach
 * ZERO, which is the whole reason the reservation is `Math.max(0, …)`. Review
 * #348 M1: it was `Math.max(1, …)`, so boundaries that exactly filled the cap
 * still bought one bucket pass over the entire range and the reduction
 * returned `cap + 1`. The result is now at most `cap` points whenever the
 * transitions themselves fit, and a series that flaps more than `cap` times
 * returns exactly its boundaries — over budget on purpose, because dropping
 * transitions is the defect this exists to prevent.
 *
 * Series of `cap` or fewer pass through unchanged. Points stay in ascending
 * `at` order.
 */
export function downsampleHeartbeats(
	points: HeartbeatHistoryPoint[],
	cap: number = HEARTBEAT_POINT_CAP,
): HeartbeatHistoryPoint[] {
	if (cap < 1) {
		throw new Error("downsampleHeartbeats cap must be >= 1");
	}
	const n = points.length;
	if (n <= cap) {
		return points;
	}

	// Mandatory first — the spike buckets get whatever budget is left, so the
	// transitions never compete with them for slots.
	const keep = statusRunBoundaries(points);
	// The final poll is the chart's right edge (the liveness signal); it is
	// already a run boundary, kept explicitly so the guarantee is readable.
	keep.add(n - 1);
	// Zero is a legal budget (review #348 M1): when the boundaries already
	// fill the cap there is no slot left to spend on a spike, and the loop
	// below simply does not run. `size` is only read inside it.
	const buckets = Math.max(0, cap - keep.size);
	const size = n / buckets;
	for (let b = 0; b < buckets; b++) {
		const start = Math.floor(b * size);
		const end = Math.min(n, Math.floor((b + 1) * size));
		if (end <= start) {
			continue;
		}
		let worst = start;
		for (let i = start + 1; i < end; i++) {
			if (
				severity(points[i] as HeartbeatHistoryPoint) >
				severity(points[worst] as HeartbeatHistoryPoint)
			) {
				worst = i;
			}
		}
		keep.add(worst);
	}

	return [...keep]
		.sort((a, b) => a - b)
		.map((i) => points[i] as HeartbeatHistoryPoint);
}
