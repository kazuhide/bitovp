import { gzipSync } from "node:zlib";
import type { VmafFrame } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { DOWNSAMPLE_CAP, decodeFrames, downsampleFrames } from "./vmaf-frames";

function frames(scores: number[]): VmafFrame[] {
	return scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
}

describe("decodeFrames", () => {
	it("gunzips the worker's gzip(JSON.stringify(frames)) blob", () => {
		const original = frames([95, 80, 99]);
		const blob = gzipSync(Buffer.from(JSON.stringify(original), "utf8"));
		expect(decodeFrames(blob)).toEqual(original);
	});
});

describe("downsampleFrames", () => {
	it("passes through a series already at/under the cap", () => {
		const input = frames([90, 80, 70, 60, 50]);
		const out = downsampleFrames(input, 10);
		expect(out).toHaveLength(5);
		expect(out.map((f) => f.frameNum)).toEqual([0, 1, 2, 3, 4]);
	});

	it("downsamples a large series to <= the cap", () => {
		// 300k frames ≈ a 3h clip at the storage contract. Must shrink hard.
		const big = frames(Array.from({ length: 300_000 }, () => 95));
		const out = downsampleFrames(big, DOWNSAMPLE_CAP);
		expect(out.length).toBeLessThanOrEqual(DOWNSAMPLE_CAP);
		expect(out.length).toBeGreaterThan(0);
	});

	it("KEEPS the global worst frame (the dip survives 200:1 reduction)", () => {
		const scores = Array.from({ length: 300_000 }, () => 95);
		// A single catastrophic dip buried deep in the series.
		const worstIdx = 187_421;
		scores[worstIdx] = 11;
		const out = downsampleFrames(frames(scores), DOWNSAMPLE_CAP);

		const worst = out.find((f) => f.frameNum === worstIdx);
		expect(worst).toBeDefined();
		expect(worst?.vmaf).toBe(11);
		expect(worst?.worst).toBe(true);

		// And it is genuinely the minimum of the downsampled output.
		const min = out.reduce((m, f) => (f.vmaf < m.vmaf ? f : m));
		expect(min.frameNum).toBe(worstIdx);
		expect(min.vmaf).toBe(11);
	});

	it("flags exactly one worst frame and keeps ascending frameNum order", () => {
		const scores = Array.from({ length: 50_000 }, (_, i) =>
			i === 42_000 ? 30 : 90,
		);
		const out = downsampleFrames(frames(scores), 500);
		expect(out.filter((f) => f.worst).length).toBe(1);
		const nums = out.map((f) => f.frameNum);
		expect([...nums].sort((a, b) => a - b)).toEqual(nums);
	});

	it("buckets keep their MINIMUM (not the mean) so dips are not averaged away", () => {
		// 1000 frames: every 10th frame is a 40, the rest 90. With cap 100,
		// each ~10-frame bucket must report its 40, not ~85.
		const scores = Array.from({ length: 1000 }, (_, i) =>
			i % 10 === 0 ? 40 : 90,
		);
		const out = downsampleFrames(frames(scores), 100);
		const lows = out.filter((f) => f.vmaf === 40);
		expect(lows.length).toBeGreaterThan(50);
	});

	it("returns [] for an empty series and respects cap=1", () => {
		expect(downsampleFrames([], 100)).toEqual([]);
		const one = downsampleFrames(frames([99, 50, 99, 99]), 1);
		expect(one).toHaveLength(1);
		expect(one[0]?.vmaf).toBe(50); // the worst is what survives a 1-point cap
		expect(one[0]?.worst).toBe(true);
	});

	it("rejects a cap below 1", () => {
		expect(() => downsampleFrames(frames([1, 2]), 0)).toThrow(/cap/);
	});
});
