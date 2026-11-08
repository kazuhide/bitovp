export type CropOverlayRect = { x: number; y: number; w: number; h: number };
export type CropSourceSize = { width: number; height: number };
export type CropHandle = "move" | "nw" | "ne" | "sw" | "se";

const clamp = (value: number, low: number, high: number) =>
	Math.max(low, Math.min(high, value));

export function sameCropOverlayRect(a: CropOverlayRect, b: CropOverlayRect) {
	return (["x", "y", "w", "h"] as const).every(
		(key) => Math.abs(a[key] - b[key]) < 1e-12,
	);
}

export function isCropOverlayRect(
	rect: CropOverlayRect | null,
	source: CropSourceSize | null,
): rect is CropOverlayRect {
	return Boolean(
		source &&
			Number.isSafeInteger(source.width) &&
			source.width > 0 &&
			Number.isSafeInteger(source.height) &&
			source.height > 0 &&
			rect &&
			Object.values(rect).every(Number.isFinite) &&
			rect.x >= 0 &&
			rect.y >= 0 &&
			rect.w > 0 &&
			rect.h > 0 &&
			rect.x + rect.w <= 1 + 1e-12 &&
			rect.y + rect.h <= 1 + 1e-12 &&
			rect.w * source.width >= 1 - 1e-9 &&
			rect.h * source.height >= 1 - 1e-9,
	);
}

/** Deltas are normalized to the whole displayed source, never the result canvas. */
export function cropFromDelta(
	rect: CropOverlayRect,
	handle: CropHandle,
	dx: number,
	dy: number,
	source: CropSourceSize,
): CropOverlayRect {
	if (
		!isCropOverlayRect(rect, source) ||
		!Number.isFinite(dx) ||
		!Number.isFinite(dy)
	)
		throw new RangeError("Invalid source crop gesture");
	let next: CropOverlayRect;
	if (handle === "move") {
		next = {
			...rect,
			x: clamp(rect.x + dx, 0, 1 - rect.w),
			y: clamp(rect.y + dy, 0, 1 - rect.h),
		};
	} else {
		const west = handle.endsWith("w"),
			north = handle.startsWith("n");
		const anchorX = clamp(west ? rect.x + rect.w : rect.x, 0, 1);
		const anchorY = clamp(north ? rect.y + rect.h : rect.y, 0, 1);
		const changeX = (west ? -dx : dx) / rect.w;
		const changeY = (north ? -dy : dy) / rect.h;
		const requested =
			1 + (Math.abs(changeX) >= Math.abs(changeY) ? changeX : changeY);
		const minimum = Math.max(
			1 / (rect.w * source.width),
			1 / (rect.h * source.height),
		);
		const maximum = Math.min(
			(west ? anchorX : 1 - anchorX) / rect.w,
			(north ? anchorY : 1 - anchorY) / rect.h,
		);
		const scale = clamp(requested, minimum, maximum);
		const w = rect.w * scale,
			h = rect.h * scale;
		// Anchored subtraction can cross zero by one floating-point tick.
		// Bound both edges first, then derive the spans without relaxing validation.
		const left = west ? Math.max(0, anchorX - w) : anchorX;
		const top = north ? Math.max(0, anchorY - h) : anchorY;
		const right = west ? anchorX : Math.min(1, anchorX + w);
		const bottom = north ? anchorY : Math.min(1, anchorY + h);
		next = {
			x: left,
			y: top,
			w: right - left,
			h: bottom - top,
		};
	}
	return sameCropOverlayRect(rect, next) ? rect : next;
}

export function cropFromKey(
	rect: CropOverlayRect,
	handle: CropHandle,
	key: string,
	shift: boolean,
	source: CropSourceSize,
): CropOverlayRect | null {
	if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key))
		return null;
	const step = shift ? 10 : 1;
	return cropFromDelta(
		rect,
		handle,
		(key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0) /
			source.width,
		(key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0) /
			source.height,
		source,
	);
}
