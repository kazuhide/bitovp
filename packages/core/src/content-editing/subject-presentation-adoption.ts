import { z } from "zod";
import type {
	CompositionClip,
	CompositionDocument,
} from "./composition-schema";
import { compositionSubjectProtectionContext } from "./subject-protection";
import { hashEditingEvidence } from "./verify-automatic-binding";

export const COMPOSITION_SUBJECT_PRESENTATION_ADOPTION_VERSION =
	"source-bound-manual-presentation-v1" as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** A saved manual view, never an attestation of current subject tracking. */
export const compositionSubjectPresentationAdoptionSchema = z.strictObject({
	version: z.literal(COMPOSITION_SUBJECT_PRESENTATION_ADOPTION_VERSION),
	sourceBindingHash: hash,
	geometryHash: hash,
	proofHash: hash,
});
export type CompositionSubjectPresentationAdoption = z.infer<
	typeof compositionSubjectPresentationAdoptionSchema
>;

/** Only crop coordinates/keys may change during an explicit manual crop edit.
 * Source/clock, canvas/layout, bands, and the CROP/FIT ranges stay authorized by
 * the stored view. In particular, LOST/FIT ranges cannot become manual FILL. */
export function createSubjectPresentationAdoption(
	document: CompositionDocument,
	clip: CompositionClip,
	proofHash: string,
): CompositionSubjectPresentationAdoption | undefined {
	const context = compositionSubjectProtectionContext(document, clip);
	if (!context) return undefined;
	const { framingHash, ...sourceContext } = context;
	return compositionSubjectPresentationAdoptionSchema.parse({
		version: COMPOSITION_SUBJECT_PRESENTATION_ADOPTION_VERSION,
		proofHash,
		sourceBindingHash: hashEditingEvidence({
			sourceContext,
			clipId: clip.id,
			canvas: document.canvas,
			fps: document.fps,
			presentation: document.presentation
				? {
						videoFit: document.presentation.videoFit ?? null,
						captionPlacement: document.presentation.captionPlacement,
						fallbackFraming: document.presentation.fallbackFraming ?? null,
					}
				: null,
			trackId: clip.trackId ?? "main",
			tracks:
				document.videoTracks?.map(({ id, order }) => ({ id, order })) ?? null,
			layout: clip.layout ?? null,
			videoFit: clip.videoFit ?? null,
			framing: clip.framing.map(({ fromFrame, toFrame, mode }) => ({
				fromFrame,
				toFrame,
				mode,
			})),
		}),
		geometryHash: hashEditingEvidence({
			framingHash,
			fallbackCrop: clip.fallbackCrop ?? null,
		}),
	});
}

export function hasCurrentSubjectPresentationAdoption(
	document: CompositionDocument,
	clip: CompositionClip,
): boolean {
	const parsed = compositionSubjectPresentationAdoptionSchema.safeParse(
		clip.subjectPresentationAdoption,
	);
	if (
		!parsed.success ||
		!clip.framing.some((part) => part.mode === "CROP") ||
		clip.framing.some(
			(part) =>
				part.mode === "CROP" &&
				(part.origin !== "MANUAL" || part.manualOverride !== true),
		)
	)
		return false;
	const expected = createSubjectPresentationAdoption(
		document,
		clip,
		parsed.data.proofHash,
	);
	return (
		!!expected &&
		hashEditingEvidence(parsed.data) === hashEditingEvidence(expected)
	);
}

export function isCompositionSubjectPresentationAdopted(input: {
	document: CompositionDocument;
	clip: CompositionClip;
	frame: number;
	sourceWidth: number;
	sourceHeight: number;
}): boolean {
	const binding = input.document.autoGeneration?.binding;
	const part = input.clip.framing.find(
		(value) => input.frame >= value.fromFrame && input.frame < value.toFrame,
	);
	return (
		binding?.width === input.sourceWidth &&
		binding.height === input.sourceHeight &&
		part?.mode === "CROP" &&
		part.origin === "MANUAL" &&
		part.manualOverride === true &&
		hasCurrentSubjectPresentationAdoption(input.document, input.clip)
	);
}
