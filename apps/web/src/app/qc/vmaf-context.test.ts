import { describe, expect, it } from "vitest";
import {
	comparisonContext,
	DEGENERATE_ZERO_SHARE,
	judgeDegenerate,
	ladderSeparation,
} from "./vmaf-context";

/**
 * The case these functions exist for is a real report, so it is the first test: mean
 * 16.77, half the frames at zero, harmonic mean 0. Hours were spent treating it as a
 * pipeline bug before re-scoring the pair by hand reproduced it exactly.
 */

const REAL_REPORT = {
	mean: 16.77047859447005,
	min: 0,
	max: 76.799006,
	harmonicMean: 0,
	low1Percent: 0,
	percentiles: { p1: 0, p5: 0, p10: 0, p25: 0, p50: 2.854175 },
};

describe("judgeDegenerate — the report that started this", () => {
	it("calls the real 16.77 report degenerate from its percentiles alone", () => {
		const verdict = judgeDegenerate(REAL_REPORT);
		expect(verdict.degenerate).toBe(true);
		expect(verdict.reason).toEqual({ kind: "p25-below-one" });
	});

	it("calls it degenerate from the per-frame series too — 106 of 217 below 1.0", () => {
		// The measured shape of the real run: roughly half the frames at zero.
		const frames = [
			...Array.from({ length: 106 }, () => ({ vmaf: 0 })),
			...Array.from({ length: 111 }, (_, i) => ({ vmaf: 20 + (i % 50) })),
		];
		const verdict = judgeDegenerate(REAL_REPORT, frames);
		expect(verdict.degenerate).toBe(true);
		expect(verdict.zeroShare).toBeCloseTo(106 / 217, 3);
	});

	it("does NOT call a merely-low report degenerate", () => {
		// The distinction that matters: an aggressive ladder scores low without being
		// broken. Flagging that as degenerate would recreate the false alarm in reverse.
		const frames = Array.from({ length: 200 }, () => ({ vmaf: 22 }));
		const verdict = judgeDegenerate(
			{
				mean: 22,
				min: 18,
				max: 31,
				harmonicMean: 21.6,
				percentiles: { p25: 20 },
			},
			frames,
		);
		expect(verdict.degenerate).toBe(false);
	});

	it("tolerates a few zero frames — a hard cut is not a defect", () => {
		const frames = [
			...Array.from({ length: 5 }, () => ({ vmaf: 0 })),
			...Array.from({ length: 195 }, () => ({ vmaf: 90 })),
		];
		const verdict = judgeDegenerate(
			{
				mean: 87.7,
				min: 0,
				max: 96,
				harmonicMean: 0,
				percentiles: { p25: 90 },
			},
			frames,
		);
		expect(verdict.degenerate).toBe(false);
		expect(verdict.zeroShare).toBeLessThan(DEGENERATE_ZERO_SHARE);
	});

	it("flags a collapsed harmonic mean when no frames are available", () => {
		// harmonicMean 0 with a positive arithmetic mean means at least one zero frame
		// dominated the aggregate, so the aggregate is not comparable.
		const verdict = judgeDegenerate({
			mean: 88,
			min: 0,
			max: 96,
			harmonicMean: 0,
		});
		expect(verdict.degenerate).toBe(true);
	});

	it("sits exactly at the threshold without tipping over it", () => {
		// 20% of 100 is 20 zero frames: `> DEGENERATE_ZERO_SHARE`, so 20 must NOT trip
		// and 21 must. Pinned because an off-by-one here changes every verdict.
		const at = judgeDegenerate(REAL_REPORT, [
			...Array.from({ length: 20 }, () => ({ vmaf: 0 })),
			...Array.from({ length: 80 }, () => ({ vmaf: 90 })),
		]);
		const over = judgeDegenerate(REAL_REPORT, [
			...Array.from({ length: 21 }, () => ({ vmaf: 0 })),
			...Array.from({ length: 79 }, () => ({ vmaf: 90 })),
		]);
		expect(at.degenerate).toBe(false);
		expect(over.degenerate).toBe(true);
	});
});

