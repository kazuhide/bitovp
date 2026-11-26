import { describe, expect, it, vi } from "vitest";
import * as timeline from "./index";

const id = (value: number) =>
	`00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const nextIds = () => {
	let value = 100;
	return vi.fn(() => id(value++));
};
const rows = (
	document: timeline.VodInputTimelineV2Document,
	track: timeline.VodInputTimelineTrack,
) => timeline.getVodInputTimelineTrack(document, track);
function gapped(
	track: timeline.VodInputTimelineTrack,
): timeline.VodInputTimelineV2Document {
	const clips = [
		{ id: id(2), sourceKey: "a", startMs: 0, inMs: 2000, outMs: 4000 },
		{ id: id(3), sourceKey: "b", startMs: 5000, inMs: 1000, outMs: 3000 },
		{ id: id(4), sourceKey: "c", startMs: 10_000, inMs: 4000, outMs: 6000 },
	];
	const opposite = [
		{ id: id(9), sourceKey: "opposite", startMs: 0, inMs: 0, outMs: 12_000 },
	];
	return {
		schemaVersion: 2,
		id: id(1),
		audioEnabled: true,
		durationMs: 12_000,
		videoClips: track === "video" ? clips : opposite,
		audioClips: track === "audio" ? clips : opposite,
	};
}
function overlap(): timeline.VodInputTimelineV2Document {
	return {
		schemaVersion: 2,
		id: id(1),
		audioEnabled: true,
		durationMs: 14_000,
		videoClips: [
			{
				id: id(2),
				sourceKey: "target",
				startMs: 1000,
				inMs: 2000,
				outMs: 10_000,
			},
			{
				id: id(3),
				sourceKey: "moving",
				startMs: 10_000,
				inMs: 4000,
				outMs: 6000,
			},
		],
		audioClips: [
			{ id: id(9), sourceKey: "audio", startMs: 0, inMs: 0, outMs: 14_000 },
		],
	};
}

describe("absolute independent VOD clip placement", () => {
	it.each([
		["video", 3000],
		["video", 7000],
		["audio", 3000],
		["audio", 7000],
	] as const)("moves %s into a gap at %i without changing its order or source range", (track, startMs) => {
		const base = gapped(track),
			before = structuredClone(base),
			allocate = nextIds();
		const result = timeline.positionVodInputTimelineClip(
			base,
			{ track, id: id(3), startMs },
			allocate,
		);
		expect(rows(result, track).map((clip) => clip.id)).toEqual([
			id(2),
			id(3),
			id(4),
		]);
		expect(rows(result, track)[1]).toEqual({
			...rows(before, track)[1],
			startMs,
		});
		expect(rows(result, track)[0]).toEqual(rows(before, track)[0]);
		expect(rows(result, track)[2]).toEqual(rows(before, track)[2]);
		expect(rows(result, track === "video" ? "audio" : "video")).toEqual(
			rows(before, track === "video" ? "audio" : "video"),
		);
		expect(result.durationMs).toBe(before.durationMs);
		expect(result.id).toBe(before.id);
		expect(base).toEqual(before);
		expect(allocate).not.toHaveBeenCalled();
	});
	it("splits the destination and keeps both surviving source clocks while vacating the original position", () => {
		const base = overlap(),
			before = structuredClone(base),
			allocate = nextIds();
		const result = timeline.positionVodInputTimelineClip(
			base,
			{ track: "video", id: id(3), startMs: 4000 },
			allocate,
		);
		expect(result.videoClips).toEqual([
			{
				id: id(2),
				sourceKey: "target",
				startMs: 1000,
				inMs: 2000,
				outMs: 5000,
			},
			{
				id: id(3),
				sourceKey: "moving",
				startMs: 4000,
				inMs: 4000,
				outMs: 6000,
			},
			{
				id: id(100),
				sourceKey: "target",
				startMs: 6000,
				inMs: 7000,
				outMs: 10_000,
			},
		]);
		expect(allocate).toHaveBeenCalledTimes(1);
		expect(result.audioClips).toEqual(before.audioClips);
		expect(result.durationMs).toBe(14_000);
		expect(
			timeline.locateVodInputTimelineTime(result, 10_000, "video"),
		).toBeNull();
		expect(base).toEqual(before);
	});
	it.each([
		[0, { startMs: 2000, inMs: 3000, outMs: 10_000 }],
		[8000, { startMs: 1000, inMs: 2000, outMs: 9000 }],
	] as const)("trims only the overlapped destination edge at %i", (startMs, target) => {
		const allocate = nextIds();
		const result = timeline.positionVodInputTimelineClip(
			overlap(),
			{ track: "video", id: id(3), startMs },
			allocate,
		);
		expect(result.videoClips.find((clip) => clip.id === id(2))).toEqual({
			id: id(2),
			sourceKey: "target",
			...target,
		});
		expect(result.videoClips.find((clip) => clip.id === id(3))).toMatchObject({
			startMs,
			inMs: 4000,
			outMs: 6000,
		});
		expect(allocate).not.toHaveBeenCalled();
	});
	it("removes a fully covered clip and treats adjacent boundaries as non-overlap", () => {
		const base = gapped("video"),
			allocate = nextIds();
		const result = timeline.positionVodInputTimelineClip(
			base,
			{ track: "video", id: id(3), startMs: 0 },
			allocate,
		);
		expect(result.videoClips).toEqual([
			{ id: id(3), sourceKey: "b", startMs: 0, inMs: 1000, outMs: 3000 },
			base.videoClips[2],
		]);
		const adjacent = timeline.positionVodInputTimelineClip(
			base,
			{ track: "video", id: id(3), startMs: 2000 },
			allocate,
		);
		expect(adjacent.videoClips[0]).toEqual(base.videoClips[0]);
		expect(allocate).not.toHaveBeenCalled();
	});
	it("overwrites several neighbors without moving unaffected material or changing source clocks", () => {
		const base: timeline.VodInputTimelineV2Document = {
			schemaVersion: 2,
			id: id(1),
			audioEnabled: true,
			durationMs: 10_000,
			videoClips: [
				{ id: id(2), sourceKey: "a", startMs: 0, inMs: 0, outMs: 2000 },
				{ id: id(3), sourceKey: "b", startMs: 2000, inMs: 5000, outMs: 7000 },
				{
					id: id(4),
					sourceKey: "c",
					startMs: 4000,
					inMs: 10_000,
					outMs: 12_000,
				},
				{ id: id(5), sourceKey: "moving", startMs: 8000, inMs: 0, outMs: 2000 },
			],
			audioClips: [],
		};
		const result = timeline.positionVodInputTimelineClip(
			base,
			{ track: "video", id: id(5), startMs: 3000 },
			nextIds(),
		);
		expect(result.videoClips).toEqual([
			base.videoClips[0],
			{ id: id(3), sourceKey: "b", startMs: 2000, inMs: 5000, outMs: 6000 },
			{ id: id(5), sourceKey: "moving", startMs: 3000, inMs: 0, outMs: 2000 },
			{ id: id(4), sourceKey: "c", startMs: 5000, inMs: 11_000, outMs: 12_000 },
		]);
	});
	it("returns the same valid V2 document for a no-op without allocating IDs", () => {
		const base = gapped("video"),
			allocate = nextIds();
		expect(
			timeline.positionVodInputTimelineClip(
				base,
				{ track: "video", id: id(3), startMs: 5000 },
				allocate,
			),
		).toBe(base);
		expect(allocate).not.toHaveBeenCalled();
	});
	it("normalizes legacy input and keeps the coincident AV partner stationary", () => {
		const legacy: timeline.VodInputTimelineV1Document = {
			schemaVersion: 1,
			id: id(1),
			audioEnabled: true,
			clips: [
				{ id: id(2), sourceKey: "a", inMs: 0, outMs: 4000 },
				{ id: id(3), sourceKey: "b", inMs: 0, outMs: 4000 },
			],
		};
		const before = structuredClone(legacy),
			normalized = timeline.normalizeVodInputTimelineDocument(legacy);
		const result = timeline.positionVodInputTimelineClip(
			legacy,
			{ track: "video", id: id(2), startMs: 2000 },
			nextIds(),
		);
		expect(result.schemaVersion).toBe(2);
		expect(result.videoClips).toEqual([
			{ id: id(2), sourceKey: "a", startMs: 2000, inMs: 0, outMs: 4000 },
			{ id: id(3), sourceKey: "b", startMs: 6000, inMs: 2000, outMs: 4000 },
		]);
		expect(result.audioClips).toEqual(normalized.audioClips);
		expect(result.durationMs).toBe(8000);
		expect(legacy).toEqual(before);
	});
	it.each([
		0, 10_000,
	])("accepts the exact program boundary at %i", (startMs) => {
		const result = timeline.positionVodInputTimelineClip(
			gapped("video"),
			{ track: "video", id: id(3), startMs },
			nextIds(),
		);
		expect(result.videoClips.find((clip) => clip.id === id(3))?.startMs).toBe(
			startMs,
		);
		expect(result.durationMs).toBe(12_000);
	});
	it.each([
		-1,
		0.5,
		Number.NaN,
		Infinity,
		-Infinity,
		Number.MAX_SAFE_INTEGER,
		10_001,
	])("rejects an invalid position %s", (startMs) => {
		expect(() =>
			timeline.positionVodInputTimelineClip(
				gapped("video"),
				{ track: "video", id: id(3), startMs },
				nextIds(),
			),
		).toThrowError(expect.objectContaining({ code: "TIMELINE_RANGE_INVALID" }));
	});
	it("reports a missing selected clip", () => {
		expect(() =>
			timeline.positionVodInputTimelineClip(
				gapped("video"),
				{ track: "audio", id: id(3), startMs: 2000 },
				nextIds(),
			),
		).toThrowError(expect.objectContaining({ code: "CLIP_NOT_FOUND" }));
	});
	it.each([
		2, 3,
	])("rejects a split allocation colliding with existing ID %i", (collision) => {
		expect(() =>
			timeline.positionVodInputTimelineClip(
				overlap(),
				{ track: "video", id: id(3), startMs: 4000 },
				() => id(collision),
			),
		).toThrowError(expect.objectContaining({ code: "TIMELINE_ID_CONFLICT" }));
	});
	it("preserves the per-track clip cap when inserting into an existing clip creates two survivors", () => {
		const base: timeline.VodInputTimelineV2Document = {
			schemaVersion: 2,
			id: id(1),
			audioEnabled: true,
			durationMs: 1000,
			videoClips: [
				{ id: id(2), sourceKey: "a", startMs: 0, inMs: 0, outMs: 100 },
				...Array.from({ length: 62 }, (_, index) => ({
					id: id(index + 10),
					sourceKey: "a",
					startMs: 100 + index,
					inMs: 0,
					outMs: 1,
				})),
				{ id: id(90), sourceKey: "b", startMs: 200, inMs: 0, outMs: 1 },
			],
			audioClips: [],
		};
		expect(() =>
			timeline.positionVodInputTimelineClip(
				base,
				{ track: "video", id: id(90), startMs: 50 },
				() => id(1000),
			),
		).toThrowError(
			expect.objectContaining({ code: "TIMELINE_LIMIT_EXCEEDED" }),
		);
	});
	it("retains the source-count and program-duration guards, including a same-start call", () => {
		const base = gapped("video");
		const tooMany = {
			...base,
			videoClips: Array.from({ length: 17 }, (_, index) => ({
				id: id(index + 20),
				sourceKey: `source${index}`,
				startMs: index,
				inMs: 0,
				outMs: 1,
			})),
		};
		expect(() =>
			timeline.positionVodInputTimelineClip(
				tooMany,
				{ track: "video", id: id(20), startMs: 0 },
				nextIds(),
			),
		).toThrowError(
			expect.objectContaining({ code: "TIMELINE_LIMIT_EXCEEDED" }),
		);
		expect(() =>
			timeline.positionVodInputTimelineClip(
				{ ...base, durationMs: timeline.MAX_VOD_TIMELINE_DURATION_MS + 1 },
				{ track: "video", id: id(3), startMs: 5000 },
				nextIds(),
			),
		).toThrowError(
			expect.objectContaining({ code: "TIMELINE_LIMIT_EXCEEDED" }),
		);
	});
	it("moves both screenshot clips into the left gap without shifting the opposite track", () => {
		const base: timeline.VodInputTimelineV2Document = {
			schemaVersion: 2,
			id: id(1),
			audioEnabled: true,
			durationMs: 34_000,
			videoClips: [
				{ id: id(2), sourceKey: "aisa", startMs: 0, inMs: 0, outMs: 7689 },
				{ id: id(3), sourceKey: "a", startMs: 11_347, inMs: 0, outMs: 8000 },
				{
					id: id(4),
					sourceKey: "aisa",
					startMs: 19_347,
					inMs: 11_347,
					outMs: 18_000,
				},
			],
			audioClips: [
				{ id: id(2), sourceKey: "aisa", startMs: 0, inMs: 0, outMs: 7689 },
				{
					id: id(4),
					sourceKey: "aisa",
					startMs: 11_347,
					inMs: 11_347,
					outMs: 18_000,
				},
				{
					id: id(5),
					sourceKey: "sound",
					startMs: 26_000,
					inMs: 0,
					outMs: 8000,
				},
			],
		};
		const video = timeline.positionVodInputTimelineClip(
			base,
			{ track: "video", id: id(3), startMs: 7689 },
			nextIds(),
		);
		expect(video.videoClips[1]).toEqual({
			...base.videoClips[1],
			startMs: 7689,
		});
		expect(video.audioClips).toEqual(base.audioClips);
		const audio = timeline.positionVodInputTimelineClip(
			base,
			{ track: "audio", id: id(4), startMs: 7689 },
			nextIds(),
		);
		expect(audio.audioClips[1]).toEqual({
			...base.audioClips[1],
			startMs: 7689,
		});
		expect(audio.videoClips).toBe(base.videoClips);
		expect(audio.durationMs).toBe(base.durationMs);
	});
	it("rejects an interior gap above the available two-sided padding budget", () => {
		const base: timeline.VodInputTimelineV2Document = {
			schemaVersion: 2,
			id: id(1),
			audioEnabled: true,
			durationMs: 26_001,
			videoClips: [
				{ id: id(2), sourceKey: "a", startMs: 0, inMs: 0, outMs: 2000 },
				{ id: id(3), sourceKey: "b", startMs: 10_000, inMs: 0, outMs: 2000 },
				{ id: id(4), sourceKey: "c", startMs: 24_001, inMs: 0, outMs: 2000 },
			],
			audioClips: [],
		};
		expect(() =>
			timeline.positionVodInputTimelineClip(
				base,
				{ track: "video", id: id(3), startMs: 2000 },
				nextIds(),
			),
		).toThrowError(expect.objectContaining({ code: "TIMELINE_GAP_TOO_LONG" }));
		expect(
			timeline.positionVodInputTimelineClip(
				base,
				{ track: "video", id: id(3), startMs: 2001 },
				nextIds(),
			).videoClips[1]?.startMs,
		).toBe(2001);
	});
	it.each([
		0, 10_001,
	])("retains the single-sided padding limit at the program edge after moving to %i", (startMs) => {
		const base: timeline.VodInputTimelineV2Document = {
			schemaVersion: 2,
			id: id(1),
			audioEnabled: false,
			durationMs: 14_001,
			videoClips: [
				{ id: id(2), sourceKey: "a", startMs: 5000, inMs: 0, outMs: 4000 },
			],
			audioClips: [],
		};
		expect(() =>
			timeline.positionVodInputTimelineClip(
				base,
				{ track: "video", id: id(2), startMs },
				nextIds(),
			),
		).toThrowError(expect.objectContaining({ code: "TIMELINE_GAP_TOO_LONG" }));
	});
	it("preserves the muted flag and latent audio while positioning audio independently", () => {
		const base = { ...gapped("audio"), audioEnabled: false };
		const result = timeline.positionVodInputTimelineClip(
			base,
			{ track: "audio", id: id(3), startMs: 3000 },
			nextIds(),
		);
		expect(result.audioEnabled).toBe(false);
		expect(result.audioClips[1]).toMatchObject({
			startMs: 3000,
			inMs: 1000,
			outMs: 3000,
		});
		expect(result.videoClips).toEqual(base.videoClips);
	});
});
