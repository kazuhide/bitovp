import { describe, expect, it } from "vitest";
import { selectedCaptionAudioRanges } from "./caption-source-ranges";

const map = (origin = 0, editingStartFrame = 0) => ({
	sourceStartUs: origin,
	sourceEndUs: origin + 2_000_000,
	editingStartFrame,
	editingEndFrame: editingStartFrame + 60,
});

describe("selected caption audio uses the authoritative CFR endpoints", () => {
	it.each([
		0, 12_345_678,
	])("does not add independent rounded durations past valid EOF (origin %s)", (origin) => {
		expect(
			selectedCaptionAudioRanges(
				[{ sourceInUs: origin + 33_334, durationFrames: 59 }],
				map(origin, 90),
			),
		).toEqual([{ startUs: origin + 33_334, endUs: origin + 2_000_000 }]);
	});
	it("uses the decoded frame's start rather than an arbitrary subframe selection timestamp", () => {
		expect(
			selectedCaptionAudioRanges(
				[{ sourceInUs: 1, durationFrames: 30 }],
				map(),
			),
		).toEqual([{ startUs: 0, endUs: 1_000_000 }]);
	});
	it("uses actual audio EOF for a valid final padded CFR frame", () => {
		expect(
			selectedCaptionAudioRanges(
				[{ sourceInUs: 2_000_000, durationFrames: 1 }],
				{ ...map(), sourceEndUs: 2_005_000, editingEndFrame: 61 },
			),
		).toEqual([{ startUs: 2_000_000, endUs: 2_005_000 }]);
	});
	it("rejects frames beyond the verified time map instead of hiding an invalid selection by clamping", () => {
		expect(() =>
			selectedCaptionAudioRanges(
				[{ sourceInUs: 2_000_000, durationFrames: 1 }],
				map(),
			),
		).toThrow("SOURCE_OUT_OF_BOUNDS");
	});
	it("preserves adjacent and reordered source ranges without microsecond overlaps", () => {
		expect(
			selectedCaptionAudioRanges(
				[
					{ sourceInUs: 1_000_000, durationFrames: 30 },
					{ sourceInUs: 33_334, durationFrames: 29 },
				],
				map(),
			),
		).toEqual([
			{ startUs: 1_000_000, endUs: 2_000_000 },
			{ startUs: 33_334, endUs: 1_000_000 },
		]);
	});
});
