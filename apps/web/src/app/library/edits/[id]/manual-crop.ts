import {
	type CompositionSourceFacts,
	type NormalizedCropRect,
	type PixelRect,
	resolveCompositionGeometry,
} from "@bitovp/core";

// A fixed decimal grid prevents noise in newly authored JSON numeric values.
const DECIMAL_GRID = 1_000_000_000_000;
const NEARBY_TICKS = [0, -1, 1, -2, 2] as const;

function stableAxisCandidates(
	start: number,
	size: number,
	pixels: number,
	pixelStart: number,
	pixelEnd: number,
): [number, number][] {
	const candidates: [number, number][] = [];
	// Independent decimal rounding can move a half-pixel edge; keep both source edges.
	const initialStart = Math.round(start * DECIMAL_GRID);
	const initialSize = Math.round(size * DECIMAL_GRID);
	for (const startTick of NEARBY_TICKS)
		for (const sizeTick of NEARBY_TICKS) {
			const savedStart = initialStart + startTick,
				savedSize = initialSize + sizeTick;
			if (
				savedStart < 0 ||
				savedSize <= 0 ||
				savedStart + savedSize > DECIMAL_GRID
			)
				continue;
			const x = savedStart / DECIMAL_GRID,
				w = savedSize / DECIMAL_GRID;
			if (w * pixels < 1 - 4 * Number.EPSILON) continue;
			if (
				Math.round(x * pixels) === pixelStart &&
				Math.round((x + w) * pixels) === pixelEnd
			)
				candidates.push([x, w]);
		}
	return candidates;
}

export type ManualCropProjection = (rect: NormalizedCropRect) => PixelRect;

function samePixels(left: PixelRect, right: PixelRect): boolean {
	return (
		left.x === right.x &&
		left.y === right.y &&
		left.w === right.w &&
		left.h === right.h
	);
}

/** Only new versioned-presentation manual crops/keys use this precision; saved evidence is untouched. */
export function stableManualCrop(
	rect: NormalizedCropRect,
	source: Pick<CompositionSourceFacts, "width" | "height">,
	project?: ManualCropProjection,
): NormalizedCropRect {
	const geometry = resolveCompositionGeometry({
		sourceWidth: source.width,
		sourceHeight: source.height,
		width: 1,
		height: 1,
		frame: 0,
		framing: { mode: "CROP", rect },
	});
	const original = geometry.cropRect ?? rect,
		pixels = geometry.sourceRect;
	const horizontal = stableAxisCandidates(
		original.x,
		original.w,
		source.width,
		pixels.x,
		pixels.x + pixels.w,
	);
	const vertical = stableAxisCandidates(
		original.y,
		original.h,
		source.height,
		pixels.y,
		pixels.y + pixels.h,
	);
	const displayed = project?.(rect);
	// At most 25 candidates per axis; the closest common case returns first.
	for (const [x, w] of horizontal)
		for (const [y, h] of vertical) {
			const candidate = { x, y, w, h };
			if (!project || (displayed && samePixels(project(candidate), displayed)))
				return candidate;
		}
	throw new RangeError(
		"Manual crop cannot retain source pixels at saved precision",
	);
}
