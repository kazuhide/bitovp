import { describe, expect, it } from "vitest";
import {
	assessBandingFrames,
	type BandingFrame,
	bandingFrameSchema,
	bandingPooledSchema,
	computeBandingPooled,
	parseQcFrames,
} from "./index";

const frame = (
	frameNum: number,
	timestampSeconds: number,
	durationSeconds: number,
	cambi: number,
): BandingFrame => ({ frameNum, timestampSeconds, durationSeconds, cambi });

describe("CAMBI frames, pooling and affected presentation intervals", () => {
	it("pools independent banding without a VMAF score", () => {
		const pooled = computeBandingPooled([
			frame(0, 0, 0.1, 2),
			frame(1, 0.1, 0.2, 8),
		]);
		expect(pooled).toMatchObject({ mean: 5, min: 2, max: 8, frameCount: 2 });
		expect(pooled.durationSeconds).toBeCloseTo(0.3);
		expect(pooled).not.toHaveProperty("vmaf");
	});

	it("keeps a constant long-run mean within its actual extrema", () => {
		const pooled = computeBandingPooled(
			Array.from({ length: 600 }, (_, i) => frame(i, i / 25, 1 / 25, 0.1)),
		);
		expect(bandingPooledSchema.safeParse(pooled).success).toBe(true);
		expect(pooled.mean).toBe(0.1);
	});

	it("uses canonical CPU scores rather than the raw GPU rounding near a boundary", () => {
		const frames = [{ ...frame(0, 0, 0.1, 5), computedCambi: 5.0000001 }];
		expect(assessBandingFrames(frames, { warningThreshold: 5 }).severity).toBe(
			"PASS",
		);
	});

	it("builds VFR ranges from timestamps and preserves warning/failure changes", () => {
		const assessed = assessBandingFrames(
			[
				frame(0, 0, 0.04, 1),
				frame(1, 0.04, 0.06, 6),
				frame(2, 0.1, 0.1, 7),
				frame(3, 0.2, 0.2, 12),
				frame(4, 0.4, 0.1, 5),
			],
			{ warningThreshold: 5, failureThreshold: 10 },
		);
		expect(assessed.severity).toBe("FAIL");
		expect(assessed.ranges).toEqual([
			{
				startSeconds: 0.04,
				endSeconds: 0.2,
				startFrame: 1,
				endFrame: 2,
				peak: 7,
				severity: "WARN",
			},
			{
				startSeconds: 0.2,
				endSeconds: 0.4,
				startFrame: 3,
				endFrame: 3,
				peak: 12,
				severity: "FAIL",
			},
		]);
		expect(assessed.affectedSeconds).toBeCloseTo(0.36);
	});

	it("does not join separate scored intervals over a timing gap", () => {
		const assessed = assessBandingFrames(
			[frame(0, 0, 0.04, 6), frame(1, 1, 0.04, 7)],
			{ warningThreshold: 5 },
		);
		expect(assessed.ranges).toHaveLength(2);
		expect(assessed.affectedSeconds).toBeCloseTo(0.08);
	});

	it("rejects incomplete, nonfinite or nonmonotone full-frame evidence", () => {
		for (const frames of [
			[],
			[frame(1, 0, 0.1, 1)],
			[frame(0, 0, 0.1, 1), frame(2, 0.1, 0.1, 1)],
			[frame(0, 0, 0.1, 1), frame(1, 0, 0.1, 1)],
			[frame(0, 0, 0.1, Number.NaN)],
			[frame(0, 0, 0, 1)],
			[frame(0, 0, 0.2, 1), frame(1, 0.1, 0.1, 1)],
		])
			expect(() => computeBandingPooled(frames)).toThrow();
		expect(() =>
			bandingFrameSchema.parse({
				...frame(0, 0, 0.1, 1),
				computedCambi: Infinity,
			}),
		).toThrow();
	});

	it("accepts legacy frames and a versioned envelope without fabricating VMAF", () => {
		expect(parseQcFrames([{ frameNum: 0, vmaf: 90 }])).toEqual({
			kind: "QC_FRAMES",
			version: 1,
			vmaf: [{ frameNum: 0, vmaf: 90 }],
			banding: [],
		});
		const banding = [frame(0, 0, 0.1, 7)];
		expect(parseQcFrames({ kind: "QC_FRAMES", version: 1, banding })).toEqual({
			kind: "QC_FRAMES",
			version: 1,
			banding,
		});
		expect(() =>
			parseQcFrames({ kind: "QC_FRAMES", version: 2, banding }),
		).toThrow();
	});
});
