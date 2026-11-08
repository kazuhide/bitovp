import {
	type CompositionClip,
	type CompositionDocument,
	type CompositionPlan,
	type CompositionSourceFacts,
	compileComposition,
	compositionOutputRect,
	compositionPixelRect,
	compositionUsesMainPresentation,
	compositionVideoFit,
	evaluateCompositionFrame,
	interpolateCompositionCrop,
	type NormalizedCropRect,
	normalizedCropRectSchema,
	normalizeManualSubjectProtectionEdits,
	type PixelRect,
	resolvePresentedCompositionGeometry,
	suggestFixedCrop,
} from "@bitovp/core";
import { stableManualCrop } from "./manual-crop";

export type DirectCropDescription = {
	clipId: string;
	mediaVersionId: string;
	sourceFrame: number;
	outputFrame: number;
	localFrame: number;
	sourceWidth: number;
	sourceHeight: number;
	mode: "FIT" | "CROP";
	rect: NormalizedCropRect;
	editable: boolean;
};

function contextFromPlan(
	plan: CompositionPlan,
	clipId: string,
	outputFrame: number,
) {
	const frame = evaluateCompositionFrame(plan, outputFrame);
	const layer = frame.layers.find((value) => value.clipId === clipId);
	const compiled = plan.clips.find((value) => value.clip.id === clipId);
	const source = plan.sources.find(
		(value) => value.mediaVersionId === layer?.mediaVersionId,
	);
	if (!layer || !compiled || !source) return null;
	const clip = compiled.clip;
	const part = clip.framing.find(
		(value) =>
			layer.localFrame >= value.fromFrame && layer.localFrame < value.toFrame,
	);
	if (!part) return null;
	const main = compositionUsesMainPresentation(plan.document, clip);
	const editable =
		layer.mode === "CROP" &&
		(part.mode === "CROP" ||
			(main && compositionVideoFit(plan.document, clip) === "FILL"));
	const description: DirectCropDescription = {
		clipId,
		mediaVersionId: layer.mediaVersionId,
		sourceFrame: layer.sourceFrame,
		outputFrame,
		localFrame: layer.localFrame,
		sourceWidth: source.width,
		sourceHeight: source.height,
		mode: layer.mode,
		rect: {
			x: layer.sourceRect.x / source.width,
			y: layer.sourceRect.y / source.height,
			w: layer.sourceRect.w / source.width,
			h: layer.sourceRect.h / source.height,
		},
		editable,
	};
	return { description, clip, source, part, main };
}

/** Uses the preview's existing plan and its exact selected-layer source clock. */
export function describeDirectCropFromPlan(
	plan: CompositionPlan,
	clipId: string,
	outputFrame: number,
): DirectCropDescription | null {
	try {
		return contextFromPlan(plan, clipId, outputFrame)?.description ?? null;
	} catch {
		return null;
	}
}

export function describeDirectCrop(
	document: CompositionDocument,
	sources: readonly CompositionSourceFacts[],
	clipId: string,
	outputFrame: number,
): DirectCropDescription | null {
	try {
		const plan = compileComposition(document, [...sources], {
			allowUnconfirmed: true,
		});
		return describeDirectCropFromPlan(plan, clipId, outputFrame);
	} catch {
		return null;
	}
}

function samePixels(left: PixelRect, right: PixelRect): boolean {
	return (
		left.x === right.x &&
		left.y === right.y &&
		left.w === right.w &&
		left.h === right.h
	);
}

