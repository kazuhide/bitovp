import type { VodInputTimelineV2Document } from "@bitovp/core/vod-input-timeline";
import { describe, expect, it } from "vitest";
import { snapTimelineTime, timelineSnapCandidates } from "./timeline-snapping";

const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";
const audioId = "10000000-0000-4000-8000-000000000003";

function document(): VodInputTimelineV2Document {
	return {
		schemaVersion: 2,
		id: "10000000-0000-4000-8000-000000000004",
		audioEnabled: true,
		durationMs: 10_000,
		videoClips: [
			{
				id: firstId,
				sourceKey: "a",
				startMs: 1000,
				inMs: 10_000,
				outMs: 12_000,
			},
			{ id: secondId, sourceKey: "b", startMs: 5000, inMs: 0, outMs: 2000 },
		],
		audioClips: [
			{
				id: firstId,
				sourceKey: "a",
				startMs: 1500,
				inMs: 20_000,
				outMs: 23_000,
			},
			{ id: audioId, sourceKey: "c", startMs: 4500, inMs: 0, outMs: 2500 },
		],
	};
}

describe("timeline snap candidates", () => {
	it("collects output boundaries from both tracks, gaps and the whole program", () => {
		expect(timelineSnapCandidates(document())).toEqual([
			0, 1000, 1500, 3000, 4500, 5000, 7000, 10_000,
		]);
	});

	it("excludes only the edited track's clip even when the other track shares its ID", () => {
		expect(
			timelineSnapCandidates(document(), { track: "video", id: firstId }),
		).toEqual([0, 1500, 4500, 5000, 7000, 10_000]);
		expect(
			timelineSnapCandidates(document(), { track: "audio", id: firstId }),
		).toEqual([0, 1000, 3000, 4500, 5000, 7000, 10_000]);
	});

	it("retains boundaries from latent audio when program audio is disabled", () => {
		expect(
			timelineSnapCandidates({ ...document(), audioEnabled: false }),
		).toContain(1500);
	});

	it("deduplicates endpoints and includes a valid integer playhead", () => {
		expect(timelineSnapCandidates(document(), undefined, 3750)).toEqual([
			0, 1000, 1500, 3000, 3750, 4500, 5000, 7000, 10_000,
		]);
		expect(timelineSnapCandidates(document(), undefined, 5000)).toHaveLength(8);
		expect(timelineSnapCandidates(document(), undefined, 0)).toHaveLength(8);
		expect(timelineSnapCandidates(document(), undefined, 10_000)).toHaveLength(
			8,
		);
	});

	it.each([
		-1,
		10_001,
		1000.5,
		Number.NaN,
		Infinity,
		-Infinity,
	])("ignores invalid or out-of-program playhead %s", (playheadMs) => {
		expect(timelineSnapCandidates(document(), undefined, playheadMs)).toEqual(
			timelineSnapCandidates(document()),
		);
	});

	it("keeps zero and the program end for an empty track pair", () => {
		const empty = { ...document(), videoClips: [], audioClips: [] };
		expect(timelineSnapCandidates(empty)).toEqual([0, 10_000]);
		expect(timelineSnapCandidates({ ...empty, durationMs: 0 })).toEqual([0]);
	});

	it("does not change the source document or its clip arrays", () => {
		const original = document();
		const before = structuredClone(original);
		for (const clips of [original.videoClips, original.audioClips]) {
			for (const clip of clips) Object.freeze(clip);
			Object.freeze(clips);
		}
		Object.freeze(original);
		timelineSnapCandidates(original, { track: "video", id: firstId }, 3750);
		expect(original).toEqual(before);
	});
});

