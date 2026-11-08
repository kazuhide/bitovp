import { describe, expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import {
	moveCompositionClip,
	splitCompositionClip,
	trimCompositionClip,
} from "./composition-mutations";
import { compositionDocumentSchema } from "./composition-schema";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";

function fixture() {
	const f = compositionFixture(),
		clip = f.document.clips[0];
	if (!clip) throw Error("Missing clip");
	f.document.analysisRevisionId = ids.item;
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		fallbackFraming: "AISA_STATIC_V1",
		centerCropConfirmed: true,
	};
	f.document.autoGeneration = {
		policyVersion: "aisa-shot-window-v1",
		requestHash: "a".repeat(64),
		requestedDurationFrames: 90,
		generatedDurationFrames: 90,
		reasonCodes: [],
		binding: {
			schemaVersion: 1,
			kind: "CAPTURED_INPUT",
			organizationId: ids.media,
			sourceId: ids.media,
			locale: "ja",
			analysisRevisionId: ids.item,
			analysisRawHash: "b".repeat(64),
			analysisDocumentHash: "c".repeat(64),
			mediaVersionId: ids.media,
			mediaSha256: "d".repeat(64),
			timeMapId: ids.map,
			timeMapHash: "e".repeat(64),
			sourceStartUs: f.source.timeMap.sourceStartUs,
			sourceEndUs: f.source.timeMap.sourceEndUs,
			width: f.source.width,
			height: f.source.height,
		},
	};
	clip.evidence = { sceneId: ids.other, shotIndex: 2 };
	clip.fallbackCrop = { x: 0.4, y: 0, w: 0.31640625, h: 1 };
	clip.framing = [
		{ fromFrame: 0, toFrame: 10, mode: "FIT", origin: "AUTO_POLICY" },
		{
			fromFrame: 10,
			toFrame: 90,
			mode: "CROP",
			origin: "AUTO_POLICY",
			rect: { x: 0.2, y: 0, w: 0.31640625, h: 1 },
		},
	];
	clip.cropKeyframes = [
		{
			frame: 10,
			rect: { x: 0.2, y: 0, w: 0.31640625, h: 1 },
			easing: "LINEAR",
		},
		{
			frame: 89,
			rect: { x: 0.5, y: 0, w: 0.31640625, h: 1 },
			easing: "SMOOTH",
		},
	];
	return { ...f, clip };
}

