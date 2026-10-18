import { describe, expect, it } from "vitest";
import {
	estimatePeriodFrames,
	isMaskedSourceFrame,
	loopProfileSchema,
	maskedOutputFrames,
	sourceMaskOf,
	timelineFromContainerProbe,
	timelineFromProfile,
} from "./loop-timeline";

/**
 * . A normalized profile is an exact, hole-free period; a container
 * probe of a raw source yields the CONTAINER period with the video-less head
 * and tail as holes (the 10.04 s / video-starts-at-1.0 s shape that broke the
 * live lab: 301 frames, the first 30 without a reference); masks follow
 * `(i + offset) mod F` across a wrap; and the autocorrelation cross-check
 * finds the pushed period where the source-frame-count assumption is wrong.
 */
const profile = {
	version: 1 as const,
	mode: "normalized" as const,
	fps: 30,
	frames: 271,
	loopSeconds: 271 / 30,
	audioEndSec: 271 / 30,
	sourceSha256: "a".repeat(64),
	normalizer: { version: 1 as const },
	recordedAt: "2026-09-06T00:00:00.000Z",
};

describe("timelineFromProfile", () => {
	it("is the exact period with no holes, and the schema pins the persisted shape", () => {
		expect(loopProfileSchema.safeParse(profile).success).toBe(true);
		expect(timelineFromProfile(profile)).toEqual({
			source: "feeder-profile",
			fps: 30,
			frames: 271,
			loopSeconds: 271 / 30,
			holes: [],
		});
	});

	it("refuses a profile whose frames and seconds disagree by more than half a frame", () => {
		expect(() =>
			timelineFromProfile({ ...profile, loopSeconds: 10.04 }),
		).toThrow(/inconsistent/);
		expect(
			loopProfileSchema.safeParse({ ...profile, frames: 271.5 }).success,
		).toBe(false);
	});
});

describe("timelineFromContainerProbe", () => {
	const bbb = {
		durationSec: 10.04,
		videoStartSec: 1.0,
		videoDurationSec: 271 / 30,
	};

	it("uses the container span as the period and the video-less head as a hole (the row #256 source)", () => {
		expect(timelineFromContainerProbe(bbb, 30)).toEqual({
			source: "container-probe",
			fps: 30,
			frames: 301,
			loopSeconds: 10.04,
			holes: [{ fromFrame: 0, toFrame: 30 }],
		});
	});

	it("adds a tail hole when the video ends before the container, never overlapping the head", () => {
		const t = timelineFromContainerProbe(
			{ durationSec: 12, videoStartSec: 0.5, videoDurationSec: 10 },
			30,
		);
		expect(t.frames).toBe(360);
		expect(t.holes).toEqual([
			{ fromFrame: 0, toFrame: 15 },
			{ fromFrame: 315, toFrame: 360 },
		]);
		expect(sourceMaskOf(t).filter(Boolean)).toHaveLength(60);
	});

	it("a video that spans the whole container has no holes; degenerate inputs throw", () => {
		expect(
			timelineFromContainerProbe(
				{ durationSec: 9.0333, videoStartSec: 0, videoDurationSec: 9.0333 },
				30,
			).holes,
		).toEqual([]);
		expect(() =>
			timelineFromContainerProbe({ ...bbb, durationSec: 0 }, 30),
		).toThrow(/duration/);
		expect(() => timelineFromContainerProbe(bbb, 0)).toThrow(/fps/);
	});

	it("rev427 R2: an absent ffprobe field (NaN) fails closed instead of meaning 'no hole'", () => {
		expect(() =>
			timelineFromContainerProbe({ ...bbb, videoStartSec: Number.NaN }, 30),
		).toThrow(/video start/);
		expect(() =>
			timelineFromContainerProbe({ ...bbb, videoDurationSec: Number.NaN }, 30),
		).toThrow(/video duration/);
		expect(() =>
			timelineFromContainerProbe({ ...bbb, videoStartSec: -1 }, 30),
		).toThrow(/video start/);
		// a negative CTS offset (≈ −1/fps) is a legitimate MP4 shape: no hole
		expect(
			timelineFromContainerProbe(
				{ durationSec: 9.0333, videoStartSec: -0.02, videoDurationSec: 9.0333 },
				30,
			).holes,
		).toEqual([]);
		// an MPEG-TS source starts both streams and the container at ≈ 1.4 s:
		// the caller passes video.start_time − format.start_time, i.e. 0
		expect(
			timelineFromContainerProbe(
				{ durationSec: 10.0, videoStartSec: 0, videoDurationSec: 10.0 },
				30,
			).holes,
		).toEqual([]);
	});

	it("rev427 O2: a container shorter than its own video is a contradiction, not a period", () => {
		expect(() =>
			timelineFromContainerProbe(
				{ durationSec: 9.5, videoStartSec: 1.0, videoDurationSec: 9.033 },
				30,
			),
		).toThrow(/outruns the container/);
		// within a frame of slack it is accepted (container rounding)
		expect(
			timelineFromContainerProbe(
				{ durationSec: 10.02, videoStartSec: 1.0, videoDurationSec: 9.04 },
				30,
			).frames,
		).toBe(301);
	});
});

