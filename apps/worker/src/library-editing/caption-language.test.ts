import { describe, expect, it } from "vitest";
import { captionLanguageForSelectedSegments } from "./caption-language";

const observations = ["ja", "ko", "ja", "ja", "ja", "ja", "ja", "ko", "ja"].map(
	(language, i) => ({
		startUs: i * 180_000_000,
		endUs: Math.min((i + 1) * 180_000_000, 1_470_000_000),
		language,
	}),
);
const selected = [
	{ startUs: 507_220_000, endUs: 516_860_000 },
	{ startUs: 613_280_000, endUs: 623_200_000 },
	{ startUs: 649_980_000, endUs: 660_230_000 },
];
const source = { startUs: 0, endUs: 1_470_000_000 };
function known<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing authored language window");
	return value;
}

describe("observed language for the selected full-paragraph audio context", () => {
	it("does not let unrelated source-language windows disable Japanese caption alignment", () => {
		expect(
			captionLanguageForSelectedSegments(selected, observations, source),
		).toBe("ja");
	});
	it("requires support for the whole paragraph and context, not just the chosen video shot", () => {
		expect(
			captionLanguageForSelectedSegments(
				[{ startUs: 358_000_000, endUs: 361_000_000 }],
				observations,
				source,
			),
		).toBeUndefined();
		expect(
			captionLanguageForSelectedSegments(
				[{ startUs: 361_000_000, endUs: 365_000_000 }],
				observations,
				source,
			),
		).toBeUndefined();
	});
	it("does not guess a language for mixed, unknown or missing observed support", () => {
		expect(
			captionLanguageForSelectedSegments(
				[known(selected[0]), { startUs: 1_270_000_000, endUs: 1_275_000_000 }],
				observations,
				source,
			),
		).toBeUndefined();
		expect(
			captionLanguageForSelectedSegments(
				selected,
				observations.filter((o) => o.startUs !== 540_000_000),
				source,
			),
		).toBeUndefined();
		expect(
			captionLanguageForSelectedSegments(
				selected,
				observations.map((o) => ({ ...o, language: "und" })),
				source,
			),
		).toBeUndefined();
	});
	it("accepts English observations without confusing the request language auto with speech", () => {
		expect(
			captionLanguageForSelectedSegments(
				selected,
				observations.map((o) => ({ ...o, language: "en" })),
				source,
			),
		).toBe("en");
	});
	it("uses original-presentation time once when the source origin is nonzero", () => {
		const origin = 77_000_000;
		const shift = <T extends { startUs: number; endUs: number }>(r: T) => ({
			...r,
			startUs: r.startUs + origin,
			endUs: r.endUs + origin,
		});
		expect(
			captionLanguageForSelectedSegments(
				selected.map(shift),
				observations.map(shift),
				shift(source),
			),
		).toBe("ja");
	});
	it("fails closed on overlapping observations or an empty target", () => {
		expect(
			captionLanguageForSelectedSegments(
				selected,
				[known(observations[2]), known(observations[2])],
				source,
			),
		).toBeUndefined();
		expect(
			captionLanguageForSelectedSegments([], observations, source),
		).toBeUndefined();
	});
});
