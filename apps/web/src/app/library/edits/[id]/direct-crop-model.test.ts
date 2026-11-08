import {
	type CompositionDocument,
	type CompositionSourceFacts,
	compileComposition,
	compositionSubjectProtectionContext,
	createCompositionSubjectProtection,
	evaluateCompositionFrame,
	interpolateCompositionCrop,
	localStoryEvidenceSchema,
	type NormalizedCropRect,
	normalizeManualSubjectProtectionEdits,
	resolvePresentedCompositionGeometry,
	suggestFixedCrop,
	toCompositionDocument,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { editingProjectFixture } from "../editing-fixtures";
import {
	applyDirectCrop,
	describeDirectCrop,
	describeDirectCropFromPlan,
} from "./direct-crop-model";

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null)
		throw new Error("Missing required test fixture");
	return value;
}
function fixture(width = 1920, height = 1080) {
	const project = editingProjectFixture();
	if (!project.media.timeMap) throw new Error("Missing source map");
	const document = toCompositionDocument(project.draft);
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		centerCropConfirmed: true,
		fallbackFraming: "AISA_STATIC_V1",
	};
	const source: CompositionSourceFacts = {
		mediaVersionId: document.mediaVersionId,
		timeMap: project.media.timeMap,
		width,
		height,
		hasAudio: true,
	};
	return {
		document,
		source,
		sources: [source],
		clipId: required(document.clips[0]).id,
	};
}
function crop(source: CompositionSourceFacts, x = 0.5, zoom = 1.6, y = 0.5) {
	return suggestFixedCrop({
		sourceWidth: source.width,
		sourceHeight: source.height,
		targetWidth: 1080,
		targetHeight: 1920,
		centerX: x,
		centerY: y,
		zoom,
	});
}
function animated(
	document: CompositionDocument,
	source: CompositionSourceFacts,
) {
	const clip = required(document.clips[0]);
	document.analysisRevisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	clip.evidence = {
		sceneId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		shotIndex: 4,
	};
	const first = crop(source, 0.36, 1.6);
	const last = crop(source, 0.62, 2);
	clip.framing = [
		{ fromFrame: 0, toFrame: 60, mode: "FIT", origin: "MANUAL" },
		{
			fromFrame: 60,
			toFrame: 220,
			mode: "CROP",
			origin: "EDITOR_CONFIRMED",
			rect: first,
		},
		{ fromFrame: 220, toFrame: 300, mode: "FIT", origin: "MANUAL" },
	];
	clip.cropKeyframes = [
		{
			frame: 60,
			rect: first,
			easing: "SMOOTH",
			curveStart: 0.15,
			curveEnd: 0.82,
		},
		{ frame: 180, rect: last, easing: "LINEAR" },
	];
	clip.fallbackCrop = crop(source, 0.51, 1.2);
}

