import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import { resolveCompositionGeometry } from "./composition-geometry";
import {
	compositionHasUnconfirmedCenterCrop,
	resolvePresentedCompositionGeometry,
	setCompositionPresentation,
} from "./composition-presentation";
import {
	type CompositionDocument,
	compositionClipSchema,
	compositionDocumentSchema,
	compositionPresentationSchema,
} from "./composition-schema";
import {
	applyCompositionTemplate,
	COMPOSITION_TEMPLATE_PRESETS,
} from "./composition-templates";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture value");
	return value;
}

function automaticView() {
	const f = compositionFixture();
	f.source.width = 1600;
	f.source.height = 714;
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
	};
	return f;
}
function geometry(
	f: ReturnType<typeof automaticView>,
	frame = 0,
	width = 1080,
	height = 1920,
) {
	return resolvePresentedCompositionGeometry({
		document: f.document,
		clip: required(f.document.clips[0]),
		sourceWidth: f.source.width,
		sourceHeight: f.source.height,
		width,
		height,
		frame,
	});
}
function setMeasuredWindow(f: ReturnType<typeof automaticView>) {
	required(f.document.clips[0]).framing = [
		{ fromFrame: 0, toFrame: 10, mode: "FIT", origin: "MANUAL" },
		{
			fromFrame: 10,
			toFrame: 31,
			mode: "CROP",
			origin: "MANUAL",
			rect: { x: 0.1, y: 0.2, w: 0.2, h: 0.5 },
		},
		{ fromFrame: 31, toFrame: 90, mode: "FIT", origin: "MANUAL" },
	];
	required(f.document.clips[0]).cropKeyframes = [
		{ frame: 10, rect: { x: 0.1, y: 0.2, w: 0.2, h: 0.5 }, easing: "LINEAR" },
		{ frame: 30, rect: { x: 0.3, y: 0.25, w: 0.15, h: 0.4 }, easing: "SMOOTH" },
	];
}

