import { gzipSync } from "node:zlib";
import type { VmafFrame } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	DOWNSAMPLE_CAP,
	downsampleFrameBlob,
	downsampleFrames,
	iterateFrames,
} from "./vmaf-frames";

function frames(scores: number[]): VmafFrame[] {
	return scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
}

describe("iterateFrames", () => {
	it("gunzips the worker's gzip(JSON.stringify(frames)) blob", async () => {
		const original = frames([95, 80, 99]);
		const blob = gzipSync(Buffer.from(JSON.stringify(original), "utf8"));
		const actual = [];
		for await (const frame of iterateFrames(blob)) actual.push(frame);
		expect(actual).toEqual(original);
	});
});

describe("streaming frame reads", () => {
	it("matches JSON.parse numbers, key order, Unicode and additional retained properties", async () => {
		const json =
			'[{"frameNum":0,"vmaf":-0,"psnr":4.25e1,"note":"雪😀","__proto__":{"kept":true}},{"vmaf":91.12345678901235,"frameNum":1}]';
		const actual = [];
		for await (const frame of iterateFrames(gzipSync(json))) actual.push(frame);
		expect(JSON.stringify(actual, null, 2)).toBe(
			JSON.stringify(JSON.parse(json), null, 2),
		);
		const first = actual[0];
		if (!first) throw new Error("Missing first frame");
		expect(Object.hasOwn(first, "__proto__")).toBe(true);
	});

	it.each([
		0, 1, 1499, 1500, 1501, 3001,
	])("preserves bucket minima, first ties and pinned worst frames for %i frames", async (length) => {
		const input = Array.from({ length }, (_, i) => ({
			frameNum: i * 3,
			vmaf: i % 97,
			...(i % 2 ? { psnr: 42.123456789 } : {}),
		}));
		for (const cap of [1, 2, 17, DOWNSAMPLE_CAP]) {
			const actual = await downsampleFrameBlob(
				gzipSync(JSON.stringify(input)),
				cap,
			);
			expect(actual).toEqual({
				frameCount: length,
				frames: downsampleFrames(input, cap),
			});
		}
	});

	it.each([
		[15, 12],
		[1502, DOWNSAMPLE_CAP],
		[1507, DOWNSAMPLE_CAP],
	])("preserves the finite bucket endpoint when %i frames round below cap %i", async (length, cap) => {
		for (const minimum of ["first", "tail", "tied-tail", "first-tail-tie"]) {
			const minimumIndices =
				minimum === "tail"
					? [length - 1]
					: minimum === "first-tail-tie"
						? [length - 2, length - 1]
						: minimum === "tied-tail"
							? [0, length - 1]
							: [0];
			const input = Array.from({ length }, (_, index) => ({
				frameNum: index * 3 + 7,
				vmaf: minimumIndices.includes(index) ? 0 : 90,
				psnr: 42.123456789 + index / 1000,
			}));
			const expected = downsampleFrames(input, cap);
			const actual = await downsampleFrameBlob(
				gzipSync(JSON.stringify(input)),
				cap,
			);
			expect(actual.frameCount).toBe(length);
			expect(actual.frames, minimum).toEqual(expected);
			if (minimum === "first") {
				expect(actual.frames).toHaveLength(cap - 1);
				expect(actual.frames.at(-1)?.frameNum).toBe((length - 2) * 3 + 7);
			}
			if (minimum === "tail")
				expect(actual.frames.at(-1)).toEqual({
					...input.at(-1),
					worst: true,
				});
			if (minimum === "tied-tail")
				expect(actual.frames.filter((frame) => frame.worst)).toEqual([
					{ ...input[0], worst: true },
				]);
		}
	});

	it.each([
		'[{"frameNum":0,"vmaf":95}',
		"[] trailing",
		"{}",
	])("rejects malformed or non-array persisted JSON: %s", async (json) => {
		const read = async () => {
			for await (const _frame of iterateFrames(gzipSync(json))) {
				// Drain through the syntax check at end of input.
			}
		};
		await expect(read()).rejects.toThrow();
	});

	it("stops an active decoder on abort and allows an early iterator return", async () => {
		const blob = gzipSync(
			JSON.stringify(frames(Array.from({ length: 20_000 }, () => 95))),
		);
		const controller = new AbortController();
		const reader = iterateFrames(blob, controller.signal);
		expect((await reader.next()).value?.frameNum).toBe(0);
		controller.abort();
		await expect(reader.next()).rejects.toThrow();
		const early = iterateFrames(blob);
		await early.next();
		await early.return(undefined);
		expect(await early.next()).toEqual({ value: undefined, done: true });
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
