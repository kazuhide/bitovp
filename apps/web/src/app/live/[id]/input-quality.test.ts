import { describe, expect, it } from "vitest";
import { inputQualityWarnings } from "./input-quality";

const at = Date.parse("2026-09-07T08:00:00Z");
const time = (ago: number) => new Date(at - ago).toISOString();
const sample = (
	streams: unknown[],
	counters: Record<string, unknown> = {},
) => ({ ingest: { streams, ...counters } });
describe("inputQualityWarnings", () => {
	it("uses the provider sample clock for per-stream video/audio arrival stalls", () => {
		const current = sample([
			{ mediaType: "video", lastArrivalTime: time(10_000) },
			{ mediaType: "audio", lastArrivalTime: time(15_000) },
			{ mediaType: "VIDEO", lastArrivalTime: time(9_999) },
		]);
		expect(inputQualityWarnings(current, null, at)).toEqual([
			{
				code: "PACKET_ARRIVAL_STALLED",
				params: { streamIndex: 1, mediaType: "VIDEO", ageSeconds: 10 },
			},
			{
				code: "PACKET_ARRIVAL_STALLED",
				params: { streamIndex: 2, mediaType: "AUDIO", ageSeconds: 15 },
			},
		]);
	});
	it("ignores invalid/future arrival timestamps, missing streams, and absent audio", () => {
		for (const lastArrivalTime of [
			undefined,
			null,
			"bad",
			at - 50_000,
			"2026-09-07",
			"2026-02-30T01:00:00Z",
			time(-1),
		]) {
			expect(
				inputQualityWarnings(
					sample([{ mediaType: "video", lastArrivalTime }]),
					null,
					at,
				),
			).toEqual([]);
		}
		for (const current of [
			null,
			{},
			{ ingest: {} },
			sample([]),
			sample([{ mediaType: "video", lastArrivalTime: time(0) }]),
		])
			expect(inputQualityWarnings(current, null, at)).toEqual([]);
	});
	it("warns only below80% for video rolling1minute average, not audio samples/sec", () => {
		const warnings = inputQualityWarnings(
			sample([
				{ mediaType: "VIDEO", rate: 30, samplesReadPerSecondAvg: 23.9 },
				{ mediaType: "video", rate: 30, samplesReadPerSecondAvg: 24 },
				{ mediaType: "audio", rate: 48000, samplesReadPerSecondAvg: 100 },
			]),
			null,
			at,
		);
		expect(warnings).toEqual([
			{
				code: "VIDEO_RATE_LOW",
				params: { streamIndex: 1, actualFps: 23.9, declaredFps: 30 },
			},
		]);
	});
	it("uses rolling-minute GOP maximum, never lifetime maximum or output constraints", () => {
		expect(
			inputQualityWarnings(
				sample([
					{
						mediaType: "video",
						keyFrameIntervalMax: 10000,
						keyFrameIntervalMaxLastMinute: 4000,
					},
					{ mediaType: "video", keyFrameIntervalMaxLastMinute: 4001 },
					{ mediaType: "audio", keyFrameIntervalMaxLastMinute: 5000 },
				]),
				null,
				at,
			),
		).toEqual([
			{ code: "VIDEO_GOP_LONG", params: { streamIndex: 2, maximumMs: 4001 } },
		]);
	});
	it("compares cumulative counters only across chronological distinct samples <=90s apart", () => {
		const before = sample([], {
			droppedPacketsVideo: 10,
			droppedPacketsAudio: 1,
			corruptPacketsVideo: 8,
			corruptPacketsAudio: 2,
		});
		const current = sample([], {
			droppedPacketsVideo: 13,
			droppedPacketsAudio: 3,
			corruptPacketsVideo: 9,
			corruptPacketsAudio: 6,
		});
		expect(inputQualityWarnings(current, before, at, at - 90_000)).toEqual([
			{
				code: "PACKET_COUNTERS_INCREASED",
				params: {
					droppedVideo: 3,
					droppedAudio: 2,
					corruptVideo: 1,
					corruptAudio: 4,
				},
			},
		]);
		for (const previousAt of [
			undefined,
			at,
			at + 1,
			at - 90_001,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		])
			expect(inputQualityWarnings(current, before, at, previousAt)).toEqual([]);
	});
	it("ignores counter resets/missing/noninteger values without mistaking cumulative totals for deltas", () => {
		const current = sample([], {
			droppedPacketsVideo: 100,
			corruptPacketsAudio: 900,
		});
		expect(inputQualityWarnings(current, null, at, at - 20_000)).toEqual([]);
		expect(
			inputQualityWarnings(
				sample([], { droppedPacketsVideo: 0 }),
				current,
				at,
				at - 20_000,
			),
		).toEqual([]);
		for (const value of [
			null,
			"4",
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		])
			expect(
				inputQualityWarnings(
					sample([], { droppedPacketsVideo: value }),
					sample([], { droppedPacketsVideo: 0 }),
					at,
					at - 20_000,
				),
			).toEqual([]);
	});
	it("rejects malformed numeric quality fields and non-finite sample clocks", () => {
		for (const rate of [
			null,
			"30",
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		])
			expect(
				inputQualityWarnings(
					sample([{ mediaType: "video", rate, samplesReadPerSecondAvg: 0 }]),
					null,
					at,
				),
			).toEqual([]);
		for (const n of [null, "10", -1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(
				inputQualityWarnings(
					sample([
						{
							mediaType: "video",
							rate: 30,
							samplesReadPerSecondAvg: n,
							keyFrameIntervalMaxLastMinute: n,
						},
					]),
					null,
					at,
				),
			).toEqual([]);
		for (const clock of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		])
			expect(
				inputQualityWarnings(
					sample([
						{ mediaType: "video", rate: 30, samplesReadPerSecondAvg: 0 },
					]),
					null,
					clock,
				),
			).toEqual([]);
	});
	it("bounds inspection to first16 streams; unknown provider text is never returned", () => {
		const noisy = {
			mediaType: "video",
			streamId: "untrusted-text",
			message: "untrusted-text",
			lastArrivalTime: time(10_000),
			rate: 30,
			samplesReadPerSecondAvg: 0,
			keyFrameIntervalMaxLastMinute: 5000,
		};
		const current = sample(
			Array.from({ length: 1000 }, () => noisy),
			{ droppedPacketsVideo: 1 },
		);
		const warnings = inputQualityWarnings(
			current,
			sample([], { droppedPacketsVideo: 0 }),
			at,
			at - 20_000,
		);
		expect(warnings).toHaveLength(49);
		expect(JSON.stringify(warnings)).not.toContain("untrusted-text");
		expect(
			warnings
				.filter((w) => w.code === "PACKET_ARRIVAL_STALLED")
				.map((w) => w.params.streamIndex),
		).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
	});
});
