import { expect, it } from "vitest";
import { resolveCompositionGeometry } from "./composition-geometry";
import type { CompositionClip } from "./composition-schema";

const source = {
	sourceWidth: 1920,
	sourceHeight: 1080,
	width: 1080,
	height: 1920,
};
it("keeps encoder-rounded FIT padding and crop edges in the output clock", () => {
	expect(
		resolveCompositionGeometry({
			...source,
			frame: 0,
			framing: { mode: "FIT" },
		}),
	).toMatchObject({
		sourceRect: { x: 0, y: 0, w: 1920, h: 1080 },
		drawRect: { x: 0, y: 656, w: 1080, h: 608 },
	});
	expect(
		resolveCompositionGeometry({
			...source,
			frame: 0,
			framing: { mode: "CROP", rect: { x: 0.3333, y: 0, w: 0.3164, h: 1 } },
		}),
	).toMatchObject({
		sourceRect: { x: 640, y: 0, w: 607, h: 1080 },
		drawRect: { x: 0, y: 0, w: 1080, h: 1920 },
	});
});
it("interpolates actual crop position and size with linear or smoothstep easing", () => {
	const first: NonNullable<CompositionClip["cropKeyframes"]>[number] = {
		frame: 0,
		rect: { x: 0, y: 0, w: 0.2, h: 0.5 },
		easing: "LINEAR",
	};
	const last: NonNullable<CompositionClip["cropKeyframes"]>[number] = {
		frame: 8,
		rect: { x: 0.6, y: 0.5, w: 0.4, h: 0.5 },
		easing: "LINEAR",
	};
	const keys = [first, last];
	const at = (frame: number) =>
		resolveCompositionGeometry({
			...source,
			frame,
			framing: { mode: "CROP", rect: first.rect },
			cropKeyframes: keys,
		});
	expect(at(2).cropRect).toEqual({ x: 0.15, y: 0.125, w: 0.25, h: 0.5 });
	first.easing = "SMOOTH";
	expect(at(2).cropRect).toMatchObject({
		x: 0.09375,
		y: 0.078125,
		w: 0.23125,
		h: 0.5,
	});
	expect(at(9).cropRect).toEqual(last.rect);
});
it("never applies crop animation through an explicit FIT fallback interval", () => {
	expect(
		resolveCompositionGeometry({
			...source,
			frame: 10,
			framing: { mode: "FIT" },
			cropKeyframes: [
				{
					frame: 0,
					rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
					easing: "LINEAR",
				},
			],
		}).mode,
	).toBe("FIT");
});
it("places a video in its rounded output layout and supports one-pixel sources", () => {
	const geometry = resolveCompositionGeometry({
		sourceWidth: 2,
		sourceHeight: 2,
		width: 1080,
		height: 1920,
		frame: 0,
		layout: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
		framing: { mode: "CROP", rect: { x: 0.25, y: 0, w: 0.5, h: 1 } },
	});
	expect(geometry.sourceRect).toEqual({ x: 1, y: 0, w: 1, h: 2 });
	expect(geometry.layoutRect).toEqual({ x: 648, y: 192, w: 324, h: 576 });
	expect(geometry.drawRect).toEqual(geometry.layoutRect);
});
it("repairs half-pixel cancellation without shrinking an actual one-pixel crop", () => {
	const geometry = resolveCompositionGeometry({
		sourceWidth: 2,
		sourceHeight: 1080,
		width: 1920,
		height: 1080,
		frame: 0,
		framing: {
			mode: "CROP",
			rect: { x: 0, y: 0.749537037037037, w: 8 / 9, h: 1 / 1080 },
		},
	});
	expect(geometry.sourceRect.h).toBeGreaterThanOrEqual(1);
});
it("rejects sub-pixel crop sizes and zero-pixel layouts", () => {
	expect(() =>
		resolveCompositionGeometry({
			...source,
			frame: 0,
			framing: { mode: "CROP", rect: { x: 0, y: 0, w: 0.00001, h: 1 } },
		}),
	).toThrow();
	expect(() =>
		resolveCompositionGeometry({
			...source,
			frame: 0,
			framing: { mode: "FIT" },
			layout: { x: 0, y: 0, w: 0.00001, h: 1 },
		}),
	).toThrow();
});
