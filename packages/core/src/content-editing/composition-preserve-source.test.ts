import { describe, expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import { trimCompositionClip } from "./composition-mutations";
import {
	confirmCompositionFraming,
	resolvePresentedCompositionGeometry,
	setCompositionPresentation,
} from "./composition-presentation";
import { compositionDocumentSchema } from "./composition-schema";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw Error("Missing fixture value");
	return value;
}

function fixture() {
	const f = compositionFixture();
	f.source.width = 1600;
	f.source.height = 714;
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		captionPlacement: "OVERLAY",
		fallbackFraming: "PRESERVE_SOURCE_V1",
	};
	const clip = f.document.clips[0];
	if (!clip) throw Error("Missing clip");
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: 90,
			mode: "CROP",
			origin: "AUTO_POLICY",
			rect: { x: 0.2, y: 0, w: 0.25, h: 1 },
		},
	];
	clip.cropKeyframes = [
		{ frame: 0, rect: { x: 0.2, y: 0, w: 0.25, h: 1 }, easing: "LINEAR" },
		{ frame: 89, rect: { x: 0.5, y: 0, w: 0.25, h: 1 }, easing: "SMOOTH" },
	];
	clip.fallbackCrop = { x: 0.1, y: 0, w: 0.25, h: 1 };
	return { ...f, clip };
}
function geometry(
	f: ReturnType<typeof fixture>,
	frame = 0,
	width = 1080,
	height = 1920,
) {
	return resolvePresentedCompositionGeometry({
		document: f.document,
		clip: f.clip,
		sourceWidth: f.source.width,
		sourceHeight: f.source.height,
		width,
		height,
		frame,
	});
}

