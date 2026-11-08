import { describe, expect, it } from "vitest";
import {
	positionCropRect,
	suggestFixedCrop,
	suggestShotFraming,
} from "./framing";

const portrait = {
	sourceWidth: 1920,
	sourceHeight: 1080,
	targetWidth: 1080,
	targetHeight: 1920,
};

function proposal(box2d: unknown) {
	return suggestShotFraming({
		...portrait,
		mainSubjects: [{ centerX: 99, centerY: 99, box2d }],
		coordinateSpaceVerified: true,
	});
}

describe("manual fixed crop zoom", () => {
	it("keeps the legacy maximum crop exactly when zoom is omitted or one", () => {
		const input = { ...portrait, centerX: 0.7, centerY: 0.5 };
		const expected = { x: 0.541796875, y: 0, w: 0.31640625, h: 1 };
		expect(suggestFixedCrop(input)).toEqual(expected);
		expect(suggestFixedCrop({ ...input, zoom: 1 })).toEqual(expected);
	});
	it("shrinks around the same center without changing the target aspect", () => {
		const crop = suggestFixedCrop({
			...portrait,
			centerX: 0.5,
			centerY: 0.5,
			zoom: 2,
		});
		expect(crop).toEqual({
			x: 0.4208984375,
			y: 0.25,
			w: 0.158203125,
			h: 0.5,
		});
		expect((crop.w * 1920) / (crop.h * 1080)).toBeCloseTo(9 / 16, 12);
		expect(crop.x + crop.w / 2).toBe(0.5);
		expect(crop.y + crop.h / 2).toBe(0.5);
	});
	it.each([1.5, 3])("accepts fractional and maximum zoom %s", (zoom) => {
		const crop = suggestFixedCrop({
			...portrait,
			centerX: 0.5,
			centerY: 0.5,
			zoom,
		});
		expect(crop.w).toBeCloseTo(0.31640625 / zoom, 12);
		expect(crop.h).toBeCloseTo(1 / zoom, 12);
		expect(crop.x + crop.w / 2).toBeCloseTo(0.5, 12);
		expect(crop.y + crop.h / 2).toBeCloseTo(0.5, 12);
	});
	it.each([
		[0, 0],
		[0, 1],
		[1, 0],
		[1, 1],
	])("clamps a zoomed crop at frame edge (%s,%s)", (centerX, centerY) => {
		const crop = suggestFixedCrop({ ...portrait, centerX, centerY, zoom: 2 });
		expect(crop.w).toBe(0.158203125);
		expect(crop.h).toBe(0.5);
		expect(crop.x).toBe(centerX ? 1 - crop.w : 0);
		expect(crop.y).toBe(centerY ? 1 - crop.h : 0);
	});
	it("uses displayed geometry for landscape crops of portrait material", () => {
		expect(
			suggestFixedCrop({
				sourceWidth: 1080,
				sourceHeight: 1920,
				targetWidth: 1920,
				targetHeight: 1080,
				centerX: 0.5,
				centerY: 0.5,
				zoom: 2,
			}),
		).toEqual({ x: 0.25, y: 0.4208984375, w: 0.5, h: 0.158203125 });
	});
	it.each([
		0,
		-1,
		0.99,
		3.01,
		Number.NaN,
		Infinity,
		null,
		"2",
	])("rejects invalid zoom %j without coercion", (zoom) => {
		expect(() =>
			suggestFixedCrop({
				...portrait,
				centerX: 0.5,
				centerY: 0.5,
				zoom: zoom as number,
			}),
		).toThrow(RangeError);
	});
});

