import {
	compileComposition,
	compositionDocumentSchema,
	evaluateCompositionFrame,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { durationReviewFixture } from "./generation-duration-review-fixture";

vi.mock("./tracking", async (original) => ({
	...(await original<object>()),
	trackShotSubjects: vi.fn(async () => ({ observations: [], fallbacks: [] })),
}));
const presentation = {
	version: "portrait-layout-v1",
	videoFit: "FILL",
	captionPlacement: "OVERLAY",
} as const;
function fixture() {
	const f = durationReviewFixture(89, true, "DRAFT", true);
	Object.assign(f.task.parameters.input.parameters, { presentation });
	f.refreshCurrent();
	return f;
}
describe("portrait-layout draft publication", () => {
	it("publishes a full-height editable proposal without discarding FIT evidence or queueing any encode", async () => {
		const f = fixture(),
			result = await f.run(),
			doc = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(result).toHaveProperty("presentation", presentation);
		expect(doc).toHaveProperty("presentation", {
			...presentation,
			centerCropConfirmed: false,
		});
		expect(
			doc.clips.flatMap((c) => c.framing).every((f) => f.mode === "FIT"),
		).toBe(true);
		expect(doc.clips.flatMap((c) => c.cropKeyframes ?? [])).toEqual([]);
		const sources = [
			{
				mediaVersionId: f.media.id,
				width: f.media.width,
				height: f.media.height,
				hasAudio: true,
				timeMap: f.media.timeMap,
			},
		];
		expect(() => compileComposition(doc, sources)).toThrow(
			"UNCONFIRMED_FRAMING",
		);
		const frame = evaluateCompositionFrame(
			compileComposition(doc, sources, { allowUnconfirmed: true }),
			0,
		);
		expect(frame.layers[0]).toMatchObject({
			mode: "CROP",
			drawRect: { x: 0, y: 0, w: 1080, h: 1920 },
		});
		expect(f.runs).toEqual([]);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(await f.run()).toEqual(result);
		expect(f.projects).toHaveLength(1);
	});
	it("keeps the whole image when FIT is explicitly selected, with no central-crop confirmation", async () => {
		const f = fixture();
		Object.assign(f.task.parameters.input.parameters, {
			presentation: { ...presentation, videoFit: "FIT" },
		});
		f.refreshCurrent();
		const result = await f.run(),
			doc = compositionDocumentSchema.parse(f.projects[0]?.draft);
		const frame = evaluateCompositionFrame(
			compileComposition(doc, [
				{
					mediaVersionId: f.media.id,
					width: f.media.width,
					height: f.media.height,
					hasAudio: true,
					timeMap: f.media.timeMap,
				},
			]),
			0,
		);
		expect(frame.layers[0]).toMatchObject({
			mode: "FIT",
			sourceRect: { x: 0, y: 0, w: 640, h: 360 },
		});
		expect(frame.layers[0]?.drawRect.h).toBeLessThan(1920);
		expect(result.warnings).not.toContain("CENTER_CROP_REVIEW_REQUIRED");
		expect(f.runs).toEqual([]);
	});
	it("retains BANDS provenance and reserves the actual caption and video geometry", async () => {
		const f = fixture();
		Object.assign(f.task.parameters.input.parameters, {
			presentation: { ...presentation, captionPlacement: "BANDS" },
		});
		f.refreshCurrent();
		const result = await f.run(),
			doc = compositionDocumentSchema.parse(f.projects[0]?.draft);
		const frame = evaluateCompositionFrame(
			compileComposition(
				doc,
				[
					{
						mediaVersionId: f.media.id,
						width: f.media.width,
						height: f.media.height,
						hasAudio: true,
						timeMap: f.media.timeMap,
					},
				],
				{ allowUnconfirmed: true },
			),
			0,
		);
		expect(result).toHaveProperty("presentation.captionPlacement", "BANDS");
		expect(doc).toHaveProperty("presentation.captionPlacement", "BANDS");
		expect(frame.layers[0]?.drawRect.y).toBeGreaterThan(0);
		expect(frame.layers[0]?.drawRect.h).toBeLessThan(1920);
		expect(f.runs).toEqual([]);
	});
	it("refuses a replay result whose presentation marker was lost or switched", async () => {
		for (const corrupt of [
			undefined,
			{ ...presentation, captionPlacement: "BANDS" },
		]) {
			const f = fixture(),
				result = await f.run();
			f.task.result = { ...result, presentation: corrupt };
			await expect(f.run()).rejects.toMatchObject({
				code: "TASK_RESULT_UNVERIFIED",
			});
		}
	});
});