describe("versioned source-preserving automatic presentation", () => {
	it("roundtrips the new marker without changing raw framing or adding legacy defaults", () => {
		const f = fixture();
		required(f.clip.framing[0]).origin = "MANUAL";
		expect(compositionDocumentSchema.parse(f.document)).toEqual(f.document);
		const legacy = compositionFixture().document;
		expect(compositionDocumentSchema.parse(legacy)).toEqual(legacy);
		expect(
			compositionDocumentSchema.safeParse({
				...f.document,
				presentation: { ...f.document.presentation, fallbackFraming: "latest" },
			}).success,
		).toBe(false);
	});
	it.each([
		"AUTO_POLICY",
		"AISA_PROPOSAL",
		"EDITOR_CONFIRMED",
		"MANUAL",
	] as const)("keeps every source pixel for %s, including saved keys and override metadata", (origin) => {
		const f = fixture();
		required(f.clip.framing[0]).origin = origin;
		required(f.clip.framing[0]).manualOverride = true;
		const before = structuredClone(f.document);
		for (const frame of [0, 45, 89]) {
			const g = geometry(f, frame);
			expect(g.mode).toBe("FIT");
			expect(g.sourceRect).toEqual({ x: 0, y: 0, w: 1600, h: 714 });
			expect(g.backdrop?.kind).toBe("BLUR");
			expect(g.drawRect).toEqual({ x: 0, y: 718, w: 1080, h: 482 });
		}
		expect(f.document).toEqual(before);
	});
	it("cannot change geometry merely by adopting a proposal or normalizing a saved automatic origin", () => {
		const f = fixture();
		required(f.clip.framing[0]).origin = "AISA_PROPOSAL";
		const initial = geometry(f, 45);
		const confirmed = confirmCompositionFraming(f.document);
		expect(confirmed.clips[0]?.framing[0]?.origin).toBe("EDITOR_CONFIRMED");
		f.document = confirmed;
		f.clip = required(confirmed.clips[0]);
		expect(geometry(f, 45)).toEqual(initial);
		required(f.clip.framing[0]).origin = "MANUAL";
		expect(geometry(f, 45)).toEqual(initial);
	});
	it("lets only explicit clip or document FILL restore the saved crop and measured key interpolation", () => {
		const f = fixture();
		const before = structuredClone(f.document);
		f.clip.videoFit = "FILL";
		const cropped = geometry(f, 45);
		expect(cropped.mode).toBe("CROP");
		expect(cropped.sourceRect.w).toBe(400);
		expect(cropped.sourceRect.x).toBeGreaterThan(320);
		expect(cropped.backdrop).toBeUndefined();
		delete f.clip.videoFit;
		required(f.document.presentation).videoFit = "FILL";
		expect(geometry(f, 45)).toEqual(cropped);
		required(f.document.presentation).videoFit = "AUTO";
		expect(geometry(f, 45).mode).toBe("FIT");
		expect(f.document).toEqual(before);
	});
	it("supports black space explicitly without cropping or a decorative background", () => {
		const f = fixture();
		required(f.document.presentation).videoFit = "FIT";
		const g = geometry(f);
		expect(g.mode).toBe("FIT");
		expect(g.sourceRect).toEqual({ x: 0, y: 0, w: 1600, h: 714 });
		expect(g.backdrop).toBeUndefined();
	});
	it.each([
		[1600, 714],
		[480, 1280],
		[1080, 1920],
	])("fits landscape, narrow portrait and matching source %ix%i", (width, height) => {
		const f = fixture();
		f.source.width = width;
		f.source.height = height;
		const g = geometry(f);
		expect(g.sourceRect).toEqual({ x: 0, y: 0, w: width, h: height });
		expect(g.drawRect.x).toBeGreaterThanOrEqual(0);
		expect(g.drawRect.y).toBeGreaterThanOrEqual(0);
		expect(g.drawRect.x + g.drawRect.w).toBeLessThanOrEqual(1080);
		expect(g.drawRect.y + g.drawRect.h).toBeLessThanOrEqual(1920);
		if (width === 1080) expect(g.backdrop).toBeUndefined();
		else expect(g.backdrop).toBeDefined();
	});
	it("preserves caption bands and does not reframe a custom layout", () => {
		const f = fixture();
		required(f.document.presentation).captionPlacement = "BANDS";
		const bands = geometry(f);
		expect(bands.sourceRect).toEqual({ x: 0, y: 0, w: 1600, h: 714 });
		expect(bands.backdrop?.clipRect).toEqual(bands.layoutRect);
		expect(bands.layoutRect.y).toBeGreaterThan(0);
		expect(bands.layoutRect.h).toBeLessThan(1920);
		f.clip.layout = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
		expect(geometry(f).mode).toBe("CROP");
		expect(geometry(f).backdrop).toBeUndefined();
	});
	it("leaves old AUTO and AISA_STATIC_V1 crop behavior unchanged", () => {
		const f = fixture();
		delete required(f.document.presentation).fallbackFraming;
		expect(geometry(f).mode).toBe("CROP");
		required(f.document.presentation).fallbackFraming = "AISA_STATIC_V1";
		expect(geometry(f).mode).toBe("CROP");
	});
	it("compiles every export and scaled preview frame with the same uncropped source and keeps evidence immutable", () => {
		const f = fixture();
		required(f.clip.framing[0]).origin = "MANUAL";
		const before = structuredClone(f.document);
		const plan = compileComposition(f.document, [f.source]);
		for (let i = 0; i < 90; i++)
			for (const canvas of [
				{ width: 1080, height: 1920 },
				{ width: 270, height: 480 },
			]) {
				const layer = evaluateCompositionFrame(plan, i, canvas).layers[0];
				expect(layer?.sourceRect).toEqual({ x: 0, y: 0, w: 1600, h: 714 });
				expect(layer?.backdrop?.kind).toBe("BLUR");
			}
		expect(f.document).toEqual(before);
	});
	it("invalidates a stale shot reference when the source window changes, while retaining the candidate and keys", () => {
		const f = fixture();
		required(f.clip.framing[0]).origin = "MANUAL";
		f.document.analysisRevisionId = ids.item;
		f.clip.evidence = { sceneId: ids.other, shotIndex: 0 };
		const before = structuredClone(f.document);
		const next = trimCompositionClip(
			f.document,
			ids.clip,
			{ sourceInUs: 1366667, durationFrames: 60 },
			[f.source],
		);
		expect(next.clips[0]?.evidence).toEqual({ sceneId: ids.other });
		expect(next.clips[0]?.fallbackCrop).toEqual(f.clip.fallbackCrop);
		expect(next.clips[0]?.cropKeyframes?.length).toBeGreaterThan(0);
		expect(f.document).toEqual(before);
	});
	it("keeps the policy marker when explicitly switching framing and removes only overridden main clip modes", () => {
		const f = fixture();
		required(f.clip.framing[0]).origin = "MANUAL";
		f.clip.videoFit = "FILL";
		const changed = setCompositionPresentation(f.document, { videoFit: "FIT" });
		expect(changed.presentation?.fallbackFraming).toBe("PRESERVE_SOURCE_V1");
		expect(changed.clips[0]?.videoFit).toBeUndefined();
	});
});
