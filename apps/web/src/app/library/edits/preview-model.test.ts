import { compileEditDocument } from "@bitovp/core";
import { expect, it } from "vitest";
import { editingProjectFixture } from "./editing-fixtures";
import { buildPreviewPlan, previewLocation } from "./preview-model";

it("maps reordered source ranges with the same pinned frame offsets as export", () => {
	const p = editingProjectFixture();
	const first = p.draft.clips[0];
	const map = p.media.timeMap;
	if (!first || !map) throw new Error("fixture");
	map.sourceStartUs = 111_111;
	map.sourceEndUs += 111_111;
	map.editingStartFrame = 90;
	map.editingEndFrame += 90;
	p.draft.clips = [
		{
			...first,
			sourceInUs: 144_445,
			durationFrames: 31,
			framing: [{ fromFrame: 0, toFrame: 31, mode: "FIT", origin: "MANUAL" }],
		},
		{
			...first,
			id: "77777777-7777-4777-8777-777777777777",
			sourceInUs: 5_111_111,
			timelineStartFrame: 31,
			durationFrames: 29,
			audio: { mode: "MUTE" },
			framing: [{ fromFrame: 0, toFrame: 29, mode: "FIT", origin: "MANUAL" }],
		},
	];
	const plan = buildPreviewPlan(p.draft, p.media);
	expect(plan.clips.map((clip) => clip.sourceFrom)).toEqual(
		compileEditDocument(p.draft, map).segments.map((s) => s.editingStartFrame),
	);
	expect(previewLocation(plan, 30)).toMatchObject({
		frame: 30,
		sourceFrame: 121,
		clipIndex: 0,
		muted: false,
	});
	expect(previewLocation(plan, 31)).toMatchObject({
		frame: 31,
		sourceFrame: 240,
		clipIndex: 1,
		muted: true,
	});
	expect(previewLocation(plan, 1000).frame).toBe(59);
});

it("uses rounded pixel crop edges and fit padding for the output canvas", () => {
	const p = editingProjectFixture();
	const clip = p.draft.clips[0];
	if (!clip) throw new Error("fixture");
	clip.framing = [
		{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" },
		{
			fromFrame: 30,
			toFrame: 300,
			mode: "CROP",
			origin: "AISA_PROPOSAL",
			rect: { x: 0.3333, y: 0, w: 0.3164, h: 1 },
		},
	];
	const plan = buildPreviewPlan(p.draft, p.media);
	expect(previewLocation(plan, 0).geometry).toEqual({
		sx: 0,
		sy: 0,
		sw: 1920,
		sh: 1080,
		dx: 0,
		dy: 656,
		dw: 1080,
		dh: 608,
	});
	expect(previewLocation(plan, 30).geometry).toEqual({
		sx: 640,
		sy: 0,
		sw: 607,
		sh: 1080,
		dx: 0,
		dy: 0,
		dw: 1080,
		dh: 1920,
	});
});

it("rejects unready or mismatched media and out-of-source edits", () => {
	const p = editingProjectFixture();
	expect(() =>
		buildPreviewPlan(p.draft, { ...p.media, state: "PENDING" }),
	).toThrow();
	expect(() =>
		buildPreviewPlan(p.draft, { ...p.media, id: "wrong" }),
	).toThrow();
	const clip = p.draft.clips[0];
	if (!clip) throw new Error("fixture");
	clip.sourceInUs = 59_000_000;
	expect(() => buildPreviewPlan(p.draft, p.media)).toThrow();
});

it.each([
	{
		axis: "vertical",
		source: { width: 1920, height: 1078 },
		canvas: { width: 1080, height: 1920 },
		geometry: { dx: 0, dy: 656, dw: 1080, dh: 606 },
	},
	{
		axis: "horizontal",
		source: { width: 1078, height: 1920 },
		canvas: { width: 1920, height: 1080 },
		geometry: { dx: 656, dy: 0, dw: 606, dh: 1080 },
	},
])("matches yuv420 FIT padding on $axis chroma boundaries", ({
	source,
	canvas,
	geometry,
}) => {
	const p = editingProjectFixture();
	const clip = p.draft.clips[0];
	if (!clip) throw new Error("fixture");
	p.media.width = source.width;
	p.media.height = source.height;
	p.draft.canvas.width = canvas.width;
	p.draft.canvas.height = canvas.height;
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: clip.durationFrames,
			mode: "FIT",
			origin: "MANUAL",
		},
	];
	expect(
		previewLocation(buildPreviewPlan(p.draft, p.media), 0).geometry,
	).toMatchObject(geometry);
});
