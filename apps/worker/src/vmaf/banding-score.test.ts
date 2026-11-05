import { describe, expect, it } from "vitest";
import {
	bandingInputFromProbe,
	buildCpuBandingCommand,
	parseBandingLibvmafVersion,
	parseBandingTiming,
	parseCpuBandingLog,
} from "./banding-score";

describe("standalone CPU CAMBI", () => {
	it.each([
		"3.2.0",
		"v3.2.0",
		"v3.2.0-17-g86da14d",
		"86da14d",
		"86da14d-dirty",
		"a".repeat(40),
	])("preserves the official extractor's version identity %s", (value) => {
		expect(parseBandingLibvmafVersion(value)).toBe(value);
	});
	it.each(
		[
			undefined,
			null,
			0,
			"",
			"unknown",
			" 86da14d",
			"86da14d\n",
			"a".repeat(41),
			"3.2",
			"86da14d;echo",
		].map((value) => ({ value })),
	)("rejects missing or malformed extractor identities %s", ({ value }) => {
		expect(() => parseBandingLibvmafVersion(value)).toThrow(
			"BANDING_CPU_VERSION",
		);
	});

	it("rejects default window sizes that the official CPU and GPU extractors cannot initialize", () => {
		const probe = (width: number, height: number) =>
			JSON.stringify({
				streams: [
					{
						codec_type: "video",
						codec_name: "hevc",
						width,
						height,
						pix_fmt: "yuv420p10le",
						r_frame_rate: "24/1",
						sample_aspect_ratio: "1:1",
					},
				],
			});
		expect(() => bandingInputFromProbe(probe(3840, 2160))).not.toThrow();
		expect(() => bandingInputFromProbe(probe(3840, 2252))).not.toThrow();
		for (const [width, height] of [
			[3840, 2254],
			[4096, 2160],
			[7680, 4320],
		])
			expect(() =>
				bandingInputFromProbe(probe(width ?? 0, height ?? 0)),
			).toThrow("BANDING_GEOMETRY_UNSUPPORTED");
	});

	it("uses one encoded input with the official extractor and no VMAF model", () => {
		const command = buildCpuBandingCommand("/encoded.mp4", "/cambi.json", 2);
		expect(command.filter((arg) => arg === "-i")).toHaveLength(1);
		expect(command).toContain("/encoded.mp4");
		const graph = command[command.indexOf("-filter_complex") + 1];
		expect(graph).toContain("split=2");
		expect(graph).toContain("libvmaf=model=:feature=name=cambi");
		expect(graph).toContain("n_subsample=1");
		expect(graph).not.toContain("scale");
		expect(graph).not.toContain("fps=");
		expect(graph).not.toContain("max_val=");
	});

	it("preserves VFR presentation durations and gaps relative to the first PTS", () => {
		const timing = parseBandingTiming({
			streams: [{ time_base: "1/1000" }],
			frames: [
				{ best_effort_timestamp: "7100", duration: "40" },
				{ best_effort_timestamp: "7140", pkt_duration: "80" },
				{ best_effort_timestamp: "7400", duration: "100" },
			],
		});
		expect(timing.map((frame) => frame.durationSeconds)).toEqual([
			0.04, 0.08, 0.1,
		]);
		expect(timing[2]?.timestampSeconds).toBeCloseTo(0.3);
		expect(timing[0]?.timestampSeconds).toBe(0);
	});

	it.each([
		{ frames: [{ best_effort_timestamp: "1000" }] },
		{ frames: [{ best_effort_timestamp: "1000", duration: "0" }] },
		{
			frames: [
				{ best_effort_timestamp: "1000", duration: "80" },
				{ best_effort_timestamp: "1040", duration: "40" },
			],
		},
	])("rejects unknown duration or overlapping presentation intervals", ({
		frames,
	}) => {
		expect(() =>
			parseBandingTiming({ streams: [{ time_base: "1/1000" }], frames }),
		).toThrow("BANDING_TIMING");
	});

	it("requires every full-frame score and preserves values above 24", () => {
		const timing = parseBandingTiming({
			streams: [{ time_base: "1/1000" }],
			frames: [
				{ best_effort_timestamp: "0", duration: "40" },
				{ best_effort_timestamp: "40", duration: "40" },
			],
		});
		const log = {
			frames: [
				{ frameNum: 0, metrics: { cambi: 0 } },
				{ frameNum: 1, metrics: { cambi: 28 } },
			],
		};
		expect(parseCpuBandingLog(log, timing).map((frame) => frame.cambi)).toEqual(
			[0, 28],
		);
		expect(() =>
			parseCpuBandingLog({ frames: log.frames.slice(1) }, timing),
		).toThrow("BANDING_FRAME_COVERAGE");
		// Official extractor initialization errors can leave an empty JSON log
		// even when FFmpeg exits zero. Coverage must still fail closed.
		expect(() =>
			parseCpuBandingLog({ version: "3.2.0", frames: [] }, timing),
		).toThrow("BANDING_FRAME_COVERAGE");
		expect(() =>
			parseCpuBandingLog(
				{ frames: [log.frames[0], { frameNum: 1, metrics: { vmaf: 99 } }] },
				timing,
			),
		).toThrow("BANDING_FRAME_SCORE");
	});

	it("subtracts long source timestamps as integer ticks before converting to seconds", () => {
		const frames = parseBandingTiming({
			streams: [{ time_base: "1/90000" }],
			frames: [
				{ best_effort_timestamp: "9007199254740993", duration: 3003 },
				{ best_effort_timestamp: "9007199254743996", duration: 3003 },
			],
		});
		expect(frames[1]?.timestampSeconds).toBe(3003 / 90000);
		expect(frames[0]?.durationSeconds).toBe(3003 / 90000);
	});

	it("rejects a decoded-frame precision change instead of converting it", () => {
		expect(() =>
			parseBandingTiming(
				{
					streams: [{ time_base: "1/1000" }],
					frames: [
						{
							best_effort_timestamp: 0,
							duration: 40,
							width: 640,
							height: 360,
							pix_fmt: "yuv420p10le",
						},
					],
				},
				{ width: 640, height: 360, bitDepth: 8 },
			),
		).toThrow("BANDING_FRAME_FORMAT_CHANGED");
	});

	it("rejects missing decoded frames when the encoded stream declares its frame count", () => {
		expect(() =>
			parseBandingTiming(
				{
					streams: [{ time_base: "1/1000" }],
					frames: [
						{
							best_effort_timestamp: 0,
							duration: 40,
							width: 640,
							height: 360,
							pix_fmt: "yuv420p",
						},
					],
				},
				{ width: 640, height: 360, bitDepth: 8, frames: 2 },
			),
		).toThrow("BANDING_FRAME_COVERAGE");
	});
});
