import {
	type CompositionVideoGeometry,
	compositionOutputRect,
	compositionPixelRect,
	interpolateCompositionCrop,
	resolveCompositionGeometry,
} from "./composition-geometry";
import {
	type AnyEditDocument,
	type CompositionClip,
	type CompositionDocument,
	type CompositionPresentation,
	compositionDocumentSchema,
	compositionPresentationSchema,
	DEFAULT_CAPTION_LAYOUT,
} from "./composition-schema";
import { suggestFixedCrop } from "./framing";
import type { NormalizedCropRect } from "./schema";
import { isCompositionSubjectPresentationAdopted } from "./subject-presentation-adoption";
import { isCompositionSubjectProtected } from "./subject-protection";

export const COMPOSITION_BANDS_VIDEO_LAYOUT = Object.freeze({
	x: 0,
	y: 0.18,
	w: 1,
	h: 0.64,
});
export const COMPOSITION_BANDS_CAPTION_LAYOUT = Object.freeze({
	x: 0.05,
	y: 0.84,
	w: 0.9,
	h: 0.13,
});

/** Presentation presets target full-frame clips on the lowest video track. */
export function compositionUsesMainPresentation(
	document: CompositionDocument,
	clip: CompositionClip,
): boolean {
	const tracks = document.videoTracks ?? [
		{ id: "main", name: "Main", order: 0 },
	];
	const main = tracks.reduce((first, track) =>
		track.order < first.order ? track : first,
	);
	const layout = clip.layout;
	return (
		(clip.trackId ?? "main") === main.id &&
		(!layout ||
			(layout.x === 0 && layout.y === 0 && layout.w === 1 && layout.h === 1))
	);
}

export function compositionVideoFit(
	document: CompositionDocument,
	clip: CompositionClip,
): CompositionPresentation["videoFit"] {
	return (
		clip.videoFit ??
		(compositionUsesMainPresentation(document, clip)
			? document.presentation?.videoFit
			: undefined)
	);
}

export function compositionHasUnconfirmedCenterCrop(
	document: CompositionDocument,
): boolean {
	return Boolean(
		document.autoGeneration &&
			document.presentation?.centerCropConfirmed !== true &&
			document.clips.some(
				(clip) =>
					compositionUsesMainPresentation(document, clip) &&
					compositionVideoFit(document, clip) === "FILL" &&
					clip.framing.some((part) => part.mode === "FIT"),
			),
	);
}

export function compositionHasUnconfirmedFraming(
	document: AnyEditDocument,
): boolean {
	return (
		document.clips.some((clip) =>
			clip.framing.some((part) => part.origin === "AISA_PROPOSAL"),
		) ||
		(document.schemaVersion === 2 &&
			compositionHasUnconfirmedCenterCrop(document))
	);
}

/** Confirmation changes a clone; observed samples and source evidence stay intact. */
export function confirmCompositionFraming<T extends AnyEditDocument>(
	input: T,
): T {
	const document = structuredClone(input);
	for (const clip of document.clips)
		for (const part of clip.framing)
			if (part.origin === "AISA_PROPOSAL") part.origin = "EDITOR_CONFIRMED";
	if (
		document.schemaVersion === 2 &&
		compositionHasUnconfirmedCenterCrop(document)
	)
		document.presentation = {
			version: "portrait-layout-v1",
			captionPlacement: "OVERLAY",
			...document.presentation,
			centerCropConfirmed: true,
		};
	return document;
}

export function setCompositionPresentation(
	input: CompositionDocument,
	patch: Partial<
		Pick<CompositionPresentation, "videoFit" | "captionPlacement">
	>,
): CompositionDocument {
	const change = compositionPresentationSchema
		.pick({ videoFit: true, captionPlacement: true })
		.partial()
		.parse(patch);
	const document = compositionDocumentSchema.parse(input);
	const previous = document.presentation;
	const next: CompositionPresentation = {
		version: "portrait-layout-v1",
		captionPlacement: "OVERLAY",
		...previous,
		...change,
	};
	const fitChanged = previous?.videoFit !== next.videoFit;
	if (
		!previous ||
		fitChanged ||
		previous.captionPlacement !== next.captionPlacement
	)
		next.centerCropConfirmed = false;
	if (fitChanged)
		for (const clip of document.clips)
			if (compositionUsesMainPresentation(document, clip)) delete clip.videoFit;
	document.presentation = next;
	return compositionDocumentSchema.parse(document);
}

