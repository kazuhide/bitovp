import { describe, expect, it } from "vitest";
import {
	appendMoqLiveSample,
	type MoqMetricSample,
	moqViewerMetricSeries,
} from "./metric-series";

const startedAt = "2026-11-19T06:02:00.000Z";
const origin = Date.parse(startedAt);
const emptyPoint = {
	latencyMs: null,
	videoFps: null,
	canvasUpdates: null,
	legacyFrameRate: null,
	playerBufferSeconds: null,
	videoBufferSeconds: null,
	legacyBufferSeconds: null,
};

function sample(
	elapsedMs: number,
	fields: Partial<MoqMetricSample> = {},
): MoqMetricSample {
	return {
		elapsedMs,
		latencyMs: null,
		fps: null,
		bufferSeconds: null,
		...fields,
	};
}

describe("MoQ viewer metric series", () => {
	it("routes video presentation, Canvas updates and legacy frame rates to distinct series", () => {
		const rows = moqViewerMetricSeries(
			[
				sample(1000, { fps: 30, renderingSource: "video" }),
				sample(2000, { fps: 0, renderingSource: "canvas" }),
				sample(3000, { fps: 28, renderingSource: "video" }),
				sample(4000, { fps: 16 }),
				sample(5000, { renderingSource: "canvas" }),
			],
			startedAt,
		);
		expect(rows).toEqual([
			{ ...emptyPoint, timestamp: origin + 1000, videoFps: 30 },
			{ ...emptyPoint, timestamp: origin + 2000, canvasUpdates: 0 },
			{ ...emptyPoint, timestamp: origin + 3000, videoFps: 28 },
			{ ...emptyPoint, timestamp: origin + 4000, legacyFrameRate: 16 },
			{ ...emptyPoint, timestamp: origin + 5000 },
		]);
	});

	it("routes player, native video and legacy buffer readings to distinct series", () => {
		const rows = moqViewerMetricSeries(
			[
				sample(1000, { bufferSeconds: 2, bufferSource: "player" }),
				sample(2000, { bufferSeconds: 0, bufferSource: "video" }),
				sample(3000, { bufferSeconds: 1.5, bufferSource: "player" }),
				sample(4000, { bufferSeconds: 0.5, bufferSource: null }),
				sample(5000, { bufferSource: "player" }),
			],
			startedAt,
		);
		expect(rows).toEqual([
			{ ...emptyPoint, timestamp: origin + 1000, playerBufferSeconds: 2 },
			{ ...emptyPoint, timestamp: origin + 2000, videoBufferSeconds: 0 },
			{ ...emptyPoint, timestamp: origin + 3000, playerBufferSeconds: 1.5 },
			{ ...emptyPoint, timestamp: origin + 4000, legacyBufferSeconds: 0.5 },
			{ ...emptyPoint, timestamp: origin + 5000 },
		]);
	});

	it("breaks long gaps while preserving explicit latency zero and the 2500 ms boundary", () => {
		const rows = moqViewerMetricSeries(
			[
				sample(1000, { latencyMs: 625 }),
				sample(3500, { latencyMs: 0, fps: 23, renderingSource: "video" }),
				sample(6001, { latencyMs: 795, fps: 25, renderingSource: "video" }),
			],
			startedAt,
		);
		expect(rows).toEqual([
			{ ...emptyPoint, timestamp: origin + 1000, latencyMs: 625 },
			{ ...emptyPoint, timestamp: origin + 3500, latencyMs: 0, videoFps: 23 },
			{ ...emptyPoint, timestamp: origin + 4500 },
			{ ...emptyPoint, timestamp: origin + 6001, latencyMs: 795, videoFps: 25 },
		]);
	});

	it.each([
		1997, 2002, 2500,
	])("connects a saved interval of %i ms without inventing a missing point", (intervalMs) => {
		const points = moqViewerMetricSeries(
			[
				sample(1000, { fps: 17, latencyMs: 1642, bufferSeconds: 1.62 }),
				sample(1000 + intervalMs, {
					fps: 0,
					latencyMs: 0,
					bufferSeconds: 0,
				}),
			],
			startedAt,
		);
		expect(points).toEqual([
			{
				...emptyPoint,
				timestamp: origin + 1000,
				latencyMs: 1642,
				legacyFrameRate: 17,
				legacyBufferSeconds: 1.62,
			},
			{
				...emptyPoint,
				timestamp: origin + 1000 + intervalMs,
				latencyMs: 0,
				legacyFrameRate: 0,
				legacyBufferSeconds: 0,
			},
		]);
	});

	it("preserves individual missing measurements inside a continuous saved interval", () => {
		const points = moqViewerMetricSeries(
			[
				sample(1000, { latencyMs: 1642, fps: 17, bufferSeconds: 1.62 }),
				sample(2999, { fps: 16, bufferSeconds: 1.5 }),
				sample(4000, { latencyMs: 1648, bufferSeconds: 1.4 }),
				sample(6000, { latencyMs: 1650, fps: 16 }),
			],
			startedAt,
		);
		expect(
			points.map(({ latencyMs, legacyFrameRate, legacyBufferSeconds }) => [
				latencyMs,
				legacyFrameRate,
				legacyBufferSeconds,
			]),
		).toEqual([
			[1642, 17, 1.62],
			[null, 16, 1.5],
			[1648, null, 1.4],
			[1650, 16, null],
		]);
	});

	it("requires a valid clock origin", () => {
		expect(
			moqViewerMetricSeries([sample(1000, { latencyMs: 625 })], ""),
		).toEqual([]);
	});
});

describe("live MoQ metric samples", () => {
	it("holds at most the latest 60 observations without mutating earlier state", () => {
		let samples: readonly MoqMetricSample[] = [];
		for (let i = 0; i < 60; i++) {
			samples = appendMoqLiveSample(samples, sample(i * 1000));
		}
		const previous = Object.freeze(samples);
		samples = appendMoqLiveSample(samples, sample(60_000, { latencyMs: 0 }));
		expect(samples).toHaveLength(60);
		expect(samples[0]?.elapsedMs).toBe(1000);
		expect(samples.at(-1)).toEqual(sample(60_000, { latencyMs: 0 }));
		expect(previous[0]?.elapsedMs).toBe(0);
	});

	it.each([
		-1,
		0.5,
		NaN,
		Infinity,
		1000,
		900,
	])("discards invalid or nonincreasing elapsed time %s", (elapsedMs) => {
		const previous = [sample(1000)];
		expect(appendMoqLiveSample(previous, sample(elapsedMs))).toBe(previous);
	});

	it("can keep measuring after the saved observation window", () => {
		const previous = [sample(600_000)];
		const next = sample(601_000, { latencyMs: 420 });
		expect(appendMoqLiveSample(previous, next)).toEqual([...previous, next]);
	});
});
