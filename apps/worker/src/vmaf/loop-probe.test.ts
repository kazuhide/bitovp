import { timelineFromContainerProbe } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { containerLoopFromProbe } from "./loop-probe";

/** : the probe reads the container span and the video's start/duration; the  source shape yields 301 frames with a 30-frame head hole. */
describe("containerLoopFromProbe", () => {
	it("reads format.duration and the video stream's start_time/duration", () => {
		const probe = containerLoopFromProbe(
			JSON.stringify({
				format: { duration: "10.040000" },
				streams: [
					{
						codec_type: "audio",
						start_time: "0.010000",
						duration: "10.030000",
					},
					{ codec_type: "video", start_time: "1.000000", duration: "9.033333" },
				],
			}),
		);
		expect(probe).toEqual({
			durationSec: 10.04,
			videoStartSec: 1,
			videoDurationSec: 9.033333,
		});
		expect(timelineFromContainerProbe(probe, 30)).toMatchObject({
			frames: 301,
			holes: [{ fromFrame: 0, toFrame: 30 }],
		});
	});

	it("rev427 R2: the video start is relative to the container start — an MPEG-TS source starting at 1.4 s has no hole", () => {
		const probe = containerLoopFromProbe(
			JSON.stringify({
				format: { duration: "10.000000", start_time: "1.400000" },
				streams: [
					{
						codec_type: "audio",
						start_time: "1.400000",
						duration: "10.000000",
					},
					{
						codec_type: "video",
						start_time: "1.400000",
						duration: "10.000000",
					},
				],
			}),
		);
		expect(probe.videoStartSec).toBeCloseTo(0, 9);
		expect(timelineFromContainerProbe(probe, 30).holes).toEqual([]);
	});

	it("falls back to nb_frames ÷ frame rate for the video duration, and refuses a probe without one", () => {
		const probe = containerLoopFromProbe(
			JSON.stringify({
				format: { duration: 9.0333 },
				streams: [
					{ codec_type: "video", nb_frames: "271", r_frame_rate: "30/1" },
				],
			}),
		);
		expect(probe.videoStartSec).toBe(0);
		expect(probe.videoDurationSec).toBeCloseTo(271 / 30, 6);
		expect(() =>
			containerLoopFromProbe(
				JSON.stringify({
					format: { duration: 9 },
					streams: [{ codec_type: "video" }],
				}),
			),
		).toThrow(/no video duration/);
		expect(() =>
			containerLoopFromProbe(
				JSON.stringify({ streams: [{ codec_type: "video", duration: 1 }] }),
			),
		).toThrow(/no container duration/);
		expect(() => containerLoopFromProbe("nope")).toThrow(/parseable/);
	});
});
