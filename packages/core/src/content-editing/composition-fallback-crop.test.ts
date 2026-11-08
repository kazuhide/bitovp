import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import { resolvePresentedCompositionGeometry } from "./composition-presentation";
import {
	compositionDocumentSchema,
	compositionPresentationSchema,
} from "./composition-schema";
import { compositionFixture } from "./composition-test-fixtures";
import { suggestFixedCrop } from "./framing";

function fixture() {
	const f = compositionFixture();
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		fallbackFraming: "AISA_STATIC_V1",
	};
	const clip = f.document.clips[0];
	if (!clip) throw Error("Missing clip");
	clip.fallbackCrop = suggestFixedCrop({
		sourceWidth: f.source.width,
		sourceHeight: f.source.height,
		targetWidth: 1080,
		targetHeight: 1920,
		centerX: 0.15,
		centerY: 0.5,
		zoom: 1.5,
	});
	return { ...f, clip };
}
function view(
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
describe("explicit static fallback framing", () => {
	it("retains new explicit flags without adding either field to old documents", () => {
		const f = fixture();
		expect(
			compositionDocumentSchema.parse(f.document).clips[0]?.fallbackCrop,
		).toEqual(f.clip.fallbackCrop);
		expect(
			compositionPresentationSchema.parse(f.document.presentation)
				.fallbackFraming,
		).toBe("AISA_STATIC_V1");
		const old = compositionFixture().document;
		expect(canonicalEditingJson(compositionDocumentSchema.parse(old))).toBe(
			canonicalEditingJson(old),
		);
		expect(
			Object.hasOwn(
				compositionDocumentSchema.parse(old).clips[0] ?? {},
				"fallbackCrop",
			),
		).toBe(false);
	});
	it("uses an explicitly chosen static view only for the raw FIT window without changing evidence or keys", () => {
		const f = fixture();
		f.clip.framing = [
			{ fromFrame: 0, toFrame: 10, mode: "FIT", origin: "MANUAL" },
			{
				fromFrame: 10,
				toFrame: 90,
				mode: "CROP",
				origin: "MANUAL",
				rect: { x: 0.4, y: 0.1, w: 0.2, h: 0.6 },
			},
		];
		f.clip.cropKeyframes = [
			{ frame: 10, rect: { x: 0.4, y: 0.1, w: 0.2, h: 0.6 }, easing: "LINEAR" },
			{
				frame: 89,
				rect: { x: 0.6, y: 0.2, w: 0.15, h: 0.5 },
				easing: "SMOOTH",
			},
		];
		const before = structuredClone(f.document),
			fallback = view(f, 0),
			tracked = view(f, 35);
		expect(fallback.cropRect).toEqual(f.clip.fallbackCrop);
		expect(fallback.sourceRect.x).toBeLessThan(400);
		delete f.clip.fallbackCrop;
		expect(view(f, 35)).toEqual(tracked);
		expect(view(f, 0)).not.toEqual(fallback);
		f.clip.fallbackCrop = before.clips[0]?.fallbackCrop;
		expect(f.document).toEqual(before);
	});
	it.each([
		"FIT",
		"AUTO",
	] as const)("does not change %s presentation pixels", (videoFit) => {
		const f = fixture();
		if (!f.document.presentation) throw Error("Missing presentation");
		f.document.presentation.videoFit = videoFit;
		const actual = view(f);
		delete f.clip.fallbackCrop;
		expect(view(f)).toEqual(actual);
	});
	it.each([
		"CUSTOM",
		"UPPER",
	] as const)("does not apply a fallback to %s clips", (kind) => {
		const f = fixture();
		f.clip.videoFit = "FILL";
		if (kind === "CUSTOM") f.clip.layout = { x: 0.4, y: 0.1, w: 0.4, h: 0.3 };
		else {
			f.document.videoTracks = [
				{ id: "main", name: "Main", order: 0 },
				{ id: "upper", name: "Upper", order: 1 },
			];
			f.clip.trackId = "upper";
		}
		const actual = view(f);
		delete f.clip.fallbackCrop;
		expect(view(f)).toEqual(actual);
	});
	it("keeps an explicit clip FIT whole even inside a FILL document", () => {
		const f = fixture();
		f.clip.videoFit = "FIT";
		expect(view(f).mode).toBe("FIT");
		expect(view(f).sourceRect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
	});
	it("reprojects the saved canonical centre and zoom for BANDS without changing its source pixels across output sizes", () => {
		const f = fixture();
		if (!f.document.presentation) throw Error("Missing presentation");
		f.document.presentation.captionPlacement = "BANDS";
		const full = view(f),
			small = view(f, 0, 360, 640);
		expect(small.sourceRect).toEqual(full.sourceRect);
		expect(full.drawRect).toEqual({ x: 0, y: 346, w: 1080, h: 1228 });
		const fallback = f.clip.fallbackCrop;
		if (!fallback) throw Error("Missing crop");
		expect(full.cropRect?.x).toBeLessThan(fallback.x);
		expect(full.cropRect?.w).toBeGreaterThan(fallback.w);
		expect(full.cropRect?.h).toBeCloseTo(fallback.h);
		const before = structuredClone(f.document);
		compileComposition(f.document, [f.source]);
		evaluateCompositionFrame(compileComposition(f.document, [f.source]), 89);
		expect(f.document).toEqual(before);
	});
});
