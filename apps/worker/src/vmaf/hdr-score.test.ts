import { hdrInputFromProbe } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import meridianHeader from "../../../../packages/core/src/vmaf/__fixtures__/meridian-imf-rgb-header.json";
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

// Saved original MXF stream shape; a complete 60000/1001 clock is an explicit
// fixture input, not inferred from the partial header's avg_frame_rate=0/0.
const meridianVideo = {
	...meridianHeader.streams[0],
	avg_frame_rate: "60000/1001",
};
const declaredReference = hdrInputFromProbe(
	JSON.stringify({
		streams: [
			{
				...meridianVideo,
				color_primaries: "smpte432",
				color_transfer: "smpte2084",
			},
		],
	}),
	"reference",
	"P3_D65_PQ_RGB_FULL",
);
const meridianFrame = (n: number) => ({
	width: 3840,
	height: 2160,
	pix_fmt: "rgb48le",
	sample_aspect_ratio: "1:1",
	best_effort_timestamp: n,
	duration: 1,
});
const meridianTimeline = (frames: unknown[]) =>
	JSON.stringify({ streams: [{ time_base: "1001/60000" }], frames });

describe("full-frame HDR measurement", () => {
	it("accepts missing frame color attributes only for the explicitly declared P3/PQ RGB reference", () => {
		const completeFrames = [
			meridianFrame(0),
			{
				...meridianFrame(1),
				color_primaries: "smpte432",
				color_transfer: "smpte2084",
				color_range: "pc",
				color_space: "gbr",
			},
			meridianFrame(2),
		];
		expect(
			validateHdrFrameTimeline(
				meridianTimeline(completeFrames),
				declaredReference,
			),
		).toBe(3);
		expect(() =>
			validateHdrFrameTimeline(meridianTimeline(completeFrames), {
				...declaredReference,
				attributeSource: "STREAM_METADATA",
			}),
		).toThrow("HDR_FRAME_FORMAT_CHANGED");
		expect(() =>
			validateHdrFrameTimeline(
				meridianTimeline([meridianFrame(0), meridianFrame(2)]),
				declaredReference,
			),
		).toThrow("HDR_FRAME_CADENCE");
	});
	it.each([
		{ color_primaries: "bt2020" },
		{ color_transfer: "bt709" },
		{ color_range: "tv" },
		{ color_space: "bt2020nc" },
		{ color_primaries: null },
	])("rejects contradictory frame attributes in a declared RGB reference: %j", (tags) => {
		expect(() =>
			validateHdrFrameTimeline(
				meridianTimeline([meridianFrame(0), { ...meridianFrame(1), ...tags }]),
				declaredReference,
			),
		).toThrow("HDR_FRAME_FORMAT_CHANGED");
	});
	it("does not relax encoded YUV frame metadata for a forged declaration marker", () => {
		const missing = {
			...frame(0),
			color_primaries: undefined,
			color_transfer: undefined,
			color_range: undefined,
			color_space: undefined,
		};
		expect(() =>
			validateHdrFrameTimeline(timeline([missing]), {
				...input,
				attributeSource: "P3_D65_PQ_RGB_FULL",
			}),
		).toThrow("HDR_FRAME_FORMAT_CHANGED");
	});
	it.each([
		"24000/1001",
		"60000/1001",
	])("accepts complete %s frames quantized to a 90 kHz clock and rejects dropped/repeated slots", (frameRate) => {
		const fractional = hdrInputFromProbe(
			JSON.stringify({
				streams: [
					{
						...video,
						avg_frame_rate: frameRate,
						r_frame_rate: frameRate,
					},
				],
			}),
			"distorted",
		);
		const [numerator, denominator] = frameRate.split("/").map(Number);
		const ticks = (90000 * Number(denominator)) / Number(numerator);
		const frames = Array.from({ length: 10 }, (_, n) => ({
			...frame(n),
			best_effort_timestamp: 125 + Math.round(n * ticks),
			duration: Math.round((n + 1) * ticks) - Math.round(n * ticks),
		}));
		const encode = (population: unknown[]) =>
			JSON.stringify({
				streams: [{ time_base: "1/90000" }],
				frames: population,
			});
		expect(validateHdrFrameTimeline(encode(frames), fractional)).toBe(10);
		expect(() =>
			validateHdrFrameTimeline(encode([frames[0], frames[2]]), fractional),
		).toThrow("HDR_FRAME_CADENCE");
		expect(() =>
			validateHdrFrameTimeline(encode([frames[0], frames[0]]), fractional),
		).toThrow("HDR_FRAME_CADENCE");
	});
	it("keeps exactly representable one-tick frames strict", () => {
		const encode = (positions: number[]) =>
			JSON.stringify({
				streams: [{ time_base: "1/24" }],
				frames: positions.map((n) => ({
					...frame(n),
					best_effort_timestamp: n,
					duration: 1,
				})),
			});
		expect(validateHdrFrameTimeline(encode([0, 1, 2]), input)).toBe(3);
		expect(() => validateHdrFrameTimeline(encode([0, 2, 3]), input)).toThrow(
			"HDR_FRAME_CADENCE",
		);
	});
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