function subjectProtectedFixture(placement: "OVERLAY" | "BANDS") {
	const f = fixture();
	const clip = required(f.document.clips[0]);
	const analysis = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	f.document.analysisRevisionId = analysis;
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: placement,
		fallbackFraming: "PRESERVE_SOURCE_V1",
	};
	f.document.autoGeneration = {
		policyVersion: "aisa-local-story-window-v1",
		requestHash: "a".repeat(64),
		requestedDurationFrames: 300,
		generatedDurationFrames: 300,
		reasonCodes: [],
		renderMode: "DRAFT",
		binding: {
			schemaVersion: 1,
			kind: "CAPTURED_INPUT",
			organizationId: analysis,
			sourceId: analysis,
			locale: "en",
			analysisRevisionId: analysis,
			analysisRawHash: "b".repeat(64),
			analysisDocumentHash: "c".repeat(64),
			mediaVersionId: f.document.mediaVersionId,
			mediaSha256: "d".repeat(64),
			timeMapId: f.document.timeMapId,
			timeMapHash: "e".repeat(64),
			sourceStartUs: 0,
			sourceEndUs: 60_000_000,
			width: 1920,
			height: 1080,
		},
		localStoryEvidence: localStoryEvidenceSchema.parse({
			version: "local-story-evidence-v1",
			method: "LOCAL_LLM_BEAT_PLAN",
			model: {
				version: "local-story-model-v1",
				provider: "LOCAL_OLLAMA",
				profile: "nvidia",
				model: "authored-test-model",
				modelDigest: "a".repeat(64),
				runtimeVersion: "0.40.14",
				promptVersion: "local-story-v1",
				schemaHash: "b".repeat(64),
				configId: analysis,
				context: 8192,
				thinking: false,
			},
			inputHash: "a".repeat(64),
			artifactHash: "a".repeat(64),
			ledgerHash: "a".repeat(64),
			blueprintHash: "a".repeat(64),
			ledger: {
				version: "local-story-corpus-v1",
				summaries: ["An object moves"],
				coveredRefs: ["s0"],
				events: [
					{
						id: "event",
						label: "An object moves",
						role: "ACTION",
						refs: ["s0"],
						quotes: [{ ref: "s0", quote: "An object moves" }],
						subjects: ["robot"],
						uncertainty: "",
					},
				],
			},
			blueprint: {
				mode: "FLOW",
				message: "An object moves",
				beats: [
					{ id: "beat", role: "ACTION", eventIds: ["event"], requires: [] },
				],
				uncertainty: "",
			},
			selection: {
				selectedBeatIds: ["beat"],
				selectedEventIds: ["event"],
				reason: "COMPLETE_BEATS",
			},
			inputCoverage: {
				totalShots: 1,
				eligibleShots: 1,
				processedShots: 1,
				excludedShots: 0,
				truncated: false,
			},
		}),
	};
	clip.evidence = { sceneId: analysis, shotIndex: 0 };
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: 180,
			mode: "CROP",
			origin: "AUTO_POLICY",
			rect: crop(f.source, 0.5, 1),
		},
		{ fromFrame: 180, toFrame: 300, mode: "FIT", origin: "AUTO_POLICY" },
	];
	const context = required(
		compositionSubjectProtectionContext(f.document, clip),
	);
	const box = { x: 0.45, y: 0.3, w: 0.08, h: 0.3 };
	clip.subjectProtection = createCompositionSubjectProtection({
		context,
		seedSourceTimeUs: 0,
		target: {
			ref: "s0",
			sceneId: analysis,
			shotIndex: 0,
			targetId: `target-${"a".repeat(64)}`,
			eventIds: ["event"],
			subjectLabels: ["robot"],
			subjectIndexes: [0],
			analysisDocumentHash: context.analysisDocumentHash,
			timeMapHash: context.timeMapHash,
			protectedBoxes: [box],
			decision: "CROP",
			reason: "STORY_SUBJECT_MATCHED",
		},
		samples: [
			0, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000, 5_966_667,
		].map((sourceTimeUs) => ({ sourceTimeUs, box, confidence: 0.99 })),
	});
	return f;
}
function view(
	document: CompositionDocument,
	sources: CompositionSourceFacts[],
	frame = 110,
	clipId = required(document.clips[0]).id,
) {
	const result = describeDirectCrop(document, sources, clipId, frame);
	if (!result) throw new Error("Expected active source view");
	return result;
}
function changed(rect: NormalizedCropRect, dx: number, dy = 0, scale = 1) {
	const w = rect.w * scale;
	const h = rect.h * scale;
	return {
		x: rect.x + rect.w / 2 + dx - w / 2,
		y: rect.y + rect.h / 2 + dy - h / 2,
		w,
		h,
	};
}
describe("direct crop model", () => {
	it.each([
		"OVERLAY",
		"BANDS",
	] as const)("keeps a native or adopted AUTO crop editable through drag, resize and save, retaining LOST FIT (%s)", (placement) => {
		for (const alreadyAdopted of [false, true]) {
			const f = subjectProtectedFixture(placement);
			const document = alreadyAdopted
				? normalizeManualSubjectProtectionEdits(f.document, f.document)
				: f.document;
			const before = view(document, f.sources);
			expect(before.editable).toBe(true);
			const moved = applyDirectCrop(
				document,
				f.sources,
				f.clipId,
				110,
				changed(before.rect, 0.02, 0, 0.8),
			);
			expect(moved).not.toBe(document);
			expect(required(moved.clips[0]).subjectProtection).toBeUndefined();
			expect(
				required(moved.clips[0]).subjectPresentationAdoption,
			).toBeDefined();
			expect(required(moved.clips[0]).videoFit).toBeUndefined();
			const preview = view(moved, f.sources);
			expect(preview.mode).toBe("CROP");
			expect(preview.rect).not.toEqual(before.rect);
			const saved = normalizeManualSubjectProtectionEdits(document, moved);
			expect(view(saved, f.sources).rect).toEqual(preview.rect);
			for (const result of [moved, saved])
				expect(view(result, f.sources, 250)).toMatchObject({
					mode: "FIT",
					editable: false,
					rect: { x: 0, y: 0, w: 1, h: 1 },
				});
		}
	});
	it("describes the exact selected source frame and rounded export rectangle from an existing plan", () => {
		const { document, source, sources, clipId } = fixture(1600, 714);
		const clip = required(document.clips[0]);
		clip.sourceInUs = 2000000;
		clip.timelineStartFrame = 40;
		source.timeMap.sourceStartUs = 1000000;
		source.timeMap.sourceEndUs = 61000000;
		source.timeMap.editingStartFrame = 90;
		source.timeMap.editingEndFrame = 1890;
		clip.fallbackCrop = crop(source, 0.42, 1.2);
		const plan = compileComposition(document, sources, {
			allowUnconfirmed: true,
		});
		const layer = required(evaluateCompositionFrame(plan, 55).layers[0]);
		const described = describeDirectCropFromPlan(plan, clipId, 55);
		expect(described).toMatchObject({
			clipId,
			mediaVersionId: source.mediaVersionId,
			sourceFrame: 135,
			outputFrame: 55,
			localFrame: 15,
			sourceWidth: 1600,
			sourceHeight: 714,
			mode: "CROP",
			editable: true,
			rect: {
				x: layer.sourceRect.x / 1600,
				y: layer.sourceRect.y / 714,
				w: layer.sourceRect.w / 1600,
				h: layer.sourceRect.h / 714,
			},
		});
		expect(describeDirectCrop(document, sources, clipId, 55)).toEqual(
			described,
		);
		expect(describeDirectCropFromPlan(plan, clipId, 39)).toBeNull();
		expect(describeDirectCropFromPlan(plan, "other", 55)).toBeNull();
		expect(describeDirectCropFromPlan(plan, clipId, 55.5)).toBeNull();
	});
	it.each([
		"FIT",
		"AUTO",
	] as const)("shows %s full source read-only without inventing a crop", (fit) => {
		const { document, sources, clipId } = fixture();
		required(document.presentation).videoFit = fit;
		const current = view(document, sources);
		expect(current).toMatchObject({
			editable: false,
			mode: "FIT",
			rect: { x: 0, y: 0, w: 1, h: 1 },
		});
		expect(
			applyDirectCrop(document, sources, clipId, 110, {
				x: 0.2,
				y: 0.2,
				w: 0.3,
				h: 0.5,
			}),
		).toBe(document);
	});
	it("fails closed for inactive clips, invalid clocks, or mismatched source bindings", () => {
		const { document, sources, clipId } = fixture();
		const rect = { x: 0.2, y: 0.2, w: 0.3, h: 0.5 };
		expect(describeDirectCrop(document, sources, clipId, 300)).toBeNull();
		expect(describeDirectCrop(document, sources, clipId, -1)).toBeNull();
		const wrong = [
			{
				...required(sources[0]),
				timeMap: {
					...required(sources[0]).timeMap,
					id: "99999999-9999-4999-8999-999999999999",
				},
			},
		];
		expect(describeDirectCrop(document, wrong, clipId, 110)).toBeNull();
		expect(applyDirectCrop(document, wrong, clipId, 110, rect)).toBe(document);
		expect(applyDirectCrop(document, sources, "other", 110, rect)).toBe(
			document,
		);
	});
	it("edits raw FIT only through fallbackCrop and preserves measured keys, CROP frames, evidence, and all clocks", () => {
		const { document, source, sources, clipId } = fixture();
		animated(document, source);
		const before = structuredClone(document);
		const current = view(document, sources, 20);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			20,
			changed(current.rect, 0.03),
		);
		expect(next).not.toBe(document);
		expect(document).toEqual(before);
		const expected = structuredClone(before);
		required(expected.clips[0]).fallbackCrop = required(
			next.clips[0],
		).fallbackCrop;
		required(expected.presentation).centerCropConfirmed = false;
		expect(next).toEqual(expected);
		expect(required(next.clips[0]).fallbackCrop).not.toEqual(
			required(before.clips[0]).fallbackCrop,
		);
		for (const frame of [60, 91, 110, 179, 219])
			expect(view(next, sources, frame).rect).toEqual(
				view(before, sources, frame).rect,
			);
		expect(view(next, sources, 20).rect.x).toBeCloseTo(
			current.rect.x + 0.03,
			3,
		);
		expect(
			compileComposition(JSON.parse(JSON.stringify(next)), sources),
		).toBeDefined();
	});
	it("transforms all existing CROP rectangles and keys uniformly without inserting keys or changing easing subcurves", () => {
		const { document, source, sources, clipId } = fixture();
		animated(document, source);
		const before = structuredClone(document);
		const current = view(document, sources);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			110,
			changed(current.rect, 0.025, 0.02, 0.8),
		);
		const original = required(before.clips[0]);
		const edited = required(next.clips[0]);
		expect(edited.cropKeyframes).toHaveLength(2);
		for (let i = 0; i < required(original.cropKeyframes).length; i++) {
			const old = required(required(original.cropKeyframes)[i]);
			const key = required(required(edited.cropKeyframes)[i]);
			expect({ ...key, rect: old.rect }).toEqual(old);
			expect(key.rect.w / old.rect.w).toBeCloseTo(0.8, 10);
			expect(key.rect.h / old.rect.h).toBeCloseTo(0.8, 10);
			expect(
				key.rect.x + key.rect.w / 2 - old.rect.x - old.rect.w / 2,
			).toBeCloseTo(0.025, 10);
			expect(
				key.rect.y + key.rect.h / 2 - old.rect.y - old.rect.h / 2,
			).toBeCloseTo(0.02, 10);
		}
		expect(
			edited.framing.map(({ fromFrame, toFrame, mode }) => ({
				fromFrame,
				toFrame,
				mode,
			})),
		).toEqual(
			original.framing.map(({ fromFrame, toFrame, mode }) => ({
				fromFrame,
				toFrame,
				mode,
			})),
		);
		expect(edited.framing[0]).toEqual(original.framing[0]);
		expect(edited.framing[2]).toEqual(original.framing[2]);
		expect(edited.framing[1]).toMatchObject({
			mode: "CROP",
			origin: "MANUAL",
			manualOverride: true,
		});
		expect(edited.fallbackCrop).toEqual(original.fallbackCrop);
		for (const frame of [60, 75, 110, 150, 180, 219]) {
			const old = interpolateCompositionCrop(
				required(original.cropKeyframes),
				frame,
				required(required(original.cropKeyframes)[0]).rect,
			);
			const actual = interpolateCompositionCrop(
				required(edited.cropKeyframes),
				frame,
				required(required(edited.cropKeyframes)[0]).rect,
			);
			const expected = changed(old, 0.025, 0.02, 0.8);
			for (const field of ["x", "y", "w", "h"] as const)
				expect(actual[field]).toBeCloseTo(expected[field], 10);
		}
		expect(view(next, sources, 20).rect).toEqual(
			view(before, sources, 20).rect,
		);
		expect(view(next, sources, 250).rect).toEqual(
			view(before, sources, 250).rect,
		);
		expect(document).toEqual(before);
		expect(view(JSON.parse(JSON.stringify(next)), sources).rect).toEqual(
			view(next, sources).rect,
		);
	});
	it("clamps the shared pan against every key rather than flattening individual tracking positions", () => {
		const { document, source, sources, clipId } = fixture();
		animated(document, source);
		const clip = required(document.clips[0]);
		required(required(clip.cropKeyframes)[1]).rect = crop(source, 1, 2);
		const before = structuredClone(document);
		const current = view(document, sources);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			110,
			changed(current.rect, 0.06, 0, 0.8),
		);
		const oldKeys = required(required(before.clips[0]).cropKeyframes);
		const keys = required(required(next.clips[0]).cropKeyframes);
		const deltas = keys.map(
			(key, index) =>
				key.rect.x +
				key.rect.w / 2 -
				required(oldKeys[index]).rect.x -
				required(oldKeys[index]).rect.w / 2,
		);
		expect(deltas[0]).toBeCloseTo(required(deltas[1]), 10);
		expect(deltas[0]).toBeGreaterThan(0);
		expect(deltas[0]).toBeLessThan(0.06);
		expect(required(keys[1]).rect.x + required(keys[1]).rect.w).toBeCloseTo(
			1,
			10,
		);
		for (const key of keys)
			expect(
				key.rect.w / required(oldKeys[keys.indexOf(key)]).rect.w,
			).toBeCloseTo(0.8, 10);
	});
	it("limits shared zoom-out when distant measured endpoints would otherwise require different pans", () => {
		const { document, sources, clipId } = fixture();
		const first = {
			x: 0.05,
			y: 0.5 - 0.632098765432 / 2,
			w: 0.2,
			h: 0.632098765432,
		};
		const last = { ...first, x: 0.75 };
		const clip = required(document.clips[0]);
		clip.framing = [
			{
				fromFrame: 0,
				toFrame: 300,
				mode: "CROP",
				origin: "MANUAL",
				rect: first,
			},
		];
		clip.cropKeyframes = [
			{ frame: 0, rect: first, easing: "LINEAR" },
			{ frame: 299, rect: last, easing: "SMOOTH" },
		];
		const current = view(document, sources, 150);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			150,
			changed(current.rect, 0, 0, 1.55),
		);
		const keys = required(required(next.clips[0]).cropKeyframes);
		expect(required(keys[0]).rect.w / first.w).toBeCloseTo(1.5, 9);
		expect(required(keys[1]).rect.w / last.w).toBeCloseTo(1.5, 9);
		expect(required(keys[0]).rect.x).toBe(0);
		expect(required(keys[1]).rect.x + required(keys[1]).rect.w).toBeCloseTo(
			1,
			10,
		);
	});
	it("does not create a history change for zero, source-pixel-equivalent, or fully blocked pan", () => {
		const { document, source, sources, clipId } = fixture();
		animated(document, source);
		const current = view(document, sources);
		expect(applyDirectCrop(document, sources, clipId, 110, current.rect)).toBe(
			document,
		);
		expect(
			applyDirectCrop(
				document,
				sources,
				clipId,
				110,
				changed(current.rect, 0.000001),
			),
		).toBe(document);
		required(required(required(document.clips[0]).cropKeyframes)[1]).rect =
			crop(source, 1, 2);
		const blocked = view(document, sources);
		expect(
			applyDirectCrop(
				document,
				sources,
				clipId,
				110,
				changed(blocked.rect, 0.03),
			),
		).toBe(document);
	});
	it.each([
		[1600, 714],
		[1920, 614],
		[1080, 1920],
		[1080, 1080],
	] as const)("roundtrips actual BANDS crop and edge bounds on source %ix%i", (width, height) => {
		const { document, source, sources, clipId } = fixture(width, height);
		required(document.presentation).captionPlacement = "BANDS";
		required(document.clips[0]).fallbackCrop = crop(source, 0.5, 1.6);
		const current = view(document, sources);
		const desired = changed(current.rect, 0.015, 0.01, 0.8);
		const next = applyDirectCrop(document, sources, clipId, 110, desired);
		expect(next).not.toBe(document);
		const actual = view(next, sources);
		for (const field of ["x", "y", "w", "h"] as const)
			expect(Math.abs(actual.rect[field] - desired[field])).toBeLessThanOrEqual(
				1 / (field === "x" || field === "w" ? width : height) + 1e-12,
			);
		const saved = JSON.parse(JSON.stringify(next));
		expect(view(saved, sources).rect).toEqual(actual.rect);
		const canonical = required(saved.clips[0]).fallbackCrop;
		expect((canonical.w * width) / (canonical.h * height)).toBeCloseTo(
			1080 / 1920,
			8,
		);
		const edge = { ...actual.rect, x: 1 - actual.rect.w, y: 1 - actual.rect.h };
		const edgeDoc = applyDirectCrop(next, sources, clipId, 110, edge);
		const edgeView = view(edgeDoc, sources).rect;
		expect(edgeView.x + edgeView.w).toBeLessThanOrEqual(1);
		expect(edgeView.y + edgeView.h).toBeLessThanOrEqual(1);
		const plan = compileComposition(edgeDoc, sources, {
			allowUnconfirmed: true,
		});
		const full = required(evaluateCompositionFrame(plan, 110).layers[0]);
		const preview = required(
			evaluateCompositionFrame(plan, 110, {
				width: 360,
				height: 640,
			}).layers[0],
		);
		expect(preview.sourceRect).toEqual(full.sourceRect);
	});
	it("keeps actual BANDS clamp behavior instead of storing its shorter window as a canonical portrait crop", () => {
		const { document, source, sources, clipId } = fixture(1080, 1920);
		required(document.presentation).captionPlacement = "BANDS";
		required(document.clips[0]).fallbackCrop = crop(source, 0.5, 1);
		const current = view(document, sources);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			110,
			changed(current.rect, 0, 0.05),
		);
		expect(next).toBe(document);
		expect(required(document.clips[0]).fallbackCrop).toEqual({
			x: 0,
			y: 0,
			w: 1,
			h: 1,
		});
	});
	it("limits BANDS resize in canonical zoom space so removing bands cannot reveal hidden excessive magnification", () => {
		const { document, source, sources, clipId } = fixture(1600, 714);
		required(document.presentation).captionPlacement = "BANDS";
		required(document.clips[0]).fallbackCrop = crop(source, 0.5, 1.6);
		const current = view(document, sources);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			110,
			changed(current.rect, 0, 0, 0.01),
		);
		expect(next).not.toBe(document);
		const canonical = required(required(next.clips[0]).fallbackCrop);
		const maximum = crop(source, 0.5, 1);
		expect(maximum.w / canonical.w).toBeCloseTo(3, 9);
		expect(maximum.h / canonical.h).toBeCloseTo(3, 9);
		required(next.presentation).captionPlacement = "OVERLAY";
		expect(view(next, sources).rect.w).toBeCloseTo(canonical.w, 3);
	});
	it("adjusts a non-key SMOOTH frame through BANDS while preserving all tracking clocks and untouched FIT windows", () => {
		const { document, source, sources, clipId } = fixture(1600, 714);
		animated(document, source);
		required(document.presentation).captionPlacement = "BANDS";
		const before = structuredClone(document);
		const current = view(document, sources);
		const desired = changed(current.rect, 0.01, 0.01, 0.8);
		const next = applyDirectCrop(document, sources, clipId, 110, desired);
		const actual = view(next, sources);
		for (const field of ["x", "y", "w", "h"] as const)
			expect(Math.abs(actual.rect[field] - desired[field])).toBeLessThanOrEqual(
				1 / (field === "x" || field === "w" ? source.width : source.height) +
					1e-12,
			);
		const oldKeys = required(required(before.clips[0]).cropKeyframes);
		const newKeys = required(required(next.clips[0]).cropKeyframes);
		expect(newKeys.map(({ rect: _rect, ...rest }) => rest)).toEqual(
			oldKeys.map(({ rect: _rect, ...rest }) => rest),
		);
		const shifts = newKeys.map(
			(key, index) =>
				key.rect.x +
				key.rect.w / 2 -
				required(oldKeys[index]).rect.x -
				required(oldKeys[index]).rect.w / 2,
		);
		expect(shifts[0]).toBeCloseTo(required(shifts[1]), 10);
		for (const frame of [0, 30, 220, 299])
			expect(view(next, sources, frame).rect).toEqual(
				view(before, sources, frame).rect,
			);
		expect(required(next.clips[0]).evidence).toEqual(
			required(before.clips[0]).evidence,
		);
	});
	it("creates a canonical fixed fallback from the existing centre without adding measurement or presentation evidence", () => {
		const { document, sources, clipId } = fixture();
		const before = structuredClone(document);
		const current = view(document, sources);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			110,
			changed(current.rect, 0.02, 0, 0.8),
		);
		expect(required(next.clips[0]).fallbackCrop).toBeDefined();
		expect(Object.hasOwn(required(next.clips[0]), "cropKeyframes")).toBe(false);
		expect(required(next.clips[0]).framing).toEqual(
			required(before.clips[0]).framing,
		);
		expect(required(next.presentation).fallbackFraming).toBe(
			required(before.presentation).fallbackFraming,
		);
		expect(Object.hasOwn(required(next.clips[0]), "evidence")).toBe(false);
	});
	it("honours explicit FIT over a measured CROP and permits explicit FILL over document AUTO", () => {
		const { document, source, sources, clipId } = fixture();
		animated(document, source);
		required(document.clips[0]).videoFit = "FIT";
		const fit = view(document, sources);
		expect(fit).toMatchObject({ editable: false, mode: "FIT" });
		expect(applyDirectCrop(document, sources, clipId, 110, crop(source))).toBe(
			document,
		);
		required(document.presentation).videoFit = "AUTO";
		required(document.clips[0]).videoFit = "FILL";
		const fill = view(document, sources, 20);
		expect(fill.editable).toBe(true);
		expect(
			applyDirectCrop(document, sources, clipId, 20, changed(fill.rect, 0.02)),
		).not.toBe(document);
	});
	it("supports actual CROP under AUTO and custom/PIP layouts while rejecting raw FIT whose fallback is not used", () => {
		const { document, source, sources, clipId } = fixture();
		animated(document, source);
		required(document.presentation).videoFit = "AUTO";
		expect(view(document, sources).editable).toBe(true);
		required(document.clips[0]).layout = { x: 0.55, y: 0.05, w: 0.4, h: 0.3 };
		required(document.clips[0]).videoFit = "FILL";
		const current = view(document, sources);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			110,
			changed(current.rect, 0.02, 0, 0.8),
		);
		expect(view(next, sources).editable).toBe(true);
		expect(view(next, sources).rect.w).toBeCloseTo(current.rect.w * 0.8, 3);
		expect(required(next.clips[0]).layout).toEqual(
			required(document.clips[0]).layout,
		);
		expect(view(document, sources, 20).editable).toBe(false);
		expect(applyDirectCrop(document, sources, clipId, 20, crop(source))).toBe(
			document,
		);
	});
	it("uses the selected secondary source during a crossfade and preserves other clips, evidence, audio, captions and overlays", () => {
		const { document, source, sources } = fixture();
		animated(document, source);
		const secondId = "99999999-9999-4999-8999-999999999999";
		const second: CompositionSourceFacts = {
			...source,
			mediaVersionId: secondId,
			width: 1600,
			height: 714,
			timeMap: { ...source.timeMap, id: secondId, mediaVersionId: secondId },
		};
		document.sources = [
			{
				mediaVersionId: secondId,
				timeMapId: secondId,
				analysisRevisionId: null,
			},
		];
		const clip = {
			...structuredClone(required(document.clips[0])),
			id: "88888888-8888-4888-8888-888888888888",
			mediaVersionId: secondId,
			timelineStartFrame: 285,
			sourceInUs: 3000000,
			transitionIn: { type: "CROSSFADE" as const, durationFrames: 15 },
		};
		clip.framing = [
			{
				fromFrame: 0,
				toFrame: 300,
				mode: "CROP",
				origin: "MANUAL",
				rect: crop(second),
			},
		];
		delete clip.cropKeyframes;
		delete clip.evidence;
		document.clips.push(clip);
		document.captions = [
			{
				id: "77777777-7777-4777-8777-777777777777",
				fromFrame: 1,
				toFrame: 60,
				text: "untouched",
				anchorClipId: required(document.clips[0]).id,
			},
		];
		document.overlays = [
			{
				id: "66666666-6666-4666-8666-666666666666",
				fromFrame: 1,
				toFrame: 60,
				rect: { x: 0, y: 0, w: 0.5, h: 0.1 },
				opacity: 1,
				zIndex: 1,
				kind: "TEXT",
				text: "untouched",
			},
		];
		const all = [...sources, second];
		const before = structuredClone(document);
		expect(
			evaluateCompositionFrame(compileComposition(document, all), 290).layers,
		).toHaveLength(2);
		const current = view(document, all, 290, clip.id);
		expect(current).toMatchObject({
			mediaVersionId: secondId,
			sourceFrame: 95,
			sourceWidth: 1600,
			sourceHeight: 714,
		});
		const next = applyDirectCrop(
			document,
			all,
			clip.id,
			290,
			changed(current.rect, 0.02, 0.01, 0.8),
		);
		const expected = structuredClone(before);
		required(expected.clips[1]).framing = required(next.clips[1]).framing;
		required(expected.presentation).centerCropConfirmed = false;
		expect(next).toEqual(expected);
		expect(document).toEqual(before);
	});
	it("retains legacy presentation absence and rejects malformed gesture rectangles", () => {
		const { document, source, sources, clipId } = fixture();
		animated(document, source);
		delete document.presentation;
		const current = view(document, sources);
		const next = applyDirectCrop(
			document,
			sources,
			clipId,
			110,
			changed(current.rect, 0.02),
		);
		expect(next).not.toBe(document);
		expect(Object.hasOwn(next, "presentation")).toBe(false);
		for (const rect of [
			{ ...current.rect, x: Number.NaN },
			{ ...current.rect, w: 0 },
			{ ...current.rect, x: -1 },
		])
			expect(applyDirectCrop(document, sources, clipId, 110, rect)).toBe(
				document,
			);
	});
	it("uses the shared presentation resolver for the crop shown in BANDS", () => {
		const { document, source, sources } = fixture(1600, 714);
		animated(document, source);
		required(document.presentation).captionPlacement = "BANDS";
		const actual = view(document, sources);
		const geometry = resolvePresentedCompositionGeometry({
			document,
			clip: required(document.clips[0]),
			sourceWidth: source.width,
			sourceHeight: source.height,
			width: document.canvas.width,
			height: document.canvas.height,
			frame: 110,
		});
		expect(actual.rect).toEqual({
			x: geometry.sourceRect.x / source.width,
			y: geometry.sourceRect.y / source.height,
			w: geometry.sourceRect.w / source.width,
			h: geometry.sourceRect.h / source.height,
		});
	});
});
