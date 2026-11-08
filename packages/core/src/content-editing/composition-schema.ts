import { z } from "zod";
import { compositionCaptionSourceEvidenceSchema } from "./composition-caption-source";
import {
	captionDisplayLanguageSchema,
	compositionCaptionTranslationSchema,
} from "./composition-caption-translation";
import {
	editAudioSchema,
	editClipSchema,
	editingDocumentSchema,
	normalizedCropRectSchema,
} from "./schema";
import { compositionSubjectPresentationAdoptionSchema } from "./subject-presentation-adoption";
import { compositionSubjectProtectionSchema } from "./subject-protection";

export const COMPOSITION_LIMITS = {
	clips: 20,
	durationFrames: 5400,
	sources: 8,
	videoTracks: 4,
	audioTracks: 8,
	keyframes: 128,
	overlays: 32,
	imageAssets: 16,
	captions: 300,
	words: 2000,
	duckIntervals: 64,
} as const;
const frame = z.number().int().min(0).max(5399);
const endFrame = z.number().int().min(1).max(5400);
const safeUs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) =>
	z
		.string()
		.max(max)
		.refine(
			(value) =>
				[...value].every((character) => {
					const code = character.charCodeAt(0);
					return code >= 32 || code === 9 || code === 10 || code === 13;
				}),
			"Text contains unsupported control characters",
		);
const trackId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/);
const anchor = z.uuid().optional();
const range = { fromFrame: frame, toFrame: endFrame };
const gainDb = z.number().finite().min(-60).max(12);
const fades = {
	fadeInFrames: z.number().int().min(0).max(5400),
	fadeOutFrames: z.number().int().min(0).max(5400),
};
const fadeWindow = z
	.strictObject({
		offsetFrames: z.number().int().min(-5400).max(5400),
		durationFrames: endFrame,
	})
	.optional();
export const compositionTextStyleSchema = z.strictObject({
	fontSize: z.number().finite().min(0.01).max(0.25),
	color: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i),
	emphasisColor: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i),
	backgroundColor: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i),
	align: z.enum(["LEFT", "CENTER", "RIGHT"]),
});
export type CompositionTextStyle = z.infer<typeof compositionTextStyleSchema>;
export const DEFAULT_COMPOSITION_TEXT_STYLE: CompositionTextStyle = {
	fontSize: 0.045,
	color: "#FFFFFF",
	emphasisColor: "#FFE04B",
	backgroundColor: "#000000B3",
	align: "CENTER",
};
export const DEFAULT_CAPTION_LAYOUT = { x: 0.05, y: 0.8, w: 0.9, h: 0.17 };
export const compositionPresentationSchema = z.strictObject({
	version: z.literal("portrait-layout-v1"),
	videoFit: z.enum(["AUTO", "FILL", "FIT"]).optional(),
	captionPlacement: z.enum(["OVERLAY", "BANDS"]),
	centerCropConfirmed: z.boolean().optional(),
	fallbackFraming: z.enum(["AISA_STATIC_V1", "PRESERVE_SOURCE_V1"]).optional(),
});
export type CompositionPresentation = z.infer<
	typeof compositionPresentationSchema
>;
export const compositionCanvasSchema = z
	.strictObject({ width: z.number().int(), height: z.number().int() })
	.refine(
		({ width, height }) =>
			["1920:1080", "1080:1920", "1080:1080", "1080:1350"].includes(
				`${width}:${height}`,
			),
		"Unsupported composition canvas",
	);

