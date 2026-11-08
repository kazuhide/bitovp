import {
	type CompositionDocument,
	compositionDocumentSchema,
	type GenerationTaskParameters,
	hashEditingEvidence,
} from "@bitovp/core";
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
const presentation = {
	version: "portrait-layout-v1",
	videoFit: "AUTO",
	captionPlacement: "OVERLAY",
	fallbackFraming: "PRESERVE_SOURCE_V1",
} as const;
type Presentation = NonNullable<GenerationTaskParameters["presentation"]>;
function fixture(settings: Presentation = presentation) {
	const f = durationReviewFixture(89, true, "DRAFT", true);
	Object.assign(f.task.parameters.input.parameters, { presentation: settings });
	f.refreshCurrent();
	return f;
}
function rawClips(f: ReturnType<typeof fixture>, doc: CompositionDocument) {
	return doc.clips.map((clip) => ({
		sourceInUs: clip.sourceInUs,
		durationFrames: clip.durationFrames,
		timelineStartFrame: clip.timelineStartFrame,
		framing: clip.framing,
		keys: clip.cropKeyframes,
		evidence: clip.evidence && {
			sceneIndex: f.analysis.document.scenes.findIndex(
				(scene) => scene.id === clip.evidence?.sceneId,
			),
			shotIndex: clip.evidence.shotIndex,
		},
	}));
}

describe("preserve-source draft publication", () => {
	it("retains a static AISA candidate for later explicit FILL without replacing raw FIT or queuing an encode", async () => {
		const f = fixture(),
			request = structuredClone(f.task.parameters),
			result = await f.run(),
			doc = compositionDocumentSchema.parse(f.projects[0]?.draft),
			clip = doc.clips.find(
				(value) => value.evidence?.sceneId === f.sceneIds[0],
			);
		expect(result.presentation).toEqual(presentation);
		expect(doc.presentation).toEqual({
			...presentation,
			centerCropConfirmed: false,
		});
		expect(clip?.fallbackCrop).toBeDefined();
		expect(clip?.fallbackCrop?.x).toBeCloseTo(0.361572265625, 12);
		expect(clip?.fallbackCrop?.y).toBeCloseTo(0.0125, 12);
		expect(clip?.fallbackCrop?.w).toBeCloseTo(0.27685546875, 12);
		expect(clip?.fallbackCrop?.h).toBeCloseTo(0.875, 12);
		expect(
			doc.clips
				.flatMap((value) => value.framing)
				.every((part) => part.mode === "FIT"),
		).toBe(true);
		expect(doc.clips.flatMap((value) => value.cropKeyframes ?? [])).toEqual([]);
		expect(f.task.parameters).toEqual(request);
		expect(f.runs).toEqual([]);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(await f.run()).toEqual(result);
		expect(f.projects).toHaveLength(1);
	});
	it("retains measured raw CROP, observation-derived keys and shot evidence while adding the same fallback as the old static policy", async () => {
		track.mockImplementation(async ({ shots }: TrackingInput) => ({
			fallbacks: [],
			observations: shots.flatMap((shot) =>
				[shot.startUs, shot.startUs + 333334]
					.filter((time) => time < shot.endUs)
					.map((sourceTimeUs) => ({
						sceneId: shot.sceneId,
						shotIndex: shot.shotIndex,
						sourceTimeUs,
						box: { x: 0.1, y: 0.1, w: 0.05, h: 0.2 },
						confidence: 0.95,
					})),
			),
		}));
		const old = fixture({
			...presentation,
			videoFit: "FILL",
			fallbackFraming: "AISA_STATIC_V1",
		});
		await old.run();
		const previous = compositionDocumentSchema.parse(old.projects[0]?.draft),
			next = fixture();
		await next.run();
		const doc = compositionDocumentSchema.parse(next.projects[0]?.draft);
		expect(
			doc.clips.some((clip) =>
				clip.framing.some((part) => part.mode === "CROP"),
			),
		).toBe(true);
		expect(
			doc.clips.some((clip) => (clip.cropKeyframes?.length ?? 0) >= 2),
		).toBe(true);
		expect(rawClips(next, doc)).toEqual(rawClips(old, previous));
		expect(doc.clips.map((clip) => clip.fallbackCrop)).toEqual(
			previous.clips.map((clip) => clip.fallbackCrop),
		);
		expect(next.runs).toEqual([]);
	});
	it("keeps legacy AUTO and missing presentation free of the new fallback and marker", async () => {
		for (const missing of [false, true]) {
			const f = fixture({
				version: "portrait-layout-v1",
				videoFit: "AUTO",
				captionPlacement: "OVERLAY",
			});
			if (missing) delete f.task.parameters.input.parameters.presentation;
			f.refreshCurrent();
			const result = await f.run(),
				doc = compositionDocumentSchema.parse(f.projects[0]?.draft);
			expect(
				doc.clips.every((clip) => !Object.hasOwn(clip, "fallbackCrop")),
			).toBe(true);
			if (missing) expect(Object.hasOwn(result, "presentation")).toBe(false);
			else
				expect(result.presentation).toEqual({
					version: "portrait-layout-v1",
					videoFit: "AUTO",
					captionPlacement: "OVERLAY",
				});
		}
	});
	it("retains a central candidate only when bound subjects have no valid position", async () => {
		const f = fixture(),
			analysis = structuredClone(f.analysis.document);
		for (const scene of analysis.scenes)
			for (const shot of scene.shots) shot.mainSubjects = [];
		f.analysis.document = analysis;
		f.binding.analysisDocumentHash = hashEditingEvidence(analysis);
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
		expect(doc.clips.flatMap((clip) => clip.cropKeyframes ?? [])).toEqual([]);
	});
	it("retains separate candidates for all canonical variant canvases", async () => {
		const f = fixture();
		Object.assign(f.task.parameters.input.parameters, { variants: 3 });
		f.refreshCurrent();
		await f.run();
		expect(f.projects).toHaveLength(3);
		for (const project of f.projects) {
			const doc = compositionDocumentSchema.parse(project.draft),
				rect = doc.clips.find((clip) => clip.fallbackCrop)?.fallbackCrop;
			expect(rect).toBeDefined();
			if (!rect) throw new Error("Missing retained candidate");
			expect((rect.w * f.media.width) / (rect.h * f.media.height)).toBeCloseTo(
				doc.canvas.width / doc.canvas.height,
				10,
			);
		}
	});
	it.each([
		undefined,
		"AISA_STATIC_V1",
	] as const)("refuses completed result replay whose preserve-source marker becomes %s", async (fallbackFraming) => {
		const f = fixture(),
			result = await f.run();
		f.task.result = {
			...result,
			presentation: { ...presentation, fallbackFraming },
		};
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.runs).toEqual([]);
	});
});