describe("source-pixel crop zoom limits", () => {
	const sourceSizes = [
		{ sourceWidth: 2, sourceHeight: 2 },
		{ sourceWidth: 2, sourceHeight: 6 },
		{ sourceWidth: 6, sourceHeight: 2 },
		{ sourceWidth: 2, sourceHeight: 1080 },
		{ sourceWidth: 1920, sourceHeight: 2 },
	];
	const targets = [
		{ targetWidth: 1080, targetHeight: 1920 },
		{ targetWidth: 1920, targetHeight: 1080 },
	];
	const geometries = sourceSizes.flatMap((source) =>
		targets.map((target) => ({ ...source, ...target })),
	);
	const centers = [
		{ centerX: 0, centerY: 0 },
		{ centerX: 0.25, centerY: 0.75 },
		{ centerX: 0.5, centerY: 0.5 },
		{ centerX: 0.499999, centerY: 0.500001 },
		{ centerX: 1, centerY: 1 },
	];
	it.each(
		geometries,
	)("keeps nonempty raster edges for $sourceWidth x $sourceHeight to $targetWidth x $targetHeight", (geometry) => {
		for (const zoom of [1, 1.125, 1.5, 2, 3]) {
			for (const center of centers) {
				const crop = suggestFixedCrop({ ...geometry, ...center, zoom });
				const left = Math.round(crop.x * geometry.sourceWidth);
				const top = Math.round(crop.y * geometry.sourceHeight);
				const right = Math.round((crop.x + crop.w) * geometry.sourceWidth);
				const bottom = Math.round((crop.y + crop.h) * geometry.sourceHeight);
				const context = JSON.stringify({ geometry, center, zoom, crop });
				expect(right - left, context).toBeGreaterThanOrEqual(1);
				expect(bottom - top, context).toBeGreaterThanOrEqual(1);
				expect(left, context).toBeGreaterThanOrEqual(0);
				expect(top, context).toBeGreaterThanOrEqual(0);
				expect(right, context).toBeLessThanOrEqual(geometry.sourceWidth);
				expect(bottom, context).toBeLessThanOrEqual(geometry.sourceHeight);
				expect(
					(crop.w * geometry.sourceWidth) / (crop.h * geometry.sourceHeight),
					context,
				).toBeCloseTo(geometry.targetWidth / geometry.targetHeight, 12);
			}
		}
	});
	it.each(
		geometries,
	)("repositions capped crops without resizing for $sourceWidth x $sourceHeight to $targetWidth x $targetHeight", (geometry) => {
		for (const zoom of [1, 1.5, 3]) {
			const rect = suggestFixedCrop({
				...geometry,
				centerX: 0.5,
				centerY: 0.5,
				zoom,
			});
			const before = JSON.stringify(rect);
			for (const center of centers) {
				const moved = positionCropRect({ ...geometry, ...center, rect });
				const left = Math.round(moved.x * geometry.sourceWidth);
				const top = Math.round(moved.y * geometry.sourceHeight);
				const right = Math.round((moved.x + moved.w) * geometry.sourceWidth);
				const bottom = Math.round((moved.y + moved.h) * geometry.sourceHeight);
				const context = JSON.stringify({ geometry, center, zoom, moved });
				expect(moved.w, context).toBe(rect.w);
				expect(moved.h, context).toBe(rect.h);
				expect(right - left, context).toBeGreaterThanOrEqual(1);
				expect(bottom - top, context).toBeGreaterThanOrEqual(1);
				expect(left, context).toBeGreaterThanOrEqual(0);
				expect(top, context).toBeGreaterThanOrEqual(0);
				expect(right, context).toBeLessThanOrEqual(geometry.sourceWidth);
				expect(bottom, context).toBeLessThanOrEqual(geometry.sourceHeight);
			}
			expect(JSON.stringify(rect)).toBe(before);
		}
	});
	it("retains a normal crop's exact size and clamps its requested center", () => {
		const rect = suggestFixedCrop({
			...portrait,
			centerX: 0.5,
			centerY: 0.5,
			zoom: 2,
		});
		expect(
			positionCropRect({ ...portrait, rect, centerX: 1, centerY: 0 }),
		).toEqual({
			x: 1 - rect.w,
			y: 0,
			w: rect.w,
			h: rect.h,
		});
	});
	it.each([
		{ sourceWidth: 0 },
		{ centerX: 2 },
		{ centerY: Number.NaN },
		{ rect: { x: 0, y: 0, w: 0, h: 0.5 } },
		{ rect: { x: 0.9, y: 0, w: 0.2, h: 0.5 } },
	])("rejects invalid reposition input without inventing a new crop %#", (invalid) => {
		expect(() =>
			positionCropRect({
				...portrait,
				rect: { x: 0.4, y: 0.25, w: 0.15, h: 0.5 },
				centerX: 0.5,
				centerY: 0.5,
				...invalid,
			}),
		).toThrow();
	});
	it("returns the attainable zoom rather than a requested three on 2 x 2 material", () => {
		const geometry = { ...portrait, sourceWidth: 2, sourceHeight: 2 };
		const center = { centerX: 0.5, centerY: 0.5 };
		const maximum = suggestFixedCrop({ ...geometry, ...center });
		const crop = suggestFixedCrop({ ...geometry, ...center, zoom: 3 });
		expect(maximum.w / crop.w).toBe(1.125);
		expect(crop.w).toBe(0.5);
		expect(crop.h).toBeCloseTo(8 / 9, 12);
		expect(crop.x + crop.w / 2).toBe(0.5);
		expect(crop.y + crop.h / 2).toBeCloseTo(0.5, 12);
	});
	it("preserves the maximum crop when a generic target cannot fit a full source pixel", () => {
		const input = {
			sourceWidth: 2,
			sourceHeight: 2,
			targetWidth: 1,
			targetHeight: 100,
			centerX: 0.5,
			centerY: 0.5,
		};
		expect(suggestFixedCrop({ ...input, zoom: 3 })).toEqual(
			suggestFixedCrop(input),
		);
	});
	it.each(
		targets.flatMap((target) =>
			[
				[490, 490, 510, 510],
				[0, 0, 1, 1],
				[999, 999, 1000, 1000],
			].map((box2d) => ({ ...target, box2d })),
		),
	)("keeps tiny bbox proposals nonempty on 2 x 2 material %#", ({
		box2d,
		...target
	}) => {
		const result = suggestShotFraming({
			sourceWidth: 2,
			sourceHeight: 2,
			...target,
			mainSubjects: [{ box2d }],
			coordinateSpaceVerified: true,
		});
		if (result.mode !== "CROP") throw new Error("Expected crop");
		const { x, y, w, h } = result.rect;
		expect(Math.round((x + w) * 2) - Math.round(x * 2)).toBeGreaterThanOrEqual(
			1,
		);
		expect(Math.round((y + h) * 2) - Math.round(y * 2)).toBeGreaterThanOrEqual(
			1,
		);
	});
});