export const compositionClipSchema = editClipSchema
	.safeExtend({
		subjectProtection: compositionSubjectProtectionSchema.optional(),
		subjectPresentationAdoption:
			compositionSubjectPresentationAdoptionSchema.optional(),
		mediaVersionId: z.uuid().optional(),
		trackId: trackId.optional(),
		layout: normalizedCropRectSchema.optional(),
		videoFit: z.enum(["FILL", "FIT"]).optional(),
		fallbackCrop: normalizedCropRectSchema.optional(),
		opacity: z.number().finite().min(0).max(1).optional(),
		audio: editAudioSchema.extend({
			gainDb: gainDb.optional(),
			fadeInFrames: fades.fadeInFrames.optional(),
			fadeOutFrames: fades.fadeOutFrames.optional(),
			fadeWindow,
		}),
		cropKeyframes: z
			.array(
				z
					.strictObject({
						frame,
						rect: normalizedCropRectSchema,
						easing: z.enum(["LINEAR", "SMOOTH"]),
						curveStart: z.number().min(0).max(1).optional(),
						curveEnd: z.number().min(0).max(1).optional(),
					})
					.refine(
						(key) => (key.curveStart ?? 0) < (key.curveEnd ?? 1),
						"Easing subrange must be increasing",
					),
			)
			.min(1)
			.max(128)
			.optional(),
		transitionIn: z
			.strictObject({
				type: z.literal("CROSSFADE"),
				durationFrames: z.number().int().min(1).max(60),
			})
			.optional(),
	})
	.superRefine((clip, ctx) => {
		let previous = -1;
		for (const key of clip.cropKeyframes ?? []) {
			if (key.frame <= previous || key.frame >= clip.durationFrames)
				ctx.addIssue({
					code: "custom",
					path: ["cropKeyframes"],
					message: "Crop keyframes must be ordered within the clip",
				});
			previous = key.frame;
		}
		if (
			(clip.audio.fadeInFrames ?? 0) >
				(clip.audio.fadeWindow?.durationFrames ?? clip.durationFrames) ||
			(clip.audio.fadeOutFrames ?? 0) >
				(clip.audio.fadeWindow?.durationFrames ?? clip.durationFrames)
		)
			ctx.addIssue({
				code: "custom",
				path: ["audio"],
				message: "Audio fade exceeds the clip",
			});
	});
