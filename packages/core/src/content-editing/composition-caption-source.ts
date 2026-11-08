import { z } from "zod";
import { canonicalEditingJson } from "./automatic-binding";
import type {
	CompositionCaption,
	CompositionClip,
	CompositionDocument,
} from "./composition-schema";

export const COMPOSITION_CAPTION_SOURCE_VERSION = "source-caption-v1";

/** Selection changes invalidate GENERATE results, not saved provenance or ASR. */
export const COMPOSITION_CAPTION_SELECTION_POLICY = {
	version: "source-caption-selection-v4",
	automaticTiming: "ALIGNED_TEXT_ONLY",
	alignedTextPunctuation: "verbatim-nonlexical-v2",
	alignedWordContainment: "original-clock-ticks-v1",
	captionLanguage: "observed-selected-context-v1",
	measuredPause: "single-verified-vad-island-conservative-frames-v1",
	unmeasuredBoundarySpillMaxFrames: 1,
	unmeasuredVad: {
		mergeGapUs: 600_000,
		carryInMaxUs: 200_000,
		laterSupportMinUs: 500_000,
		carryInSupportRatioDenominator: 10,
		segmentMinUs: 2_000_000,
		endPaddingUs: 100_000,
	},
} as const;

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const word = z.strictObject({
	text: z.string().min(1).max(1000),
	startChar: integer,
	endChar: integer,
	fromFrame: integer,
	toFrame: integer,
	confidence: z.number().finite().min(0).max(1).optional(),
});
const captionSnapshotSchema = z.strictObject({
	text: z.string().min(1).max(1000),
	fromFrame: integer,
	toFrame: integer,
	words: z.array(word).max(256).optional(),
});
const clipSnapshotSchema = z.strictObject({
	sourceInUs: integer,
	durationFrames: integer,
	timelineStartFrame: integer,
	trackId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
	mediaVersionId: z.uuid().optional(),
});

/** A deterministic derivation reference, never a model receipt or ASR-quality claim. */
export const compositionCaptionSourceEvidenceSchema = z
	.strictObject({
		version: z.literal(COMPOSITION_CAPTION_SOURCE_VERSION),
		mediaVersionId: z.uuid(),
		timeMapId: z.uuid(),
		segmentIndex: integer.max(4999),
		segmentStartUs: integer,
		segmentEndUs: integer,
		segmentTextHash: z.string().regex(/^[a-f0-9]{64}$/),
		transcriptSegmentsHash: z.string().regex(/^[a-f0-9]{64}$/),
		caption: captionSnapshotSchema,
		spans: z
			.array(
				z.strictObject({
					clipId: z.uuid(),
					sourceFromFrame: integer,
					sourceToFrame: integer,
					outputFromFrame: integer,
					outputToFrame: integer,
					clip: clipSnapshotSchema,
				}),
			)
			.min(1)
			.max(20),
	})
	.refine((evidence) => {
		let output = evidence.caption.fromFrame;
		let source: number | undefined;
		for (const span of evidence.spans) {
			if (
				span.outputFromFrame !== output ||
				span.outputToFrame <= span.outputFromFrame ||
				span.sourceToFrame - span.sourceFromFrame !==
					span.outputToFrame - span.outputFromFrame ||
				(source !== undefined && span.sourceFromFrame !== source)
			)
				return false;
			output = span.outputToFrame;
			source = span.sourceToFrame;
		}
		return (
			evidence.segmentEndUs > evidence.segmentStartUs &&
			output === evidence.caption.toFrame
		);
	}, "Source caption spans must preserve one continuous source/output interval");
export type CompositionCaptionSourceEvidence = z.infer<
	typeof compositionCaptionSourceEvidenceSchema
>;

export function compositionCaptionSourceSnapshot(caption: CompositionCaption) {
	return {
		text: caption.text,
		fromFrame: caption.fromFrame,
		toFrame: caption.toFrame,
		...(caption.words ? { words: caption.words } : {}),
	};
}
export function compositionCaptionClipSnapshot(clip: CompositionClip) {
	return {
		sourceInUs: clip.sourceInUs,
		durationFrames: clip.durationFrames,
		timelineStartFrame: clip.timelineStartFrame,
		...(clip.trackId ? { trackId: clip.trackId } : {}),
		...(clip.mediaVersionId ? { mediaVersionId: clip.mediaVersionId } : {}),
	};
}

/** Any text/word/time/source edit makes this reference stale. Geometry edits do not. */
export function isCompositionCaptionSourceEvidenceCurrent(
	caption: CompositionCaption,
	document: CompositionDocument,
) {
	const evidence = caption.sourceEvidence;
	if (
		!evidence ||
		canonicalEditingJson(evidence.caption) !==
			canonicalEditingJson(compositionCaptionSourceSnapshot(caption))
	)
		return false;
	return evidence.spans.every((span) => {
		const clip = document.clips.find((clip) => clip.id === span.clipId);
		const timeMapId =
			evidence.mediaVersionId === document.mediaVersionId
				? document.timeMapId
				: document.sources?.find(
						(source) => source.mediaVersionId === evidence.mediaVersionId,
					)?.timeMapId;
		return (
			clip &&
			(clip.mediaVersionId ?? document.mediaVersionId) ===
				evidence.mediaVersionId &&
			timeMapId === evidence.timeMapId &&
			canonicalEditingJson(span.clip) ===
				canonicalEditingJson(compositionCaptionClipSnapshot(clip))
		);
	});
}

/** Server save boundary: a client may preserve a trusted reference, never invent one. */
export function normalizeManualCaptionSourceEvidenceEdits(
	previous: CompositionDocument,
	next: CompositionDocument,
): CompositionDocument {
	const original = new Map((previous.captions ?? []).map((c) => [c.id, c]));
	return {
		...next,
		...(next.captions
			? {
					captions: next.captions.map((caption) => {
						const trusted = original.get(caption.id)?.sourceEvidence;
						const { sourceEvidence: _provided, ...display } = caption;
						if (
							!trusted ||
							canonicalEditingJson(trusted) !==
								canonicalEditingJson(caption.sourceEvidence ?? null) ||
							!isCompositionCaptionSourceEvidenceCurrent(caption, next)
						)
							return display;
						return { ...display, sourceEvidence: structuredClone(trusted) };
					}),
				}
			: {}),
	};
}