export function compositionCaptionPresentationLayout(
	document: CompositionDocument,
): NormalizedCropRect {
	return {
		...(document.presentation?.captionPlacement === "BANDS"
			? COMPOSITION_BANDS_CAPTION_LAYOUT
			: (document.captionLayout ?? DEFAULT_CAPTION_LAYOUT)),
	};
}

function withAutomaticBackdrop(
	input: {
		document: CompositionDocument;
		sourceWidth: number;
		sourceHeight: number;
		width: number;
		height: number;
		layout?: NormalizedCropRect;
	},
	foreground: CompositionVideoGeometry,
): CompositionVideoGeometry {
	const clipRect = foreground.layoutRect;
	if (
		foreground.drawRect.x === clipRect.x &&
		foreground.drawRect.y === clipRect.y &&
		foreground.drawRect.w === clipRect.w &&
		foreground.drawRect.h === clipRect.h
	)
		return foreground;
	// Round the decorative source view against the document canvas once, so a
	// smaller preview cannot select different source pixels from the export.
	const reference = compositionOutputRect(
		input.layout ?? { x: 0, y: 0, w: 1, h: 1 },
		input.document.canvas.width,
		input.document.canvas.height,
	);
	const sourceRect = compositionPixelRect(
		suggestFixedCrop({
			sourceWidth: input.sourceWidth,
			sourceHeight: input.sourceHeight,
			targetWidth: reference.w,
			targetHeight: reference.h,
			centerX: 0.5,
			centerY: 0.5,
		}),
		input.sourceWidth,
		input.sourceHeight,
	);
	const blurPx = (24 * Math.max(input.width, input.height)) / 1920;
	const margin = Math.ceil(3 * blurPx);
	const scale = Math.max(
		(clipRect.w + 2 * margin) / sourceRect.w,
		(clipRect.h + 2 * margin) / sourceRect.h,
	);
	// Scale both axes together, rounding outward by at most one output pixel.
	// The renderer clips the overscan after blurring, avoiding dark blur edges.
	const w = Math.ceil(sourceRect.w * scale);
	const h = Math.ceil(sourceRect.h * scale);
	return {
		...foreground,
		backdrop: {
			kind: "BLUR",
			sourceRect,
			drawRect: {
				x: clipRect.x + Math.floor((clipRect.w - w) / 2),
				y: clipRect.y + Math.floor((clipRect.h - h) / 2),
				w,
				h,
			},
			clipRect: { ...clipRect },
			blurPx,
			shadeOpacity: 0.35,
		},
	};
}

function reprojectPresentationCrop(
	rect: NormalizedCropRect,
	geometry: {
		sourceWidth: number;
		sourceHeight: number;
		targetWidth: number;
		targetHeight: number;
	},
	oldTarget: { w: number; h: number },
) {
	const centerX = rect.x + rect.w / 2;
	const centerY = rect.y + rect.h / 2;
	const maximum = suggestFixedCrop({
		...geometry,
		targetWidth: oldTarget.w,
		targetHeight: oldTarget.h,
		centerX,
		centerY,
	});
	const zoom = Math.max(
		1,
		Math.min(3, Math.min(maximum.w / rect.w, maximum.h / rect.h)),
	);
	return suggestFixedCrop({ ...geometry, centerX, centerY, zoom });
}

