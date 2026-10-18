import { describe, expect, it } from "vitest";
import {
	computePooled,
	computePsnrPooled,
	PSNR_MAX_DB,
	parseVmafJson,
} from "./pooled";

/**
 * Pure pooling — hand-computed expectations (see the python cross-check in
 * the PR notes) plus degenerate cases. Percentiles use the (n−1) linear
 * convention; low1Percent uses ceil (≥1 frame). computePooled takes parsed
 * frames; `framesOf` wraps bare scores as in-order frames for the score-math
 * cases (frameNum == index), and a dedicated case below exercises the
 * drop-aware worstFrame.frameNum.
 */
const framesOf = (scores: number[]) =>
	scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));

describe("computePooled", () => {
	it("matches hand-computed stats for a 10-frame descending set", () => {
		// scores 100..10; sorted ascending 10..100, n=10.
		const scores = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
		const m = computePooled(framesOf(scores));
		expect(m.mean).toBeCloseTo(55, 10);
		expect(m.harmonicMean).toBeCloseTo(34.14171521474054, 10);
		expect(m.min).toBe(10);
		expect(m.max).toBe(100);
		expect(m.percentiles.p1).toBeCloseTo(10.9, 10);
		expect(m.percentiles.p5).toBeCloseTo(14.5, 10);
		expect(m.percentiles.p10).toBeCloseTo(19, 10);
		expect(m.percentiles.p25).toBeCloseTo(32.5, 10);
		expect(m.percentiles.p50).toBeCloseTo(55, 10);
		// lowest 1% of 10 frames ⇒ ceil(0.1)=1 ⇒ just the min.
		expect(m.low1Percent).toBeCloseTo(10, 10);
		// worst frame is the 10-score, at original index 9.
		expect(m.worstFrame).toEqual({ frameNum: 9, vmaf: 10 });
	});

	it("matches hand-computed stats for a 5-frame set", () => {
		const scores = [95, 80, 70, 60, 50];
		const m = computePooled(framesOf(scores));
		expect(m.mean).toBeCloseTo(71, 10);
		expect(m.harmonicMean).toBeCloseTo(67.5870246463962, 10);
		expect(m.percentiles.p1).toBeCloseTo(50.4, 10);
		expect(m.percentiles.p5).toBeCloseTo(52, 10);
		expect(m.percentiles.p10).toBeCloseTo(54, 10);
		expect(m.percentiles.p25).toBeCloseTo(60, 10);
		expect(m.percentiles.p50).toBeCloseTo(70, 10);
		expect(m.low1Percent).toBeCloseTo(50, 10);
		expect(m.worstFrame).toEqual({ frameNum: 4, vmaf: 50 });
	});

	it("uses ceil so a 200-frame clip's low1% averages its worst 2 frames", () => {
		// 198 perfect frames + two low ones (20, 40). worst-2 mean = 30.
		const scores = [...Array(198).fill(100), 40, 20];
		const m = computePooled(framesOf(scores));
		expect(m.low1Percent).toBeCloseTo(30, 10); // (20+40)/2
		expect(m.worstFrame.vmaf).toBe(20);
	});

	it("reports the true libvmaf frameNum for the worst frame after a drop", () => {
		// Non-contiguous frameNums (a middle frame was dropped in parsing): the
		// worst frame is libvmaf #5, NOT array index 1. This is why computePooled
		// takes frames, not bare scores.
		const m = computePooled([
			{ frameNum: 0, vmaf: 90 },
			{ frameNum: 5, vmaf: 20 },
			{ frameNum: 9, vmaf: 80 },
		]);
		expect(m.worstFrame).toEqual({ frameNum: 5, vmaf: 20 });
		expect(m.min).toBe(20);
	});

	it("handles a single frame (all metrics collapse to it)", () => {
		const m = computePooled(framesOf([88.5]));
		expect(m.mean).toBe(88.5);
		expect(m.harmonicMean).toBeCloseTo(88.5, 10);
		expect(m.min).toBe(88.5);
		expect(m.max).toBe(88.5);
		expect(m.percentiles).toEqual({
			p1: 88.5,
			p5: 88.5,
			p10: 88.5,
			p25: 88.5,
			p50: 88.5,
		});
		expect(m.low1Percent).toBe(88.5);
		expect(m.worstFrame).toEqual({ frameNum: 0, vmaf: 88.5 });
	});

	it("handles all-equal frames", () => {
		const m = computePooled(framesOf([75, 75, 75, 75]));
		expect(m.mean).toBe(75);
		expect(m.harmonicMean).toBeCloseTo(75, 10);
		expect(m.min).toBe(75);
		expect(m.max).toBe(75);
		expect(m.percentiles.p1).toBe(75);
		expect(m.percentiles.p50).toBe(75);
		expect(m.low1Percent).toBe(75);
		expect(m.worstFrame).toEqual({ frameNum: 0, vmaf: 75 });
	});

	it("throws on an empty frame array", () => {
		expect(() => computePooled([])).toThrow(/at least one frame/);
	});
});

