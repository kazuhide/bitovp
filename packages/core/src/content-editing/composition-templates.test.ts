import { describe, expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import {
	applyCompositionTemplate,
	COMPOSITION_TEMPLATE_PRESETS,
	createCompositionVariants,
} from "./composition-templates";
import { compositionFixture } from "./composition-test-fixtures";

describe("editable composition templates", () => {
	it("creates bounded independent portrait/landscape/square variants with editable fields", () => {
		const { document, source } = compositionFixture();
		const variants = createCompositionVariants(document, [source]);
		expect(variants.map((v) => v.presetId)).toEqual([
			"portrait-clean",
			"landscape-clean",
			"square-clean",
		]);
		expect(variants.map((v) => v.document.canvas)).toEqual(
			COMPOSITION_TEMPLATE_PRESETS.map((p) => p.canvas),
		);
		const first = variants[0];
		if (!first) throw new Error("Missing variant");
		first.document.clips[0]?.framing.splice(0);
		expect(document.clips[0]?.framing).toHaveLength(1);
		expect(variants[1]?.document.clips[0]?.framing).toHaveLength(1);
	});
	it("retains center/zoom and source aspect for crop keyframes after an aspect change", () => {
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.framing = [
			{
				fromFrame: 0,
				toFrame: 90,
				mode: "CROP",
				origin: "EDITOR_CONFIRMED",
				rect: { x: 0.4, y: 0.25, w: 0.158203125, h: 0.5 },
			},
		];
		clip.cropKeyframes = [
			{
				frame: 0,
				rect: { x: 0.4, y: 0.25, w: 0.158203125, h: 0.5 },
				easing: "LINEAR",
			},
		];
		const result = applyCompositionTemplate(document, "landscape-clean", [
			source,
		]);
		expect(result.clips[0]?.framing[0]?.origin).toBe("MANUAL");
		const rect = result.clips[0]?.cropKeyframes?.[0]?.rect;
		expect(rect?.w).toBeCloseTo(0.5);
		expect(rect?.h).toBeCloseTo(0.5);
		expect((rect?.x ?? 0) + (rect?.w ?? 0) / 2).toBeCloseTo(0.4791015625);
		expect(() =>
			evaluateCompositionFrame(compileComposition(result, [source]), 0),
		).not.toThrow();
	});
	it("rejects unknown/duplicate/excess presets and missing geometry", () => {
		const { document, source } = compositionFixture();
		expect(() =>
			applyCompositionTemplate(document, "unknown", [source]),
		).toThrow("Unknown composition template");
		expect(() =>
			createCompositionVariants(
				document,
				[source],
				["portrait-clean", "portrait-clean"],
			),
		).toThrow(RangeError);
		expect(() =>
			applyCompositionTemplate(document, "landscape-clean", []),
		).toThrow("Missing source geometry");
	});
});
