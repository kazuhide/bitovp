import type { CompositionClip } from "./composition-schema";
import { positionCropRect } from "./framing";
import { type NormalizedCropRect, normalizedCropRectSchema } from "./schema";

export type PixelRect = { x: number; y: number; w: number; h: number };
/** Decorative pixels from the same video frame, clipped behind its foreground. */
export type CompositionVideoBackdrop = {
	kind: "BLUR";
	sourceRect: PixelRect;
	drawRect: PixelRect;
	clipRect: PixelRect;
	blurPx: number;
	shadeOpacity: 0.35;
};
export type CompositionVideoGeometry = {
	mode: "FIT" | "CROP";
	layoutRect: PixelRect;
	sourceRect: PixelRect;
	drawRect: PixelRect;
	cropRect?: NormalizedCropRect;
	backdrop?: CompositionVideoBackdrop;
};
export function compositionPixelRect(
	rect: NormalizedCropRect,
	width: number,
	height: number,
): PixelRect {
	const parsed = normalizedCropRectSchema.parse(rect);
	const x = Math.round(parsed.x * width);
	const y = Math.round(parsed.y * height);
	const w = Math.round((parsed.x + parsed.w) * width) - x;
	const h = Math.round((parsed.y + parsed.h) * height) - y;
	if (w < 1 || h < 1 || x < 0 || y < 0 || x + w > width || y + h > height)
		throw new RangeError("Empty or out-of-frame composition rectangle");
	return { x, y, w, h };
}
/** Output downscaling keeps a valid export layout at least one preview pixel. */
export function compositionOutputRect(
	rect: NormalizedCropRect,
	width: number,
	height: number,
	reference?: { width: number; height: number },
): PixelRect {
	if (
		![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
	)
		throw new RangeError("Invalid output dimensions");
	compositionPixelRect(
		rect,
		reference?.width ?? width,
		reference?.height ?? height,
	);
	const parsed = normalizedCropRectSchema.parse(rect);
	const x = Math.min(width - 1, Math.round(parsed.x * width));
	const y = Math.min(height - 1, Math.round(parsed.y * height));
	const right = Math.max(
		x + 1,
		Math.min(width, Math.round((parsed.x + parsed.w) * width)),
	);
	const bottom = Math.max(
		y + 1,
		Math.min(height, Math.round((parsed.y + parsed.h) * height)),
	);
	return { x, y, w: right - x, h: bottom - y };
}
export function interpolateCompositionCrop(
	keys: NonNullable<CompositionClip["cropKeyframes"]>,
	frame: number,
	fallback: NormalizedCropRect,
): NormalizedCropRect {
	if (!keys.length) return { ...fallback };
	const first = keys[0];
	const last = keys.at(-1);
	if (!first || !last) return { ...fallback };
	if (frame <= first.frame) return { ...first.rect };
	if (frame >= last.frame) return { ...last.rect };
	const index = keys.findIndex((key) => key.frame > frame);
	const left = keys[index - 1];
	const right = keys[index];
	if (!left || !right) throw new RangeError("Invalid crop keyframe interval");
	let p = (frame - left.frame) / (right.frame - left.frame);
	if (left.easing === "SMOOTH") {
		const ease = (v: number) => v * v * (3 - 2 * v);
		const start = left.curveStart ?? 0;
		const end = left.curveEnd ?? 1;
		p =
			(ease(start + (end - start) * p) - ease(start)) /
			(ease(end) - ease(start));
	}
	const lerp = (a: number, b: number) => a + (b - a) * p;
	return {
		x: lerp(left.rect.x, right.rect.x),
		y: lerp(left.rect.y, right.rect.y),
		w: lerp(left.rect.w, right.rect.w),
		h: lerp(left.rect.h, right.rect.h),
	};
}

/** This rounded geometry is consumed unchanged by the canvas and FFmpeg program. */
export function resolveCompositionGeometry(input: {
	sourceWidth: number;
	sourceHeight: number;
	width: number;
	height: number;
	frame: number;
	layout?: NormalizedCropRect;
	outputReference?: { width: number; height: number };
	framing: { mode: "FIT" } | { mode: "CROP"; rect: NormalizedCropRect };
	cropKeyframes?: CompositionClip["cropKeyframes"];
}): CompositionVideoGeometry {
	if (
		![input.sourceWidth, input.sourceHeight, input.width, input.height].every(
			(n) => Number.isSafeInteger(n) && n > 0,
		) ||
		!Number.isFinite(input.frame)
	)
		throw new RangeError("Invalid composition geometry");
	const layoutRect = compositionOutputRect(
		input.layout ?? { x: 0, y: 0, w: 1, h: 1 },
		input.width,
		input.height,
		input.outputReference,
	);
	if (input.framing.mode === "CROP") {
		let cropRect = interpolateCompositionCrop(
			input.cropKeyframes ?? [],
			input.frame,
			input.framing.rect,
		);
		if (
			cropRect.w * input.sourceWidth < 1 - 4 * Number.EPSILON ||
			cropRect.h * input.sourceHeight < 1 - 4 * Number.EPSILON
		)
			throw new RangeError("Crop must retain a source pixel");
		let sourceRect: PixelRect;
		try {
			sourceRect = compositionPixelRect(
				cropRect,
				input.sourceWidth,
				input.sourceHeight,
			);
		} catch {
			cropRect = positionCropRect({
				sourceWidth: input.sourceWidth,
				sourceHeight: input.sourceHeight,
				rect: cropRect,
				centerX: cropRect.x + cropRect.w / 2,
				centerY: cropRect.y + cropRect.h / 2,
			});
			sourceRect = compositionPixelRect(
				cropRect,
				input.sourceWidth,
				input.sourceHeight,
			);
		}
		return {
			mode: "CROP",
			layoutRect,
			sourceRect,
			drawRect: { ...layoutRect },
			cropRect,
		};
	}
	const even = (value: number, maximum: number) =>
		Math.max(
			Math.min(2, maximum),
			Math.floor(Math.min(maximum, value) / 2) * 2,
		);
	const w = even(
		Math.round((layoutRect.h * input.sourceWidth) / input.sourceHeight),
		layoutRect.w,
	);
	const h = even(
		Math.round((layoutRect.w * input.sourceHeight) / input.sourceWidth),
		layoutRect.h,
	);
	return {
		mode: "FIT",
		layoutRect,
		sourceRect: { x: 0, y: 0, w: input.sourceWidth, h: input.sourceHeight },
		drawRect: {
			x: layoutRect.x + Math.floor((layoutRect.w - w) / 4) * 2,
			y: layoutRect.y + Math.floor((layoutRect.h - h) / 4) * 2,
			w,
			h,
		},
	};
}
