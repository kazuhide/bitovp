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

type SegmentSample = Omit<MoqPushOutput, "sampledAt"> & { timestamp: number };

export function moqOutputSeries(history: MoqHeartbeatHistory): SegmentSample[] {
	const byTime = new Map<number, SegmentSample>();
	for (const { sampledAt, ...metrics } of history.pushOutput ?? []) {
		const timestamp = Date.parse(sampledAt);
		byTime.set(timestamp, { timestamp, ...metrics });
	}
	for (const point of history.points) {
		const timestamp = Date.parse(point.sampledAt ?? point.observedAt);
		const previous = byTime.get(timestamp);
		byTime.set(timestamp, {
			timestamp,
			segmentProcessingMeanMs:
				point.segmentProcessingMeanMs ??
				previous?.segmentProcessingMeanMs ??
				null,
			segmentProcessingMinMs:
				point.segmentProcessingMinMs ??
				previous?.segmentProcessingMinMs ??
				null,
			segmentProcessingMaxMs:
				point.segmentProcessingMaxMs ??
				previous?.segmentProcessingMaxMs ??
				null,
		});
	}
	return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}
