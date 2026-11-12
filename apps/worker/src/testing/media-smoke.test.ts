import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	decodePresentation,
	validateAvProbe,
	validateBandingMeasurement,
	validateVideoSegments,
	validateVmafReports,
	x264Capabilities,
} from "./media-smoke";

const frames = (count = 48, start = 0) =>
	Array.from({ length: count }, (_, index) => ({
		best_effort_timestamp_time: String(start + index / 24),
	}));
const segments = () =>
	Array.from({ length: 5 }, (_, index) => ({
		frames: frames(48, index * 2),
	}));
const report = (score: number) => ({
	frames: Array.from({ length: 240 }, (_, frameNum) => ({
		frameNum,
		metrics: { vmaf: score },
	})),
	pooled_metrics: {
		vmaf: { min: score, max: score, mean: score, harmonic_mean: score },
	},
});

function presentation(videoStart = 0, audioStart = 0, count = 470) {
	return {
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				width: 320,
				height: 180,
				r_frame_rate: "24/1",
				nb_read_frames: "240",
			},
			{
				codec_type: "audio",
				codec_name: "aac",
				sample_rate: "48000",
				channels: 2,
				nb_read_frames: String(count),
			},
		],
		frames: [
			...frames(240, videoStart).map((frame) => ({
				...frame,
				media_type: "video",
			})),
			...Array.from({ length: count }, (_, index) => ({
				media_type: "audio",
				best_effort_timestamp_time: String(audioStart + (index * 1024) / 48000),
				nb_samples: 1024,
			})),
		],
	};
}

