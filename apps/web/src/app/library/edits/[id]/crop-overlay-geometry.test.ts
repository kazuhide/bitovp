import { normalizedCropRectSchema, toCompositionDocument } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { editingProjectFixture } from "../editing-fixtures";
import {
	type CropHandle,
	cropFromDelta,
	cropFromKey,
	isCropOverlayRect,
} from "./crop-overlay-geometry";
import { applyDirectCrop, describeDirectCrop } from "./direct-crop-model";

const source = { width: 2000, height: 1000 };
const rect = { x: 0.25, y: 0.2, w: 0.25, h: 0.5 };

describe("source crop overlay geometry", () => {
	it.each([
		{ width: 1600, height: 714, x: 946 },
		{ width: 1920, height: 1080, x: 946 },
		{ width: 1080, height: 1920, x: 600 },
	])("keeps all resized integer-pixel edges inside $width x $height without weakening validity", (source) => {
		const base = {
			x: source.x / source.width,
			y: 118 / source.height,
			w: 249 / source.width,
			h: 443 / source.height,
		};
		expect(isCropOverlayRect(base, source)).toBe(true);
		for (const corner of ["nw", "ne", "sw", "se"] as const) {
			const next = cropFromDelta(
				base,
				corner,
				corner.endsWith("w") ? -0.05 : 0.05,
				0,
				source,
			);
			expect(next.x).toBeGreaterThanOrEqual(0);
			expect(next.y).toBeGreaterThanOrEqual(0);
			expect(next.x + next.w).toBeLessThanOrEqual(1);
			expect(next.y + next.h).toBeLessThanOrEqual(1);
			expect(next.w / next.h).toBeCloseTo(base.w / base.h, 12);
			expect(isCropOverlayRect(next, source)).toBe(true);
			expect(normalizedCropRectSchema.safeParse(next).success).toBe(true);
		}
	});

	it("applies the reported NE top-edge resize through the strict production crop model", () => {
		const source = { width: 1600, height: 714 },
			base = { x: 946 / 1600, y: 118 / 714, w: 249 / 1600, h: 443 / 714 },
			project = editingProjectFixture(),
			document = toCompositionDocument(project.draft),
			clip = document.clips[0];
		if (!clip || !project.media.timeMap) throw Error("Missing fixture");
		clip.framing = [
			{
				fromFrame: 0,
				toFrame: 300,
				mode: "CROP",
				origin: "MANUAL",
				rect: base,
			},
		];
		delete clip.cropKeyframes;
		const facts = {
				...source,
				mediaVersionId: document.mediaVersionId,
				timeMap: project.media.timeMap,
				hasAudio: true,
			},
			before = structuredClone(document),
			view = describeDirectCrop(document, [facts], clip.id, 20);
		if (!view) throw Error("Missing crop description");
		expect(view.rect).toEqual(base);
		const request = cropFromDelta(view.rect, "ne", 0.05, 0, source);
		expect(request.y).toBe(0);
		expect(isCropOverlayRect(request, source)).toBe(true);
		expect(normalizedCropRectSchema.safeParse(request).success).toBe(true);
		const next = applyDirectCrop(document, [facts], clip.id, 20, request);
		expect(next).not.toBe(document);
		expect(describeDirectCrop(next, [facts], clip.id, 20)?.rect.y).toBe(0);
		expect(document).toEqual(before);
	});

	it("continues to reject a negative epsilon instead of broadening crop validation", () => {
		const negative = { ...rect, y: -Number.EPSILON };
		expect(isCropOverlayRect(negative, source)).toBe(false);
		expect(normalizedCropRectSchema.safeParse(negative).success).toBe(false);
	});
	it("moves in normalized source coordinates and keeps the crop size", () => {
		expect(cropFromDelta(rect, "move", 0.1, 0.1, source)).toEqual({
			x: 0.35,
			y: 0.30000000000000004,
			w: 0.25,
			h: 0.5,
		});
		expect(cropFromDelta(rect, "move", 10, -10, source)).toEqual({
			x: 0.75,
			y: 0,
			w: 0.25,
			h: 0.5,
		});
	});
	it.each([
		["nw", 0.5, 0.7],
		["ne", 0.25, 0.7],
		["sw", 0.5, 0.2],
		["se", 0.25, 0.2],
	] as const)("resizes %s around the opposite corner without changing aspect", (handle, anchorX, anchorY) => {
		const next = cropFromDelta(rect, handle, 0.07, -0.04, source);
		expect(next.w / next.h).toBeCloseTo(rect.w / rect.h, 12);
		expect(handle.endsWith("w") ? next.x + next.w : next.x).toBeCloseTo(
			anchorX,
			12,
		);
		expect(handle.startsWith("n") ? next.y + next.h : next.y).toBeCloseTo(
			anchorY,
			12,
		);
		expect(isCropOverlayRect(next, source)).toBe(true);
	});
	it.each([
		"nw",
		"ne",
		"sw",
		"se",
	] as const)("clamps %s expansion to the source and contraction to at least one pixel", (handle) => {
		for (const delta of [-100, 100]) {
			const next = cropFromDelta(rect, handle, delta, delta, source);
			expect(isCropOverlayRect(next, source)).toBe(true);
			expect(next.w / next.h).toBeCloseTo(0.5, 12);
			expect(next.w * source.width).toBeGreaterThanOrEqual(1 - 1e-9);
			expect(next.h * source.height).toBeGreaterThanOrEqual(1 - 1e-9);
		}
	});
	it("keeps the original value for zero delta and ignores unrelated keyboard keys", () => {
		for (const handle of ["move", "nw", "ne", "sw", "se"] as CropHandle[])
			expect(cropFromDelta(rect, handle, 0, 0, source)).toBe(rect);
		expect(cropFromKey(rect, "move", "Enter", false, source)).toBeNull();
	});
	it("offers one source pixel keyboard steps and ten pixel Shift steps", () => {
		expect(cropFromKey(rect, "move", "ArrowRight", false, source)?.x).toBe(
			0.2505,
		);
		expect(cropFromKey(rect, "move", "ArrowUp", true, source)?.y).toBe(0.19);
		const next = cropFromKey(rect, "se", "ArrowRight", false, source);
		expect(next?.w).toBeCloseTo(0.2505, 12);
		expect((next?.w ?? 0) / (next?.h ?? 1)).toBeCloseTo(0.5, 12);
	});
	it.each([
		0,
		-1,
		Number.NaN,
		Infinity,
	])("rejects invalid source dimensions %s", (width) => {
		expect(isCropOverlayRect(rect, { width, height: 1000 })).toBe(false);
		expect(() =>
			cropFromDelta(rect, "move", 0, 0, { width, height: 1000 }),
		).toThrow(RangeError);
	});
	it("rejects out-of-bounds and non-finite requests without changing the input", () => {
		const before = structuredClone(rect);
		expect(() => cropFromDelta(rect, "move", Number.NaN, 0, source)).toThrow(
			RangeError,
		);
		expect(isCropOverlayRect({ ...rect, x: 0.9 }, source)).toBe(false);
		expect(rect).toEqual(before);
	});
	it("retains bounded rectangles at real source edges after large diagonal gestures", () => {
		for (const size of [
			{ width: 1600, height: 714 },
			{ width: 1920, height: 1080 },
			{ width: 1080, height: 1920 },
		]) {
			for (const base of [
				{ x: 0, y: 0, w: 402 / size.width, h: 1 },
				{ x: 1 - 402 / size.width, y: 0, w: 402 / size.width, h: 1 },
				{ x: 0.1, y: 0.2, w: 0.35, h: 0.4 },
			]) {
				for (const handle of ["nw", "ne", "sw", "se"] as const) {
					for (const [dx, dy] of [
						[-3, 2],
						[2, -3],
						[3, 3],
						[-3, -3],
					]) {
						const next = cropFromDelta(base, handle, dx ?? 0, dy ?? 0, size);
						expect(isCropOverlayRect(next, size)).toBe(true);
						expect(next.x).toBeGreaterThanOrEqual(0);
						expect(next.y).toBeGreaterThanOrEqual(0);
						expect(next.x + next.w).toBeLessThanOrEqual(1 + 1e-12);
						expect(next.y + next.h).toBeLessThanOrEqual(1 + 1e-12);
						expect(next.w / next.h).toBeCloseTo(base.w / base.h, 12);
					}
				}
			}
		}
	});
});