function center(rect: NormalizedCropRect) {
	return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function panBounds(rects: NormalizedCropRect[], scale: number) {
	return rects.reduce(
		(bounds, rect) => {
			const c = center(rect);
			return {
				minX: Math.max(bounds.minX, (rect.w * scale) / 2 - c.x),
				maxX: Math.min(bounds.maxX, 1 - (rect.w * scale) / 2 - c.x),
				minY: Math.max(bounds.minY, (rect.h * scale) / 2 - c.y),
				maxY: Math.min(bounds.maxY, 1 - (rect.h * scale) / 2 - c.y),
			};
		},
		{ minX: -1, maxX: 1, minY: -1, maxY: 1 },
	);
}

function sharedScale(
	rects: NormalizedCropRect[],
	requested: number,
	source: CompositionSourceFacts,
	presentationLimits = { minimum: 0, maximum: Number.POSITIVE_INFINITY },
): number {
	const minimum = Math.max(
		presentationLimits.minimum,
		...rects.flatMap((rect) => [
			1 / (rect.w * source.width),
			1 / (rect.h * source.height),
		]),
	);
	const maximum = Math.min(
		presentationLimits.maximum,
		...rects.flatMap((rect) => [1 / rect.w, 1 / rect.h]),
	);
	let scale = Math.max(minimum, Math.min(maximum, requested));
	// Larger crops may leave no *shared* pan for distant tracking endpoints.
	// Find the largest common scale; never clamp the endpoints independently.
	const feasible = (value: number) => {
		const bounds = panBounds(rects, value);
		return bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY;
	};
	if (scale > 1 && !feasible(scale)) {
		let low = 1;
		let high = scale;
		for (let i = 0; i < 48; i++) {
			const middle = (low + high) / 2;
			if (feasible(middle)) low = middle;
			else high = middle;
		}
		scale = low;
	}
	return scale;
}

function transformed(
	rect: NormalizedCropRect,
	scale: number,
	dx: number,
	dy: number,
): NormalizedCropRect {
	const c = center(rect);
	const w = Math.min(1, rect.w * scale);
	const h = Math.min(1, rect.h * scale);
	return {
		// Shared bounds already enforce containment; these only absorb float error.
		x: Math.max(0, Math.min(1 - w, c.x + dx - w / 2)),
		y: Math.max(0, Math.min(1 - h, c.y + dy - h / 2)),
		w,
		h,
	};
}

function projection(
	document: CompositionDocument,
	clip: CompositionClip,
	source: CompositionSourceFacts,
) {
	const bands = {
		...document,
		presentation: {
			...document.presentation,
			version: "portrait-layout-v1" as const,
			captionPlacement: "BANDS" as const,
		},
	};
	return (rect: NormalizedCropRect) =>
		resolvePresentedCompositionGeometry({
			document: bands,
			clip: {
				...clip,
				videoFit: "FILL",
				cropKeyframes: undefined,
				framing: [
					{
						fromFrame: 0,
						toFrame: clip.durationFrames,
						mode: "CROP",
						origin: "MANUAL",
						rect,
					},
				],
			},
			sourceWidth: source.width,
			sourceHeight: source.height,
			...document.canvas,
			frame: 0,
		});
}

/** Nearest canonical center in the preimage of the clamped displayed center. */
function unprojectCenter(
	requested: number,
	displayedSize: number,
	previous: number,
	pixels: number,
) {
	const low = displayedSize / 2;
	const high = 1 - low;
	const tolerance = 0.5 / pixels + 1e-12;
	if (requested <= low + tolerance) return Math.min(previous, low);
	if (requested >= high - tolerance) return Math.max(previous, high);
	return requested;
}

/** One scene-level edit. Its affine transform preserves key clocks and easing. */
export function applyDirectCrop(
	document: CompositionDocument,
	sources: readonly CompositionSourceFacts[],
	clipId: string,
	outputFrame: number,
	nextDisplayRect: NormalizedCropRect,
): CompositionDocument {
	try {
		const parsed = normalizedCropRectSchema.safeParse(nextDisplayRect);
		if (!parsed.success) return document;
		const plan = compileComposition(document, [...sources], {
			allowUnconfirmed: true,
		});
		const context = contextFromPlan(plan, clipId, outputFrame);
		if (!context?.description.editable) return document;
		// Preserve the exact native CROP/FIT view before the explicit gesture
		// changes coordinates. This does not turn LOST intervals into FILL.
		const manual = normalizeManualSubjectProtectionEdits(document, document);
		const { description, source, part, main } = context;
		const clip = manual.clips.find((value) => value.id === clipId);
		if (!clip) return document;
		const requested = parsed.data;
		if (
			samePixels(
				compositionPixelRect(requested, source.width, source.height),
				compositionPixelRect(description.rect, source.width, source.height),
			)
		)
			return document;
		const target = compositionOutputRect(
			clip.layout ?? { x: 0, y: 0, w: 1, h: 1 },
			document.canvas.width,
			document.canvas.height,
		);
		const reference =
			part.mode === "CROP"
				? interpolateCompositionCrop(
						clip.cropKeyframes ?? [],
						description.localFrame,
						part.rect,
					)
				: (clip.fallbackCrop ??
					suggestFixedCrop({
						sourceWidth: source.width,
						sourceHeight: source.height,
						targetWidth: target.w,
						targetHeight: target.h,
						centerX: 0.5,
						centerY: 0.5,
					}));
		const rects =
			part.mode === "FIT"
				? [reference]
				: [
						...clip.framing.flatMap((value) =>
							value.mode === "CROP" ? [value.rect] : [],
						),
						...(clip.cropKeyframes ?? []).map((key) => key.rect),
					];
		const bands = main && document.presentation?.captionPlacement === "BANDS";
		const maximum = suggestFixedCrop({
			sourceWidth: source.width,
			sourceHeight: source.height,
			targetWidth: target.w,
			targetHeight: target.h,
			centerX: 0.5,
			centerY: 0.5,
		});
		const zooms = rects.map((rect) =>
			Math.min(maximum.w / rect.w, maximum.h / rect.h),
		);
		// BANDS' shared renderer represents zoom 1..3. Retain existing outliers,
		// but do not store a hidden zoom that appears only after changing presets.
		const limits = bands
			? {
					minimum: Math.min(1, Math.max(...zooms) / 3),
					maximum: Math.max(1, Math.min(...zooms)),
				}
			: undefined;
		const scale = sharedScale(
			rects,
			requested.w / description.rect.w,
			source,
			limits,
		);
		const oldCenter = center(reference);
		const displayCenter = center(description.rect);
		const requestedCenter = center(requested);
		const project = main ? projection(document, clip, source) : undefined;
		const projected = bands
			? project?.(transformed(reference, scale, 0, 0)).cropRect
			: undefined;
		const desiredCenter = projected
			? {
					x: unprojectCenter(
						requestedCenter.x,
						projected.w,
						oldCenter.x,
						source.width,
					),
					y: unprojectCenter(
						requestedCenter.y,
						projected.h,
						oldCenter.y,
						source.height,
					),
				}
			: {
					x: oldCenter.x + requestedCenter.x - displayCenter.x,
					y: oldCenter.y + requestedCenter.y - displayCenter.y,
				};
		const bounds = panBounds(rects, scale);
		const dx = Math.max(
			bounds.minX,
			Math.min(bounds.maxX, desiredCenter.x - oldCenter.x),
		);
		const dy = Math.max(
			bounds.minY,
			Math.min(bounds.maxY, desiredCenter.y - oldCenter.y),
		);
		const author = (rect: NormalizedCropRect) =>
			stableManualCrop(
				transformed(rect, scale, dx, dy),
				source,
				project ? (value) => project(value).sourceRect : undefined,
			);
		const replacement: CompositionClip =
			part.mode === "FIT"
				? { ...clip, fallbackCrop: author(reference) }
				: {
						...clip,
						framing: clip.framing.map((value) =>
							value.mode === "CROP"
								? {
										...value,
										origin: "MANUAL",
										manualOverride: true,
										rect: author(value.rect),
									}
								: value,
						),
						...(clip.cropKeyframes
							? {
									cropKeyframes: clip.cropKeyframes.map((key) => ({
										...key,
										rect: author(key.rect),
									})),
								}
							: {}),
					};
		const next: CompositionDocument = {
			...manual,
			clips: manual.clips.map((value) =>
				value.id === clipId ? replacement : value,
			),
			...(manual.presentation
				? {
						presentation: {
							...manual.presentation,
							centerCropConfirmed: false,
						},
					}
				: {}),
		};
		const normalized = normalizeManualSubjectProtectionEdits(manual, next);
		const updated = describeDirectCrop(
			normalized,
			sources,
			clipId,
			outputFrame,
		);
		if (
			!updated ||
			samePixels(
				compositionPixelRect(updated.rect, source.width, source.height),
				compositionPixelRect(description.rect, source.width, source.height),
			)
		)
			return document;
		return normalized;
	} catch {
		// A stale binding or unrepresentable gesture cannot author a different view.
		return document;
	}
}
