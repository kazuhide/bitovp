import { describe, expect, it } from "vitest";
import {
	comparedModels,
	comparedSubsamples,
	mixesModels,
	mixesScoringGenerations,
	mixesSubsampling,
	scoringGenerations,
	VMAF_AXIS_MAX,
} from "./vmaf-shared";

/**
 * The hazard this guards: the 2026-08-11 PTS fix changed what a VMAF number
 * MEANS. The same encode measured 23.08 before and 84.21 after, so a chart that
 * overlays the two is comparing pipelines while looking like it compares
 * encodes.
 */
describe("scoring generations", () => {
	it("treats a missing version as generation 1", () => {
		// Rows written before the column existed were scored by the old pipeline
		// by definition — defaulting them to the CURRENT generation would silently
		// relabel every historical number as trustworthy.
		expect(scoringGenerations([{}, { scoringVersion: 1 }])).toEqual([1]);
		expect(mixesScoringGenerations([{}, { scoringVersion: 1 }])).toBe(false);
	});

	it("flags a mixed set", () => {
		expect(
			mixesScoringGenerations([{ scoringVersion: 1 }, { scoringVersion: 2 }]),
		).toBe(true);
		expect(mixesScoringGenerations([{}, { scoringVersion: 2 }])).toBe(true);
		expect(scoringGenerations([{ scoringVersion: 2 }, {}])).toEqual([1, 2]);
	});

	it("does not flag a uniform set, at either generation", () => {
		expect(
			mixesScoringGenerations([{ scoringVersion: 2 }, { scoringVersion: 2 }]),
		).toBe(false);
		expect(mixesScoringGenerations([])).toBe(false);
		expect(mixesScoringGenerations([{ scoringVersion: 2 }])).toBe(false);
	});
});

describe("compared models", () => {
	it("de-duplicates and sorts, so the warning names a stable set", () => {
		expect(
			comparedModels([
				{ model: "vmaf_v1.0.16_3d0h" },
				{ model: "vmaf_v0.6.1" },
				{ model: "vmaf_v1.0.16_3d0h" },
			]),
		).toEqual(["vmaf_v0.6.1", "vmaf_v1.0.16_3d0h"]);
	});

	it("mixes only when two DIFFERENT models are present", () => {
		expect(mixesModels([{ model: "a" }, { model: "a" }])).toBe(false);
		expect(mixesModels([{ model: "a" }, { model: "b" }])).toBe(true);
		expect(mixesModels([])).toBe(false);
		expect(mixesModels([{ model: "a" }])).toBe(false);
	});

	it("ignores a missing model rather than counting it as a second one", () => {
		// `model` is required on both wire types, so absence means a payload cached
		// before the field existed. Counting `undefined` as a distinct model would
		// fire the warning on a single report, which is never right.
		expect(mixesModels([{ model: "a" }, {}])).toBe(false);
		expect(comparedModels([{}, { model: "a" }])).toEqual(["a"]);
	});
});

/**
 * The quietest of the three axes: subsampling barely moves the pooled mean, so the
 * chart looks fine while the minima measure different things — the worst frame of a
 * sample versus the worst frame there is.
 */
describe("compared subsampling", () => {
	it("treats null, absent and 1 as the same answer — full precision", () => {
		// They must not read as three strides, or every historical report would look
		// like it disagreed with every new one.
		expect(
			comparedSubsamples([{ subsample: null }, {}, { subsample: 1 }]),
		).toEqual([1]);
		expect(mixesSubsampling([{ subsample: null }, {}, { subsample: 1 }])).toBe(
			false,
		);
	});

	it("mixes when a subsampled report meets a full-precision one", () => {
		expect(mixesSubsampling([{ subsample: 4 }, { subsample: null }])).toBe(
			true,
		);
		expect(comparedSubsamples([{ subsample: 4 }, {}])).toEqual([1, 4]);
	});

	it("mixes when two different strides meet", () => {
		expect(mixesSubsampling([{ subsample: 2 }, { subsample: 4 }])).toBe(true);
		expect(comparedSubsamples([{ subsample: 4 }, { subsample: 2 }])).toEqual([
			2, 4,
		]);
	});

	it("stays quiet for a uniform stride, and for degenerate input", () => {
		expect(mixesSubsampling([{ subsample: 4 }, { subsample: 4 }])).toBe(false);
		expect(mixesSubsampling([])).toBe(false);
		expect(mixesSubsampling([{ subsample: 4 }])).toBe(false);
	});
});

/**
 * VMAF is not capped at 100, and four charts used to assume it was.
 *
 * None of the fourteen bundled models defines `score_clip` and `pooled.ts` never
 * clamps, so a model tuned for a larger display legitimately scores above it —
 * review measured pooled MEANS of 101.88 / 104.20 / 107.49 / 107.53 on a 1080p
 * reference. With `domain={[0, 100]}` such a series is drawn flattened against the
 * top of the plot: a plateau that is not in the data, with nothing saying so. That is
 * the same defect class as the mixed-model chart this file's other tests guard.
 */
describe("VMAF_AXIS_MAX", () => {
	it("keeps the ordinary axis at exactly 100", () => {
		// The common case must look unchanged — the axis only grows when it must.
		expect(VMAF_AXIS_MAX(100)).toBe(100);
		expect(VMAF_AXIS_MAX(92.65)).toBe(100);
		expect(VMAF_AXIS_MAX(0)).toBe(100);
	});

	it("grows to fit a score above 100 rather than clipping it", () => {
		// The measured values, not invented ones.
		expect(VMAF_AXIS_MAX(101.88)).toBe(102);
		expect(VMAF_AXIS_MAX(107.53)).toBe(108);
	});

	it("never returns a bound below the data it was given", () => {
		// The property that matters: whatever the input, the series fits.
		for (const max of [0, 50, 99.9, 100, 100.01, 104.2, 130]) {
			expect(VMAF_AXIS_MAX(max)).toBeGreaterThanOrEqual(max);
		}
	});
});