describe("hybrid automatic presentation", () => {
	it("admits AUTO only at document presentation and injects no old defaults", () => {
		const f = automaticView();
		expect(
			compositionPresentationSchema.parse(f.document.presentation),
		).toEqual(f.document.presentation);
		expect(
			compositionClipSchema.safeParse({
				...f.document.clips[0],
				videoFit: "AUTO",
			}).success,
		).toBe(false);
		const old = compositionFixture().document;
		expect(canonicalEditingJson(compositionDocumentSchema.parse(old))).toBe(
			canonicalEditingJson(old),
		);
		expect(
			Object.hasOwn(compositionDocumentSchema.parse(old), "presentation"),
		).toBe(false);
	});
	it("preserves the complete unknown source while deriving a decorative backdrop", () => {
		const f = automaticView(),
			before = structuredClone(f.document),
			frame = geometry(f);
		expect(frame.mode).toBe("FIT");
		expect(frame.sourceRect).toEqual({ x: 0, y: 0, w: 1600, h: 714 });
		expect(frame.drawRect).toEqual({ x: 0, y: 718, w: 1080, h: 482 });
		expect(frame.backdrop).toMatchObject({
			kind: "BLUR",
			sourceRect: { x: 599, y: 0, w: 402, h: 714 },
			clipRect: { x: 0, y: 0, w: 1080, h: 1920 },
			blurPx: 24,
			shadeOpacity: 0.35,
		});
		const bg = required(frame.backdrop);
		expect(bg.drawRect.x).toBeLessThanOrEqual(-72);
		expect(bg.drawRect.y).toBeLessThanOrEqual(-72);
		expect(bg.drawRect.x + bg.drawRect.w).toBeGreaterThanOrEqual(1152);
		expect(bg.drawRect.y + bg.drawRect.h).toBeGreaterThanOrEqual(1992);
		expect(
			Math.abs(
				bg.drawRect.w / bg.sourceRect.w - bg.drawRect.h / bg.sourceRect.h,
			),
		).toBeLessThan(1 / Math.min(bg.sourceRect.w, bg.sourceRect.h));
		expect(f.document).toEqual(before);
	});
	it.each([
		0, 9, 31, 89,
	])("keeps FIT frame %i separate from neighbouring real crop keys", (frame) => {
		const f = automaticView();
		setMeasuredWindow(f);
		expect(geometry(f, frame).sourceRect).toEqual({
			x: 0,
			y: 0,
			w: 1600,
			h: 714,
		});
		expect(geometry(f, frame).backdrop).toBeDefined();
	});
	it.each([
		10, 20, 30,
	])("preserves measured/manual CROP and interpolation at frame %i", (frame) => {
		const f = automaticView();
		setMeasuredWindow(f);
		const before = structuredClone(f.document),
			auto = geometry(f, frame);
		required(f.document.presentation).videoFit = "FILL";
		expect(auto).toEqual(geometry(f, frame));
		expect(Object.hasOwn(auto, "backdrop")).toBe(false);
		required(f.document.presentation).videoFit = "AUTO";
		expect(f.document).toEqual(before);
	});
	it("honours explicit clip FIT with backdrop even where the raw framing is CROP", () => {
		const f = automaticView();
		setMeasuredWindow(f);
		required(f.document.clips[0]).videoFit = "FIT";
		expect(geometry(f, 20).mode).toBe("FIT");
		expect(geometry(f, 20).sourceRect).toEqual({ x: 0, y: 0, w: 1600, h: 714 });
		expect(geometry(f, 20).backdrop).toBeDefined();
	});
	it("honours explicit clip FILL without adding AUTO decoration", () => {
		const f = automaticView();
		required(f.document.clips[0]).videoFit = "FILL";
		expect(geometry(f).mode).toBe("CROP");
		expect(Object.hasOwn(geometry(f), "backdrop")).toBe(false);
		setMeasuredWindow(f);
		const actual = geometry(f, 20);
		required(f.document.presentation).videoFit = "FILL";
		expect(actual).toEqual(geometry(f, 20));
	});
	it("retains the existing explicit FILL confirmation gate for automatic projects", () => {
		const f = automaticView();
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
		expect(compositionHasUnconfirmedCenterCrop(f.document)).toBe(false);
		expect(() => compileComposition(f.document, [f.source])).not.toThrow();
		required(f.document.clips[0]).videoFit = "FILL";
		expect(compositionHasUnconfirmedCenterCrop(f.document)).toBe(true);
		expect(() => compileComposition(f.document, [f.source])).toThrow(
			"UNCONFIRMED_FRAMING",
		);
	});
	it.each([
		[1080, 1920],
		[360, 640],
		[126, 224],
		[9, 16],
	])("rounds backdrop source only once for %ix%i preview/export", (width, height) => {
		const f = automaticView();
		required(f.document.presentation).captionPlacement = "BANDS";
		const result = geometry(f, 89, width, height),
			full = geometry(f, 89);
		expect(required(result.backdrop).sourceRect).toEqual(
			required(full.backdrop).sourceRect,
		);
		expect(required(result.backdrop).clipRect).toEqual(result.layoutRect);
		expect(required(result.backdrop).blurPx).toBe(
			(24 * Math.max(width, height)) / 1920,
		);
		expect(result.layoutRect.y).toBeGreaterThan(0);
		expect(result.layoutRect.y + result.layoutRect.h).toBeLessThan(height);
		const bg = required(result.backdrop),
			margin = 3 * bg.blurPx;
		expect(bg.drawRect.x).toBeLessThanOrEqual(bg.clipRect.x - margin);
		expect(bg.drawRect.y).toBeLessThanOrEqual(bg.clipRect.y - margin);
		expect(bg.drawRect.x + bg.drawRect.w).toBeGreaterThanOrEqual(
			bg.clipRect.x + bg.clipRect.w + margin,
		);
		expect(bg.drawRect.y + bg.drawRect.h).toBeGreaterThanOrEqual(
			bg.clipRect.y + bg.clipRect.h + margin,
		);
		expect(Object.values(bg.sourceRect).every(Number.isSafeInteger)).toBe(true);
		expect(Object.values(bg.drawRect).every(Number.isSafeInteger)).toBe(true);
	});
	it("does not add a background when the whole source already fills its viewport", () => {
		const f = automaticView();
		f.source.width = 1080;
		f.source.height = 1920;
		expect(Object.hasOwn(geometry(f), "backdrop")).toBe(false);
		expect(geometry(f).sourceRect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
	});
	it.each([
		"CUSTOM",
		"UPPER",
	] as const)("leaves %s layouts and tracks outside the AUTO main policy", (kind) => {
		const f = automaticView();
		required(f.document.presentation).captionPlacement = "BANDS";
		if (kind === "CUSTOM")
			required(f.document.clips[0]).layout = {
				x: 0.5,
				y: 0.05,
				w: 0.4,
				h: 0.2,
			};
		else {
			required(f.document.videoTracks).push({
				id: "upper",
				name: "Upper",
				order: 1,
			});
			required(f.document.clips[0]).trackId = "upper";
		}
		const actual = geometry(f),
			clip = required(f.document.clips[0]);
		expect(actual).toEqual(
			resolveCompositionGeometry({
				sourceWidth: f.source.width,
				sourceHeight: f.source.height,
				width: 1080,
				height: 1920,
				outputReference: f.document.canvas,
				frame: 0,
				layout: clip.layout,
				framing: { mode: "FIT" },
			}),
		);
		expect(Object.hasOwn(actual, "backdrop")).toBe(false);
	});
	it.each(
		COMPOSITION_TEMPLATE_PRESETS.map((p) => p.id),
	)("keeps explicit AUTO through the %s template", (preset) => {
		const f = automaticView();
		f.document = applyCompositionTemplate(f.document, preset, [f.source]);
		expect(required(f.document.presentation).videoFit).toBe("AUTO");
		expect(geometry(f).sourceRect).toEqual({ x: 0, y: 0, w: 1600, h: 714 });
		expect(geometry(f).backdrop).toBeDefined();
	});
	it("keeps backdrop attached to its source frame and existing crossfade opacity", () => {
		const f = automaticView();
		required(f.document.clips[0]).opacity = 0.4;
		f.document.clips.push({
			...structuredClone(required(f.document.clips[0])),
			id: ids.other,
			timelineStartFrame: 75,
			opacity: 0.7,
			transitionIn: { type: "CROSSFADE", durationFrames: 15 },
		});
		const plan = compileComposition(f.document, [f.source]),
			frame = evaluateCompositionFrame(plan, 82);
		expect(frame.layers).toHaveLength(2);
		expect(frame.layers.map((l) => l.sourceFrame)).toEqual([173, 98]);
		expect(required(frame.layers[0]).opacity).toBeCloseTo(0.4 * 0.5);
		expect(required(frame.layers[1]).opacity).toBeCloseTo(0.7 * 0.5);
		expect(
			frame.layers.every(
				(l) => l.mediaVersionId === ids.media && l.backdrop?.kind === "BLUR",
			),
		).toBe(true);
	});
	it("clears only main clip fit overrides when explicitly changing presentation", () => {
		const f = automaticView();
		required(f.document.clips[0]).videoFit = "FILL";
		const changed = setCompositionPresentation(f.document, {
			videoFit: "AUTO",
		});
		expect(required(changed.clips[0]).videoFit).toBe("FILL");
		const whole = setCompositionPresentation(
			{
				...f.document,
				presentation: { ...required(f.document.presentation), videoFit: "FIT" },
			},
			{ videoFit: "AUTO" },
		);
		expect(Object.hasOwn(required(whole.clips[0]), "videoFit")).toBe(false);
		expect(required(whole.presentation).videoFit).toBe("AUTO");
	});
});

it("preserves pre-AUTO document hashes, exact frames and compiler version for legacy presentations", () => {
	const variants: Array<CompositionDocument["presentation"]> = [
		undefined,
		{ version: "portrait-layout-v1", captionPlacement: "OVERLAY" },
		...(["FILL", "FIT"] as const).flatMap((videoFit) =>
			(["OVERLAY", "BANDS"] as const).map((captionPlacement) => ({
				version: "portrait-layout-v1" as const,
				videoFit,
				captionPlacement,
				centerCropConfirmed: true,
			})),
		),
	];
	const results = [];
	for (const presentation of variants)
		for (const mode of ["FIT", "CROP"] as const) {
			const f = compositionFixture();
			if (presentation) f.document.presentation = presentation;
			if (mode === "CROP")
				required(f.document.clips[0]).framing = [
					{
						fromFrame: 0,
						toFrame: 90,
						mode: "CROP",
						origin: "MANUAL",
						rect: { x: 0.2, y: 0.15, w: 0.25, h: 0.7 },
					},
				];
			const plan = compileComposition(f.document, [f.source]);
			results.push({
				label: JSON.stringify({ presentation, mode }),
				document: canonicalEditingJson(
					compositionDocumentSchema.parse(f.document),
				),
				canonicalSha256: createHash("sha256")
					.update(
						canonicalEditingJson(compositionDocumentSchema.parse(f.document)),
					)
					.digest("hex"),
				compilerVersion: plan.compilerVersion,
				frames: [0, 31, 89].flatMap((frame) =>
					[
						{ width: 1080, height: 1920 },
						{ width: 360, height: 640 },
					].map((size) => evaluateCompositionFrame(plan, frame, size)),
				),
			});
		}
	expect(
		createHash("sha256").update(JSON.stringify(results)).digest("hex"),
	).toBe("75f7ab49e775d3c0df15119eadc3fce93688ed43c68d2f62ba35bed9518f7c2e");
});