describe("comparisonContext — the fact that was missing", () => {
	it("states the upscale factor for the real case", () => {
		const context = comparisonContext({
			renditionHeight: 360,
			referenceHeight: 1080,
			model: "vmaf_v1.0.16_3d0h",
		});
		// STRUCTURE, not prose: this module decides WHAT was compared, and the banner
		// renders the words through the catalogue. It used to return finished English
		// sentences, so a Japanese operator read English here whatever the catalogue
		// said . The sentence's content is asserted in the banner's own
		// test, in both locales. The WHOLE object, so the variant's payload is pinned
		// as a set — each field is REQUIRED on its variant now, and a piecemeal
		// `context.upscale` no longer typechecks before narrowing (that looseness is
		// what let `kind: "cross-resolution"` travel without an upscale and throw an
		// unfilled-{placeholder} error inside the banner).
		expect(context).toEqual({
			kind: "cross-resolution",
			crossResolution: true,
			renditionHeight: 360,
			referenceHeight: 1080,
			upscale: 3,
			model: "vmaf_v1.0.16_3d0h",
		});
	});

	it("says a native comparison IS a real problem when it scores low", () => {
		const context = comparisonContext({
			renditionHeight: 1080,
			referenceHeight: 1080,
			model: "vmaf_v0.6.1",
		});
		expect(context.crossResolution).toBe(false);
	});

	it("admits when it does not know, instead of inventing terms", () => {
		const context = comparisonContext({ renditionHeight: 360, model: "m" });
		expect(context.crossResolution).toBe(false);
	});

	it("treats a trivially different height as native, not as a 1.0× upscale", () => {
		expect(
			comparisonContext({ renditionHeight: 1080, referenceHeight: 1082 })
				.crossResolution,
		).toBe(false);
	});
});

describe("ladderSeparation", () => {
	it("accepts a ladder where each meaningful bitrate step moves the score", () => {
		const result = ladderSeparation([
			{ label: "360p", bitrate: 300_000, mean: 42 },
			{ label: "540p", bitrate: 600_000, mean: 55 },
			{ label: "720p", bitrate: 1_500_000, mean: 71 },
		]);
		expect(result.separated).toBe(true);
	});

	it("reports a doubled bitrate that changed nothing", () => {
		const result = ladderSeparation([
			{ label: "360p", bitrate: 300_000, mean: 42.0 },
			{ label: "540p", bitrate: 600_000, mean: 42.3 },
		]);
		expect(result.separated).toBe(false);
		// The STEPS, not a sentence: the words are the banner's business now.
		expect(result.reason).toMatchObject({ kind: "flat-steps" });
		expect(
			result.reason.kind === "flat-steps" ? result.reason.steps : [],
		).toEqual([expect.stringContaining("360p→540p")]);
	});

	it("does not judge a ladder already at the top of the scale", () => {
		// Above ~85 VMAF the scale genuinely compresses; complaining there would be
		// noise, and noise is what gets checks ignored.
		const result = ladderSeparation([
			{ label: "1080p", bitrate: 4_000_000, mean: 95.1 },
			{ label: "1440p", bitrate: 8_000_000, mean: 95.4 },
		]);
		expect(result.separated).toBe(true);
	});

	it("ignores steps too small to be expected to matter", () => {
		const result = ladderSeparation([
			{ label: "a", bitrate: 1_000_000, mean: 60 },
			{ label: "b", bitrate: 1_200_000, mean: 60.1 },
		]);
		expect(result.separated).toBe(true);
	});

	it("says so when no rung carries a bitrate, rather than passing silently", () => {
		const result = ladderSeparation([
			{ label: "per-title-1", mean: 70 },
			{ label: "per-title-2", mean: 80 },
		]);
		expect(result.separated).toBe(true);
		expect(result.reason).toEqual({ kind: "too-few-rungs" });
	});
});
