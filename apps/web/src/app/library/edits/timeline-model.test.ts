import type { EditDocument } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { editingProjectFixture } from "./editing-fixtures";
import { timelinePoint, trimTimelineClip } from "./timeline-model";

function fixture() {
	const project = editingProjectFixture();
	const map = project.media.timeMap;
	const first = project.draft.clips[0];
	if (!first) throw new Error("Missing clip");
	if (!map) throw new Error("Missing map");
	const document: EditDocument = {
		...project.draft,
		clips: [
			{
				...first,
				sourceInUs: 1_000_000,
				durationFrames: 60,
				framing: [
					{
						fromFrame: 0,
						toFrame: 31,
						mode: "CROP",
						origin: "EDITOR_CONFIRMED",
						manualOverride: true,
						rect: { x: 0.3, y: 0, w: 0.3, h: 1 },
					},
					{ fromFrame: 31, toFrame: 60, mode: "FIT", origin: "MANUAL" },
				],
				audio: { mode: "MUTE" },
			},
			{
				...first,
				id: "77777777-7777-4777-8777-777777777777",
				sourceInUs: 5_000_000,
				timelineStartFrame: 60,
				durationFrames: 30,
				framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
			},
		],
	};
	return { document, map };
}

describe("output timeline positions", () => {
	it("resolves cuts to the next clip and clamps outside clicks to real frames", () => {
		const { document, map } = fixture();
		expect(timelinePoint(document, 59, map)).toMatchObject({
			frame: 59,
			index: 0,
			localFrame: 59,
			part: 1,
			sourceFrame: 89,
		});
		expect(timelinePoint(document, 60, map)).toMatchObject({
			index: 1,
			localFrame: 0,
			sourceSeconds: 5,
		});
		expect(timelinePoint(document, -20, map).frame).toBe(0);
		expect(timelinePoint(document, 90, map).frame).toBe(89);
	});
	it("uses the pinned time map for a nonzero source and editing offset", () => {
		const { document, map } = fixture();
		map.sourceStartUs = 111_111;
		map.sourceEndUs += 111_111;
		map.editingStartFrame = 90;
		map.editingEndFrame += 90;
		document.clips = document.clips.map((clip, index) =>
			index === 0 ? { ...clip, sourceInUs: 144_445 } : clip,
		);
		expect(timelinePoint(document, 1, map)).toMatchObject({
			sourceFrame: 92,
			sourceSeconds: 92 / 30,
		});
	});
});

describe("frame-based timeline trimming", () => {
	it("trims one source frame without resetting manual crop, audio or origins", () => {
		const { document, map } = fixture();
		const result = trimTimelineClip(document, 0, "IN", 1, map);
		expect(result.clips[0]).toMatchObject({
			sourceInUs: 1_033_334,
			durationFrames: 59,
			audio: { mode: "MUTE" },
			framing: [
				{
					fromFrame: 0,
					toFrame: 30,
					mode: "CROP",
					origin: "EDITOR_CONFIRMED",
					manualOverride: true,
					rect: { x: 0.3, y: 0, w: 0.3, h: 1 },
				},
				{ fromFrame: 30, toFrame: 59, mode: "FIT", origin: "MANUAL" },
			],
		});
		expect(result.clips[1]?.timelineStartFrame).toBe(59);
		expect(document.clips[0]?.durationFrames).toBe(60);
	});
	it("adds fit only for newly exposed source at either edge", () => {
		const { document, map } = fixture();
		const left = trimTimelineClip(document, 0, "IN", -2, map);
		expect(left.clips[0]?.framing).toMatchObject([
			{ fromFrame: 0, toFrame: 2, mode: "FIT", origin: "MANUAL" },
			{ fromFrame: 2, toFrame: 33, mode: "CROP", manualOverride: true },
			{ fromFrame: 33, toFrame: 62, mode: "FIT" },
		]);
		const right = trimTimelineClip(document, 0, "OUT", 2, map);
		expect(right.clips[0]?.framing.at(-1)).toEqual({
			fromFrame: 31,
			toFrame: 62,
			mode: "FIT",
			origin: "MANUAL",
		});
	});
	it("does not accumulate identical fit segments while extending frame by frame", () => {
		const project = editingProjectFixture();
		const map = project.media.timeMap;
		if (!map) throw new Error("Missing map");
		let document = project.draft;
		for (let frame = 0; frame < 200; frame++)
			document = trimTimelineClip(document, 0, "OUT", 1, map);
		expect(document.clips[0]?.durationFrames).toBe(500);
		expect(document.clips[0]?.framing).toEqual([
			{ fromFrame: 0, toFrame: 500, mode: "FIT", origin: "MANUAL" },
		]);
	});
	it("clamps at source edges and keeps at least one frame", () => {
		const { document, map } = fixture();
		expect(
			trimTimelineClip(document, 0, "IN", -200, map).clips[0],
		).toMatchObject({
			sourceInUs: 0,
			durationFrames: 90,
		});
		expect(
			trimTimelineClip(document, 0, "IN", 500, map).clips[0],
		).toMatchObject({
			durationFrames: 1,
		});
		expect(
			trimTimelineClip(document, 0, "OUT", 5000, map).clips[0]?.durationFrames,
		).toBe(1770);
		expect(
			trimTimelineClip(document, 0, "OUT", -500, map).clips[0]?.durationFrames,
		).toBe(1);
	});
	it("clamps extension to the 180 second total budget", () => {
		const { document, map } = fixture();
		map.sourceEndUs = 600_000_000;
		map.editingEndFrame = 18_000;
		const result = trimTimelineClip(document, 0, "OUT", 10_000, map);
		expect(
			result.clips.reduce((sum, clip) => sum + clip.durationFrames, 0),
		).toBe(5400);
	});
	it("preserves ceil microseconds when trimming a split frame with nonzero origin", () => {
		const { document, map } = fixture();
		map.sourceStartUs = 111_111;
		map.sourceEndUs += 111_111;
		document.clips = document.clips.map((clip, index) =>
			index === 0 ? { ...clip, sourceInUs: 144_445 } : clip,
		);
		expect(
			trimTimelineClip(document, 0, "IN", 1, map).clips[0]?.sourceInUs,
		).toBe(177_778);
	});
	it("returns the original document for a no-op and rejects mismatched maps", () => {
		const { document, map } = fixture();
		expect(trimTimelineClip(document, 0, "OUT", 0, map)).toBe(document);
		expect(() =>
			trimTimelineClip(document, 0, "OUT", 1, { ...map, id: "wrong" }),
		).toThrow();
	});
});
