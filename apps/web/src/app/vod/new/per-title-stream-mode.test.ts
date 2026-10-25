import { describe, expect, it } from "vitest";
import {
	PER_TITLE_STREAM_CHOICES,
	perTitleStreamChoice,
	perTitleStreamChoiceLabel,
	perTitleStreamMode,
} from "./per-title-stream-mode";

describe("Per-Title Stream mode choices", () => {
	it("keeps the two ordinary-template choices on the same API mode", () => {
		expect(PER_TITLE_STREAM_CHOICES).toEqual([
			"template",
			"template-resolution",
			"fixed-resolution",
			"fixed-range",
		]);
		expect(PER_TITLE_STREAM_CHOICES.map(perTitleStreamMode)).toEqual([
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		]);
	});

	it("uses explicitly supplied dimensions without silently treating invalid input as absent", () => {
		expect(perTitleStreamChoice({ mode: "PER_TITLE_TEMPLATE" })).toBe(
			"template",
		);
		for (const dimension of [{ height: 360 }, { width: 640 }, { height: NaN }])
			expect(
				perTitleStreamChoice({ mode: "PER_TITLE_TEMPLATE", ...dimension }),
			).toBe("template-resolution");
		expect(
			perTitleStreamChoice({
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
				height: 360,
			}),
		).toBe("fixed-resolution");
		expect(
			perTitleStreamChoice({
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				height: 360,
			}),
		).toBe("fixed-range");
	});

	it.each([
		"en",
		"ja",
	] as const)("labels every choice with its actual Stream mode (%s)", (locale) => {
		for (const choice of PER_TITLE_STREAM_CHOICES)
			expect(perTitleStreamChoiceLabel(choice, locale)).toContain(
				perTitleStreamMode(choice),
			);
		expect(perTitleStreamChoiceLabel("template", locale)).not.toBe(
			perTitleStreamChoiceLabel("template-resolution", locale),
		);
	});
});
