import { describe, expect, it } from "vitest";
import { trackGrayFrames, trackingCacheKey } from "./tracking";

function texture() {
	let state = 7;
	return Uint8Array.from({ length: 16 * 12 }, () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state >>> 24;
	});
}
const patch = texture();
function scaledImage(left: number, top: number, width: number, height: number) {
	const data = new Uint8Array(80 * 60).fill(45);
	const sample = (x: number, y: number) =>
		patch[Math.max(0, Math.min(11, y)) * 16 + Math.max(0, Math.min(15, x))] ??
		0;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const u = (x * 15) / (width - 1),
				v = (y * 11) / (height - 1),
				ix = Math.floor(u),
				iy = Math.floor(v),
				dx = u - ix,
				dy = v - iy;
			data[(top + y) * 80 + left + x] = Math.round(
				sample(ix, iy) * (1 - dx) * (1 - dy) +
					sample(ix + 1, iy) * dx * (1 - dy) +
					sample(ix, iy + 1) * (1 - dx) * dy +
					sample(ix + 1, iy + 1) * dx * dy,
			);
		}
	return data;
}
function image(x: number, y: number, duplicate = false) {
	const frame = new Uint8Array(80 * 60).fill(45);
	const put = (left: number, top: number) => {
		for (let py = 0; py < 12; py++)
			for (let px = 0; px < 16; px++)
				frame[(top + py) * 80 + left + px] = patch[py * 16 + px] ?? 0;
	};
	put(x, y);
	if (duplicate) put(x + 22, y);
	return frame;
}
const base = {
	width: 80,
	height: 60,
	sourceStartUs: 1_000_000,
	sampleStepUs: 333_333,
	seedBox: { x: 20 / 80, y: 20 / 60, w: 16 / 80, h: 12 / 60 },
};
describe("measured frame template tracking", () => {
	it("reacquires a fast moving immutable-seed match with bounded expanded NCC search", async () => {
		const result = await trackGrayFrames({
			...base,
			adaptiveRecovery: true,
			frames: [image(20, 20), image(32, 20), image(44, 20)],
		});
		expect(result.reason).toBeUndefined();
		expect(
			result.observations.map((point) => Math.round(point.box.x * 80)),
		).toEqual([20, 32, 44]);
	});
	it("resumes the same seed after a short occlusion but marks every unsupported interpolation interval", async () => {
		const result = await trackGrayFrames({
			...base,
			adaptiveRecovery: true,
			frames: [
				image(20, 20),
				image(23, 21),
				new Uint8Array(4800),
				image(29, 23),
				image(32, 24),
			],
		});
		expect(result.reason).toBeUndefined();
		expect(
			result.observations.map((point) => Math.round(point.box.x * 80)),
		).toEqual([20, 23, 29, 32]);
		expect(result.gaps).toEqual([
			{ fromUs: 1_333_333, toUs: 1_999_999, reason: "LOST" },
		]);
	});
	it("never reacquires an equally plausible replacement and keeps recovery work bounded", async () => {
		const result = await trackGrayFrames({
			...base,
			adaptiveRecovery: true,
			frames: [
				image(20, 20),
				image(23, 20),
				new Uint8Array(4800),
				image(29, 20, true),
			],
		});
		expect(result.observations).toHaveLength(2);
		expect(result.reason).toBe("AMBIGUOUS");
		const limited = await trackGrayFrames({
			...base,
			adaptiveRecovery: true,
			maxOperations: 1,
			frames: [image(20, 20), image(40, 20)],
		});
		expect(limited.reason).toBe("WORK_LIMIT");
		expect(limited.observations).toEqual([]);
	});
	it("separates recovery policy and explicit target identity in cache keys", () => {
		const input = {
			mediaSha256: "a".repeat(64),
			sourceWidth: 80,
			sourceHeight: 60,
			shots: [
				{
					sceneId: "scene",
					shotIndex: 0,
					startUs: 0,
					endUs: 2_000_000,
					targetId: "target-a",
					seed: { sourceTimeUs: 0, box: base.seedBox },
				},
			],
		};
		expect(trackingCacheKey({ ...input, adaptiveRecovery: true })).not.toBe(
			trackingCacheKey(input),
		);
		expect(
			trackingCacheKey({
				...input,
				shots: input.shots.map((shot) => ({ ...shot, targetId: "target-b" })),
			}),
		).not.toBe(trackingCacheKey(input));
	});
	it("follows actual moving texture and emits measured sample times/boxes", async () => {
		const result = await trackGrayFrames({
			...base,
			frames: [image(20, 20), image(23, 21), image(26, 22), image(29, 23)],
		});
		expect(result.observations).toHaveLength(4);
		expect(result.observations.map((p) => Math.round(p.box.x * 80))).toEqual([
			20, 23, 26, 29,
		]);
		expect(result.observations[1]?.sourceTimeUs).toBe(1_333_333);
		expect(result.observations.every((p) => p.confidence > 0.9)).toBe(true);
	});
	it("measures changing image scale as well as position instead of retaining seed dimensions", async () => {
		const sizes = [24, 26, 28, 26, 24],
			heights = [18, 20, 21, 20, 18];
		const result = await trackGrayFrames({
			...base,
			seedBox: { x: 20 / 80, y: 20 / 60, w: 24 / 80, h: 18 / 60 },
			frames: sizes.map((size, i) =>
				scaledImage(20 + i * 2, 20, size, heights[i] ?? 18),
			),
		});
		expect(result.reason).toBeUndefined();
		expect(result.observations).toHaveLength(5);
		for (const [index, observation] of result.observations.entries()) {
			expect(
				Math.abs(observation.box.w * 80 - (sizes[index] ?? 0)),
			).toBeLessThanOrEqual(1);
			expect(
				Math.abs(observation.box.h * 60 - (heights[index] ?? 0)),
			).toBeLessThanOrEqual(1);
			expect(
				Math.abs(observation.box.x * 80 - (20 + index * 2)),
			).toBeLessThanOrEqual(1);
			expect(observation.confidence).toBeGreaterThanOrEqual(0.78);
		}
		expect(result.observations[2]?.box.w).toBeGreaterThan(
			result.observations[0]?.box.w ?? 1,
		);
		expect(result.observations[4]?.box.w).toBeLessThan(
			result.observations[2]?.box.w ?? 0,
		);
	});
	it("does not call one seed frame a continuous track", async () => {
		expect(
			(await trackGrayFrames({ ...base, frames: [image(20, 20)] }))
				.observations,
		).toEqual([]);
	});
	it("falls back on low texture instead of confidently following blank pixels", async () => {
		const result = await trackGrayFrames({
			...base,
			frames: [new Uint8Array(4800), new Uint8Array(4800)],
		});
		expect(result.observations).toEqual([]);
		expect(result.reason).toBe("LOW_TEXTURE");
	});
	it("stops after loss and never extrapolates later observations", async () => {
		const result = await trackGrayFrames({
			...base,
			frames: [
				image(20, 20),
				image(23, 21),
				new Uint8Array(4800),
				image(29, 23),
			],
		});
		expect(result.observations).toHaveLength(2);
		expect(result.reason).toBe("LOST");
		expect(result.lostAtUs).toBe(1_666_666);
	});
	it("keeps the immutable seed identity while adaptive candidates gradually change appearance", async () => {
		const initial = image(20, 20),
			replacement = new Uint8Array(4800).fill(45);
		let random = 912;
		for (let y = 20; y < 32; y++)
			for (let x = 20; x < 36; x++) {
				random = (random * 1664525 + 1013904223) >>> 0;
				replacement[y * 80 + x] = random >>> 24;
			}
		const frames = Array.from({ length: 11 }, (_, index) =>
			Uint8Array.from(initial, (value, pixel) =>
				Math.round(
					value * (1 - index / 10) + ((replacement[pixel] ?? 0) * index) / 10,
				),
			),
		);
		const result = await trackGrayFrames({ ...base, frames });
		expect(result.reason).toBe("LOST");
		expect(result.observations.length).toBeGreaterThanOrEqual(2);
		expect(result.observations.length).toBeLessThan(frames.length);
		expect(result.observations.every((point) => point.confidence >= 0.78)).toBe(
			true,
		);
	});
	it("rejects two equally plausible subjects", async () => {
		const result = await trackGrayFrames({
			...base,
			searchRadius: 30,
			frames: [image(20, 20), image(20, 20, true)],
		});
		expect(result.observations).toEqual([]);
		expect(result.reason).toBe("AMBIGUOUS");
	});
	it("bounds work without silently inventing the unexamined remainder", async () => {
		const result = await trackGrayFrames({
			...base,
			maxOperations: 1,
			frames: [image(20, 20), image(23, 21)],
		});
		expect(result.reason).toBe("WORK_LIMIT");
		expect(result.observations).toEqual([]);
	});
	it("supports cancellation between actual frame samples", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			trackGrayFrames({
				...base,
				signal: controller.signal,
				frames: [image(20, 20), image(23, 21)],
			}),
		).rejects.toMatchObject({ code: "CANCELED" });
	});
	it("binds cache to seed time, shot bounds and actual media identity", () => {
		const input = {
			mediaSha256: "a".repeat(64),
			sourceWidth: 80,
			sourceHeight: 60,
			shots: [
				{
					sceneId: "scene",
					shotIndex: 0,
					startUs: 0,
					endUs: 2_000_000,
					seed: { sourceTimeUs: 1_000_000, box: base.seedBox },
				},
			],
		};
		const key = trackingCacheKey(input);
		expect(
			trackingCacheKey({ ...input, mediaSha256: "b".repeat(64) }),
		).not.toBe(key);
		expect(
			trackingCacheKey({
				...input,
				shots: input.shots.map((shot) => ({
					...shot,
					seed: { sourceTimeUs: 0, box: base.seedBox },
				})),
			}),
		).not.toBe(key);
	});
});
