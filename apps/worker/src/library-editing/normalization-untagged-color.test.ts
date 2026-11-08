import { editingNormalizationEvidenceSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { inspectNormalizationSourceMetadata } from "./normalization";

// Technical metadata observed by BitOVP's normal StorageInspection worker.
// This fixture never downloads, decodes, or submits the customer material.
const untaggedProbe = (video: Record<string, unknown> = {}) => ({
	format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			codec_tag_string: "avc1",
			pix_fmt: "yuv420p",
			bits_per_raw_sample: "8",
			field_order: "progressive",
			sample_aspect_ratio: "1:1",
			width: 872,
			height: 480,
			r_frame_rate: "30/1",
			avg_frame_rate: "30/1",
			time_base: "1/30000",
			start_time: "0.000000",
			duration: "180.000000",
			nb_frames: "5400",
			...video,
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			codec_tag_string: "mp4a",
			channels: 2,
			sample_rate: "48000",
			time_base: "1/48000",
			start_time: "0.000000",
			duration: "180.031667",
		},
	],
});

const assumedEvidence = () => ({
	schemaVersion: 1,
	profile: "SDR_CFR30_INDEXED_V1",
	mode: "NORMALIZE",
	originalSha256: "a".repeat(64),
	preparedSha256: "b".repeat(64),
	originalBytes: 100,
	preparedBytes: 120,
	source: {
		width: 872,
		height: 480,
		codec: "h264",
		fps: { num: 30, den: 1 },
		timeBase: { num: 1, den: 30000 },
		frameCount: 2,
		durationUs: 66667,
		videoPtsHash: "c".repeat(64),
		colorProfile: "BT709_8BIT_LIMITED_ASSUMED",
		audio: null,
	},
	output: {
		width: 872,
		height: 480,
		frameCount: 2,
		durationUs: 66667,
		fps: { num: 30, den: 1 },
		hasAudio: false,
	},
	sourceStartUs: 0,
	sourceEndUs: 66667,
	sourceFrameIndex: [0, 1],
	indexMapHash: "d".repeat(64),
	recipeHash: "e".repeat(64),
});

describe("untagged 8bit normalization evidence", () => {
	it("admits the untagged BitOVP output with an explicit color assumption", () => {
		const source = inspectNormalizationSourceMetadata(untaggedProbe());
		expect(source).toMatchObject({
			width: 872,
			height: 480,
			frameCount: 5400,
			durationUs: 180_000_000,
			fps: { num: 30, den: 1 },
			colorProfile: "BT709_8BIT_LIMITED_ASSUMED",
			audio: { sampleRate: 48000, channels: 2 },
		});
	});

	it.each([
		"unknown",
		"unspecified",
	])("distinguishes %s color metadata from verified BT709", (value) => {
		const source = inspectNormalizationSourceMetadata(
			untaggedProbe({
				color_primaries: value,
				color_transfer: value,
				color_space: value,
			}),
		);
		expect(source.colorProfile).toBe("BT709_8BIT_LIMITED_ASSUMED");
	});

	it("retains the verified profile when all color tags explicitly specify BT709", () => {
		const source = inspectNormalizationSourceMetadata(
			untaggedProbe({
				color_primaries: "bt709",
				color_transfer: "bt709",
				color_space: "bt709",
				color_range: "tv",
			}),
		);
		expect(source.colorProfile).toBe("BT709_8BIT_LIMITED");
	});

	it.each([
		{ color_transfer: "smpte2084" },
		{ color_transfer: "arib-std-b67" },
		{ color_primaries: "bt2020" },
		{ color_space: "bt2020nc" },
		{ color_range: "pc" },
		{ pix_fmt: "yuv420p10le" },
		{ color_primaries: "bt709" },
		{ side_data_list: [{ side_data_type: "Mastering display metadata" }] },
		{ side_data_list: [{ side_data_type: "Content light level metadata" }] },
		{ side_data_list: [{ side_data_type: "DOVI configuration record" }] },
	])("refuses contradictory or incomplete color evidence %j", (video) => {
		expect(() =>
			inspectNormalizationSourceMetadata(untaggedProbe(video)),
		).toThrow();
	});

	it("accepts normalized evidence without claiming the original had BT709 tags", () => {
		const result = editingNormalizationEvidenceSchema.safeParse(
			assumedEvidence(),
		);
		expect(result.success).toBe(true);
	});

	it("forbids identity-copy evidence for assumed color even at CFR30", () => {
		const evidence = assumedEvidence();
		evidence.mode = "IDENTITY_COPY";
		evidence.preparedSha256 = evidence.originalSha256;
		evidence.preparedBytes = evidence.originalBytes;
		expect(editingNormalizationEvidenceSchema.safeParse(evidence).success).toBe(
			false,
		);
	});
});
