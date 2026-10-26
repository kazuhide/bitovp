import { describe, expect, it } from "vitest";
import {
	parsePerTitlePreset,
	serializePerTitlePreset,
} from "./per-title-simulator-preset";

const global = { minBitrate: 100_000, maxBitrate: 4_000_000 };

describe("Per-Title width-only reference files", () => {
	it.each([
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	])("preserves width and absent height for %s", (mode) => {
		const reference = {
			codec: "H264",
			global,
			streams: [
				{
					id: "width-only",
					mode,
					width: 640,
					...(mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
						? { perTitleSettings: { minBitrate: 300_000, maxBitrate: 600_000 } }
						: {}),
				},
			],
		};
		const loaded = parsePerTitlePreset(
			JSON.stringify({ version: 1, reference }),
			["H264"],
		);
		expect(loaded.goal.rows?.[0]?.width).toBe(640);
		expect(loaded.goal.rows?.[0]).not.toHaveProperty("height");
		expect(loaded.reference).toEqual(reference);
		expect(
			parsePerTitlePreset(
				serializePerTitlePreset(loaded.goal, loaded.reference),
				["H264"],
			),
		).toEqual(loaded);
	});

	it("still rejects a fixed Stream with neither width nor height", () => {
		expect(() =>
			parsePerTitlePreset(
				JSON.stringify({
					version: 1,
					reference: {
						codec: "H264",
						global,
						streams: [
							{ id: "missing", mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" },
						],
					},
				}),
				["H264"],
			),
		).toThrow("Invalid Per-Title preset.");
	});
});
