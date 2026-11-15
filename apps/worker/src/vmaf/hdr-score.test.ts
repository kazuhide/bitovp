import { hdrInputFromProbe } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { validateHdrFrameTimeline, validateHdrVmafLog } from "./hdr-score";

const video = {
	codec_type: "video",
	codec_name: "av1",
	width: 3840,
	height: 2160,
	pix_fmt: "yuv420p10le",
	color_range: "tv",
	color_space: "bt2020nc",
	color_primaries: "bt2020",
	color_transfer: "smpte2084",
	sample_aspect_ratio: "1:1",
	field_order: "progressive",
	avg_frame_rate: "24/1",
	r_frame_rate: "24/1",
};
const input = hdrInputFromProbe(
	JSON.stringify({ streams: [video] }),
	"distorted",
);
const frame = (n: number) => ({
	...video,
	best_effort_timestamp: n * 1000,
	duration: 1000,
});
const timeline = (frames: unknown[]) =>
	JSON.stringify({ streams: [{ time_base: "1/24000" }], frames });

describe("full-frame HDR measurement", () => {
	it("requires an uninterrupted decoded presentation slot for every input frame", () => {
		expect(
			validateHdrFrameTimeline(timeline([frame(0), frame(1), frame(2)]), input),
		).toBe(3);
		expect(() =>
			validateHdrFrameTimeline(timeline([frame(0), frame(2)]), input),
		).toThrow("HDR_FRAME_CADENCE");
	});
	it("rejects mid-stream format/color changes and presentation transforms", () => {
		for (const changed of [
			{ ...frame(1), color_transfer: "bt709" },
			{ ...frame(1), width: 1920 },
			{ ...frame(1), side_data_list: [{ side_data_type: "Display Matrix" }] },
		])
			expect(() =>
				validateHdrFrameTimeline(timeline([frame(0), changed]), input),
			).toThrow();
	});
	it("requires every score, a contiguous index and the pinned library identity", () => {
		const log = {
			version: "a6ed0f1",
			frames: [
				{ frameNum: 0, metrics: { vmaf: 99 } },
				{ frameNum: 1, metrics: { vmaf: 98 } },
			],
		};
		expect(() => validateHdrVmafLog(log, 2)).not.toThrow();
		expect(() => validateHdrVmafLog(log, 3)).toThrow(
			"HDR_SCORE_FRAME_COVERAGE",
		);
		expect(() => validateHdrVmafLog({ ...log, version: "3.2.0" }, 2)).toThrow(
			"HDR_RUNTIME_REVISION_MISMATCH",
		);
		expect(() =>
			validateHdrVmafLog(
				{ ...log, frames: [{ frameNum: 0, metrics: { vmaf: Number.NaN } }] },
				1,
			),
		).toThrow();
	});
});