describe("parseVmafJson", () => {
	it("lifts frames + pooled vmaf from the libvmaf JSON shape", () => {
		const raw = {
			frames: [
				{ frameNum: 0, metrics: { vmaf: 90.1, psnr_y: 40 } },
				{ frameNum: 1, metrics: { vmaf: 85.2 } },
			],
			pooled_metrics: {
				vmaf: { min: 85.2, max: 90.1, mean: 87.65, harmonic_mean: 87.6 },
				psnr_y: { min: 38, max: 42, mean: 40, harmonic_mean: 39.9 },
			},
		};
		const parsed = parseVmafJson(raw);
		// psnr_y is now lifted into `psnr` per frame (P4-PR5); the frame without
		// a psnr_y metric stays psnr-absent.
		expect(parsed.frames).toEqual([
			{ frameNum: 0, vmaf: 90.1, psnr: 40 },
			{ frameNum: 1, vmaf: 85.2 },
		]);
		// pooled_metrics.psnr_y is NOT lifted into ParsedVmaf.pooled (that block
		// stays VMAF-only — the runner re-pools PSNR from the per-frame values).
		expect(parsed.pooled).toEqual({
			min: 85.2,
			max: 90.1,
			mean: 87.65,
			harmonicMean: 87.6,
		});
	});

	it("indexes frames missing frameNum and drops frames without a vmaf metric", () => {
		const parsed = parseVmafJson({
			frames: [
				{ metrics: { vmaf: 50 } },
				{ metrics: { psnr_y: 30 } }, // no vmaf ⇒ dropped
				{ metrics: { vmaf: 60 } },
			],
		});
		// second source frame dropped; surviving frames keep positional index.
		expect(parsed.frames).toEqual([
			{ frameNum: 0, vmaf: 50 },
			{ frameNum: 2, vmaf: 60 },
		]);
		expect(parsed.pooled).toBeUndefined();
	});

	it("tolerates an empty / pooled-only document", () => {
		expect(parseVmafJson({}).frames).toEqual([]);
		expect(parseVmafJson({ frames: [] }).pooled).toBeUndefined();
	});

	it("feeds computePooled end-to-end", () => {
		const parsed = parseVmafJson({
			frames: [
				{ frameNum: 0, metrics: { vmaf: 100 } },
				{ frameNum: 1, metrics: { vmaf: 50 } },
			],
		});
		const pooled = computePooled(parsed.frames);
		expect(pooled.mean).toBe(75);
		expect(pooled.min).toBe(50);
		expect(pooled.worstFrame).toEqual({ frameNum: 1, vmaf: 50 });
	});
});

describe("parseVmafJson — PSNR (P4-PR5)", () => {
	it("lifts metrics.psnr_y into psnr per frame", () => {
		const parsed = parseVmafJson({
			frames: [
				{ frameNum: 0, metrics: { vmaf: 90, psnr_y: 42.5 } },
				{ frameNum: 1, metrics: { vmaf: 88, psnr_y: 39.1 } },
			],
		});
		expect(parsed.frames).toEqual([
			{ frameNum: 0, vmaf: 90, psnr: 42.5 },
			{ frameNum: 1, vmaf: 88, psnr: 39.1 },
		]);
	});

	it("caps an Infinity psnr (identical frame) at PSNR_MAX_DB", () => {
		// libvmaf emits inf for identical frames; a too-large JSON literal also
		// parses to Infinity (built at runtime here to avoid the lint on 1e400).
		const overflow = 1 / 0; // === Infinity
		const parsed = parseVmafJson({
			frames: [
				{
					frameNum: 0,
					metrics: { vmaf: 100, psnr_y: Number.POSITIVE_INFINITY },
				},
				{ frameNum: 1, metrics: { vmaf: 100, psnr_y: overflow } },
				{ frameNum: 2, metrics: { vmaf: 100, psnr_y: 250 } }, // over-cap finite
			],
		});
		expect(parsed.frames.map((f) => f.psnr)).toEqual([
			PSNR_MAX_DB,
			PSNR_MAX_DB,
			PSNR_MAX_DB,
		]);
		// And the capped value is finite + JSON-safe (Infinity would stringify null).
		expect(JSON.parse(JSON.stringify(parsed.frames))[0].psnr).toBe(PSNR_MAX_DB);
	});

	it("leaves psnr absent when the log has no psnr_y (VMAF-only run)", () => {
		const parsed = parseVmafJson({
			frames: [
				{ frameNum: 0, metrics: { vmaf: 90 } },
				{ frameNum: 1, metrics: { vmaf: 80 } },
			],
		});
		expect(parsed.frames).toEqual([
			{ frameNum: 0, vmaf: 90 },
			{ frameNum: 1, vmaf: 80 },
		]);
		expect(parsed.frames.every((f) => !("psnr" in f))).toBe(true);
	});
});

describe("computePsnrPooled (P4-PR5)", () => {
	it("returns mean/min/max in dB", () => {
		expect(computePsnrPooled([40, 38, 42, 41])).toEqual({
			mean: (40 + 38 + 42 + 41) / 4,
			min: 38,
			max: 42,
		});
	});

	it("collapses to the single value for a one-element set", () => {
		expect(computePsnrPooled([45.25])).toEqual({
			mean: 45.25,
			min: 45.25,
			max: 45.25,
		});
	});

	it("returns undefined for an empty array (feature off, not a bug)", () => {
		expect(computePsnrPooled([])).toBeUndefined();
	});
});
