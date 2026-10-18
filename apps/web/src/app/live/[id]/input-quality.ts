/** Fixed UI heuristics, never encoder/output constraints or automatic actions. */
export type InputQualityWarning =
	| {
			code: "PACKET_ARRIVAL_STALLED";
			params: {
				streamIndex: number;
				mediaType: "VIDEO" | "AUDIO";
				ageSeconds: number;
			};
	  }
	| {
			code: "VIDEO_RATE_LOW";
			params: { streamIndex: number; actualFps: number; declaredFps: number };
	  }
	| {
			code: "VIDEO_GOP_LONG";
			params: { streamIndex: number; maximumMs: number };
	  }
	| {
			code: "PACKET_COUNTERS_INCREASED";
			params: {
				droppedVideo: number;
				droppedAudio: number;
				corruptVideo: number;
				corruptAudio: number;
			};
	  };

const COUNTERS = [
	["droppedPacketsVideo", "droppedVideo"],
	["droppedPacketsAudio", "droppedAudio"],
	["corruptPacketsVideo", "corruptVideo"],
	["corruptPacketsAudio", "corruptAudio"],
] as const;
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function arrivalMs(value: unknown): number | null {
	if (typeof value !== "string" || value.length > 64) return null;
	const match =
		/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
			value,
		);
	if (
		!match ||
		Number(match[2]) > 23 ||
		Number(match[3]) > 59 ||
		Number(match[4]) > 59
	)
		return null;
	const date = Date.parse(`${match[1]}T00:00:00Z`),
		stamp = Date.parse(value);
	// Date.parse normalizes impossible dates such as Feb30; reject them explicitly.
	return Number.isFinite(date) &&
		new Date(date).toISOString().slice(0, 10) === match[1] &&
		Number.isFinite(stamp)
		? stamp
		: null;
}

/**
 * https://developer.bitmovin.com/encoding/docs/live-heartbeat#payload-explanation
 * Arrival is encoder wall clock; FPS average and GOP maximum are rolling 1min.
 * UI thresholds: >=10s without a packet, video average <80% of declared rate,
 * rolling GOP maximum >4000ms. These are heuristics, not output-plan validation.
 * Caller selects fresh telemetry and supplies only the same run's previous
 * distinct sample. Counter growth additionally requires 0<sample gap<=90s;
 * old comparisons, resets, absent values and invalid counters are not warnings.
 * First16 streams only (bounded untrusted input); all resulting warnings are
 * returned, up to48 stream warnings +1 aggregate. Missing audio is not an error.
 */
export function inputQualityWarnings(
	currentRaw: unknown,
	previousRaw: unknown,
	sampleAtMs: number,
	previousSampleAtMs?: number,
): InputQualityWarning[] {
	if (!Number.isFinite(sampleAtMs)) return [];
	const ingest = record(record(currentRaw)?.ingest);
	if (!ingest) return [];
	const warnings: InputQualityWarning[] = [];
	const streams = Array.isArray(ingest.streams)
		? ingest.streams.slice(0, 16)
		: [];
	for (const [index, item] of streams.entries()) {
		const stream = record(item);
		if (!stream) continue;
		const kind =
			typeof stream.mediaType === "string"
				? stream.mediaType.toUpperCase()
				: null;
		if (kind !== "VIDEO" && kind !== "AUDIO") continue;
		const streamIndex = index + 1,
			arrival = arrivalMs(stream.lastArrivalTime);
		if (arrival !== null && sampleAtMs - arrival >= 10_000)
			warnings.push({
				code: "PACKET_ARRIVAL_STALLED",
				params: {
					streamIndex,
					mediaType: kind,
					ageSeconds: (sampleAtMs - arrival) / 1_000,
				},
			});
		if (kind !== "VIDEO") continue;
		const rate = stream.rate,
			average = stream.samplesReadPerSecondAvg;
		if (
			nonnegative(rate) &&
			rate > 0 &&
			nonnegative(average) &&
			average < rate * 0.8
		)
			warnings.push({
				code: "VIDEO_RATE_LOW",
				params: { streamIndex, actualFps: average, declaredFps: rate },
			});
		const maximum = stream.keyFrameIntervalMaxLastMinute;
		if (nonnegative(maximum) && maximum > 4_000)
			warnings.push({
				code: "VIDEO_GOP_LONG",
				params: { streamIndex, maximumMs: maximum },
			});
	}
	const previous = record(record(previousRaw)?.ingest);
	if (
		!previous ||
		previousSampleAtMs === undefined ||
		!Number.isFinite(previousSampleAtMs) ||
		previousSampleAtMs >= sampleAtMs ||
		sampleAtMs - previousSampleAtMs > 90_000
	)
		return warnings;
	const growth = {
		droppedVideo: 0,
		droppedAudio: 0,
		corruptVideo: 0,
		corruptAudio: 0,
	};
	for (const [field, output] of COUNTERS) {
		const before = previous[field],
			after = ingest[field];
		if (
			nonnegative(before) &&
			Number.isSafeInteger(before) &&
			nonnegative(after) &&
			Number.isSafeInteger(after) &&
			after > before
		)
			growth[output] = after - before;
	}
	if (Object.values(growth).some((value) => value > 0))
		warnings.push({ code: "PACKET_COUNTERS_INCREASED", params: growth });
	return warnings;
}
