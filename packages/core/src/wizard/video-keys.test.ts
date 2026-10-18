import { describe, expect, it } from "vitest";
import { videoKeys, type WizardVideoRendition } from "./build-plan";

const v = (
	height: number | null,
	bitrate: number | null,
	codec?: WizardVideoRendition["codec"],
): WizardVideoRendition =>
	({ height, bitrate, ...(codec ? { codec } : {}) }) as WizardVideoRendition;

describe("videoKeys — height, then bitrate, then codec (review-342 I2)", () => {
	it("a ladder of distinct heights keys by height alone", () => {
		expect(videoKeys([v(1080, 5_000_000), v(720, 3_000_000)])).toEqual([
			"v1080",
			"v720",
		]);
	});

	it("a shared height disambiguates by bitrate, as before", () => {
		expect(videoKeys([v(1080, 5_000_000), v(1080, 3_000_000)])).toEqual([
			"v1080_5000k",
			"v1080_3000k",
		]);
	});

	it("the same rung in TWO codecs — the natural mixed-codec ask — gets distinct keys", () => {
		const keys = videoKeys([
			v(1080, 5_000_000, "H264"),
			v(1080, 5_000_000, "H265"),
			v(720, 3_000_000, "H264"),
		]);
		expect(keys).toEqual(["v1080_5000k_h264", "v1080_5000k_h265", "v720"]);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("an unpinned codec reads as H264 for the tiebreak, matching the plan default", () => {
		expect(videoKeys([v(1080, 5_000_000), v(1080, 5_000_000, "H265")])).toEqual(
			["v1080_5000k_h264", "v1080_5000k_h265"],
		);
	});

	it("a GENUINE duplicate (same height, bitrate and codec) still collides — that is LIVE_DUPLICATE_KEY's job, not this one's", () => {
		const keys = videoKeys([
			v(1080, 5_000_000, "H265"),
			v(1080, 5_000_000, "H265"),
		]);
		expect(keys[0]).toBe(keys[1]);
	});

	it("an explicit extras.key wins and a per-title template without a height gets a positional key", () => {
		expect(
			videoKeys([
				{
					...v(1080, 5_000_000),
					extras: { key: "hero" },
				} as WizardVideoRendition,
				v(null, null),
			]),
		).toEqual(["hero", "video2"]);
	});
});
