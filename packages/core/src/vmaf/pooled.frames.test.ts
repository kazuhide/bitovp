import { describe, expect, it } from "vitest";
import { computePooled, poolFrames, type VmafFrame } from "./pooled";

/**
 * : pooling over a subset of frames. A masked (loop-hole) or excluded
 * (low-confidence segment) frame must not enter the harmonic mean, where one
 * 0 dominates a whole window.
 */
const frame = (frameNum: number, vmaf: number): VmafFrame => ({
	frameNum,
	vmaf,
});

describe("poolFrames", () => {
	it("pools only the included frames and counts the rest", () => {
		const frames = [
			frame(0, 90),
			frame(1, 0),
			frame(2, 92),
			frame(3, 0),
			frame(4, 94),
		];
		const result = poolFrames(frames, [true, false, true, false, true]);
		expect(result.includedFrames).toBe(3);
		expect(result.excludedFrames).toBe(2);
		expect(result.unscoredFrames).toBe(0);
		expect(result.pooled.mean).toBeCloseTo(92, 6);
		expect(result.pooled.min).toBe(90);
		expect(result.pooled.harmonicMean).toBeGreaterThan(91);
		// the same frames pooled whole are dominated by the two zeros
		expect(computePooled(frames).harmonicMean).toBe(0);
		expect(computePooled(frames).mean).toBeCloseTo(55.2, 6);
	});

	it("rev427 R4: keyed by frameNum, so a subsampled run (every Nth frame, original numbers) still maps onto the output grid", () => {
		// n_subsample=3 over a 9-frame window: frames 0, 3, 6 scored; frame 3 is masked
		const frames = [frame(0, 90), frame(3, 0), frame(6, 92)];
		const include = [true, true, true, false, true, true, true, true, true];
		const result = poolFrames(frames, include);
		expect(result.includedFrames).toBe(2);
		expect(result.excludedFrames).toBe(1);
		// six output frames were never scored — counted, not hidden
		expect(result.unscoredFrames).toBe(6);
		expect(result.pooled.min).toBe(90);
		expect(result.pooled.worstFrame).toEqual(frame(0, 90));
	});

	it("refuses a frameNum that appears twice (a concatenated log would double-count)", () => {
		expect(() =>
			poolFrames(
				[frame(0, 90), frame(0, 10), frame(2, 92)],
				[true, true, true],
			),
		).toThrow(/frameNum 0 appears twice/);
	});

	it("throws on a frameNum outside the window and when nothing is included", () => {
		expect(() => poolFrames([frame(1, 1)], [true])).toThrow(
			/frameNum 1 is outside the 1-frame window/,
		);
		expect(() => poolFrames([frame(0, 1)], [false])).toThrow(/nothing to pool/);
		expect(() => poolFrames([frame(-1, 1)], [true])).toThrow(/outside/);
	});
});
