import type { RenderRecipe } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { EditingMediaFacts } from "./media";
import { buildEditingFilterGraph, editingRenderCanvas } from "./render";

const recipe: RenderRecipe = {
	schemaVersion: 1,
	compilerVersion: "content-editing-v1",
	mediaVersionId: "media",
	timeMapId: "map",
	canvas: { width: 1080, height: 1920 },
	fps: { num: 30, den: 1 },
	durationFrames: 60,
	segments: [
		{
			clipId: "one",
			editingStartFrame: 30,
			editingEndFrame: 60,
			timelineStartFrame: 0,
			durationFrames: 30,
			framing: { mode: "CROP", rect: { x: 0.65, y: 0, w: 0.31640625, h: 1 } },
			audio: { mode: "SOURCE" },
		},
		{
			clipId: "two",
			editingStartFrame: 0,
			editingEndFrame: 30,
			timelineStartFrame: 30,
			durationFrames: 30,
			framing: { mode: "FIT" },
			audio: { mode: "MUTE" },
		},
	],
};
const facts: EditingMediaFacts = {
	width: 320,
	height: 180,
	durationUs: 2000000,
	frameCount: 60,
	fps: { num: 30, den: 1 },
	hasAudio: true,
	probe: {},
};

describe("one recipe for editing preview and export", () => {
	it("uses the same source frames, crop rasterization, and audio intervals at both resolutions", () => {
		const preview = buildEditingFilterGraph(recipe, facts, "PREVIEW");
		const output = buildEditingFilterGraph(recipe, facts, "EXPORT");
		for (const text of [preview, output]) {
			expect(text).toContain("trim=start_frame=30:end_frame=60");
			expect(text).toContain("crop=101:180:208:0:exact=1");
			expect(text).toContain("atrim=start_sample=48000:end_sample=96000");
			expect(text).toContain("concat=n=2:v=1:a=1");
		}
		expect(editingRenderCanvas(recipe.canvas, "PREVIEW")).toEqual({
			width: 360,
			height: 640,
		});
		expect(editingRenderCanvas(recipe.canvas, "EXPORT")).toEqual(recipe.canvas);
	});
	it("generates silent audio when the selected source has no audio stream", () => {
		const graph = buildEditingFilterGraph(
			recipe,
			{ ...facts, hasAudio: false },
			"EXPORT",
		);
		expect(graph).not.toContain("[0:a:0]");
		expect(graph.match(/anullsrc/g)).toHaveLength(2);
	});
	it("refuses a recipe that refers to frames outside the pinned media", () => {
		expect(() =>
			buildEditingFilterGraph(recipe, { ...facts, frameCount: 59 }, "EXPORT"),
		).toThrow();
	});
	it("refuses discontinuous or non-finite recipe fields", () => {
		const changed = structuredClone(recipe);
		const [first, second] = changed.segments;
		if (!first || !second) throw new Error("Missing test segments");
		second.timelineStartFrame = 31;
		expect(() => buildEditingFilterGraph(changed, facts, "EXPORT")).toThrow();
		first.editingStartFrame = Number.NaN;
		expect(() => buildEditingFilterGraph(changed, facts, "EXPORT")).toThrow();
	});
});