describe("offline media validation", () => {
	it("requires all finite standalone CAMBI frames, timing, canonical values and extractor identity", () => {
		const measured = {
			libvmafVersion: "3.2.0",
			featureName: "cambi_encbd_8_ench_180_encw_320",
			frames: Array.from({ length: 240 }, (_, frameNum) => ({
				frameNum,
				timestampSeconds: frameNum / 24,
				durationSeconds: 1 / 24,
				cambi: 22.307707,
			})),
		};
		expect(() => validateBandingMeasurement(measured)).not.toThrow();
		expect(() =>
			validateBandingMeasurement({ ...measured, libvmafVersion: "86da14d" }),
		).not.toThrow();
		expect(() =>
			validateBandingMeasurement({
				...measured,
				frames: measured.frames.slice(1),
			}),
		).toThrow();
		expect(() =>
			validateBandingMeasurement({ ...measured, libvmafVersion: "" }),
		).toThrow();
		expect(() =>
			validateBandingMeasurement({
				...measured,
				frames: measured.frames.map((frame) => ({ ...frame, vmaf: 0 })),
			}),
		).toThrow();
	});

	it("accepts continuous AAC timestamps with container reordering and priming offsets", () => {
		for (const probe of [
			presentation(0, 0, 469),
			presentation(0.083008, 0.062),
			presentation(2 / 24, 0),
			presentation(0, -1024 / 48000),
		])
			expect(() => validateAvProbe(probe)).not.toThrow();
	});

	it("rejects an audio presentation shifted by one second despite complete frame counts", () => {
		expect(() => validateAvProbe(presentation(0, 1))).toThrow(/span the video/);
	});

	it("rejects a missing AAC interval even when all 470 frames remain present", () => {
		const probe = presentation();
		const audio = probe.frames.filter((frame) => frame.media_type === "audio");
		for (const frame of audio.slice(100))
			frame.best_effort_timestamp_time = String(
				Number(frame.best_effort_timestamp_time) + 1024 / 48000,
			);
		expect(() => validateAvProbe(probe)).toThrow(/continuous/);
	});
	it("rejects missing decoded timing and sample data despite valid stream metadata", () => {
		for (const field of ["best_effort_timestamp_time", "nb_samples"]) {
			const probe = presentation();
			const audio = probe.frames.find((frame) => frame.media_type === "audio");
			assert(audio);
			Reflect.deleteProperty(audio, field);
			expect(() => validateAvProbe(probe)).toThrow();
		}
	});
	it("accepts exactly five complete, consecutive two-second video segments", () => {
		expect(() => validateVideoSegments(segments())).not.toThrow();
	});

	it("rejects short, missing and overlapping video segments", () => {
		const short = segments();
		short[4] = { frames: frames(47, 8) };
		expect(() => validateVideoSegments(short)).toThrow();
		expect(() => validateVideoSegments(segments().slice(0, 4))).toThrow();
		const overlap = segments();
		overlap[3] = { frames: frames(48, 4) };
		expect(() => validateVideoSegments(overlap)).toThrow();
	});

	it("requires decoded video and audio, including the complete video frame count", () => {
		const probe = presentation();
		expect(() => validateAvProbe(probe)).not.toThrow();
		expect(() =>
			validateAvProbe({ streams: probe.streams.slice(0, 1) }),
		).toThrow();
		const video = probe.streams[0];
		assert(video);
		video.nb_read_frames = "239";
		expect(() => validateAvProbe(probe)).toThrow();
		video.nb_read_frames = "240";
		const audio = probe.streams[1];
		assert(audio);
		audio.nb_read_frames = "463";
		expect(() => validateAvProbe(probe)).toThrow();
	});

	it("requires ordered full-frame reports and a meaningful degraded control", () => {
		expect(validateVmafReports(report(99), report(90), report(40))).toEqual({
			self: 99,
			encoded: 90,
			degraded: 40,
		});
		expect(() =>
			validateVmafReports(report(99), report(99), report(99)),
		).toThrow();
	});

	it("rejects missing scores, repeated indices, nonfinite values and absent pooling", () => {
		const missing = report(90);
		missing.frames.pop();
		expect(() =>
			validateVmafReports(report(99), missing, report(40)),
		).toThrow();
		const repeated = report(90);
		const second = repeated.frames[1];
		assert(second);
		second.frameNum = 0;
		expect(() =>
			validateVmafReports(report(99), repeated, report(40)),
		).toThrow();
		const noMetric = report(90);
		const missingMetric = noMetric.frames[3];
		assert(missingMetric);
		Reflect.deleteProperty(missingMetric.metrics, "vmaf");
		expect(() =>
			validateVmafReports(report(99), noMetric, report(40)),
		).toThrow();
		const invalid = report(90);
		const invalidFrame = invalid.frames[4];
		assert(invalidFrame);
		invalidFrame.metrics.vmaf = Number.NaN;
		expect(() =>
			validateVmafReports(report(99), invalid, report(40)),
		).toThrow();
		const invalidPool = report(90);
		invalidPool.pooled_metrics.vmaf.mean = 200;
		expect(() =>
			validateVmafReports(report(99), invalidPool, report(40)),
		).toThrow();
		expect(() =>
			validateVmafReports(
				report(99),
				{ frames: report(90).frames },
				report(40),
			),
		).toThrow();
	});

	it("reads the processor capabilities that x264 reports, once, from an encode's log", () => {
		// The lines of an encode at FFmpeg's level "info", around x264's report.
		const log = (...reports: string[]) =>
			[
				"Stream mapping:",
				"  Stream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))",
				"[libx264 @ 0x580814cad8c0] using SAR=1/1",
				...reports,
				"[libx264 @ 0x580814cad8c0] profile High, level 1.2, 4:2:0, 8-bit",
				"Output #0, mp4, to 'bbb-10s.mp4':",
				"",
			].join("\n");
		const report = (capabilities: string) =>
			`[libx264 @ 0x580814cad8c0] using cpu capabilities: ${capabilities}`;
		for (const capabilities of [
			"MMX2 SSE2Fast SSSE3 SSE4.2 AVX FMA3 BMI2 AVX2 AVX512",
			"MMX2 SSE2Fast SSSE3 SSE4.2 AVX FMA3 BMI2 AVX2",
			"ARMv8 NEON",
			"none!",
		])
			expect(x264Capabilities(log(report(capabilities)))).toBe(capabilities);
		// Line ends of another platform do not become a part of the names.
		expect(
			x264Capabilities(log(report("ARMv8 NEON")).replaceAll("\n", "\r\n")),
		).toBe("ARMv8 NEON");

		// At the level "error" the log holds no report, and two encodes are two
		// reports.
		expect(() => x264Capabilities(log())).toThrow(/once/);
		expect(() => x264Capabilities("")).toThrow(/once/);
		expect(() =>
			x264Capabilities(log(report("AVX2"), report("AVX2 AVX512"))),
		).toThrow(/once/);
		// Only x264's own line counts, from its start.
		for (const line of [
			"[libx265 @ 0x580814cad8c0] using cpu capabilities: AVX2",
			"x [libx264 @ 0x580814cad8c0] using cpu capabilities: AVX2",
			"[libx264 @ 0x580814cad8c0] using CPU capabilities: AVX2",
		])
			expect(() => x264Capabilities(log(line))).toThrow(/once/);
		// What is no list of x264's names does not leave the container.
		for (const capabilities of [
			"",
			"AVX2  AVX512",
			"AVX2 ",
			"AVX2, AVX512",
			"/home/runner/work",
			"none! AVX2",
			"A".repeat(17),
			Array.from({ length: 33 }, () => "AVX2").join(" "),
		])
			expect(() => x264Capabilities(log(report(capabilities)))).toThrow(
				/Unexpected x264 processor capabilities/,
			);
	});

	it("uses an absolute presentation path so DASH resolves local fragments once", async () => {
		const execute = vi.fn().mockResolvedValue("");
		await decodePresentation("dash/manifest.mpd", execute);
		const args = execute.mock.calls[0]?.[1] as string[];
		expect(args[args.indexOf("-i") + 1]).toBe(resolve("dash/manifest.mpd"));
	});

	it("propagates a complete decode failure instead of accepting probe metadata", async () => {
		const execute = vi.fn().mockRejectedValue(new Error("Decode failed"));
		await expect(
			decodePresentation("/work/hls/index.m3u8", execute),
		).rejects.toThrow("Decode failed");
	});
});