describe("masks", () => {
	const t = timelineFromContainerProbe(
		{ durationSec: 10.04, videoStartSec: 1.0, videoDurationSec: 271 / 30 },
		30,
	);

	it("marks exactly the hole's source frames", () => {
		expect(isMaskedSourceFrame(t, 0)).toBe(true);
		expect(isMaskedSourceFrame(t, 29)).toBe(true);
		expect(isMaskedSourceFrame(t, 30)).toBe(false);
		expect(isMaskedSourceFrame(t, 300)).toBe(false);
		expect(sourceMaskOf(t).slice(0, 31)).toEqual([
			...new Array(30).fill(true),
			false,
		]);
	});

	it("follows (i + offset) mod F across a wrap", () => {
		// offset 290: output frames 0..10 show source 290..300, 11..40 show the
		// hole (source 0..29), 41.. show source 30..
		const m = maskedOutputFrames(t, 290, 60);
		expect(m.slice(0, 11).every((x) => !x)).toBe(true);
		expect(m.slice(11, 41).every((x) => x)).toBe(true);
		expect(m.slice(41).every((x) => !x)).toBe(true);
		expect(
			maskedOutputFrames(timelineFromProfile(profile), 5, 20).some(Boolean),
		).toBe(false);
	});
});

describe("estimatePeriodFrames", () => {
	function periodic(f: number, w: number): number[] {
		const out = new Array<number>(w);
		for (let i = 0; i < w; i++) {
			const k = i % f;
			out[i] =
				128 +
				40 * Math.sin((2 * Math.PI * k) / 37.0) +
				25 * Math.sin((2 * Math.PI * k) / 11.3 + 0.6) +
				15 * Math.sin((2 * Math.PI * k) / 5.7 + 1.7);
		}
		return out;
	}

	it("recovers a 301-frame push when asked around the 271-frame assumption, and rejects a range that excludes the truth", () => {
		const pushed = periodic(301, 1800);
		expect(estimatePeriodFrames(pushed, 271, 60)).toBe(301);
		expect(estimatePeriodFrames(pushed, 271, 10)).toBeNull();
		expect(estimatePeriodFrames(periodic(271, 1800), 271, 60)).toBe(271);
	});

	it("answers null when the window cannot hold two periods for every lag in the range, or the signal is flat", () => {
		expect(estimatePeriodFrames(periodic(301, 400), 301, 5)).toBeNull();
		// rev427 R3: a 601-frame window cannot evaluate lag 306 — the truncation
		// edge (300) must not be answered as the period
		expect(estimatePeriodFrames(periodic(301, 601), 301, 5)).toBeNull();
		expect(estimatePeriodFrames(periodic(301, 612), 301, 5)).toBe(301);
		expect(
			estimatePeriodFrames(new Array<number>(1000).fill(7), 301, 30),
		).toBeNull();
	});

	it("a multiple of the period is a period too — callers compare by divisibility", () => {
		const pushed = periodic(301, 1806);
		expect(estimatePeriodFrames(pushed, 602, 20)).toBe(602);
		expect(602 % 301).toBe(0);
	});
});
