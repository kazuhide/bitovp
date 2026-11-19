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
	for (const { sampledAt, ...metrics } of history.pushOutput ?? []) {
		const timestamp = Date.parse(sampledAt);
		byTime.set(timestamp, { timestamp, ...metrics });
	}
	for (const point of history.points) {
		const timestamp = Date.parse(point.sampledAt ?? point.observedAt);
		const existing = byTime.get(timestamp);
		// A timed Push sample outranks a collision with the time of an API read.
		// A Poll with the same explicit sample time may replace it as a whole.
		if (
			existing &&
			measured(existing) &&
			(!point.sampledAt || !measured(point))
		)
			continue;
		byTime.set(timestamp, {
			timestamp,
			segmentProcessingMeanMs: point.segmentProcessingMeanMs,
			segmentProcessingMinMs: point.segmentProcessingMinMs,
			segmentProcessingMaxMs: point.segmentProcessingMaxMs,
		});
	}
	return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}
