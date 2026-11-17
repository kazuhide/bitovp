import { describe, expect, it } from "vitest";
import { moqHistorySeries } from "./history-series";
import type { MoqObservationSample } from "./observations";

const sample = (
	elapsedMs: number,
	fps: number | null,
): MoqObservationSample => ({
	elapsedMs,
	fps,
	latencyMs: null,
	bufferSeconds: null,
	droppedFrames: null,
	decodedFrames: null,
	presentedFrames: null,
	totalFrames: null,
	resolution: null,
});
describe("saved MoQ chart gaps", () => {
	it("preserves unknown metrics and inserts an explicit gap across missing observation seconds", () => {
		const origin = Date.parse("2026-11-18T00:00:00.000Z");
		const points = moqHistorySeries(
			[sample(1000, 30), sample(4000, null)],
			"2026-11-18T00:00:00.000Z",
		);
		expect(points).toEqual([
			{
				timestamp: origin + 1000,
				seconds: 1,
				latencyMs: null,
				fps: 30,
				bufferSeconds: null,
			},
			{
				timestamp: origin + 2000,
				seconds: 2,
				latencyMs: null,
				fps: null,
				bufferSeconds: null,
			},
			{
				timestamp: origin + 4000,
				seconds: 4,
				latencyMs: null,
				fps: null,
				bufferSeconds: null,
			},
		]);
	});
});
