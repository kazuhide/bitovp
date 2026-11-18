import { describe, expect, it } from "vitest";
import type { MoqHeartbeatPoint } from "./heartbeat";
import { moqHeartbeatSeries } from "./heartbeat-series";

describe("Encoder heartbeat chart units", () => {
	it("uses server UTC observations, converts only bits/s to Mbits/s and preserves missing values and actual zero counters", () => {
		const point: MoqHeartbeatPoint = {
			observedAt: "2026-11-18T01:00:00.000Z",
			sampledAt: null,
			source: "poll",
			ingestStatus: "CONNECTED",
			ingestHealthy: true,
			videoIncomingBitrateBps: 2_500_000,
			audioIncomingBitrateBps: null,
			videoFps: 25,
			droppedPacketsVideo: 0,
			droppedPacketsAudio: null,
			corruptPacketsVideo: null,
			corruptPacketsAudio: 2,
			segmentProcessingMeanMs: 30,
			segmentProcessingMinMs: null,
			segmentProcessingMaxMs: 50,
		};
		expect(moqHeartbeatSeries([point])).toEqual([
			{
				...point,
				timestamp: Date.parse(point.observedAt),
				videoMbps: 2.5,
				audioMbps: null,
			},
		]);
	});
});
