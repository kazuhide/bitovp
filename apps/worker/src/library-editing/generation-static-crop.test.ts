import { compositionDocumentSchema, hashEditingEvidence } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { durationReviewFixture } from "./generation-duration-review-fixture";
import type { TrackingInput } from "./tracking";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("./tracking", async (original) => ({
	...(await original<object>()),
	trackShotSubjects: track,
}));
beforeEach(() => {
	track.mockReset().mockResolvedValue({ observations: [], fallbacks: [] });
});
const base = {
	version: "portrait-layout-v1",
	videoFit: "FILL",
	captionPlacement: "OVERLAY",
} as const;
const presentation = { ...base, fallbackFraming: "AISA_STATIC_V1" } as const;
function fixture(policy = true) {
	const f = durationReviewFixture(89, true, "DRAFT", true);
	Object.assign(f.task.parameters.input.parameters, {
		presentation: policy ? presentation : base,
	});
	f.refreshCurrent();
	return f;
}
describe("opt-in static AISA fallback publication", () => {
	it("publishes fixed proposals while preserving raw FIT, missing keys, policy provenance and no encode", async () => {
		const f = fixture(),
			result = await f.run(),
			doc = compositionDocumentSchema.parse(f.projects[0]?.draft),
			clip = doc.clips.find((c) => c.evidence?.sceneId === f.sceneIds[0]);
		expect(result.presentation).toEqual(presentation);
		expect(doc.presentation).toEqual({
			...presentation,
			centerCropConfirmed: false,
		});
		expect(clip?.fallbackCrop?.x).toBeCloseTo(0.361572265625);
		expect(clip?.fallbackCrop?.y).toBeCloseTo(0.0125);
		expect(clip?.fallbackCrop?.w).toBeCloseTo(0.27685546875);
		expect(clip?.fallbackCrop?.h).toBeCloseTo(0.875);
		expect(
			doc.clips.flatMap((c) => c.framing).every((p) => p.mode === "FIT"),
		).toBe(true);
		expect(doc.clips.flatMap((c) => c.cropKeyframes ?? [])).toEqual([]);
		expect(f.runs).toEqual([]);
		expect(await f.run()).toEqual(result);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
	});
	it("does not add proposals to old explicit FILL requests or old missing presentation", async () => {
		for (const missing of [false, true]) {
			const f = fixture(false);
			if (missing) delete f.task.parameters.input.parameters.presentation;
			f.refreshCurrent();
			const result = await f.run(),
				doc = compositionDocumentSchema.parse(f.projects[0]?.draft);
			expect(doc.clips.every((c) => !Object.hasOwn(c, "fallbackCrop"))).toBe(
				true,
			);
			if (missing) expect(Object.hasOwn(result, "presentation")).toBe(false);
			else expect(result.presentation).toEqual(base);
		}
	});
	it("retains successful measured windows and real keys when static fallback is added", async () => {
		track.mockImplementation(async ({ shots }: TrackingInput) => ({
			fallbacks: [],
			observations: shots.flatMap((shot) =>
				[shot.startUs, shot.startUs + 333334]
					.filter((t) => t < shot.endUs)
					.map((sourceTimeUs) => ({
						sceneId: shot.sceneId,
						shotIndex: shot.shotIndex,
						sourceTimeUs,
						box: { x: 0.1, y: 0.1, w: 0.05, h: 0.2 },
						confidence: 0.95,
					})),
			),
		}));
		const old = fixture(false);
		await old.run();
		const previous = compositionDocumentSchema.parse(old.projects[0]?.draft),
			next = fixture();
		await next.run();
		const doc = compositionDocumentSchema.parse(next.projects[0]?.draft);
		expect(
			doc.clips.some((c) => c.framing.some((p) => p.mode === "CROP")),
		).toBe(true);
		expect(doc.clips.some((c) => (c.cropKeyframes?.length ?? 0) >= 2)).toBe(
			true,
		);
		expect(
			doc.clips.map((c) => ({ framing: c.framing, keys: c.cropKeyframes })),
		).toEqual(
			previous.clips.map((c) => ({
				framing: c.framing,
				keys: c.cropKeyframes,
			})),
		);
		expect(doc.clips.some((c) => c.fallbackCrop !== undefined)).toBe(true);
		expect(next.runs).toEqual([]);
	});
	it("uses central position only where the bound shot has no valid subject position", async () => {
		const f = fixture();
		const document = structuredClone(f.analysis.document);
		for (const scene of document.scenes)
			for (const shot of scene.shots) shot.mainSubjects = [];
		f.analysis.document = document;
		f.binding.analysisDocumentHash = hashEditingEvidence(f.analysis.document);
		Object.assign(f.task.parameters.identity, {
			analysisDocumentHash: f.binding.analysisDocumentHash,
			bindingHash: hashEditingEvidence(f.binding),
		});
		f.refresh();
		f.refreshCurrent();
		await f.run();
		const doc = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(doc.clips.length).toBeGreaterThan(0);
		for (const clip of doc.clips)
			expect(clip.fallbackCrop).toEqual({
				x: 0.341796875,
				y: 0,
				w: 0.31640625,
				h: 1,
			});
		expect(doc.clips.flatMap((c) => c.cropKeyframes ?? [])).toEqual([]);
	});
	it("proposes against each variant's canonical canvas rather than the first portrait aspect", async () => {
		const f = fixture();
		Object.assign(f.task.parameters.input.parameters, { variants: 3 });
		f.refreshCurrent();
		await f.run();
		expect(f.projects).toHaveLength(3);
		for (const row of f.projects) {
			const doc = compositionDocumentSchema.parse(row.draft);
			const rect = doc.clips.find((c) => c.fallbackCrop)?.fallbackCrop;
			expect(rect).toBeDefined();
			if (!rect) throw Error("Missing variant crop");
			expect((rect.w * f.media.width) / (rect.h * f.media.height)).toBeCloseTo(
				doc.canvas.width / doc.canvas.height,
				10,
			);
		}
	});
	it("rejects a replay result whose static policy marker was removed or changed", async () => {
		for (const marker of [undefined, "OTHER"]) {
			const f = fixture(),
				result = await f.run();
			f.task.result = {
				...result,
				presentation: { ...presentation, fallbackFraming: marker },
			};
			await expect(f.run()).rejects.toMatchObject({
				code: "TASK_RESULT_UNVERIFIED",
			});
			expect(f.projects).toHaveLength(1);
		}
	});
});