describe("timeline time snapping", () => {
	it.each([
		{ scale: 0.04, inside: 1200, outside: 1200.01 },
		{ scale: 0.16, inside: 1050, outside: 1050.01 },
		{ scale: 2, inside: 1004, outside: 1004.01 },
	])("uses an inclusive eight screen-pixel radius at scale $scale", ({
		scale,
		inside,
		outside,
	}) => {
		expect(snapTimelineTime(inside, [1000], scale)).toBe(1000);
		expect(snapTimelineTime(outside, [1000], scale)).toBeNull();
	});

	it("chooses the nearest candidate regardless of input order and duplicates", () => {
		expect(snapTimelineTime(1060, [900, 1100, 1000, 1100], 0.04)).toBe(1100);
	});

	it("breaks an equal-distance tie toward the earlier time", () => {
		expect(snapTimelineTime(1000, [1100, 900, 1100], 0.04)).toBe(900);
	});

	it("holds the previous candidate within twelve pixels even when another is closer", () => {
		expect(snapTimelineTime(1001, [1000, 1100], 0.04, 1100)).toBe(1100);
		expect(snapTimelineTime(1300, [1000, 1300], 0.04, 1000)).toBe(1000);
	});

	it("releases the previous candidate beyond twelve pixels and reacquires within eight", () => {
		expect(snapTimelineTime(1301, [1000, 1300], 0.04, 1000)).toBe(1300);
		expect(snapTimelineTime(1301, [1000], 0.04, 1000)).toBeNull();
	});

	it("does not retain a previous candidate that has been removed", () => {
		expect(snapTimelineTime(1100, [1150], 0.04, 1000)).toBe(1150);
	});

	it.each([
		null,
		undefined,
		-1,
		1000.5,
		Number.NaN,
		Infinity,
	])("falls back to nearest for an invalid or absent previous target %s", (previousMs) => {
		expect(snapTimelineTime(1001, [1000], 0.04, previousMs)).toBe(1000);
	});

	it("can reach zero from a negative raw position within eight pixels", () => {
		expect(snapTimelineTime(-200, [0], 0.04)).toBe(0);
		expect(snapTimelineTime(-200.01, [0], 0.04)).toBeNull();
	});

	it("ignores noninteger, negative and nonfinite candidates", () => {
		const invalid = [-1, 1000.5, Number.NaN, Infinity, -Infinity];
		expect(snapTimelineTime(1000, invalid, 0.04)).toBeNull();
		expect(snapTimelineTime(1000, [...invalid, 1001], 0.04)).toBe(1001);
		expect(snapTimelineTime(1000, [], 0.04, 1000)).toBeNull();
	});

	it.each([
		{ position: Number.NaN, scale: 0.04 },
		{ position: Infinity, scale: 0.04 },
		{ position: -Infinity, scale: 0.04 },
		{ position: 1000, scale: 0 },
		{ position: 1000, scale: -1 },
		{ position: 1000, scale: Number.NaN },
		{ position: 1000, scale: Infinity },
		{ position: 1000, scale: -Infinity },
	])("rejects position $position and scale $scale", ({ position, scale }) => {
		expect(snapTimelineTime(position, [1000], scale, 1000)).toBeNull();
	});

	it("keeps nearest-time ordering at the smallest positive scale", () => {
		expect(snapTimelineTime(1000.4, [999, 1001], Number.MIN_VALUE)).toBe(1001);
	});

	it("handles overflowing time differences without overflowing the screen radius", () => {
		expect(
			snapTimelineTime(-Number.MAX_VALUE, [Number.MAX_VALUE], 1e-308),
		).toBe(Number.MAX_VALUE);
		expect(
			snapTimelineTime(-Number.MAX_VALUE, [Number.MAX_VALUE], 4e-308),
		).toBeNull();
	});

	it("handles the largest finite scale and an exact target", () => {
		expect(snapTimelineTime(1, [0], Number.MAX_VALUE)).toBeNull();
		expect(snapTimelineTime(1, [1], Number.MAX_VALUE)).toBe(1);
	});

	it("does not sort or mutate a readonly candidate array", () => {
		const candidates = Object.freeze([1200, 900, 1100]);
		expect(snapTimelineTime(1000, candidates, 0.04)).toBe(900);
		expect(candidates).toEqual([1200, 900, 1100]);
	});
});
