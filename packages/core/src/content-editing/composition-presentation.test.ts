import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import { resolveCompositionGeometry } from "./composition-geometry";
import {
	compositionHasUnconfirmedFraming,
	compositionUsesMainPresentation,
	confirmCompositionFraming,
	setCompositionPresentation,
} from "./composition-presentation";
import {
	type CompositionClip,
	compositionDocumentSchema,
	compositionPresentationSchema,
} from "./composition-schema";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";
import { suggestFixedCrop } from "./framing";
import { localStoryEvidenceSchema } from "./local-story-contracts";
import { editingDocumentSchema } from "./schema";
import {
	compositionSubjectProtectionContext,
	createCompositionSubjectProtection,
} from "./subject-protection";
import { normalizeManualSubjectProtectionEdits } from "./subject-protection-adoption";

function fixtureItem<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture");
	return value;
}

function automaticFixture() {
	const f = compositionFixture();
	f.document.analysisRevisionId = ids.other;
	f.document.autoGeneration = {
		policyVersion: "aisa-shot-window-v1",
		requestHash: "a".repeat(64),
		requestedDurationFrames: 90,
		generatedDurationFrames: 90,
		reasonCodes: [],
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: ids.item,
			sourceId: ids.otherMap,
			locale: f.document.locale,
			analysisRevisionId: ids.other,
			analysisRawHash: "b".repeat(64),
			analysisDocumentHash: "c".repeat(64),
			mediaVersionId: f.document.mediaVersionId,
			mediaSha256: "d".repeat(64),
			timeMapId: f.document.timeMapId,
			timeMapHash: "e".repeat(64),
			sourceStartUs: f.source.timeMap.sourceStartUs,
			sourceEndUs: f.source.timeMap.sourceEndUs,
			width: f.source.width,
			height: f.source.height,
		},
	};
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		centerCropConfirmed: false,
	};
	return f;
}

function protectedFixture() {
	const f = automaticFixture(),
		generation = fixtureItem(f.document.autoGeneration),
		clip = fixtureItem(f.document.clips[0]);
	generation.binding.kind = "CAPTURED_INPUT";
	generation.policyVersion = "aisa-local-story-window-v1";
	generation.renderMode = "DRAFT";
	generation.localStoryEvidence = localStoryEvidenceSchema.parse({
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
			configId: ids.item,
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
	});
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
		fallbackFraming: "PRESERVE_SOURCE_V1",
	};
	const rect = suggestFixedCrop({
		sourceWidth: 1920,
		sourceHeight: 1080,
		targetWidth: 1080,
		targetHeight: 1920,
		centerX: 0.5,
		centerY: 0.5,
	});
	clip.evidence = { sceneId: ids.other, shotIndex: 0 };
	clip.framing = [
		{ fromFrame: 0, toFrame: 21, mode: "CROP", rect, origin: "AUTO_POLICY" },
		{ fromFrame: 21, toFrame: 90, mode: "FIT", origin: "AUTO_POLICY" },
	];
	const context = compositionSubjectProtectionContext(f.document, clip);
	if (!context) throw new Error("Missing authored protection context");
	const box = { x: 0.45, y: 0.3, w: 0.08, h: 0.3 };
	clip.subjectProtection = createCompositionSubjectProtection({
		context,
		target: {
			ref: "s0",
			sceneId: ids.other,
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
		seedSourceTimeUs: clip.sourceInUs,
		samples: [1_033_334, 1_366_667, 1_700_000].map((sourceTimeUs) => ({
			sourceTimeUs,
			box,
			confidence: 0.99,
		})),
	});
	return f;
}

it("uses AUTO vertical crops only inside current source-bound protected observations and keeps lost frames FIT", () => {
	const f = protectedFixture(),
		clip = fixtureItem(f.document.clips[0]);
	const frame = (at: number) =>
		fixtureItem(
			evaluateCompositionFrame(compileComposition(f.document, [f.source]), at)
				.layers[0],
		);
	expect(frame(5).sourceRect.w).toBeLessThan(1920);
	expect(frame(25).sourceRect.w).toBe(1920);
	expect(frame(25).backdrop?.kind).toBe("BLUR");
	clip.framing = clip.framing.map((part) => ({ ...part, origin: "MANUAL" }));
	expect(frame(5).sourceRect.w).toBe(1920);
});

