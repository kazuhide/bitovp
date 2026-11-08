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
	videoFit: "AUTO",
	captionPlacement: "OVERLAY",
} as const;
function fixture(captionPlacement: "OVERLAY" | "BANDS" = "OVERLAY") {
	const f = durationReviewFixture(89, true, "DRAFT", true);
	Object.assign(f.task.parameters.input.parameters, {
		presentation: { ...presentation, captionPlacement },
	});
	f.refreshCurrent();
	return f;
}
function sources(f: ReturnType<typeof fixture>) {
	return [
		{
			mediaVersionId: f.media.id,
			width: f.media.width,
			height: f.media.height,
			hasAudio: true,
			timeMap: f.media.timeMap,
		},
	];
}

describe("automatic whole-source draft publication", () => {
	it("keeps unresolved evidence and whole-source preview while publishing no encode", async () => {
		const f = fixture(),
			result = await f.run(),
			doc = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(result).toHaveProperty("presentation", presentation);
		expect(doc.presentation).toEqual({
			...presentation,
			centerCropConfirmed: false,
		});
		expect(
			doc.clips.flatMap((c) => c.framing).every((part) => part.mode === "FIT"),
		).toBe(true);
		expect(doc.clips.flatMap((c) => c.cropKeyframes ?? [])).toEqual([]);
		const plan = compileComposition(doc, sources(f));
		const frame = evaluateCompositionFrame(plan, 0),
			layer = frame.layers[0];
		expect(layer).toMatchObject({
			mode: "FIT",
			sourceRect: { x: 0, y: 0, w: 640, h: 360 },
			backdrop: { kind: "BLUR", clipRect: { x: 0, y: 0, w: 1080, h: 1920 } },
		});
		expect(layer?.drawRect.h).toBeLessThan(1920);
		expect(result.warnings).not.toContain("CENTER_CROP_REVIEW_REQUIRED");
		expect(f.runs).toEqual([]);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(await f.run()).toEqual(result);
		expect(f.projects).toHaveLength(1);
	});
	it("keeps the same foreground within intentional BANDS and clips backdrop to the main viewport", async () => {
		const f = fixture("BANDS");
		await f.run();
		const doc = compositionDocumentSchema.parse(f.projects[0]?.draft),
			frame = evaluateCompositionFrame(compileComposition(doc, sources(f)), 0),
			layer = frame.layers[0];
		expect(layer?.sourceRect).toEqual({ x: 0, y: 0, w: 640, h: 360 });
		expect(layer?.backdrop?.clipRect).toEqual(layer?.layoutRect);
		expect(layer?.layoutRect.y).toBeGreaterThan(0);
		expect(layer?.layoutRect.h).toBeLessThan(1920);
		expect(f.runs).toEqual([]);
	});
	it("refuses a completed AUTO draft replay marked as another framing mode", async () => {
		const f = fixture(),
			result = await f.run();
		f.task.result = {
			...result,
			presentation: { ...presentation, videoFit: "FILL" },
		};
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expect(f.runs).toEqual([]);
	});
});
