import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { compileExpectedArtefacts } from "./expected";

describe("Per-title geometry requirements in compiled expectations", () => {
	it.each([
		"PER_TITLE_TEMPLATE",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	])("retains the raw stream mode independently of count semantics (%s)", (mode) => {
		const raw = JSON.parse(
			readFileSync(
				new URL(
					"../plan/__fixtures__/pertitle-h264-fmp4-ts-dash-hls-on-aws.plan.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		raw.renditions[0].mode = mode;
		raw.renditions[0].width = 320;
		const expected = compileExpectedArtefacts(encodingPlanSchema.parse(raw));
		const muxing = expected.muxings.find((row) => row.renditionKey === "v180");
		expect(muxing).toMatchObject({
			perTitleStreamMode: mode,
			video: { width: 320, height: 180 },
			perTitleMode:
				mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
					? "FIXED"
					: "TEMPLATE",
		});
	});
});
