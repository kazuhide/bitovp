import { describe, expect, it } from "vitest";
import { applyCompositionTemplate } from "./composition-templates";
import { compositionFixture } from "./composition-test-fixtures";

const crop = { x: 0.4208984375, y: 0.25, w: 0.158203125, h: 0.5 };
function fixture() {
	const f = compositionFixture(),
		clip = f.document.clips[0];
	if (!clip) throw Error("Missing clip");
	clip.fallbackCrop = { ...crop };
	clip.framing = [
		{
			fromFrame: 0,
			toFrame: 90,
			mode: "CROP",
			origin: "MANUAL",
			rect: { ...crop },
		},
	];
	clip.cropKeyframes = [
		{ frame: 0, rect: { ...crop }, easing: "LINEAR" },
		{ frame: 89, rect: { ...crop, x: 0.6208984375 }, easing: "SMOOTH" },
	];
	f.document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
		fallbackFraming: "AISA_STATIC_V1",
		centerCropConfirmed: true,
	};
	return { ...f, clip };
}
describe("static fallback template aspect", () => {
	it.each([
		["portrait-clean", crop],
		["landscape-clean", { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }],
		["square-clean", { x: 0.359375, y: 0.25, w: 0.28125, h: 0.5 }],
	] as const)("keeps the centre and2x zoom when applying %s", (preset, expected) => {
		const f = fixture(),
			before = structuredClone(f.document),
			doc = applyCompositionTemplate(f.document, preset, [f.source]);
		expect(doc.clips[0]?.fallbackCrop).toEqual(expected);
		expect(doc.clips[0]?.cropKeyframes?.[0]?.rect).toEqual(expected);
		expect(doc.clips[0]?.framing[0]).toHaveProperty("rect", expected);
		const rect = doc.clips[0]?.fallbackCrop;
		if (!rect) throw Error("Missing fallback");
		expect((rect.w * f.source.width) / (rect.h * f.source.height)).toBeCloseTo(
			doc.canvas.width / doc.canvas.height,
			10,
		);
		expect(f.document).toEqual(before);
	});
	it("resets confirmation for a changed static fallback while leaving the same-aspect confirmation intact", () => {
		const f = fixture();
		expect(
			applyCompositionTemplate(f.document, "landscape-clean", [f.source])
				.presentation?.centerCropConfirmed,
		).toBe(false);
		expect(
			applyCompositionTemplate(f.document, "portrait-clean", [f.source])
				.presentation?.centerCropConfirmed,
		).toBe(true);
	});
	it("leaves missing legacy fallback fields and their existing confirmation untouched", () => {
		const f = fixture();
		delete f.clip.fallbackCrop;
		if (!f.document.presentation) throw Error("Missing presentation");
		delete f.document.presentation.fallbackFraming;
		const doc = applyCompositionTemplate(f.document, "landscape-clean", [
			f.source,
		]);
		expect(Object.hasOwn(doc.clips[0] ?? {}, "fallbackCrop")).toBe(false);
		expect(doc.presentation).toEqual(f.document.presentation);
	});
});
