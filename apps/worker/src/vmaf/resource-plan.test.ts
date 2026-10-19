import { describe, expect, it } from "vitest";
import {
	planLocalResources,
	type ResourcePair,
	resourceVideoFromProbe,
} from "./resource-plan";
import type { LocalResources } from "./resources";

const GiB = 1024 ** 3;
const resources: LocalResources = {
	cpuCapacity: 4,
	memoryLimitBytes: 4 * GiB,
	headroomBytes: 3.5 * GiB,
	reserveBytes: 0.5 * GiB,
	budgetBytes: 3 * GiB,
};
function video(overrides: Record<string, unknown> = {}) {
	return resourceVideoFromProbe(
		JSON.stringify({
			streams: [
				{
					codec_type: "video",
					codec_name: "h264",
					width: 1920,
					height: 1080,
					pix_fmt: "yuv420p",
					r_frame_rate: "24/1",
					duration: "10",
					nb_frames: "240",
					...overrides,
				},
			],
		}),
	);
}
function pair(overrides: Partial<ResourcePair> = {}): ResourcePair {
	return {
		reference: video(),
		distorted: video(),
		model: "vmaf_v0.6.1",
		...overrides,
	};
}

describe("local quality resource planning", () => {
	it("uses constrained capacity rather than logical CPUs and the mirror count", () => {
		expect(planLocalResources(resources, pair(), {}, 8)).toMatchObject({
			threads: 4,
			concurrency: 1,
			decoderThreads: 2,
			filterComplexThreads: 1,
		});
		expect(
			planLocalResources({ ...resources, cpuCapacity: 10 }, pair(), {}, 8),
		).toMatchObject({ threads: 4, concurrency: 2 });
		expect(planLocalResources(resources, pair(), {}, 1).concurrency).toBe(1);
	});

	it("uses the reference conform geometry even for a small distorted rendition", () => {
		const plan = planLocalResources(
			resources,
			pair({
				reference: video({ width: 3840, height: 2160 }),
				distorted: video({ width: 640, height: 360 }),
			}),
			{},
			4,
		);
		expect(plan.threads).toBe(2);
		expect(plan.concurrency).toBe(1);
		expect(plan.estimatedBytes).toBeGreaterThan(1.5 * GiB);
	});

	it("reduces automatic threads when one 4K pair exceeds available memory", () => {
		const full = video({ width: 3840, height: 2160 });
		expect(
			planLocalResources(
				{ ...resources, budgetBytes: 1.3 * GiB },
				pair({ reference: full, distorted: full }),
				{},
				2,
			),
		).toMatchObject({ threads: 1, concurrency: 1 });
	});

	it("preserves each explicit axis, including intentional CPU overcommit", () => {
		expect(
			planLocalResources(
				{ ...resources, cpuCapacity: 10 },
				pair(),
				{ concurrency: 3 },
				8,
			),
		).toMatchObject({ threads: 3, concurrency: 3 });
		expect(
			planLocalResources(resources, pair(), { threads: 5 }, 8),
		).toMatchObject({ threads: 5, concurrency: 1 });
		expect(
			planLocalResources(resources, pair(), { threads: 5, concurrency: 4 }, 8),
		).toMatchObject({ threads: 5, concurrency: 4 });
	});

	it("does not turn a fractional quota into extra workers", () => {
		expect(
			planLocalResources({ ...resources, cpuCapacity: 0.5 }, pair(), {}, 8),
		).toMatchObject({ threads: 1, concurrency: 1 });
	});

	it("never clamps an impossible explicit thread setting", () => {
		expect(() =>
			planLocalResources(resources, pair(), { threads: 1000 }, 8),
		).toThrow("more memory");
	});

	it("uses an honest manual fallback only when both settings are explicit", () => {
		const unknown = { ...resources, budgetBytes: undefined };
		expect(() => planLocalResources(unknown, pair(), {}, 4)).toThrow(
			"could not determine available memory",
		);
		expect(() =>
			planLocalResources(unknown, pair(), { threads: 2 }, 4),
		).toThrow("could not determine available memory");
		expect(
			planLocalResources(unknown, pair(), { threads: 2, concurrency: 3 }, 4),
		).toMatchObject({ threads: 2, concurrency: 3, manualFallback: true });
	});

	it("identifies actual bit depth and treats conflicting or unknown formats conservatively", () => {
		const tenBit = video({ pix_fmt: "yuv420p10le" });
		expect(tenBit.bitDepth).toBe(10);
		const plan = planLocalResources(
			resources,
			pair({ distorted: tenBit }),
			{},
			4,
		);
		expect(plan).toMatchObject({ threads: 1, concurrency: 1, exclusive: true });
		expect(plan.estimatedBytes).toBeLessThan(resources.budgetBytes as number);
		expect(
			video({ pix_fmt: "yuv420p10le", bits_per_raw_sample: "8" }).bitDepth,
		).toBeUndefined();
		expect(video({ pix_fmt: "unrecognized" }).bitDepth).toBeUndefined();
	});

	it("keeps signature cadence separate from source fps and reserves report memory", () => {
		const short = pair({ outputFps: 30 });
		expect(planLocalResources(resources, short, {}, 1).frameCount).toBe(300);
		const long = video({ duration: "120", nb_frames: "2880" });
		expect(
			planLocalResources(
				resources,
				pair({ reference: long, distorted: long }),
				{},
				1,
			).estimatedBytes,
		).toBeGreaterThanOrEqual(
			planLocalResources(resources, short, {}, 1).estimatedBytes,
		);
	});

	it("fails before launch when frame count cannot be estimated", () => {
		const unknown = video({ duration: "N/A", nb_frames: "N/A" });
		expect(() =>
			planLocalResources(
				resources,
				pair({ reference: unknown, distorted: unknown }),
				{},
				1,
			),
		).toThrow("video metadata");
	});
});