export type CompositionClip = z.infer<typeof compositionClipSchema>;
export function compositionClipOrder(a: CompositionClip, b: CompositionClip) {
	return (
		a.timelineStartFrame - b.timelineStartFrame ||
		Number(Boolean(a.transitionIn)) - Number(Boolean(b.transitionIn)) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

export const compositionCaptionSchema = z
	.strictObject({
		id: z.uuid(),
		...range,
		text: text(1000).min(1),
		anchorClipId: anchor,
		translation: compositionCaptionTranslationSchema.optional(),
		sourceEvidence: compositionCaptionSourceEvidenceSchema.optional(),
		words: z
			.array(
				z.strictObject({
					text: text(1000).min(1),
					startChar: z.number().int().min(0).max(1000),
					endChar: z.number().int().min(1).max(1000),
					...range,
					confidence: z.number().finite().min(0).max(1).optional(),
				}),
			)
			.min(1)
			.max(256)
			.optional(),
	})
	.superRefine((caption, ctx) => {
		if (caption.toFrame <= caption.fromFrame)
			ctx.addIssue({
				code: "custom",
				message: "Caption interval must be positive",
			});
		let previousEnd = caption.fromFrame;
		let previousChar = 0;
		for (const word of caption.words ?? []) {
			if (
				word.fromFrame < previousEnd ||
				word.toFrame <= word.fromFrame ||
				word.toFrame > caption.toFrame ||
				word.startChar < previousChar ||
				word.endChar <= word.startChar ||
				caption.text.slice(word.startChar, word.endChar) !== word.text
			)
				ctx.addIssue({
					code: "custom",
					path: ["words"],
					message:
						"Word text offsets and actual frame intervals must match their caption",
				});
			previousEnd = word.toFrame;
			previousChar = word.endChar;
		}
	});
export type CompositionCaption = z.infer<typeof compositionCaptionSchema>;
export const compositionAudioTrackSchema = z
	.strictObject({
		id: z.uuid(),
		mediaVersionId: z.uuid(),
		sourceInUs: safeUs,
		timelineStartFrame: frame,
		durationFrames: endFrame,
		gainDb,
		...fades,
		fadeWindow,
		anchorClipId: anchor,
		ducking: z
			.strictObject({
				source: z.literal("CAPTIONS").optional(),
				gainDb: gainDb.max(0),
				attackFrames: z.number().int().min(0).max(300),
				releaseFrames: z.number().int().min(0).max(300),
				intervals: z
					.array(
						z
							.strictObject(range)
							.refine(
								(r) => r.toFrame > r.fromFrame,
								"Ducking interval must be positive",
							),
					)
					.max(64),
			})
			.optional(),
	})
	.refine(
		(track) =>
			track.timelineStartFrame + track.durationFrames <= 5400 &&
			track.fadeInFrames <=
				(track.fadeWindow?.durationFrames ?? track.durationFrames) &&
			track.fadeOutFrames <=
				(track.fadeWindow?.durationFrames ?? track.durationFrames),
		"Audio track exceeds composition bounds",
	);
export type CompositionAudioTrack = z.infer<typeof compositionAudioTrackSchema>;
const overlayCommon = {
	id: z.uuid(),
	...range,
	rect: normalizedCropRectSchema,
	opacity: z.number().finite().min(0).max(1),
	zIndex: z.number().int().min(0).max(100),
	anchorClipId: anchor,
};
export const compositionOverlaySchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...overlayCommon,
		kind: z.literal("TEXT"),
		text: text(2000).min(1),
		style: compositionTextStyleSchema.partial().optional(),
	}),
	z.strictObject({
		...overlayCommon,
		kind: z.literal("IMAGE"),
		assetId: z.uuid(),
	}),
]);
export type CompositionOverlay = z.infer<typeof compositionOverlaySchema>;
export const compositionDocumentSchema = z
	.strictObject({
		...editingDocumentSchema.shape,
		schemaVersion: z.literal(2),
		canvas: compositionCanvasSchema,
		clips: z.array(compositionClipSchema).min(1).max(20),
		sources: z
			.array(
				z.strictObject({
					mediaVersionId: z.uuid(),
					timeMapId: z.uuid(),
					analysisRevisionId: z.uuid().nullable().optional(),
				}),
			)
			.max(7)
			.optional(),
		videoTracks: z
			.array(
				z.strictObject({
					id: trackId,
					name: text(128).min(1),
					order: z.number().int().min(0).max(3),
				}),
			)
			.min(1)
			.max(4)
			.optional(),
		audioTracks: z.array(compositionAudioTrackSchema).max(8).optional(),
		captions: z.array(compositionCaptionSchema).max(300).optional(),
		captionDisplayLanguage: captionDisplayLanguageSchema.optional(),
		captionStyle: compositionTextStyleSchema.partial().optional(),
		captionLayout: normalizedCropRectSchema.optional(),
		presentation: compositionPresentationSchema.optional(),
		overlays: z.array(compositionOverlaySchema).max(32).optional(),
		imageAssets: z
			.array(z.strictObject({ id: z.uuid() }))
			.max(16)
			.optional(),
		template: z
			.strictObject({
				presetId: text(64).min(1),
				version: z.number().int().min(1).max(1000),
				name: text(128).min(1),
			})
			.optional(),
	})
	.superRefine((document, ctx) => {
		const issue = (message: string) =>
			ctx.addIssue({ code: "custom", message });
		if (
			(document.captions?.length ?? 0) > COMPOSITION_LIMITS.duckIntervals &&
			document.audioTracks?.some(
				(track) => track.ducking?.source === "CAPTIONS",
			)
		)
			issue("Caption-linked ducking supports at most 64 captions");
		const sources = [
			{
				mediaVersionId: document.mediaVersionId,
				timeMapId: document.timeMapId,
				analysisRevisionId: document.analysisRevisionId,
			},
			...(document.sources ?? []),
		];
		const mediaIds = new Set(sources.map((s) => s.mediaVersionId));
		if (
			mediaIds.size !== sources.length ||
			new Set(sources.map((s) => s.timeMapId)).size !== sources.length
		)
			issue("Composition sources must be unique");
		const tracks = document.videoTracks ?? [
			{ id: "main", name: "Main", order: 0 },
		];
		if (
			new Set(tracks.map((t) => t.id)).size !== tracks.length ||
			new Set(tracks.map((t) => t.order)).size !== tracks.length
		)
			issue("Video track IDs and orders must be unique");
		const clipIds = new Set(document.clips.map((c) => c.id));
		if (clipIds.size !== document.clips.length)
			issue("Composition clip IDs must be unique");
		const automatic = document.autoGeneration;
		if (
			automatic &&
			(automatic.binding.mediaVersionId !== document.mediaVersionId ||
				automatic.binding.timeMapId !== document.timeMapId ||
				automatic.binding.analysisRevisionId !== document.analysisRevisionId ||
				automatic.binding.locale !== document.locale)
		)
			issue("Automatic evidence must match the primary source tuple");
		let keys = 0;
		let framings = 0;
		for (const clip of document.clips) {
			const sourceId = clip.mediaVersionId ?? document.mediaVersionId;
			if (!mediaIds.has(sourceId)) issue("Clip source is undeclared");
			if (!tracks.some((t) => t.id === (clip.trackId ?? "main")))
				issue("Clip video track is undeclared");
			if (clip.timelineStartFrame + clip.durationFrames > 5400)
				issue("Composition exceeds 180 seconds");
			if (
				clip.evidence &&
				!sources.find((s) => s.mediaVersionId === sourceId)?.analysisRevisionId
			)
				issue("Clip evidence needs its fixed source analysis");
			if (
				clip.framing.some((f) => f.origin === "AUTO_POLICY") &&
				(!automatic || !clip.evidence || sourceId !== document.mediaVersionId)
			)
				issue("Automatic framing requires primary-source policy evidence");
			keys += clip.cropKeyframes?.length ?? 0;
			framings += clip.framing.length;
		}
		if (keys > 128 || framings > 128)
			issue("Composition keyframe/framing budget exceeded");
		for (const track of tracks) {
			const clips = document.clips
				.filter((c) => (c.trackId ?? "main") === track.id)
				.sort(compositionClipOrder);
			clips.forEach((clip, index) => {
				const previous = clips[index - 1];
				const earlier = clips[index - 2];
				const overlap = previous
					? previous.timelineStartFrame +
						previous.durationFrames -
						clip.timelineStartFrame
					: 0;
				if (clip.transitionIn) {
					if (
						!previous ||
						overlap !== clip.transitionIn.durationFrames ||
						overlap > clip.durationFrames ||
						overlap > previous.durationFrames
					)
						issue("Crossfade must exactly match the preceding clip overlap");
				} else if (overlap > 0)
					issue("Same-track overlap requires a crossfade");
				if (
					earlier &&
					earlier.timelineStartFrame + earlier.durationFrames >
						clip.timelineStartFrame
				)
					issue("Triple same-track overlap is unsupported");
			});
		}
		const unique = (rows: { id: string }[], label: string) => {
			if (new Set(rows.map((r) => r.id)).size !== rows.length)
				issue(`Duplicate ${label} ID`);
		};
		unique(document.audioTracks ?? [], "audio");
		unique(document.captions ?? [], "caption");
		unique(document.overlays ?? [], "overlay");
		unique(document.imageAssets ?? [], "image asset");
		const imageIds = new Set(document.imageAssets?.map((a) => a.id));
		for (const track of document.audioTracks ?? [])
			if (!mediaIds.has(track.mediaVersionId))
				issue("Audio source is undeclared");
		for (const overlay of document.overlays ?? []) {
			if (overlay.toFrame <= overlay.fromFrame)
				issue("Overlay interval must be positive");
			if (overlay.kind === "IMAGE" && !imageIds.has(overlay.assetId))
				issue("Image asset is undeclared");
		}
		if (
			(document.captions ?? []).reduce(
				(sum, c) => sum + (c.words?.length ?? 0),
				0,
			) > 2000
		)
			issue("Caption word budget exceeded");
		for (const item of [
			...(document.captions ?? []),
			...(document.audioTracks ?? []),
			...(document.overlays ?? []),
		])
			if (item.anchorClipId && !clipIds.has(item.anchorClipId))
				issue("Timed item anchor clip is missing");
		for (const rect of [
			...document.clips.map((c) => c.layout).filter((r) => r !== undefined),
			...(document.overlays ?? []).map((o) => o.rect),
			...(document.captionLayout ? [document.captionLayout] : []),
		]) {
			if (
				Math.round((rect.x + rect.w) * document.canvas.width) -
					Math.round(rect.x * document.canvas.width) <
					1 ||
				Math.round((rect.y + rect.h) * document.canvas.height) -
					Math.round(rect.y * document.canvas.height) <
					1
			)
				issue("Output layout must occupy a pixel");
		}
	});
export type CompositionDocument = z.infer<typeof compositionDocumentSchema>;
export const anyEditingDocumentSchema = z.discriminatedUnion("schemaVersion", [
	editingDocumentSchema,
	compositionDocumentSchema,
]);
export type AnyEditDocument = z.infer<typeof anyEditingDocumentSchema>;

/** Upgrade by copying; existing V1 data and its strict parser remain unchanged. */
export function toCompositionDocument(input: unknown): CompositionDocument {
	const document = anyEditingDocumentSchema.parse(input);
	if (document.schemaVersion === 2) return document;
	return compositionDocumentSchema.parse({
		...document,
		schemaVersion: 2,
		sources: [],
		videoTracks: [{ id: "main", name: "Main", order: 0 }],
		audioTracks: [],
		captions: [],
		overlays: [],
		imageAssets: [],
	});
}