/** Canvas and FFmpeg receive these same rounded, aspect-preserving rectangles. */
export function resolvePresentedCompositionGeometry(input: {
	document: CompositionDocument;
	clip: CompositionClip;
	sourceWidth: number;
	sourceHeight: number;
	width: number;
	height: number;
	frame: number;
}) {
	const { document, clip, frame } = input;
	const part = clip.framing.find(
		(value) => frame >= value.fromFrame && frame < value.toFrame,
	);
	if (!part) throw new RangeError("Missing composition framing");
	const legacy = {
		sourceWidth: input.sourceWidth,
		sourceHeight: input.sourceHeight,
		width: input.width,
		height: input.height,
		outputReference: document.canvas,
		frame,
		framing: part,
		layout: clip.layout,
		cropKeyframes: clip.cropKeyframes,
	};
	if (!document.presentation && clip.videoFit === undefined)
		return resolveCompositionGeometry(legacy);
	const fit = compositionVideoFit(document, clip);
	const bands =
		document.presentation?.captionPlacement === "BANDS" &&
		compositionUsesMainPresentation(document, clip);
	if (!bands && fit === undefined) return resolveCompositionGeometry(legacy);
	const layout = bands ? COMPOSITION_BANDS_VIDEO_LAYOUT : clip.layout;
	let protectedCrop = false;
	if (part.mode === "CROP" && fit === "AUTO") {
		let rect = interpolateCompositionCrop(
			clip.cropKeyframes ?? [],
			frame,
			part.rect,
		);
		if (bands) {
			const target = compositionOutputRect(
				layout ?? { x: 0, y: 0, w: 1, h: 1 },
				document.canvas.width,
				document.canvas.height,
			);
			rect = reprojectPresentationCrop(
				rect,
				{
					sourceWidth: input.sourceWidth,
					sourceHeight: input.sourceHeight,
					targetWidth: target.w,
					targetHeight: target.h,
				},
				compositionOutputRect(
					clip.layout ?? { x: 0, y: 0, w: 1, h: 1 },
					document.canvas.width,
					document.canvas.height,
				),
			);
		}
		protectedCrop = isCompositionSubjectProtected({ ...input, rect });
	}
	// A saved origin alone does not prove that subjects and text fit in a crop.
	// Keep the source unless current observations protect this crop, the user
	// picks FILL, or a source-bound adoption preserves an explicitly manual view.
	// The latter is manual presentation, never refreshed tracking evidence.
	const preserveSource =
		fit === "AUTO" &&
		document.presentation?.fallbackFraming === "PRESERVE_SOURCE_V1" &&
		!protectedCrop &&
		!isCompositionSubjectPresentationAdopted(input);
	if (
		fit === "FIT" ||
		(fit === "AUTO" && (part.mode === "FIT" || preserveSource))
	) {
		const foreground = resolveCompositionGeometry({
			...legacy,
			layout,
			framing: { mode: "FIT" },
		});
		return document.presentation?.videoFit === "AUTO" &&
			compositionUsesMainPresentation(document, clip)
			? withAutomaticBackdrop({ ...input, layout }, foreground)
			: foreground;
	}
	const target = compositionOutputRect(
		layout ?? { x: 0, y: 0, w: 1, h: 1 },
		document.canvas.width,
		document.canvas.height,
	);
	const geometry = {
		sourceWidth: input.sourceWidth,
		sourceHeight: input.sourceHeight,
		targetWidth: target.w,
		targetHeight: target.h,
	};
	if (part.mode === "FIT") {
		const fallback =
			fit === "FILL" && compositionUsesMainPresentation(document, clip)
				? clip.fallbackCrop
				: undefined;
		const fallbackRect =
			fallback && bands
				? reprojectPresentationCrop(
						fallback,
						geometry,
						compositionOutputRect(
							clip.layout ?? { x: 0, y: 0, w: 1, h: 1 },
							document.canvas.width,
							document.canvas.height,
						),
					)
				: fallback;
		return resolveCompositionGeometry({
			...legacy,
			layout,
			framing:
				fit === "FILL"
					? {
							mode: "CROP",
							rect:
								fallbackRect ??
								suggestFixedCrop({
									...geometry,
									centerX: 0.5,
									centerY: 0.5,
								}),
						}
					: part,
			// A saved fixed proposal or legacy centre is never a measured track.
			cropKeyframes: undefined,
		});
	}
	if (!bands) return resolveCompositionGeometry(legacy);
	const rect = interpolateCompositionCrop(
		clip.cropKeyframes ?? [],
		frame,
		part.rect,
	);
	const oldTarget = compositionOutputRect(
		clip.layout ?? { x: 0, y: 0, w: 1, h: 1 },
		document.canvas.width,
		document.canvas.height,
	);
	return resolveCompositionGeometry({
		...legacy,
		layout,
		framing: {
			mode: "CROP",
			rect: reprojectPresentationCrop(rect, geometry, oldTarget),
		},
		cropKeyframes: undefined,
	});
}