it.each([
	"OVERLAY",
	"BANDS",
] as const)("keeps the viewed crop and LOST FIT after a caption/volume save (%s) as manual geometry without native proof", (captionPlacement) => {
	const f = protectedFixture();
	fixtureItem(f.document.presentation).captionPlacement = captionPlacement;
	fixtureItem(fixtureItem(f.document.clips[0]).subjectProtection).context =
		fixtureItem(
			compositionSubjectProtectionContext(
				f.document,
				fixtureItem(f.document.clips[0]),
			),
		);
	const next = structuredClone(f.document);
	next.captionStyle = { fontSize: 0.04 };
	fixtureItem(next.clips[0]).audio.gainDb = -3;
	const before = [0, 5, 20, 21, 25, 89].map((frame) =>
		fixtureItem(
			evaluateCompositionFrame(compileComposition(next, [f.source]), frame)
				.layers[0],
		),
	);
	const adopted = normalizeManualSubjectProtectionEdits(f.document, next);
	expect(fixtureItem(adopted.clips[0]).subjectProtection).toBeUndefined();
	expect(
		fixtureItem(adopted.clips[0]).subjectPresentationAdoption,
	).toMatchObject({
		version: "source-bound-manual-presentation-v1",
		proofHash: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	expect(fixtureItem(adopted.clips[0]).framing[0]).toMatchObject({
		mode: "CROP",
		origin: "MANUAL",
		manualOverride: true,
	});
	for (const [index, frame] of [0, 5, 20, 21, 25, 89].entries()) {
		const after = fixtureItem(
			evaluateCompositionFrame(compileComposition(adopted, [f.source]), frame)
				.layers[0],
		);
		expect(after.sourceRect).toEqual(before[index]?.sourceRect);
		expect(after.drawRect).toEqual(before[index]?.drawRect);
		expect(after.backdrop).toEqual(before[index]?.backdrop);
	}
});

it("retains source-bound manual geometry through a second caption save and full schema roundtrip", () => {
	const f = protectedFixture();
	const adopted = compositionDocumentSchema.parse(
		normalizeManualSubjectProtectionEdits(f.document, f.document),
	);
	const next = structuredClone(adopted);
	next.captionStyle = { fontSize: 0.035 };
	fixtureItem(next.clips[0]).audio.gainDb = -5;
	const saved = normalizeManualSubjectProtectionEdits(adopted, next);
	expect(fixtureItem(saved.clips[0]).subjectPresentationAdoption).toEqual(
		fixtureItem(adopted.clips[0]).subjectPresentationAdoption,
	);
	for (const frame of [0, 5, 20, 21, 25, 89]) {
		const layer = (document: typeof adopted) =>
			fixtureItem(
				evaluateCompositionFrame(
					compileComposition(document, [f.source]),
					frame,
				).layers[0],
			);
		expect(layer(saved).sourceRect).toEqual(layer(adopted).sourceRect);
		expect(layer(saved).backdrop).toEqual(layer(adopted).backdrop);
	}
});

it("keeps an explicit drag of an adopted crop through preview and save without filling LOST frames", () => {
	const f = protectedFixture();
	const adopted = normalizeManualSubjectProtectionEdits(f.document, f.document);
	const moved = structuredClone(adopted);
	for (const part of fixtureItem(moved.clips[0]).framing)
		if (part.mode === "CROP") part.rect.x += 0.02;
	const preview = normalizeManualSubjectProtectionEdits(adopted, moved);
	const marker = fixtureItem(
		fixtureItem(preview.clips[0]).subjectPresentationAdoption,
	);
	expect(marker.sourceBindingHash).toBe(
		fixtureItem(fixtureItem(adopted.clips[0]).subjectPresentationAdoption)
			.sourceBindingHash,
	);
	expect(marker.geometryHash).not.toBe(
		fixtureItem(fixtureItem(adopted.clips[0]).subjectPresentationAdoption)
			.geometryHash,
	);
	// The first save still has the native automatic document in storage.
	const saved = normalizeManualSubjectProtectionEdits(f.document, preview);
	expect(saved).toEqual(preview);
	const layer = (document: typeof saved, frame: number) =>
		fixtureItem(
			evaluateCompositionFrame(compileComposition(document, [f.source]), frame)
				.layers[0],
		);
	expect(layer(preview, 5).sourceRect.x).not.toBe(
		layer(adopted, 5).sourceRect.x,
	);
	expect(layer(saved, 5).sourceRect).toEqual(layer(preview, 5).sourceRect);
	expect(layer(saved, 25).sourceRect.w).toBe(1920);
	expect(layer(saved, 25).backdrop?.kind).toBe("BLUR");
	expect(fixtureItem(saved.clips[0]).videoFit).toBeUndefined();
});

it.each([
	"source",
	"layout",
	"bands",
	"clock",
	"lost-range",
] as const)("invalidates adopted presentation after a %s change instead of reviving a crop", (change) => {
	const f = protectedFixture();
	const adopted = normalizeManualSubjectProtectionEdits(f.document, f.document);
	const next = structuredClone(adopted),
		clip = fixtureItem(next.clips[0]);
	if (change === "source") clip.sourceInUs += 33_334;
	if (change === "layout") clip.layout = { x: 0, y: 0, w: 0.8, h: 1 };
	if (change === "bands")
		fixtureItem(next.presentation).captionPlacement = "BANDS";
	if (change === "clock")
		fixtureItem(next.autoGeneration?.binding).timeMapHash = "f".repeat(64);
	if (change === "lost-range") {
		const lost = clip.framing.find((part) => part.mode === "FIT");
		if (!lost) throw Error("Missing LOST FIT fixture");
		clip.framing = clip.framing.map((part) =>
			part === lost
				? { ...part, mode: "CROP", rect: { x: 0.4, y: 0, w: 0.3, h: 1 } }
				: part,
		);
	}
	const saved = normalizeManualSubjectProtectionEdits(adopted, next);
	expect(
		fixtureItem(saved.clips[0]).subjectPresentationAdoption,
	).toBeUndefined();
	if (change !== "layout")
		expect(
			fixtureItem(
				evaluateCompositionFrame(compileComposition(saved, [f.source]), 5)
					.layers[0],
			).sourceRect.w,
		).toBe(1920);
});

it("strips copied or changed adoption markers that are not authorized by the stored source", () => {
	const f = protectedFixture();
	const adopted = normalizeManualSubjectProtectionEdits(f.document, f.document);
	const legacy = structuredClone(adopted);
	delete fixtureItem(legacy.clips[0]).subjectPresentationAdoption;
	const copied = normalizeManualSubjectProtectionEdits(legacy, adopted);
	expect(
		fixtureItem(copied.clips[0]).subjectPresentationAdoption,
	).toBeUndefined();
	const changed = structuredClone(adopted);
	fixtureItem(
		fixtureItem(changed.clips[0]).subjectPresentationAdoption,
	).proofHash = "f".repeat(64);
	const saved = normalizeManualSubjectProtectionEdits(adopted, changed);
	expect(
		fixtureItem(saved.clips[0]).subjectPresentationAdoption,
	).toBeUndefined();
	const forgedNativeRequest = structuredClone(f.document);
	fixtureItem(forgedNativeRequest.clips[0]).subjectPresentationAdoption =
		fixtureItem(changed.clips[0]).subjectPresentationAdoption;
	const rejectedNativeMarker = normalizeManualSubjectProtectionEdits(
		f.document,
		forgedNativeRequest,
	);
	expect(
		fixtureItem(rejectedNativeMarker.clips[0]).subjectPresentationAdoption,
	).toBeUndefined();
	for (const document of [copied, saved, rejectedNativeMarker])
		expect(
			fixtureItem(
				evaluateCompositionFrame(compileComposition(document, [f.source]), 5)
					.layers[0],
			).sourceRect.w,
		).toBe(1920);
});

it("does not adopt a user-created or modified subject proof as native evidence", () => {
	const f = protectedFixture(),
		next = structuredClone(f.document);
	fixtureItem(
		fixtureItem(fixtureItem(next.clips[0]).subjectProtection).samples[1],
	).confidence = 0.98;
	const adopted = normalizeManualSubjectProtectionEdits(f.document, next);
	expect(fixtureItem(adopted.clips[0]).subjectProtection).toBeUndefined();
	expect(
		fixtureItem(adopted.clips[0]).framing.some((part) => part.manualOverride),
	).toBe(false);
});

it("rejects adoption beyond the framing budget instead of silently changing the viewed composition", () => {
	const f = protectedFixture(),
		clip = fixtureItem(f.document.clips[0]);
	clip.durationFrames = 270;
	const part = fixtureItem(clip.framing[0]);
	if (part.mode !== "CROP") throw new Error("Missing crop fixture");
	clip.framing = [{ ...part, toFrame: 270 }];
	const old = fixtureItem(clip.subjectProtection),
		context = fixtureItem(
			compositionSubjectProtectionContext(f.document, clip),
		);
	clip.subjectProtection = {
		...old,
		context,
		samples: Array.from({ length: 270 }, (_, i) => ({
			sourceTimeUs:
				1_000_000 + Number((BigInt(i + 1) * 1_000_000n + 29n) / 30n),
			box: fixtureItem(old.samples[0]).box,
			confidence: i % 4 === 3 ? 0.8 : 0.99,
		})),
	};
	expect(() =>
		normalizeManualSubjectProtectionEdits(f.document, f.document),
	).toThrow("SUBJECT_PROTECTION_ADOPTION_LIMIT");
});

describe("explicit portrait presentation contract", () => {
	it("leaves absent presentation and per-clip override absent after parsing", () => {
		const { document } = compositionFixture();
		const before = canonicalEditingJson(document);
		const parsed = compositionDocumentSchema.parse(document);
		expect(Object.hasOwn(parsed, "presentation")).toBe(false);
		expect(Object.hasOwn(parsed.clips[0] ?? {}, "videoFit")).toBe(false);
		expect(canonicalEditingJson(parsed)).toBe(before);
	});
	it("requires a version and placement without injecting a fit or confirmation default", () => {
		const minimal = compositionPresentationSchema.parse({
			version: "portrait-layout-v1",
			captionPlacement: "BANDS",
		});
		expect(minimal).toEqual({
			version: "portrait-layout-v1",
			captionPlacement: "BANDS",
		});
		for (const invalid of [
			{ captionPlacement: "OVERLAY" },
			{ version: "portrait-layout-v1" },
			{ ...minimal, version: "future" },
			{ ...minimal, videoFit: "ZOOM" },
			{ ...minimal, other: true },
		])
			expect(compositionPresentationSchema.safeParse(invalid).success).toBe(
				false,
			);
		expect(
			compositionPresentationSchema
				.omit({ centerCropConfirmed: true })
				.safeParse({ ...minimal, centerCropConfirmed: true }).success,
		).toBe(false);
		const { document } = compositionFixture();
		expect(() =>
			setCompositionPresentation(document, {
				captionPlacement: "OVERLAY",
				...JSON.parse('{"centerCropConfirmed":true}'),
			}),
		).toThrow();
	});
	it("resets confirmation on a real presentation change and only clears main overrides for a fit change", () => {
		const f = automaticFixture();
		f.document.presentation = {
			...f.document.presentation,
			version: "portrait-layout-v1",
			captionPlacement: "OVERLAY",
			centerCropConfirmed: true,
		};
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.videoFit = "FIT";
		const before = structuredClone(f.document);
		const bands = setCompositionPresentation(f.document, {
			captionPlacement: "BANDS",
		});
		expect(bands.presentation?.centerCropConfirmed).toBe(false);
		expect(bands.clips[0]?.videoFit).toBe("FIT");
		const unchanged = setCompositionPresentation(f.document, {
			videoFit: "FILL",
		});
		expect(unchanged.presentation?.centerCropConfirmed).toBe(true);
		expect(unchanged.clips[0]?.videoFit).toBe("FIT");
		const whole = setCompositionPresentation(f.document, { videoFit: "FIT" });
		expect(whole.clips[0]?.videoFit).toBeUndefined();
		expect(whole.presentation?.centerCropConfirmed).toBe(false);
		expect(f.document).toEqual(before);
	});
});

describe("unconfirmed automatic center display fallback", () => {
	it("rejects export before confirmation even after AUTO_POLICY has become MANUAL on save", () => {
		const f = automaticFixture();
		expect(f.document.clips[0]?.framing[0]?.origin).toBe("MANUAL");
		expect(compositionHasUnconfirmedFraming(f.document)).toBe(true);
		expect(() => compileComposition(f.document, [f.source])).toThrow(
			"UNCONFIRMED_FRAMING",
		);
		const preview = compileComposition(f.document, [f.source], {
			allowUnconfirmed: true,
		});
		expect(evaluateCompositionFrame(preview, 0).layers[0]?.mode).toBe("CROP");
	});
	it("confirms a clone without deleting its real FIT evidence or rewriting source facts", () => {
		const f = automaticFixture();
		const before = structuredClone(f.document);
		const confirmed = confirmCompositionFraming(f.document);
		expect(confirmed.presentation?.centerCropConfirmed).toBe(true);
		expect(compositionHasUnconfirmedFraming(confirmed)).toBe(false);
		expect(confirmed.clips).toEqual(f.document.clips);
		expect(confirmed.autoGeneration).toEqual(f.document.autoGeneration);
		expect(f.document).toEqual(before);
		expect(() => compileComposition(confirmed, [f.source])).not.toThrow();
	});
	it("confirms a new per-clip fill override on an old automatic document without adding a global fit", () => {
		const f = automaticFixture();
		delete f.document.presentation;
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.videoFit = "FILL";
		expect(compositionHasUnconfirmedFraming(f.document)).toBe(true);
		const confirmed = confirmCompositionFraming(f.document);
		expect(confirmed.presentation).toEqual({
			version: "portrait-layout-v1",
			captionPlacement: "OVERLAY",
			centerCropConfirmed: true,
		});
		expect(confirmed.clips[0]?.videoFit).toBe("FILL");
		expect(() => compileComposition(confirmed, [f.source])).not.toThrow();
	});
	it("retains the existing AISA proposal check for both document versions", () => {
		const { document } = compositionFixture();
		const clip = document.clips[0];
		if (!clip?.framing[0]) throw new Error("Missing clip");
		clip.framing[0].origin = "AISA_PROPOSAL";
		expect(compositionHasUnconfirmedFraming(document)).toBe(true);
		const confirmed = confirmCompositionFraming(document);
		expect(confirmed.clips[0]?.framing[0]?.origin).toBe("EDITOR_CONFIRMED");
		expect(Object.hasOwn(confirmed, "presentation")).toBe(false);
		const {
			sources: _sources,
			videoTracks: _tracks,
			audioTracks: _audio,
			captions: _captions,
			overlays: _overlays,
			imageAssets: _images,
			...legacy
		} = document;
		const v1 = editingDocumentSchema.parse({ ...legacy, schemaVersion: 1 });
		expect(compositionHasUnconfirmedFraming(v1)).toBe(true);
		const confirmedV1 = confirmCompositionFraming(v1);
		expect(confirmedV1.schemaVersion).toBe(1);
		expect(confirmedV1.clips[0]?.framing[0]?.origin).toBe("EDITOR_CONFIRMED");
		expect(Object.hasOwn(confirmedV1, "presentation")).toBe(false);
	});
	it("does not require central confirmation when whole-frame FIT or real CROP is used", () => {
		const f = automaticFixture();
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.videoFit = "FIT";
		expect(compositionHasUnconfirmedFraming(f.document)).toBe(false);
		delete clip.videoFit;
		clip.framing = [
			{
				fromFrame: 0,
				toFrame: 90,
				origin: "MANUAL",
				mode: "CROP",
				rect: suggestFixedCrop({
					sourceWidth: f.source.width,
					sourceHeight: f.source.height,
					targetWidth: 1080,
					targetHeight: 1920,
					centerX: 0.5,
					centerY: 0.5,
				}),
			},
		];
		expect(compositionHasUnconfirmedFraming(f.document)).toBe(false);
	});
});

describe("shared full-bleed and band geometry", () => {
	it.each([
		[1920, 1080],
		[1600, 714],
		[1080, 1920],
	])("fills a portrait canvas without captions for a %ix%i source", (width, height) => {
		const f = compositionFixture();
		f.source.width = width;
		f.source.height = height;
		f.document.presentation = {
			version: "portrait-layout-v1",
			videoFit: "FILL",
			captionPlacement: "OVERLAY",
		};
		const layer = evaluateCompositionFrame(
			compileComposition(f.document, [f.source]),
			0,
		).layers[0];
		expect(layer?.mode).toBe("CROP");
		expect(layer?.drawRect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
	});
	it("keeps measured keys out of FIT fallback intervals while retaining real motion inside the observed range", () => {
		const f = compositionFixture();
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.framing = [
			{ fromFrame: 0, toFrame: 20, mode: "FIT", origin: "MANUAL" },
			{
				fromFrame: 20,
				toFrame: 61,
				mode: "CROP",
				origin: "MANUAL",
				rect: { x: 0.1, y: 0, w: 0.31640625, h: 1 },
			},
			{ fromFrame: 61, toFrame: 90, mode: "FIT", origin: "MANUAL" },
		];
		clip.cropKeyframes = [
			{
				frame: 20,
				rect: { x: 0.1, y: 0, w: 0.31640625, h: 1 },
				easing: "LINEAR",
			},
			{
				frame: 60,
				rect: { x: 0.6, y: 0, w: 0.31640625, h: 1 },
				easing: "LINEAR",
			},
		];
		f.document.presentation = {
			version: "portrait-layout-v1",
			videoFit: "FILL",
			captionPlacement: "OVERLAY",
		};
		const before = structuredClone(f.document);
		const plan = compileComposition(f.document, [f.source]);
		const at = (frame: number) =>
			evaluateCompositionFrame(plan, frame).layers[0];
		expect(at(10)?.cropRect?.x).toBeCloseTo((1 - 0.31640625) / 2, 12);
		expect(at(80)?.cropRect).toEqual(at(10)?.cropRect);
		expect(at(20)?.cropRect?.x).toBeCloseTo(0.1, 12);
		expect(at(40)?.cropRect?.x).toBeCloseTo(0.35, 12);
		expect(at(60)?.cropRect?.x).toBeCloseTo(0.6, 12);
		expect(f.document).toEqual(before);
	});
	it("keeps bands independent of caption count and restores the saved overlay layout", () => {
		const f = compositionFixture();
		f.document.captionLayout = { x: 0.1, y: 0.6, w: 0.8, h: 0.2 };
		f.document.captions = [
			{ id: ids.item, fromFrame: 0, toFrame: 90, text: "猫です" },
		];
		const bands = setCompositionPresentation(f.document, {
			videoFit: "FILL",
			captionPlacement: "BANDS",
		});
		const withCaptions = evaluateCompositionFrame(
			compileComposition(bands, [f.source]),
			0,
		);
		expect(withCaptions.layers[0]?.drawRect).toEqual({
			x: 0,
			y: 346,
			w: 1080,
			h: 1228,
		});
		expect(withCaptions.captions[0]?.rect).toEqual({
			x: 54,
			y: 1613,
			w: 972,
			h: 249,
		});
		const without = { ...bands, captions: [] };
		expect(
			evaluateCompositionFrame(compileComposition(without, [f.source]), 0)
				.layers,
		).toEqual(withCaptions.layers);
		const overlay = setCompositionPresentation(bands, {
			captionPlacement: "OVERLAY",
		});
		expect(overlay.captionLayout).toEqual(f.document.captionLayout);
		expect(
			evaluateCompositionFrame(compileComposition(overlay, [f.source]), 0)
				.captions[0]?.rect,
		).toEqual({ x: 108, y: 1152, w: 864, h: 384 });
	});
	it("preserves PIP and custom layouts while allowing an explicit per-clip override", () => {
		const f = compositionFixture();
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		f.document.videoTracks?.push({ id: "pip", name: "PIP", order: 1 });
		const inset: CompositionClip = {
			...structuredClone(clip),
			id: ids.other,
			trackId: "pip",
			layout: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
		};
		f.document.clips.push(inset);
		const legacy = evaluateCompositionFrame(
			compileComposition(f.document, [f.source]),
			0,
		).layers[1];
		f.document.presentation = {
			version: "portrait-layout-v1",
			videoFit: "FILL",
			captionPlacement: "BANDS",
		};
		const layer = evaluateCompositionFrame(
			compileComposition(f.document, [f.source]),
			0,
		).layers[1];
		expect(layer).toEqual(legacy);
		expect(compositionUsesMainPresentation(f.document, inset)).toBe(false);
		inset.videoFit = "FILL";
		const filled = evaluateCompositionFrame(
			compileComposition(f.document, [f.source]),
			0,
		).layers[1];
		expect(filled?.layoutRect).toEqual(legacy?.layoutRect);
		expect(filled?.drawRect).toEqual(filled?.layoutRect);
		const switched = setCompositionPresentation(f.document, {
			videoFit: "FIT",
		});
		expect(switched.clips[1]?.videoFit).toBe("FILL");
	});
	it("preserves a custom layout on the lowest track and its explicit override during global switches", () => {
		const f = compositionFixture();
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.layout = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 };
		const legacy = evaluateCompositionFrame(
			compileComposition(f.document, [f.source]),
			0,
		).layers;
		const bands = setCompositionPresentation(f.document, {
			videoFit: "FILL",
			captionPlacement: "BANDS",
		});
		expect(
			evaluateCompositionFrame(compileComposition(bands, [f.source]), 0).layers,
		).toEqual(legacy);
		expect(compositionUsesMainPresentation(bands, bands.clips[0] ?? clip)).toBe(
			false,
		);
		const first = bands.clips[0];
		if (!first) throw new Error("Missing clip");
		first.videoFit = "FIT";
		expect(
			setCompositionPresentation(bands, { videoFit: "FIT" }).clips[0]?.videoFit,
		).toBe("FIT");
	});
	it("uses video track order rather than the name main or declaration order", () => {
		const f = compositionFixture();
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		f.document.videoTracks = [
			{ id: "foreground", name: "Top", order: 3 },
			{ id: "bottom", name: "Base", order: 1 },
		];
		clip.trackId = "bottom";
		f.document.presentation = {
			version: "portrait-layout-v1",
			videoFit: "FILL",
			captionPlacement: "BANDS",
		};
		expect(compositionUsesMainPresentation(f.document, clip)).toBe(true);
		expect(
			evaluateCompositionFrame(compileComposition(f.document, [f.source]), 0)
				.layers[0]?.layoutRect,
		).toEqual({ x: 0, y: 346, w: 1080, h: 1228 });
	});
	it("retains exact legacy geometry, including awkward crops and preview rounding", () => {
		const f = compositionFixture();
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.framing = [
			{
				fromFrame: 0,
				toFrame: 90,
				mode: "CROP",
				origin: "MANUAL",
				rect: { x: 0.1, y: 0.2, w: 0.17, h: 0.31 },
			},
		];
		const plan = compileComposition(f.document, [f.source]);
		for (const canvas of [f.document.canvas, { width: 360, height: 640 }]) {
			const layer = evaluateCompositionFrame(plan, 30, canvas).layers[0];
			const expected = resolveCompositionGeometry({
				sourceWidth: f.source.width,
				sourceHeight: f.source.height,
				...canvas,
				outputReference: f.document.canvas,
				frame: 30,
				framing: clip.framing[0] ?? { mode: "FIT" },
			});
			expect(layer).toMatchObject(expected);
		}
	});
	it("refits measured crop aspect for bands without mutating or stretching the measured keys", () => {
		const f = compositionFixture();
		const clip = f.document.clips[0];
		if (!clip) throw new Error("Missing clip");
		const rect = suggestFixedCrop({
			sourceWidth: 1920,
			sourceHeight: 1080,
			targetWidth: 1080,
			targetHeight: 1920,
			centerX: 0.5,
			centerY: 0.5,
			zoom: 2,
		});
		clip.framing = [
			{ fromFrame: 0, toFrame: 90, mode: "CROP", origin: "MANUAL", rect },
		];
		clip.cropKeyframes = [
			{ frame: 0, rect, easing: "SMOOTH" },
			{ frame: 89, rect: { ...rect, x: rect.x + 0.1 }, easing: "SMOOTH" },
		];
		f.document.presentation = {
			version: "portrait-layout-v1",
			captionPlacement: "BANDS",
		};
		const before = structuredClone(f.document);
		const plan = compileComposition(f.document, [f.source]);
		for (const frame of [0, 30, 89]) {
			const full = evaluateCompositionFrame(plan, frame).layers[0];
			const small = evaluateCompositionFrame(plan, frame, {
				width: 360,
				height: 640,
			}).layers[0];
			expect(full?.sourceRect).toEqual(small?.sourceRect);
			if (!full) throw new Error("Missing layer");
			expect(
				Math.abs(
					full.sourceRect.w * full.drawRect.h -
						full.sourceRect.h * full.drawRect.w,
				),
			).toBeLessThanOrEqual(full.drawRect.w + full.drawRect.h);
		}
		expect(f.document).toEqual(before);
	});
});
