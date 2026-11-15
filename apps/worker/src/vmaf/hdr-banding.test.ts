import { describe, expect, it, vi } from "vitest";
import { measureBanding } from "./banding-measure";
import * as bandingScore from "./banding-score";
import {
	bandingInputFromProbe,
	buildCpuBandingCommand,
	parseBandingTiming,
} from "./banding-score";

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
	avg_frame_rate: "24/1",
	r_frame_rate: "24/1",
	sample_aspect_ratio: "1:1",
	field_order: "progressive",
};
const probe = (v: object) => JSON.stringify({ streams: [v] });

describe("standalone HDR banding", () => {
	it.each([
		"PQ",
		"HLG_TO_PQ_1000_NITS",
	] as const)("does not inherit SDR delivery thresholds into manual %s measurements", async (hdrMethod) => {
		const score = vi
			.spyOn(bandingScore, "runCpuBandingScore")
			.mockResolvedValue({
				frames: [
					{
						frameNum: 0,
						timestampSeconds: 0,
						durationSeconds: 1 / 24,
						cambi: 12,
					},
				],
				libvmafVersion: "a6ed0f1",
				featureName: "cambi_encbd_10_ench_2160_encw_3840_eotf_pq",
			});
		try {
			const measured = await measureBanding(
				{
					runner: { run: vi.fn(), spawn: vi.fn() },
					ffmpegPath: "ffmpeg-hdr",
					ffprobePath: "ffprobe-hdr",
				},
				{
					input: "/dist.mp4",
					logPath: "/score.json",
					inputSha256: "a".repeat(64),
					probe: probe({
						...video,
						color_transfer: hdrMethod === "PQ" ? "smpte2084" : "arib-std-b67",
					}),
					run: {
						selection: {
							version: 1,
							model: "CAMBI",
							requested: "CPU",
							backend: "cpu",
						},
						gate: {
							onFail: "BLOCK_MANIFESTS",
							rules: [
								{
									metric: "CAMBI_MAX",
									scope: "PER_RENDITION",
									lte: 5,
									severity: "FAIL",
								},
							],
						},
					},
					rendition: "video",
					signal: new AbortController().signal,
					hdrMethod,
				},
			);
			expect(measured.pooled.max).toBe(12);
			expect(measured.assessment).not.toHaveProperty("failureThreshold");
			expect(measured.assessment).not.toHaveProperty("warningThreshold");
			expect(measured.assessment.ranges).toEqual([]);
		} finally {
			score.mockRestore();
		}
	});
	it("retains the legacy HDR refusal without an explicit HDR method", () => {
		expect(() => bandingInputFromProbe(probe(video))).toThrow(
			"BANDING_HDR_UNSUPPORTED",
		);
	});
	it("scores PQ with the PQ EOTF, without the SDR bt1886 default", () => {
		const input = bandingInputFromProbe(probe(video), "PQ");
		expect(input.eotf).toBe("PQ");
		const args = buildCpuBandingCommand("/dist.mp4", "/score.json", 1, input);
		expect(args.join(" ")).toContain("eotf=pq");
		expect(args.join(" ")).not.toContain("arib-std-b67");
	});
	it("converts HLG to PQ in a recorded 16-bit domain before CAMBI", () => {
		const hlg = { ...video, color_transfer: "arib-std-b67" };
		const input = bandingInputFromProbe(probe(hlg), "HLG_TO_PQ_1000_NITS");
		const args = buildCpuBandingCommand(
			"/dist.mp4",
			"/score.json",
			1,
			input,
		).join(" ");
		expect(args).toContain("transferin=arib-std-b67");
		expect(args).toContain("format=yuv444p16le");
		expect(args).toContain("npl=1000");
		expect(args).toContain("eotf=pq");
		const frames = parseBandingTiming(
			{
				streams: [{ time_base: "1/24000" }],
				frames: [{ ...hlg, best_effort_timestamp: 0, duration: 1000 }],
			},
			input,
		);
		expect(frames[0]?.durationSeconds).toBeCloseTo(1 / 24);
	});
});