describe("subject box fixed framing", () => {
	it("uses y/x box bounds ahead of percent centers with 80 percent occupancy", () => {
		const result = proposal([300, 650, 500, 750]);
		expect(result).toMatchObject({
			mode: "CROP",
			origin: "AISA_PROPOSAL",
			requiresConfirmation: true,
			reasonCode: "SINGLE_SUBJECT",
		});
		if (result.mode !== "CROP") throw new Error("Expected crop");
		expect(result.rect.w).toBeCloseTo(0.125, 12);
		expect(result.rect.h).toBeCloseTo(0.125 / 0.31640625, 12);
		expect(result.rect.x + result.rect.w / 2).toBeCloseTo(0.7, 12);
		expect(result.rect.y + result.rect.h / 2).toBeCloseTo(0.4, 12);
		expect(0.1 / result.rect.w).toBeCloseTo(0.8, 12);
	});
	it("fits a tall subject plus margin and keeps the output aspect", () => {
		const result = proposal([300, 500, 700, 580]);
		if (result.mode !== "CROP") throw new Error("Expected crop");
		expect(result.rect.x).toBeCloseTo(0.4608984375, 12);
		expect(result.rect).toMatchObject({
			y: 0.25,
			w: 0.158203125,
			h: 0.5,
		});
		expect((result.rect.w * 1920) / (result.rect.h * 1080)).toBeCloseTo(
			9 / 16,
			12,
		);
	});
	it("transposes the physical axes for a landscape target", () => {
		const result = suggestShotFraming({
			sourceWidth: 1080,
			sourceHeight: 1920,
			targetWidth: 1920,
			targetHeight: 1080,
			mainSubjects: [{ box2d: [650, 300, 750, 500] }],
			coordinateSpaceVerified: true,
		});
		if (result.mode !== "CROP") throw new Error("Expected crop");
		expect(result.rect.h).toBeCloseTo(0.125, 12);
		expect(result.rect.w).toBeCloseTo(0.125 / 0.31640625, 12);
		expect(result.rect.x + result.rect.w / 2).toBeCloseTo(0.4, 12);
		expect(result.rect.y + result.rect.h / 2).toBeCloseTo(0.7, 12);
	});
	it("limits a tiny box to three times the maximum crop", () => {
		const result = proposal([490, 490, 510, 510]);
		if (result.mode !== "CROP") throw new Error("Expected crop");
		expect(result.rect.w).toBeCloseTo(0.10546875, 12);
		expect(result.rect.h).toBeCloseTo(1 / 3, 12);
		expect(result.rect.x + result.rect.w / 2).toBeCloseTo(0.5, 12);
		expect(result.rect.y + result.rect.h / 2).toBeCloseTo(0.5, 12);
	});
	it("keeps edge subjects inside the frame even when symmetric margin is unavailable", () => {
		const result = proposal([100, 0, 400, 100]);
		if (result.mode !== "CROP") throw new Error("Expected crop");
		expect(result.rect.x).toBe(0);
		expect(result.rect.w).toBeCloseTo(0.125, 12);
		expect(result.rect.y).toBeLessThanOrEqual(0.1);
		expect(result.rect.y + result.rect.h).toBeGreaterThanOrEqual(0.4);
		expect(result.rect.x + result.rect.w).toBeLessThanOrEqual(1);
	});
	it("uses the full maximum crop when only margin would exceed the frame", () => {
		const result = proposal([0, 342, 1000, 658]);
		expect(result).toMatchObject({
			mode: "CROP",
			rect: { x: 0.341796875, y: 0, w: 0.31640625, h: 1 },
		});
	});
	it.each([
		{ ...portrait, box2d: [100, 0, 900, 1000] },
		{
			sourceWidth: 1080,
			sourceHeight: 1920,
			targetWidth: 1920,
			targetHeight: 1080,
			box2d: [0, 100, 1000, 900],
		},
	])("returns explicit FIT instead of cutting an oversized subject %#", ({
		box2d,
		...geometry
	}) => {
		expect(
			suggestShotFraming({
				...geometry,
				mainSubjects: [{ centerX: 50, centerY: 50, box2d }],
				coordinateSpaceVerified: true,
			}),
		).toEqual({
			mode: "FIT",
			origin: "AISA_PROPOSAL",
			requiresConfirmation: true,
			reasonCode: "SUBJECT_BOX_TOO_LARGE",
		});
	});
	it.each(
		[undefined, null, []].map((box2d) => ({ box2d })),
	)("preserves center-only framing for absent box %j", ({ box2d }) => {
		expect(
			suggestShotFraming({
				...portrait,
				mainSubjects: [{ centerX: 70, centerY: 50, box2d }],
				coordinateSpaceVerified: true,
			}),
		).toMatchObject({
			mode: "CROP",
			rect: { x: 0.541796875, y: 0, w: 0.31640625, h: 1 },
			reasonCode: "SINGLE_SUBJECT",
		});
	});
	it.each([
		[0, 0, 1001, 1000],
		[800, 100, 200, 700],
		[200, 700, 800, 100],
		[0, 0, 0, 1000],
		[0, 0.5, 1000, 1000],
		[0, 0, 1000],
	])("rejects malformed nonempty boxes instead of using a center %#", (...box2d) => {
		expect(() => proposal(box2d)).toThrow(RangeError);
	});
	it("still requires explicit subject selection and verified display coordinates", () => {
		const input = {
			...portrait,
			mainSubjects: [
				{ box2d: [300, 650, 500, 750] },
				{ box2d: [100, 0, 900, 1000] },
			],
			coordinateSpaceVerified: true,
		};
		expect(suggestShotFraming(input)).toMatchObject({
			mode: "FIT",
			reasonCode: "SUBJECT_SELECTION_REQUIRED",
		});
		expect(suggestShotFraming({ ...input, subjectIndex: 0 })).toMatchObject({
			mode: "CROP",
			reasonCode: "SUBJECT_SELECTED",
		});
		expect(suggestShotFraming({ ...input, subjectIndex: 1 })).toMatchObject({
			mode: "FIT",
			reasonCode: "SUBJECT_BOX_TOO_LARGE",
		});
		expect(
			suggestShotFraming({
				...input,
				subjectIndex: 0,
				coordinateSpaceVerified: false,
			}),
		).toMatchObject({ mode: "FIT", reasonCode: "DISPLAY_GEOMETRY_UNVERIFIED" });
	});
});
