import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	downsampleBandingFrameBlob,
	iterateBandingFrames,
	iterateFrames,
} from "./vmaf-frames";

const banding = [
	{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.04, cambi: 1 },
	{
		frameNum: 1,
		timestampSeconds: 0.04,
		durationSeconds: 0.08,
		cambi: 12,
		computedCambi: 12.01,
	},
	{ frameNum: 2, timestampSeconds: 0.2, durationSeconds: 0.04, cambi: 2 },
];
const envelope = { kind: "QC_FRAMES", version: 1, banding };
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of values) result.push(value);
	return result;
}

describe("metric-aware persisted QC frames", () => {
	it.each([
		false,
		true,
	])("reads Banding-only envelopes (gzip=%s) without inventing VMAF frames", async (compressed) => {
		const json = JSON.stringify(envelope);
		const blob = compressed ? gzipSync(json) : Buffer.from(json);
		expect(await collect(iterateBandingFrames(blob))).toEqual(banding);
		expect(await collect(iterateFrames(blob))).toEqual([]);
	});

	it("separates combined metrics regardless of envelope key order", async () => {
		const vmaf = [{ frameNum: 0, vmaf: 96.5, psnr: 40.1 }];
		const blob = gzipSync(
			JSON.stringify({ banding, vmaf, version: 1, kind: "QC_FRAMES" }),
		);
		expect(await collect(iterateFrames(blob))).toEqual(vmaf);
		expect(await collect(iterateBandingFrames(blob))).toEqual(banding);
	});

	it.each([
		false,
		true,
	])("keeps legacy arrays VMAF-only (gzip=%s)", async (compressed) => {
		const vmaf = [{ frameNum: 0, vmaf: 95 }];
		const json = JSON.stringify(vmaf);
		const blob = compressed ? gzipSync(json) : Buffer.from(json);
		expect(await collect(iterateFrames(blob))).toEqual(vmaf);
		expect(await collect(iterateBandingFrames(blob))).toEqual([]);
	});

	it.each([
		{ ...envelope, version: 2 },
		{ ...envelope, kind: "OTHER" },
		{ kind: "QC_FRAMES", version: 1 },
		{ ...envelope, unknown: true },
		{ ...envelope, banding: [{ ...banding[0], cambi: -1 }] },
		{ ...envelope, banding: [{ ...banding[0], timestampSeconds: "0" }] },
		{ ...envelope, vmaf: [{ frameNum: 0, vmaf: "invalid" }] },
		{ ...envelope, banding: [{ ...banding[0], frameNum: 1 }] },
		{
			...envelope,
			banding: [banding[0], { ...banding[1], timestampSeconds: 0.01 }],
		},
	])("rejects invalid Banding envelopes: %j", async (invalid) => {
		await expect(
			collect(iterateBandingFrames(gzipSync(JSON.stringify(invalid)))),
		).rejects.toThrow();
	});

	it("validates unselected Banding frames when reading VMAF from an envelope", async () => {
		const blob = gzipSync(
			JSON.stringify({
				...envelope,
				vmaf: [{ frameNum: 0, vmaf: 95 }],
				banding: [{ ...banding[0], cambi: -1 }],
			}),
		);
		await expect(collect(iterateFrames(blob))).rejects.toThrow();
	});

	it("retains CAMBI peaks and their original presentation timestamps", async () => {
		const frames = Array.from({ length: 100 }, (_, i) => ({
			frameNum: i,
			timestampSeconds: i * 0.08,
			durationSeconds: 0.04,
			cambi: i === 37 ? 100 : i === 99 ? 99 : i % 5,
		}));
		const series = await downsampleBandingFrameBlob(
			gzipSync(JSON.stringify({ ...envelope, banding: frames })),
			5,
		);
		expect(series.frameCount).toBe(100);
		expect(series.frames.length).toBeLessThanOrEqual(5);
		expect(series.frames).toContainEqual({ ...frames[37], worst: true });
		expect(series.frames).toContainEqual(frames[99]);
		expect(series.frames.map((frame) => frame.frameNum)).toEqual(
			[...series.frames.map((frame) => frame.frameNum)].sort((a, b) => a - b),
		);
	});

	it("supports cancellation and early return", async () => {
		const blob = gzipSync(JSON.stringify(envelope));
		const controller = new AbortController();
		controller.abort();
		await expect(
			collect(iterateBandingFrames(blob, controller.signal)),
		).rejects.toThrow();
		const iterator = iterateBandingFrames(blob);
		expect((await iterator.next()).value).toEqual(banding[0]);
		await expect(iterator.return(undefined)).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});
});
