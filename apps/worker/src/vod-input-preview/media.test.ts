import {
	validateVodInputTimeline,
	vodInputTimelineSourceFactsSchema,
} from "@bitovp/core/vod-input-timeline";
import { describe, expect, it, vi } from "vitest";
import {
	inspectVodInputProbe,
	renderVodInputPreview,
	vodInputPreviewCanvas,
	vodInputPreviewReadArgs,
} from "./media";

const identity = { size: 1000, etag: '"source-v1"' };
const probe = () => ({
	streams: [
		{
			index: 2,
			codec_type: "video",
			width: 1920,
			height: 1080,
			duration: "8.125",
			avg_frame_rate: "30000/1001",
		},
		{ index: 3, codec_type: "audio", sample_rate: "48000", channels: 2 },
	],
	format: { duration: "8.2", format_name: "mov,mp4" },
});

const matrix = (a: number, b: number, c: number, d: number) =>
	`00000000: ${a} ${b} 0\n00000001: ${c} ${d} 0\n00000002: 0 0 1073741824`;

describe("CPU input timeline metadata admission", () => {
	it.each([
		undefined,
		"N/A",
	])("uses container duration for video with unknown stream duration %s, even when audio is shorter", (duration) => {
		const measured = inspectVodInputProbe(
			"source",
			{
				streams: [
					{
						index: 0,
						codec_type: "video",
						width: 1920,
						height: 1080,
						...(duration === undefined ? {} : { duration }),
					},
					{
						index: 1,
						codec_type: "audio",
						duration: "2",
						sample_rate: "48000",
						channels: 2,
					},
				],
				format: { duration: "8", format_name: "mov,mp4" },
			},
			identity,
		);
		expect(measured.durationMs).toBe(8000);
		expect(measured.video?.durationMs).toBeUndefined();
		expect(measured.audio?.durationMs).toBe(2000);
		expect(vodInputTimelineSourceFactsSchema.safeParse(measured).success).toBe(
			true,
		);
		expect(
			validateVodInputTimeline(
				{
					schemaVersion: 2,
					id: "00000000-0000-4000-8000-000000000001",
					audioEnabled: false,
					durationMs: 8000,
					videoClips: [
						{
							id: "00000000-0000-4000-8000-000000000002",
							sourceKey: "source",
							startMs: 0,
							inMs: 0,
							outMs: 8000,
						},
					],
					audioClips: [],
				},
				[measured],
			),
		).toEqual([]);
	});
	it("preserves absolute selected indices and the measured video duration", () => {
		expect(inspectVodInputProbe("source", probe(), identity)).toEqual({
			key: "source",
			durationMs: 8125,
			video: {
				streamIndex: 2,
				width: 1920,
				height: 1080,
				displayAspectRatio: { num: 16, den: 9 },
				frameRate: { num: 30000, den: 1001 },
				durationMs: 8125,
			},
			audio: { streamIndex: 3, sampleRate: 48000, channels: 2 },
			identity,
		});
	});
	it("retains absent audio and rejects impossible/oversized media instead of claiming readiness", () => {
		const value = probe();
		value.streams.pop();
		expect(inspectVodInputProbe("source", value, identity).audio).toBeNull();
		for (const patch of [
			{ duration: "Infinity" },
			{ width: 32768 },
			{ width: -1 },
		]) {
			const invalid = probe();
			const first = invalid.streams[0];
			if (!first) throw new Error("Missing test video");
			Object.assign(first, patch);
			expect(() => inspectVodInputProbe("source", invalid, identity)).toThrow();
		}
	});
	it("admits audio-only metadata and ignores album art as a video track", () => {
		for (const albumArt of [false, true]) {
			const sound = {
				streams: [
					...(albumArt
						? [
								{
									index: 0,
									codec_type: "video",
									width: 600,
									height: 600,
									disposition: { attached_pic: 1 },
								},
							]
						: []),
					{
						index: 1,
						codec_type: "audio",
						duration: "8.25",
						sample_rate: "48000",
						channels: 2,
					},
				],
				format: { duration: "8.3", format_name: albumArt ? "mp3" : "wav" },
			};
			expect(inspectVodInputProbe("sound", sound, identity)).toEqual({
				key: "sound",
				durationMs: 8250,
				video: null,
				audio: {
					streamIndex: 1,
					sampleRate: 48000,
					channels: 2,
					durationMs: 8250,
				},
				identity,
			});
		}
	});
	it("refuses streamless, artwork-only and encrypted audio sources", () => {
		for (const streams of [
			[],
			[{ codec_type: "video", disposition: { attached_pic: 1 } }],
			[
				{
					index: 0,
					codec_type: "audio",
					sample_rate: "48000",
					channels: 2,
					codec_tag_string: "enca",
				},
			],
		]) {
			expect(() =>
				inspectVodInputProbe(
					"sound",
					{ streams, format: { duration: "8" } },
					identity,
				),
			).toThrow(expect.objectContaining({ code: "SOURCE_UNSUPPORTED" }));
		}
	});
	it("fits the main source aspect into an even bounded preview canvas", () => {
		expect(vodInputPreviewCanvas(1920, 1080)).toEqual({
			width: 640,
			height: 360,
		});
		expect(vodInputPreviewCanvas(640, 480)).toEqual({
			width: 480,
			height: 360,
		});
		expect(vodInputPreviewCanvas(1080, 1920)).toEqual({
			width: 202,
			height: 360,
		});
	});
	it("only permits bridge HTTP and bounded supported container parsing", () => {
		const args = vodInputPreviewReadArgs("http://127.0.0.1:1234/token/0");
		expect(args).toContain("http,tcp");
		expect(args).toContain("mov,matroska,webm,mpegts,wav,mp3");
		expect(() =>
			vodInputPreviewReadArgs("https://customer/source.mp4"),
		).toThrow();
		expect(() => vodInputPreviewReadArgs("file:///etc/passwd")).toThrow();
	});
	it("retains anamorphic display aspect and applies ordinary display rotation", () => {
		const sample = probe();
		Object.assign(sample.streams[0] ?? {}, {
			width: 720,
			height: 576,
			sample_aspect_ratio: "16:15",
		});
		const anamorphic = inspectVodInputProbe("source", sample, identity);
		if (!anamorphic.video) throw new Error("Expected actual video");
		expect(anamorphic.video.displayAspectRatio).toEqual({ num: 4, den: 3 });
		expect(
			vodInputPreviewCanvas(720, 576, anamorphic.video.displayAspectRatio),
		).toEqual({ width: 480, height: 360 });
		Object.assign(sample.streams[0] ?? {}, {
			side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
		});
		const rotated = inspectVodInputProbe("source", sample, identity);
		if (!rotated.video) throw new Error("Expected actual video");
		expect(rotated.video.displayAspectRatio).toEqual({ num: 3, den: 4 });
		expect(
			vodInputPreviewCanvas(720, 576, rotated.video.displayAspectRatio),
		).toEqual({ width: 270, height: 360 });
	});
	it("admits the real BBB QuickTime axis scaling using encoded SAR preview geometry", () => {
		const sample = probe();
		Object.assign(sample.streams[0] ?? {}, {
			side_data_list: [
				{
					side_data_type: "Display Matrix",
					rotation: 0,
					displaymatrix:
						"\n00000000:        34475           0           0\n00000001:            0       34467           0\n00000002:            0           0  1073741824\n",
				},
			],
		});
		const measured = inspectVodInputProbe("source", sample, identity);
		expect(measured.video?.displayAspectRatio).toEqual({ num: 16, den: 9 });
	});
	it.each([
		[0, matrix(34475, 0, 0, 17237), { num: 4, den: 3 }],
		[90, matrix(0, -34475, 17237, 0), { num: 3, den: 4 }],
		[180, matrix(-34475, 0, 0, -17237), { num: 4, den: 3 }],
		[270, matrix(0, 34475, -17237, 0), { num: 3, den: 4 }],
	])("admits scaled quarter-turn %s while matching FFmpeg's encoded-SAR geometry", (rotation, displaymatrix, expected) => {
		const sample = probe();
		Object.assign(sample.streams[0] ?? {}, {
			width: 720,
			height: 576,
			sample_aspect_ratio: "16:15",
			side_data_list: [
				{ side_data_type: "Display Matrix", rotation, displaymatrix },
			],
		});
		expect(
			inspectVodInputProbe("source", sample, identity).video
				?.displayAspectRatio,
		).toEqual(expected);
	});
	it.each([
		[0, matrix(-65536, 0, 0, 65536)], // reflection
		[0, matrix(65536, 0, 0, 0)], // singular
		[0, matrix(65536, 1, 0, 65536)], // shear
		[0, matrix(-65536, 0, 0, -65536)], // conflicting orientation
		[90, matrix(0, 65536, -65536, 0)], // opposite quarter-turn
		[0, matrix(2 ** 31, 0, 0, 65536)], // not an int32
		[0, matrix(65536, 0, 0, 65536).replace("65536 0 0", "65536 0 1")], // perspective
		[0, matrix(65536, 0, 0, 65536).replace("0 0 1073741824", "1 0 1073741824")], // translation
		[0, matrix(65536, 0, 0, 65536).replace("1073741824", "0")],
		[0, matrix(65536, 0, 0, 65536).replace("00000001", "00000000")],
	])("rejects malformed or non-positive-axis display matrix %s / %s", (rotation, displaymatrix) => {
		const sample = probe();
		Object.assign(sample.streams[0] ?? {}, {
			side_data_list: [
				{ side_data_type: "Display Matrix", rotation, displaymatrix },
			],
		});
		expect(() => inspectVodInputProbe("source", sample, identity)).toThrow(
			expect.objectContaining({ code: "SOURCE_UNSUPPORTED" }),
		);
	});
	it("refuses invalid SAR and unsupported or conflicting display transforms", () => {
		for (const patch of [
			{ sample_aspect_ratio: "1:0" },
			{ sample_aspect_ratio: "NaN:1" },
			{ sample_aspect_ratio: "0:1" },
			{ side_data_list: [{ side_data_type: "Display Matrix", rotation: 45 }] },
			{ side_data_list: [{ side_data_type: "Display Matrix" }] },
			{
				tags: { rotate: "90" },
				side_data_list: [{ side_data_type: "Display Matrix", rotation: 0 }],
			},
			{ tags: { rotate: "90" } },
			{
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 0,
						displaymatrix:
							"00000000: 65536 65536 0\n00000001: 0 65536 0\n00000002: 0 0 1073741824",
					},
				],
			},
		]) {
			const sample = probe();
			Object.assign(sample.streams[0] ?? {}, patch);
			expect(() => inspectVodInputProbe("source", sample, identity)).toThrow(
				expect.objectContaining({ code: "SOURCE_UNSUPPORTED" }),
			);
		}
	});
	it("requires a fresh probe before replaying legacy facts with no display geometry", async () => {
		const measured = inspectVodInputProbe("source", probe(), identity);
		if (!measured.video) throw new Error("Expected actual video");
		delete measured.video.displayAspectRatio;
		const browserFor = vi.fn();
		await expect(
			renderVodInputPreview({
				directory: "/tmp/bitovp-aspect-legacy-unit",
				browserFor,
				signal: new AbortController().signal,
				sources: [
					{
						key: "source",
						credentialId: "00000000-0000-4000-8000-000000000001",
						bucket: "media",
						objectKey: "source.mp4",
					},
				],
				facts: [measured],
				request: {
					kind: "PREVIEW",
					probeId: "00000000-0000-4000-8000-000000000002",
					document: {
						schemaVersion: 1,
						id: "00000000-0000-4000-8000-000000000003",
						audioEnabled: false,
						clips: [
							{
								id: "00000000-0000-4000-8000-000000000004",
								sourceKey: "source",
								inMs: 0,
								outMs: 1000,
							},
						],
					},
					range: { startMs: 0, durationMs: 1000 },
				},
			}),
		).rejects.toMatchObject({ code: "PROBE_UNAVAILABLE" });
		expect(browserFor).not.toHaveBeenCalled();
	});
});
