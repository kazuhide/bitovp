import { describe, expect, it } from "vitest";
import { hasWebmHeader, validateMoqArchiveProbe } from "./moq-archive-media";

const probe = () => ({
	format: { format_name: "matroska,webm" },
	streams: [{ index: 0, codec_type: "video", codec_name: "vp8" }],
	packets: [
		{ stream_index: 0, pts_time: "0.000", duration_time: "0.033" },
		{ stream_index: 0, pts_time: "9.967", duration_time: "0.033" },
	],
});
describe("bounded WebM archive media validation", () => {
	it("requires an EBML header with the actual WebM DocType", () => {
		expect(
			hasWebmHeader(
				Buffer.from([
					0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62,
					0x6d,
				]),
			),
		).toBe(true);
		expect(hasWebmHeader(Buffer.from("not webm"))).toBe(false);
		expect(
			hasWebmHeader(
				Buffer.from([
					0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x66, 0x61, 0x6b,
					0x65,
				]),
			),
		).toBe(false);
	});
	it("derives actual duration from packet timestamps even when MediaRecorder omits format duration", () => {
		expect(validateMoqArchiveProbe(probe())).toBe(10_000);
	});
	it.each([
		{ streams: [{ index: 0, codec_type: "audio", codec_name: "opus" }] },
		{ packets: [] },
		{
			packets: [
				{ stream_index: 0, pts_time: "0" },
				{ stream_index: 0, pts_time: "91" },
			],
		},
		{ format: { format_name: "matroska,webm", duration: "91" } },
		{ packets: [{ stream_index: 0, pts_time: "NaN" }] },
		{
			packets: Array.from({ length: 40_001 }, () => ({
				stream_index: 0,
				pts_time: "0",
			})),
		},
	])("refuses absent video, invalid timestamps or a recording longer than ninety seconds", (override) => {
		expect(() =>
			validateMoqArchiveProbe({ ...probe(), ...override }),
		).toThrow();
	});
});
