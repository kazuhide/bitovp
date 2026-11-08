import { subjectBox2dSchema } from "../content-library/analysis";
import { type NormalizedCropRect, normalizedCropRectSchema } from "./schema";

export function subjectCenterFromPercent(
	x: unknown,
	y: unknown,
): { x: number; y: number } | null {
	const valid = (value: unknown): value is number =>
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100;
	return valid(x) && valid(y) ? { x: x / 100, y: y / 100 } : null;
}

export type FramingGeometry = {
	sourceWidth: number;
	sourceHeight: number;
	targetWidth: number;
	targetHeight: number;
};

/** Reposition a schema-valid crop without resizing its normalized dimensions. */
export function positionCropRect(input: {
	sourceWidth: number;
	sourceHeight: number;
	rect: NormalizedCropRect;
	centerX: number;
	centerY: number;
}): NormalizedCropRect {
	for (const dimension of [input.sourceWidth, input.sourceHeight]) {
		if (!Number.isSafeInteger(dimension) || dimension <= 0)
			throw new RangeError("Invalid displayed geometry");
	}
	for (const coordinate of [input.centerX, input.centerY]) {
		if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)
			throw new RangeError("Expected a normalized center point");
	}
	const rect = normalizedCropRectSchema.parse(input.rect);
	const start = (center: number, size: number, pixels: number) => {
		const position = Math.max(0, Math.min(1 - size, center - size / 2));
		// Protect full-pixel spans from opposite errors at half-pixel ties.
		return size * pixels >= 1 - 4 * Number.EPSILON &&
			Math.round((position + size) * pixels) === Math.round(position * pixels)
			? Math.max(0, position - Number.EPSILON)
			: position;
	};
	return {
		x: start(input.centerX, rect.w, input.sourceWidth),
		y: start(input.centerY, rect.h, input.sourceHeight),
		w: rect.w,
		h: rect.h,
	};
}

/** The point is normalized to displayed, square-pixel geometry, not provider percent. */
export function suggestFixedCrop(
	input: FramingGeometry & {
		centerX: number;
		centerY: number;
		zoom?: number;
	},
): NormalizedCropRect {
	for (const dimension of [
		input.sourceWidth,
		input.sourceHeight,
		input.targetWidth,
		input.targetHeight,
	]) {
		if (!Number.isSafeInteger(dimension) || dimension <= 0)
			throw new RangeError("Invalid displayed geometry");
	}
	for (const coordinate of [input.centerX, input.centerY]) {
		if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)
			throw new RangeError("Expected a normalized center point");
	}
	const requestedZoom = input.zoom === undefined ? 1 : input.zoom;
	if (!Number.isFinite(requestedZoom) || requestedZoom < 1 || requestedZoom > 3)
		throw new RangeError("Expected a crop zoom between 1 and 3");
	const aspect = input.targetWidth / input.targetHeight;
	const sourceAspect = input.sourceWidth / input.sourceHeight;
	const maximumW = sourceAspect >= aspect ? aspect / sourceAspect : 1;
	const maximumH = sourceAspect >= aspect ? 1 : sourceAspect / aspect;
	const pixelZoomLimit = Math.min(
		maximumW * input.sourceWidth,
		maximumH * input.sourceHeight,
	);
	// Further magnification must retain at least one source pixel on both axes.
	// If the maximum crop cannot do that, retain its existing 1x geometry.
	const zoom = Math.min(requestedZoom, Math.max(1, pixelZoomLimit));
	const w = maximumW / zoom;
	const h = maximumH / zoom;
	return positionCropRect({ ...input, rect: { x: 0, y: 0, w, h } });
}

type ShotFramingReason =
	| "SINGLE_SUBJECT"
	| "SUBJECT_SELECTED"
	| "SUBJECT_SELECTION_REQUIRED"
	| "SUBJECT_POSITION_MISSING"
	| "SUBJECT_BOX_TOO_LARGE"
	| "DISPLAY_GEOMETRY_UNVERIFIED";
export type ShotFramingProposal = (
	| { mode: "FIT" }
	| { mode: "CROP"; rect: NormalizedCropRect }
) & {
	origin: "AISA_PROPOSAL";
	requiresConfirmation: true;
	reasonCode: ShotFramingReason;
};

/** A shot observation proposes one fixed view; it never invents a track or a speaker. */
export function suggestShotFraming(
	input: FramingGeometry & {
		mainSubjects: readonly {
			centerX?: unknown;
			centerY?: unknown;
			box2d?: unknown;
		}[];
		subjectIndex?: number;
		coordinateSpaceVerified: boolean;
	},
): ShotFramingProposal {
	const fit = (reasonCode: ShotFramingReason): ShotFramingProposal => ({
		mode: "FIT",
		origin: "AISA_PROPOSAL",
		requiresConfirmation: true,
		reasonCode,
	});
	if (!input.coordinateSpaceVerified) return fit("DISPLAY_GEOMETRY_UNVERIFIED");
	const index =
		input.subjectIndex ?? (input.mainSubjects.length === 1 ? 0 : undefined);
	if (index === undefined)
		return fit(
			input.mainSubjects.length
				? "SUBJECT_SELECTION_REQUIRED"
				: "SUBJECT_POSITION_MISSING",
		);
	if (
		!Number.isInteger(index) ||
		index < 0 ||
		index >= input.mainSubjects.length
	)
		return fit("SUBJECT_SELECTION_REQUIRED");
	const subject = input.mainSubjects[index];
	const box2d = subject?.box2d;
	let rect: NormalizedCropRect;
	if (
		box2d !== undefined &&
		box2d !== null &&
		!(Array.isArray(box2d) && box2d.length === 0)
	) {
		const parsed = subjectBox2dSchema.safeParse(box2d);
		if (!parsed.success) throw new RangeError("Invalid subject box2d");
		const [ymin, xmin, ymax, xmax] = parsed.data;
		const centerX = (xmin + xmax) / 2000;
		const centerY = (ymin + ymax) / 2000;
		const width = (xmax - xmin) / 1000;
		const height = (ymax - ymin) / 1000;
		const maximum = suggestFixedCrop({ ...input, centerX, centerY, zoom: 1 });
		if (width > maximum.w || height > maximum.h)
			return fit("SUBJECT_BOX_TOO_LARGE");
		// Keep subject occupancy at 80% where frame bounds and the 3x cap allow.
		const zoom = Math.max(
			1,
			Math.min(3, (maximum.w * 0.8) / width, (maximum.h * 0.8) / height),
		);
		rect = suggestFixedCrop({ ...input, centerX, centerY, zoom });
	} else {
		const center = subjectCenterFromPercent(subject?.centerX, subject?.centerY);
		if (!center) return fit("SUBJECT_POSITION_MISSING");
		rect = suggestFixedCrop({
			...input,
			centerX: center.x,
			centerY: center.y,
			zoom: 1,
		});
	}
	return {
		mode: "CROP",
		rect,
		origin: "AISA_PROPOSAL",
		requiresConfirmation: true,
		reasonCode:
			input.subjectIndex === undefined ? "SINGLE_SUBJECT" : "SUBJECT_SELECTED",
	};
}
