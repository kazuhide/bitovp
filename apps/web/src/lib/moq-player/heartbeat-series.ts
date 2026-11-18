import type { MoqHeartbeatPoint } from "./heartbeat";

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
