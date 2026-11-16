import { describe, expect, it } from "vitest";
import meridianHeader from "./__fixtures__/meridian-imf-rgb-header.json";
import {
	buildHdrVmafCommand,
	HDR_VMAF_MODELS,
	HDR_VMAF_SCORING_VERSION,
	hdrInputFromProbe,
	hdrMeasurementOf,
	isHdrVmafModel,
} from "./hdr";

const encoded = {
	codec_type: "video",
	codec_name: "av1",
	width: 3840,
	height: 2160,
	pix_fmt: "yuv420p10le",
	color_range: "tv",
	color_primaries: "bt2020",
	color_transfer: "smpte2084",
	color_space: "bt2020nc",
	sample_aspect_ratio: "1:1",
	field_order: "progressive",
	avg_frame_rate: "24/1",
	r_frame_rate: "24/1",
	side_data_list: [
		{
			side_data_type: "DOVI configuration record",
			dv_profile: 10,
			dv_bl_signal_compatibility_id: 1,
			rpu_present_flag: 1,
			bl_present_flag: 1,
			el_present_flag: 0,
		},
	],
};
const rgb = {
	codec_type: "video",
	codec_name: "jpeg2000",
	width: 3840,
	height: 2160,
	pix_fmt: "rgb48le",
	bits_per_raw_sample: "12",
	color_primaries: "smpte432",
	color_transfer: "smpte2084",
	sample_aspect_ratio: "1:1",
	field_order: "progressive",
	avg_frame_rate: "24/1",
	r_frame_rate: "24/1",
};
const probe = (video: object) => JSON.stringify({ streams: [video] });

