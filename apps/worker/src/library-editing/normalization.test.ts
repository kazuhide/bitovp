import { describe, expect, it } from "vitest";
import {
	buildNormalizationRecipe,
	inspectNormalizationSourceMetadata,
	validateNormalizationVideoIndex,
} from "./normalization";

const probe = (fps = "24/1", frames = 48) => ({
	format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			codec_tag_string: "avc1",
			pix_fmt: "yuv420p",
			field_order: "progressive",
			sample_aspect_ratio: "1:1",
			r_frame_rate: fps,
			avg_frame_rate: fps,
			time_base: "1/120000",
			start_time: "0.000000",
			duration: String(
				frames / (Number(fps.split("/")[0]) / Number(fps.split("/")[1])),
			),
			nb_frames: String(frames),
			width: 320,
			height: 180,
			color_primaries: "bt709",
			color_transfer: "bt709",
			color_space: "bt709",
			color_range: "tv",
		},
	],
});

describe("indexed SDR normalization admission", () => {
	it.each([
		["24/1", 48, 60],
		["25/1", 50, 60],
		["30000/1001", 60, 60],
		["30/1", 60, 60],
	] as const)("maps %s to CFR30 without extending the source end", (fps, frames, outputFrames) => {
		const source = inspectNormalizationSourceMetadata(probe(fps, frames));
		const recipe = buildNormalizationRecipe(source);
		expect(recipe.outputFrameCount).toBe(outputFrames);
		expect(recipe.sourceFrameIndex).toHaveLength(outputFrames);
		for (const [j, sourceFrame] of recipe.sourceFrameIndex.entries())
			expect(sourceFrame).toBe(
				Math.floor((j * source.fps.num) / (30 * source.fps.den)),
			);
		expect(recipe.videoFilter).toContain("round=up");
	});
	it("uses integer rational arithmetic for a partial final frame", () => {
		const recipe = buildNormalizationRecipe(
			inspectNormalizationSourceMetadata(probe("24/1", 49)),
		);
		expect(recipe.outputFrameCount).toBe(61);
		expect(recipe.sourceEndUs).toBe(2_033_334);
		expect(recipe.sourceFrameIndex.at(-1)).toBe(48);
	});
	it.each([
		{ color_transfer: "smpte2084" },
		{ color_transfer: "arib-std-b67" },
		{ color_primaries: "bt2020" },
		{ color_transfer: "unknown" },
		{ pix_fmt: "yuv420p10le" },
		{ codec_tag_string: "encv" },
		{ field_order: "tt" },
		{ sample_aspect_ratio: "2:1" },
		{ avg_frame_rate: "23/1" },
		{ r_frame_rate: "60/1", avg_frame_rate: "60/1" },
		{ start_time: "1.000000" },
		{ tags: { rotate: "90" } },
		{ side_data_list: [{ rotation: -90 }] },
		{ color_range: "pc" },
	])("refuses unsupported or ambiguous source metadata %j", (change) => {
		const input = probe();
		Object.assign(input.streams[0] ?? {}, change);
		expect(() => inspectNormalizationSourceMetadata(input)).toThrow();
	});
	it("refuses a second video or unrecognized stream instead of silently dropping it", () => {
		const input = probe();
		input.streams.push({
			...input.streams[0],
		} as (typeof input.streams)[number]);
		expect(() => inspectNormalizationSourceMetadata(input)).toThrow();
	});
	it("verifies every original PTS before indexing the resample", () => {
		const source = inspectNormalizationSourceMetadata(probe());
		const timestamps = Array.from({ length: 48 }, (_, index) =>
			String(index * 5000),
		).join("\n");
		expect(validateNormalizationVideoIndex(source, timestamps)).toMatch(
			/^[a-f0-9]{64}$/,
		);
		const changed = timestamps.replace("25000\n", "25001\n");
		expect(() => validateNormalizationVideoIndex(source, changed)).toThrow();
		expect(() =>
			validateNormalizationVideoIndex(
				source,
				timestamps.split("\n").slice(1).join("\n"),
			),
		).toThrow();
	});
});