describe("static candidate evidence after source-window edits", () => {
	it.each([
		{ label: "later source start", sourceInUs: 1_366_667, durationFrames: 70 },
		{
			label: "earlier source start",
			sourceInUs: 1_000_000,
			durationFrames: 90,
		},
		{ label: "extended source end", sourceInUs: 1_033_334, durationFrames: 91 },
	])("invalidates only the shot reference and confirmation for $label", (range) => {
		const f = fixture(),
			before = structuredClone(f.document),
			result = trimCompositionClip(f.document, ids.clip, range, [f.source]);
		expect(result.clips[0]?.evidence).toEqual({ sceneId: ids.other });
		expect(Object.hasOwn(result.clips[0]?.evidence ?? {}, "shotIndex")).toBe(
			false,
		);
		expect(result.presentation).toEqual({
			...before.presentation,
			centerCropConfirmed: false,
		});
		expect(result.autoGeneration).toEqual(before.autoGeneration);
		expect(result.clips[0]?.fallbackCrop).toEqual(f.clip.fallbackCrop);
		expect(f.document).toEqual(before);
	});

	it("keeps AUTO_POLICY framing parseable and preserves the existing trim pixels and keys", () => {
		const f = fixture(),
			range = { sourceInUs: 1_366_667, durationFrames: 70 },
			legacy = structuredClone(f.document);
		if (!legacy.presentation) throw Error("Missing presentation");
		delete legacy.presentation.fallbackFraming;
		const prior = trimCompositionClip(legacy, ids.clip, range, [f.source]),
			result = trimCompositionClip(f.document, ids.clip, range, [f.source]);
		expect(result.clips[0]?.evidence).toEqual({ sceneId: ids.other });
		expect(result.clips[0]?.framing).toEqual(prior.clips[0]?.framing);
		expect(result.clips[0]?.cropKeyframes).toEqual(
			prior.clips[0]?.cropKeyframes,
		);
		expect(result.clips[0]?.framing[0]?.origin).toBe("AUTO_POLICY");
		expect(compositionDocumentSchema.safeParse(result).success).toBe(true);
		const before = compileComposition(prior, [f.source], {
			allowUnconfirmed: true,
		});
		const after = compileComposition(result, [f.source], {
			allowUnconfirmed: true,
		});
		for (let frame = 0; frame < after.durationFrames; frame++)
			expect(evaluateCompositionFrame(after, frame)).toEqual(
				evaluateCompositionFrame(before, frame),
			);
	});

	it("retains evidence and confirmation when a microsecond change stays inside the same CFR source window", () => {
		const f = fixture(),
			result = trimCompositionClip(
				f.document,
				ids.clip,
				{ sourceInUs: 1_033_335, durationFrames: 90 },
				[f.source],
			),
			before = compileComposition(f.document, [f.source], {
				allowUnconfirmed: true,
			}),
			after = compileComposition(result, [f.source], {
				allowUnconfirmed: true,
			});
		expect(result.clips[0]?.sourceInUs).toBe(1_033_335);
		expect(before.clips[0]?.sourceFromFrame).toBe(91);
		expect(after.clips[0]?.sourceFromFrame).toBe(91);
		for (let frame = 0; frame < 90; frame++)
			expect(evaluateCompositionFrame(after, frame)).toEqual(
				evaluateCompositionFrame(before, frame),
			);
		expect(result.clips[0]?.evidence).toEqual(f.clip.evidence);
		expect(result.presentation).toEqual(f.document.presentation);
	});

	it.each([
		60, 90,
	])("retains the shot reference and confirmation for an unchanged source start with %i frames", (durationFrames) => {
		const f = fixture(),
			result = trimCompositionClip(
				f.document,
				ids.clip,
				{ sourceInUs: f.clip.sourceInUs, durationFrames },
				[f.source],
			);
		expect(result.clips[0]?.evidence).toEqual(f.clip.evidence);
		expect(result.presentation).toEqual(f.document.presentation);
	});

	it("retains the source reference on timeline moves and both halves of an in-range split", () => {
		const f = fixture(),
			moved = moveCompositionClip(f.document, ids.clip, {
				timelineStartFrame: 30,
			}),
			split = splitCompositionClip(f.document, ids.clip, 30, ids.other, [
				f.source,
			]);
		expect(moved.clips[0]?.evidence).toEqual(f.clip.evidence);
		expect(moved.presentation).toEqual(f.document.presentation);
		expect(split.clips.map((clip) => clip.evidence)).toEqual([
			f.clip.evidence,
			f.clip.evidence,
		]);
		expect(split.presentation).toEqual(f.document.presentation);
	});

	it("preserves invalidation across JSON save/reload and another trim", () => {
		const f = fixture(),
			changed = trimCompositionClip(
				f.document,
				ids.clip,
				{ sourceInUs: 1_366_667, durationFrames: 70 },
				[f.source],
			),
			reloaded = compositionDocumentSchema.parse(
				JSON.parse(JSON.stringify(changed)),
			),
			trimmed = trimCompositionClip(
				reloaded,
				ids.clip,
				{ sourceInUs: 1_033_334, durationFrames: 60 },
				[f.source],
			);
		expect(reloaded.clips[0]?.evidence).toEqual({ sceneId: ids.other });
		expect(reloaded.presentation?.centerCropConfirmed).toBe(false);
		expect(trimmed.clips[0]?.evidence).toEqual({ sceneId: ids.other });
		expect(trimmed.autoGeneration).toEqual(f.document.autoGeneration);
	});

	it.each([
		"legacy-presentation",
		"missing-presentation",
	])("leaves %s documents unchanged by the new evidence policy", (kind) => {
		const f = fixture();
		if (!f.document.presentation) throw Error("Missing presentation");
		if (kind === "missing-presentation") delete f.document.presentation;
		else delete f.document.presentation.fallbackFraming;
		const result = trimCompositionClip(
			f.document,
			ids.clip,
			{ sourceInUs: 1_366_667, durationFrames: 70 },
			[f.source],
		);
		expect(result.clips[0]?.evidence).toEqual(f.clip.evidence);
		expect(result.presentation).toEqual(f.document.presentation);
		expect(Object.hasOwn(result, "presentation")).toBe(
			Object.hasOwn(f.document, "presentation"),
		);
	});
});
