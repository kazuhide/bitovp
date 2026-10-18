import { describe, expect, it } from "vitest";
import {
	formatBitrate,
	formatFrameRate,
	formatProbeDuration,
	isInspectionRunning,
	summarizeProbe,
	toInspectionDto,
} from "./inspect-shared";

describe("formatFrameRate", () => {
	it.each([
		["30000/1001", "29.97 fps"],
		["25/1", "25 fps"],
		["50", "50 fps"],
		// ffprobe reports 0/0 for streams with no frame rate (audio, data).
		["0/0", null],
		["24/0", null],
		["", null],
		[undefined, null],
		[42, null],
	])("%s → %s", (raw, expected) => {
		expect(formatFrameRate(raw)).toBe(expected);
	});
});

describe("formatProbeDuration", () => {
	it.each([
		["135.400000", "2:15.400"],
		["3735.400000", "1:02:15.400"],
		["9.5", "0:09.500"],
		["0", "0:00.000"],
		["N/A", null],
		[undefined, null],
		["-5", null],
	])("%s → %s", (raw, expected) => {
		expect(formatProbeDuration(raw)).toBe(expected);
	});
});

describe("formatBitrate", () => {
	it.each([
		["4500000", "4.50 Mbps"],
		["128000", "128 kbps"],
		["800", "800 bps"],
		["0", null],
		[undefined, null],
	])("%s → %s", (raw, expected) => {
		expect(formatBitrate(raw)).toBe(expected);
	});
});

describe("summarizeProbe", () => {
	it("does not present the 8 MiB Run25 probe's bitrate as the whole MP4 bitrate", () => {
		const probe = {
			format: {
				format_name: "mov,mp4",
				duration: "540.458",
				size: "8388608",
				bit_rate: "124170",
			},
			streams: [
				{ index: 0, codec_type: "video", bit_rate: "1280000" },
				{ index: 1, codec_type: "audio", bit_rate: "125000" },
			],
		};
		const original = structuredClone(probe);
		const summary = summarizeProbe(probe);
		expect(summary?.bitRate).toBeNull();
		expect(summary?.duration).toBe("9:00.458");
		expect(summary?.streams.map((stream) => stream.bitRate)).toEqual([
			"1.28 Mbps",
			"125 kbps",
		]);
		expect(probe).toEqual(original);
	});

	it("lifts container + per-stream fields out of raw ffprobe JSON", () => {
		const summary = summarizeProbe({
			format: {
				format_name: "mov,mp4",
				format_long_name: "QuickTime / MOV",
				duration: "10.5",
				bit_rate: "4500000",
			},
			streams: [
				{
					index: 0,
					codec_type: "video",
					codec_name: "h264",
					profile: "High",
					width: 1280,
					height: 720,
					r_frame_rate: "30/1",
					bit_rate: "3000000",
				},
				{
					index: 1,
					codec_type: "audio",
					codec_name: "aac",
					channels: 6,
					channel_layout: "5.1",
					sample_rate: "48000",
					tags: { language: "jpn" },
				},
			],
		});
		expect(summary).toEqual({
			// format_long_name wins over the terse format_name.
			formatName: "QuickTime / MOV",
			duration: "0:10.500",
			bitRate: null,
			streams: [
				{
					key: "0",
					index: 0,
					codecType: "video",
					codecName: "h264",
					profile: "High",
					resolution: "1280×720",
					frameRate: "30 fps",
					bitRate: "3.00 Mbps",
					channels: null,
					sampleRate: null,
					language: null,
				},
				{
					key: "1",
					index: 1,
					codecType: "audio",
					codecName: "aac",
					profile: null,
					resolution: null,
					frameRate: null,
					bitRate: null,
					channels: "6 (5.1)",
					sampleRate: "48000 Hz",
					language: "jpn",
				},
			],
		});
	});

	it("falls back to avg_frame_rate when the container rate is 0/0 (VFR)", () => {
		const summary = summarizeProbe({
			format: { format_name: "matroska" },
			streams: [{ r_frame_rate: "0/0", avg_frame_rate: "24000/1001" }],
		});
		expect(summary?.streams[0]?.frameRate).toBe("23.98 fps");
	});

	it("returns null for a probe with nothing recognizable (raw JSON only)", () => {
		expect(summarizeProbe(null)).toBeNull();
		expect(summarizeProbe("nope")).toBeNull();
		expect(summarizeProbe({})).toBeNull();
		expect(summarizeProbe({ streams: "not-an-array" })).toBeNull();
	});

	it("survives garbage stream entries rather than throwing", () => {
		const summary = summarizeProbe({
			format: { format_name: "mpegts" },
			streams: [null, 7, { index: "2" }],
		});
		expect(summary?.streams).toHaveLength(3);
		expect(summary?.streams[0]?.key).toBe("pos-0");
		// A numeric string index is still an index; everything else stays null.
		expect(summary?.streams[2]?.index).toBe(2);
		expect(summary?.streams[1]?.codecName).toBeNull();
	});
});

describe("row helpers", () => {
	it("maps Dates to ISO and a missing probe to null", () => {
		expect(
			toInspectionDto({
				id: "id-1",
				status: "RUNNING",
				bucket: "b",
				objectKey: "k.mp4",
				probe: null,
				bytesRead: null,
				error: null,
				createdAt: new Date("2026-08-06T00:00:00Z"),
				updatedAt: new Date("2026-08-06T00:00:01Z"),
			}),
		).toEqual({
			id: "id-1",
			status: "RUNNING",
			bucket: "b",
			objectKey: "k.mp4",
			probe: null,
			bytesRead: null,
			error: null,
			createdAt: "2026-08-06T00:00:00.000Z",
			updatedAt: "2026-08-06T00:00:01.000Z",
		});
	});

	it("polls only the non-terminal statuses", () => {
		expect(isInspectionRunning("PENDING")).toBe(true);
		expect(isInspectionRunning("RUNNING")).toBe(true);
		expect(isInspectionRunning("FINISHED")).toBe(false);
		expect(isInspectionRunning("ERROR")).toBe(false);
	});
});
