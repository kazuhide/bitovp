import { describe, expect, it } from "vitest";
import type { MoqHeartbeatPoint } from "./heartbeat";
import { moqHeartbeatSeries, moqOutputSeries } from "./heartbeat-series";

const encoderPoint: MoqHeartbeatPoint = {
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

describe("Encoder heartbeat chart units", () => {
	it("uses server UTC observations, converts only bits/s to Mbits/s and preserves missing values and actual zero counters", () => {
		expect(moqHeartbeatSeries([encoderPoint])).toEqual([
			{
				...encoderPoint,
				timestamp: Date.parse(encoderPoint.observedAt),
				videoMbps: 2.5,
				audioMbps: null,
			},
		]);
	});

	it("chooses a complete sample record at a shared provider time", () => {
		const sampledAt = "2026-11-18T00:59:55.000Z";
		const newer = "2026-11-18T01:00:30.000Z";
		const result = moqOutputSeries({
			source: "live-encoder-heartbeat",
			truncated: false,
			points: [
				{ ...encoderPoint, sampledAt },
				{
					...encoderPoint,
					observedAt: newer,
					segmentProcessingMeanMs: null,
					segmentProcessingMaxMs: null,
				},
			],
			pushOutput: [
				{
					sampledAt,
					segmentProcessingMeanMs: 31,
					segmentProcessingMinMs: 0,
					segmentProcessingMaxMs: null,
				},
			],
		});
		expect(result).toEqual([
			{
				timestamp: Date.parse(sampledAt),
				segmentProcessingMeanMs: 30,
				segmentProcessingMinMs: null,
				segmentProcessingMaxMs: 50,
			},
			{
				timestamp: Date.parse(newer),
				segmentProcessingMeanMs: null,
				segmentProcessingMinMs: null,
				segmentProcessingMaxMs: null,
			},
		]);
	});

	it("does not combine the statistics of a Push sample and an API read at the same clock time", () => {
		const sampledAt = encoderPoint.observedAt;
		const pushed = {
			segmentProcessingMinMs: 40,
			segmentProcessingMeanMs: 45,
			segmentProcessingMaxMs: 50,
		};
		expect(
			moqOutputSeries({
				source: "live-encoder-heartbeat",
				truncated: false,
				points: [
					{
						...encoderPoint,
						segmentProcessingMeanMs: 9,
						segmentProcessingMaxMs: 10,
					},
				],
				pushOutput: [{ sampledAt, ...pushed }],
			}),
		).toEqual([{ timestamp: Date.parse(sampledAt), ...pushed }]);
	});
});