describe("native HDR QC protocol", () => {
	it("keeps native HDR separate from the existing SDR generations", () => {
		expect(HDR_VMAF_SCORING_VERSION).toBe(14);
		expect(isHdrVmafModel("hdr_vmaf_v1.1.8_3d0h_2160")).toBe(true);
		expect(isHdrVmafModel("vmaf_v1.0.16_3d0h_2160")).toBe(false);
		expect(isHdrVmafModel("hdr_unknown")).toBe(false);
	});
	it("uses the calibrated HFR model for 50/60 fps HDR instead of a standard-rate model", () => {
		const hfr = hdrInputFromProbe(
			probe({ ...encoded, avg_frame_rate: "60/1", r_frame_rate: "60/1" }),
			"distorted",
		);
		const options = {
			referencePath: "/ref.mp4",
			distortedPath: "/dist.mp4",
			logPath: "/score.json",
			modelPath: "/models/hdr.json",
			reference: hfr,
			distorted: hfr,
		};
		expect(() =>
			buildHdrVmafCommand({
				...options,
				model: "hdr_vmaf_v1.1.8_hfr_3d0h_2160",
			}),
		).not.toThrow();
		expect(() =>
			buildHdrVmafCommand({ ...options, model: "hdr_vmaf_v1.1.8_3d0h_2160" }),
		).toThrow("HDR_MODEL_FRAME_RATE_MISMATCH");
	});
	it("accepts the HDR10-compatible profile10.1 base layer", () => {
		expect(hdrInputFromProbe(probe(encoded), "distorted")).toMatchObject({
			primaries: "bt2020",
			transfer: "smpte2084",
			matrix: "bt2020nc",
			range: "limited",
			bitDepth: 10,
			pixelFormat: "yuv420p10le",
			dolbyVision: { profile: 10, compatibilityId: 1 },
		});
	});
	it.each([
		0, 4,
	])("refuses Dolby compatibility ID %s when it contradicts the PQ base layer", (id) => {
		expect(() =>
			hdrInputFromProbe(
				probe({
					...encoded,
					side_data_list: [
						{
							...encoded.side_data_list[0],
							dv_bl_signal_compatibility_id: id,
						},
					],
				}),
				"distorted",
			),
		).toThrow("HDR_DOLBY_BASE_LAYER_UNSUPPORTED");
	});
	it("accepts HLG with an explicit 1000-nit display-referred PQ conversion", () => {
		const hlg = hdrInputFromProbe(
			probe({ ...encoded, color_transfer: "arib-std-b67", side_data_list: [] }),
			"distorted",
		);
		expect(hlg.transfer).toBe("arib-std-b67");
		const args = buildHdrVmafCommand({
			referencePath: "/ref.mp4",
			distortedPath: "/dist.mp4",
			logPath: "/score.json",
			model: HDR_VMAF_MODELS[0].id,
			modelPath: "/models/hdr.json",
			reference: hlg,
			distorted: hlg,
		});
		const graph = args[args.indexOf("-filter_complex") + 1];
		expect(graph).toContain("transferin=arib-std-b67");
		expect(graph).toContain("transfer=smpte2084");
		expect(graph).toContain("npl=1000");
		expect(graph).toContain("agamma=false");
	});
	it("requires an explicit declaration for the full-range P3/PQ RGB reference", () => {
		expect(() => hdrInputFromProbe(probe(rgb), "reference")).toThrow(
			"HDR_COLOR_ATTRIBUTES_REQUIRED",
		);
		expect(
			hdrInputFromProbe(probe(rgb), "reference", "P3_D65_PQ_RGB_FULL"),
		).toMatchObject({
			primaries: "smpte432",
			transfer: "smpte2084",
			matrix: "gbr",
			range: "full",
			bitDepth: 12,
			attributeSource: "P3_D65_PQ_RGB_FULL",
		});
	});
	it("accepts explicitly declared P3/PQ RGB with missing color attributes and a complete clock", () => {
		// Original MXF header metadata: f67979a1935ba52a16b941f5ac9ba058a663aa2f72521f70eb0770ea89e0516f.
		// The partial header has avg_frame_rate=0/0; this positive fixture supplies
		// a complete clock separately, without claiming the header proves it.
		const source = {
			...meridianHeader.streams[0],
			avg_frame_rate: "60000/1001",
		};
		expect(
			hdrInputFromProbe(probe(source), "reference", "P3_D65_PQ_RGB_FULL"),
		).toMatchObject({
			pixelFormat: "rgb48le",
			bitDepth: 12,
			primaries: "smpte432",
			transfer: "smpte2084",
			matrix: "gbr",
			range: "full",
			frameRate: "60000/1001",
			attributeSource: "P3_D65_PQ_RGB_FULL",
		});
		expect(() => hdrInputFromProbe(probe(source), "reference")).toThrow(
			"HDR_COLOR_ATTRIBUTES_REQUIRED",
		);
		expect(() =>
			hdrInputFromProbe(probe(source), "distorted", "P3_D65_PQ_RGB_FULL"),
		).toThrow("HDR_REFERENCE_DECLARATION_MISMATCH");
	});
	it("keeps the original partial MXF header's unknown average frame rate rejected", () => {
		expect(() =>
			hdrInputFromProbe(
				JSON.stringify(meridianHeader),
				"reference",
				"P3_D65_PQ_RGB_FULL",
			),
		).toThrow("HDR_FRAME_RATE_UNSUPPORTED");
	});
	it.each([
		{ color_primaries: "bt2020" },
		{ color_transfer: "arib-std-b67" },
		{ color_range: "tv" },
		{ color_space: "bt2020nc" },
		{ color_range: "unknown" },
		{ color_primaries: null },
	])("rejects a declared RGB reference with contradictory or malformed color metadata: %j", (tags) => {
		expect(() =>
			hdrInputFromProbe(
				probe({
					...meridianHeader.streams[0],
					avg_frame_rate: "60000/1001",
					...tags,
				}),
				"reference",
				"P3_D65_PQ_RGB_FULL",
			),
		).toThrow("HDR_REFERENCE_DECLARATION_MISMATCH");
	});
	it("does not let the RGB declaration override contradictory tags or YUV input", () => {
		for (const video of [
			{ ...rgb, color_range: "tv" },
			{ ...rgb, color_transfer: "bt709" },
			encoded,
		])
			expect(() =>
				hdrInputFromProbe(probe(video), "reference", "P3_D65_PQ_RGB_FULL"),
			).toThrow();
	});
	it.each([
		{ ...encoded, color_primaries: undefined },
		{ ...encoded, color_transfer: "bt709" },
		{ ...encoded, sample_aspect_ratio: "4:3" },
		{ ...encoded, field_order: "tt" },
		{ ...encoded, avg_frame_rate: "120/1", r_frame_rate: "120/1" },
	])("refuses incomplete, transformed or uncalibrated HDR input", (video) => {
		expect(() => hdrInputFromProbe(probe(video), "distorted")).toThrow();
	});
	it("actually transforms primaries at 16-bit precision and passes complete color attributes", () => {
		const args = buildHdrVmafCommand({
			distortedPath: "/dist.mp4",
			referencePath: "/ref.mxf",
			logPath: "/score.json",
			model: HDR_VMAF_MODELS[0].id,
			modelPath: "/models/hdr.json",
			threads: 1,
			reference: hdrInputFromProbe(
				probe(rgb),
				"reference",
				"P3_D65_PQ_RGB_FULL",
			),
			distorted: hdrInputFromProbe(probe(encoded), "distorted"),
		});
		const graph = args[args.indexOf("-filter_complex") + 1];
		expect(graph).toContain("primariesin=smpte432");
		expect(graph).toContain("primaries=2020");
		expect(graph).toContain("format=yuv444p16le");
		expect(graph).toContain("color_trc=smpte2084");
		expect(graph).toContain("shortest=1:repeatlast=0");
		expect(graph).not.toMatch(/tonemap|yuv420p10le|bt709/);
	});
	it("does not expose incomplete or private HDR evidence", () => {
		expect(
			hdrMeasurementOf({
				hdrMeasurement: {
					version: 1,
					method: "HDR_VMAF_PQ_ICTCP_16",
					privatePath: "/secret",
				},
			}),
		).toBeUndefined();
	});
});
