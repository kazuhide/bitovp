import type {
	MoqHeartbeatHistory,
	MoqHeartbeatPoint,
	MoqPushOutput,
} from "./heartbeat";

export function moqHeartbeatSeries(points: readonly MoqHeartbeatPoint[]) {
	return points.map((point) => ({
		...point,
		timestamp: Date.parse(point.observedAt),
		videoMbps:
			point.videoIncomingBitrateBps === null
				? null
				: point.videoIncomingBitrateBps / 1_000_000,
		audioMbps:
			point.audioIncomingBitrateBps === null
				? null
				: point.audioIncomingBitrateBps / 1_000_000,
	}));
}

type SegmentMeasurements = Omit<MoqPushOutput, "sampledAt">;
type SegmentSample = SegmentMeasurements & { timestamp: number };

function measured(point: SegmentMeasurements) {
	return (
		point.segmentProcessingMeanMs !== null ||
		point.segmentProcessingMinMs !== null ||
		point.segmentProcessingMaxMs !== null
	);
}

export function moqOutputSeries(history: MoqHeartbeatHistory): SegmentSample[] {
	const byTime = new Map<number, SegmentSample>();
	const providerTimes = new Set<number>();
	for (const { sampledAt, ...metrics } of history.pushOutput ?? []) {
		const timestamp = Date.parse(sampledAt);
		providerTimes.add(timestamp);
		byTime.set(timestamp, { timestamp, ...metrics });
	}
	for (const point of history.points) {
		if (point.sampledAt !== null)
			providerTimes.add(Date.parse(point.sampledAt));
	}
	for (const point of history.points) {
		const timestamp = Date.parse(point.sampledAt ?? point.observedAt);
		// A provider sample at this instant carries more timing information
		// than a Poll receipt, even when the provider sample records a gap.
		if (point.sampledAt === null && providerTimes.has(timestamp)) continue;
		const existing = byTime.get(timestamp);
		if (existing && measured(existing) && !measured(point)) continue;
		byTime.set(timestamp, {
			timestamp,
			segmentProcessingMeanMs: point.segmentProcessingMeanMs,
			segmentProcessingMinMs: point.segmentProcessingMinMs,
			segmentProcessingMaxMs: point.segmentProcessingMaxMs,
		});
	}
	return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}
