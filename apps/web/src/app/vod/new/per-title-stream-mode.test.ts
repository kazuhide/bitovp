import { describe, expect, it } from "vitest";
import {
	PER_TITLE_STREAM_CHOICES,
	perTitleStreamChoice,
	perTitleStreamChoiceLabel,
	perTitleStreamLabel,
	perTitleStreamMode,
} from "./per-title-stream-mode";

describe("Per-Title Stream mode choices", () => {
	it("offers exactly the three API modes without dimension-based variants", () => {
		expect(PER_TITLE_STREAM_CHOICES).toEqual([
			"template",
			"fixed-resolution",
			"fixed-range",
		]);
		expect(PER_TITLE_STREAM_CHOICES.map(perTitleStreamMode)).toEqual([
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		]);
	});

	it("keeps ordinary-template hints independent of the Stream mode", () => {
		expect(perTitleStreamChoice({ mode: "PER_TITLE_TEMPLATE" })).toBe(
			"template",
		);
		for (const dimension of [{ height: 360 }, { width: 640 }, { height: NaN }])
			expect(
				perTitleStreamChoice({ mode: "PER_TITLE_TEMPLATE", ...dimension }),
			).toBe("template");
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

	it("labels choices and configured streams with their actual API mode", () => {
		for (const choice of PER_TITLE_STREAM_CHOICES)
			expect(perTitleStreamChoiceLabel(choice)).toBe(
				perTitleStreamMode(choice),
			);
		for (const dimensions of [{}, { height: 360 }, { width: 640 }])
			expect(
				perTitleStreamLabel({ mode: "PER_TITLE_TEMPLATE", ...dimensions }),
			).toBe("PER_TITLE_TEMPLATE");
	});
});
