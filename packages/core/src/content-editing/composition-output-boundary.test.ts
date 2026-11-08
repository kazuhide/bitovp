import { describe, expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import {
	compositionOutputRect,
	compositionPixelRect,
} from "./composition-geometry";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";

describe("subpixel preview output layouts", () => {
	it("retains valid one-export-pixel video layouts at both preview edges", () => {
		for (const edge of [0, 1]) {
			const { document, source } = compositionFixture();
			const clip = document.clips[0];
			if (!clip) throw new Error("Missing clip");
			clip.layout = {
				x: edge * (1 - 1 / 1080),
				y: edge * (1 - 1 / 1920),
				w: 1 / 1080,
				h: 1 / 1920,
			};
			const plan = compileComposition(document, [source]);
			expect(
				evaluateCompositionFrame(plan, 0).layers[0]?.layoutRect,
			).toMatchObject({ w: 1, h: 1 });
			expect(
				evaluateCompositionFrame(plan, 0, { width: 360, height: 640 }).layers[0]
					?.layoutRect,
			).toEqual({ x: edge * 359, y: edge * 639, w: 1, h: 1 });
		}
	});
	it("keeps one-pixel image, text, and caption layouts visible and within preview bounds", () => {
		const { document, source } = compositionFixture();
		const rect = { x: 1 - 1 / 1080, y: 1 - 1 / 1920, w: 1 / 1080, h: 1 / 1920 };
		document.imageAssets = [{ id: ids.other }];
		document.captionLayout = rect;
		document.captions = [
			{ id: ids.otherMap, fromFrame: 0, toFrame: 1, text: "猫" },
		];
		document.overlays = [
			{
				id: ids.item,
				kind: "IMAGE",
				assetId: ids.other,
				fromFrame: 0,
				toFrame: 1,
				rect,
				opacity: 1,
				zIndex: 1,
			},
			{
				id: ids.otherMap,
				kind: "TEXT",
				text: "猫",
				fromFrame: 0,
				toFrame: 1,
				rect,
				opacity: 1,
				zIndex: 2,
			},
		];
		const frame = evaluateCompositionFrame(
			compileComposition(document, [source]),
			0,
			{ width: 360, height: 640 },
		);
		expect(frame.captions[0]?.rect).toEqual({ x: 359, y: 639, w: 1, h: 1 });
		expect(frame.overlays.map((item) => item.pixelRect)).toEqual([
			{ x: 359, y: 639, w: 1, h: 1 },
			{ x: 359, y: 639, w: 1, h: 1 },
		]);
	});
	it("preserves strict source-crop pixel rejection and validates output dimensions", () => {
		const tiny = { x: 0, y: 0, w: 0.001, h: 0.001 };
		expect(() => compositionPixelRect(tiny, 100, 100)).toThrow("Empty");
		expect(
			compositionOutputRect(tiny, 100, 100, { width: 1000, height: 1000 }),
		).toEqual({
			x: 0,
			y: 0,
			w: 1,
			h: 1,
		});
		expect(() => compositionOutputRect(tiny, 0, 100)).toThrow();
		const { document, source } = compositionFixture();
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing clip");
		clip.framing = [
			{
				fromFrame: 0,
				toFrame: 90,
				mode: "CROP",
				origin: "MANUAL",
				rect: { x: 0, y: 0, w: 0.1 / source.width, h: 0.1 / source.height },
			},
		];
		expect(() => compileComposition(document, [source])).toThrow(
			"source pixel",
		);
	});
});
