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
	it("keeps recorded metrics continuous across the observed downsampled timer cadence", () => {
		const startedAt = "2026-11-18T00:00:00.000Z";
		const origin = Date.parse(startedAt);
		const samples = [
			{ ...sample(3044, 17), latencyMs: 1642, bufferSeconds: 1.62 },
			{ ...sample(5041, 0), latencyMs: 0, bufferSeconds: 0 },
			{ ...sample(6043, 16), latencyMs: 1649, bufferSeconds: 1.51 },
		];
		expect(moqHistorySeries(samples, startedAt)).toEqual([
			{
				timestamp: origin + 3044,
				seconds: 3.044,
				latencyMs: 1642,
				fps: 17,
				bufferSeconds: 1.62,
			},
			{
				timestamp: origin + 5041,
				seconds: 5.041,
				latencyMs: 0,
				fps: 0,
				bufferSeconds: 0,
			},
			{
				timestamp: origin + 6043,
				seconds: 6.043,
				latencyMs: 1649,
				fps: 16,
				bufferSeconds: 1.51,
			},
		]);
	});
	it.each([
		1997, 2002, 2500,
	])("does not invent an unknown point for a bounded %i ms saved interval", (intervalMs) => {
		const points = moqHistorySeries(
			[sample(1000, 17), sample(1000 + intervalMs, 18)],
			"2026-11-18T00:00:00.000Z",
		);
		expect(points).toHaveLength(2);
		expect(points.map((point) => point.fps)).toEqual([17, 18]);
	});
	it("inserts an unknown point for all metrics beyond the 2500 ms display tolerance", () => {
		const points = moqHistorySeries(
			[
				{ ...sample(1000, 17), latencyMs: 1642, bufferSeconds: 1.62 },
				{ ...sample(3501, 18), latencyMs: 1650, bufferSeconds: 1.5 },
			],
			"2026-11-18T00:00:00.000Z",
		);
		expect(points).toHaveLength(3);
		expect(points[1]).toEqual({
			timestamp: Date.parse("2026-11-18T00:00:02.000Z"),
			seconds: 2,
			latencyMs: null,
			fps: null,
			bufferSeconds: null,
		});
	});
	it("preserves explicit per-metric nulls within normal downsampled intervals", () => {
		const samples = [
			{ ...sample(1000, 17), latencyMs: 1642, bufferSeconds: 1.62 },
			{ ...sample(2999, 16), latencyMs: null, bufferSeconds: 1.5 },
			{ ...sample(4000, null), latencyMs: 1648, bufferSeconds: 1.4 },
			{ ...sample(6000, 17), latencyMs: 1650, bufferSeconds: null },
			sample(7001, null),
		];
		const points = moqHistorySeries(samples, "2026-11-18T00:00:00.000Z");
		expect(points).toHaveLength(samples.length);
		expect(
			points.map(({ latencyMs, fps, bufferSeconds }) => ({
				latencyMs,
				fps,
				bufferSeconds,
			})),
		).toEqual([
			{ latencyMs: 1642, fps: 17, bufferSeconds: 1.62 },
			{ latencyMs: null, fps: 16, bufferSeconds: 1.5 },
			{ latencyMs: 1648, fps: null, bufferSeconds: 1.4 },
			{ latencyMs: 1650, fps: 17, bufferSeconds: null },
			{ latencyMs: null, fps: null, bufferSeconds: null },
		]);
	});
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
