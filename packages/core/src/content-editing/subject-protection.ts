import { z } from "zod";
import type {
	CompositionClip,
	CompositionDocument,
} from "./composition-schema";
import type { LocalStorySubjectTarget } from "./local-story-subjects";
import { type NormalizedCropRect, normalizedCropRectSchema } from "./schema";
import { originalTimeToCfrFrame } from "./time";
import { hashEditingEvidence } from "./verify-automatic-binding";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const us = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const COMPOSITION_SUBJECT_PROTECTION_VERSION =
	"local-subject-protection-v1" as const;
const contextSchema = z.strictObject({
	bindingHash: hash,
	mediaVersionId: z.uuid(),
	timeMapId: z.uuid(),
	mediaSha256: hash,
	timeMapHash: hash,
	analysisRevisionId: z.uuid(),
	analysisDocumentHash: hash,
	storyArtifactHash: hash,
	selectionHash: hash,
	sceneId: z.uuid(),
	shotIndex: z.number().int().min(0).max(4999),
	sourceStartUs: us,
	sourceEndUs: us,
	sourceInUs: us,
	durationFrames: z.number().int().min(1).max(5400),
	sourceWidth: z.number().int().min(1).max(8192),
	sourceHeight: z.number().int().min(1).max(8192),
	framingHash: hash,
});
export const compositionSubjectProtectionSchema = z
	.strictObject({
		version: z.literal(COMPOSITION_SUBJECT_PROTECTION_VERSION),
		context: contextSchema,
		targetId: z.string().regex(/^target-[a-f0-9]{64}$/),
		subjectIndexes: z.array(z.number().int().min(0).max(999)).min(1).max(4),
		protectedBoxes: z.array(normalizedCropRectSchema).min(1).max(4),
		seedSourceTimeUs: us,
		samples: z
			.array(
				z.strictObject({
					sourceTimeUs: us,
					box: normalizedCropRectSchema,
					confidence: z.number().min(0).max(1),
				}),
			)
			.min(2)
			.max(1120),
	})
	.superRefine((value, ctx) => {
		if (
			new Set(value.subjectIndexes).size !== value.subjectIndexes.length ||
			value.subjectIndexes.length !== value.protectedBoxes.length ||
			value.samples.some(
				(sample, i) =>
					i > 0 &&
					sample.sourceTimeUs <=
						(value.samples[i - 1]?.sourceTimeUs ?? Infinity),
			)
		)
			ctx.addIssue({
				code: "custom",
				message:
					"Subject protection requires distinct targets and increasing actual samples",
			});
	});
export type CompositionSubjectProtection = z.infer<
	typeof compositionSubjectProtectionSchema
>;
export type SubjectProtectionContext = z.infer<typeof contextSchema>;
export type SubjectProtectionSample =
	CompositionSubjectProtection["samples"][number];

export function compositionSubjectProtectionContext(
	document: CompositionDocument,
	clip: CompositionClip,
): SubjectProtectionContext | undefined {
	const generation = document.autoGeneration,
		binding = generation?.binding;
	if (
		!binding ||
		!generation?.localStoryEvidence ||
		binding.kind === "FIXTURE_AUTHORED" ||
		(clip.mediaVersionId ?? document.mediaVersionId) !==
			binding.mediaVersionId ||
		clip.evidence?.sceneId === undefined ||
		clip.evidence.shotIndex === undefined
	)
		return undefined;
	const owner =
		binding.mediaVersionId === document.mediaVersionId
			? document
			: document.sources?.find(
					(source) => source.mediaVersionId === binding.mediaVersionId,
				);
	if (
		!owner ||
		owner.timeMapId !== binding.timeMapId ||
		owner.analysisRevisionId !== binding.analysisRevisionId
	)
		return undefined;
	return contextSchema.parse({
		bindingHash: hashEditingEvidence(binding),
		mediaVersionId: binding.mediaVersionId,
		timeMapId: binding.timeMapId,
		mediaSha256: binding.mediaSha256,
		timeMapHash: binding.timeMapHash,
		analysisRevisionId: binding.analysisRevisionId,
		analysisDocumentHash: binding.analysisDocumentHash,
		storyArtifactHash: generation.localStoryEvidence.artifactHash,
		selectionHash: hashEditingEvidence(generation.localStoryEvidence.selection),
		sceneId: clip.evidence.sceneId,
		shotIndex: clip.evidence.shotIndex,
		sourceStartUs: binding.sourceStartUs,
		sourceEndUs: binding.sourceEndUs,
		sourceInUs: clip.sourceInUs,
		durationFrames: clip.durationFrames,
		sourceWidth: binding.width,
		sourceHeight: binding.height,
		framingHash: hashEditingEvidence({
			canvas: document.canvas,
			captionPlacement: document.presentation?.captionPlacement ?? "OVERLAY",
			sourceInUs: clip.sourceInUs,
			durationFrames: clip.durationFrames,
			evidence: clip.evidence,
			layout: clip.layout ?? null,
			framing: clip.framing,
			cropKeyframes: clip.cropKeyframes ?? [],
		}),
	});
}

export function createCompositionSubjectProtection(input: {
	context: SubjectProtectionContext;
	target: LocalStorySubjectTarget;
	seedSourceTimeUs: number;
	samples: readonly SubjectProtectionSample[];
}): CompositionSubjectProtection | undefined {
	if (
		input.target.decision !== "CROP" ||
		input.target.analysisDocumentHash !== input.context.analysisDocumentHash ||
		input.target.timeMapHash !== input.context.timeMapHash ||
		input.target.sceneId !== input.context.sceneId ||
		input.target.shotIndex !== input.context.shotIndex ||
		input.samples.length < 2
	)
		return undefined;
	return compositionSubjectProtectionSchema.parse({
		version: COMPOSITION_SUBJECT_PROTECTION_VERSION,
		context: input.context,
		targetId: input.target.targetId,
		subjectIndexes: input.target.subjectIndexes,
		protectedBoxes: input.target.protectedBoxes,
		seedSourceTimeUs: input.seedSourceTimeUs,
		samples: input.samples,
	});
}

/** Context/geometry checks are necessary evidence fences, not a new face detector. */
export function isSubjectProtectionValid(input: {
	proof: unknown;
	context: SubjectProtectionContext;
	frame: number;
	rect: NormalizedCropRect;
	origin: string;
}): boolean {
	const parsed = compositionSubjectProtectionSchema.safeParse(input.proof),
		rect = normalizedCropRectSchema.safeParse(input.rect);
	if (
		!parsed.success ||
		!rect.success ||
		input.origin !== "AUTO_POLICY" ||
		!Number.isInteger(input.frame) ||
		input.frame < 0 ||
		input.frame >= input.context.durationFrames
	)
		return false;
	const proof = parsed.data,
		context = input.context;
	if (hashEditingEvidence(proof.context) !== hashEditingEvidence(context))
		return false;
	const frameAt = (time: number) =>
			Number(originalTimeToCfrFrame(time, context.sourceStartUs, "FLOOR")),
		start = frameAt(context.sourceInUs),
		frames = proof.samples.map(
			(sample) => frameAt(sample.sourceTimeUs) - start,
		);
	if (
		proof.samples[0]?.sourceTimeUs !== proof.seedSourceTimeUs ||
		proof.samples.some(
			(sample, index) =>
				sample.sourceTimeUs < context.sourceInUs ||
				sample.sourceTimeUs < context.sourceStartUs ||
				sample.sourceTimeUs >= context.sourceEndUs ||
				(frames[index] ?? -1) < 0 ||
				(frames[index] ?? Infinity) >= context.durationFrames ||
				(index > 0 && (frames[index] ?? 0) <= (frames[index - 1] ?? Infinity)),
		)
	)
		return false;
	const contains = (
		outer: NormalizedCropRect,
		inner: NormalizedCropRect,
		margin = 0,
	) =>
		outer.x <= inner.x - inner.w * margin + 1e-9 &&
		outer.y <= inner.y - inner.h * margin + 1e-9 &&
		outer.x + outer.w >= inner.x + inner.w * (1 + margin) - 1e-9 &&
		outer.y + outer.h >= inner.y + inner.h * (1 + margin) - 1e-9;
	const seed = proof.samples[0];
	if (!seed || !proof.protectedBoxes.every((box) => contains(seed.box, box)))
		return false;
	for (let i = 0; i < proof.samples.length - 1; i++) {
		const a = proof.samples[i],
			b = proof.samples[i + 1],
			from = frames[i],
			to = frames[i + 1];
		if (
			!a ||
			!b ||
			from === undefined ||
			to === undefined ||
			input.frame < from ||
			input.frame > to
		)
			continue;
		if (a.confidence < 0.9 || b.confidence < 0.9) return false;
		const seconds = (b.sourceTimeUs - a.sourceTimeUs) / 1_000_000,
			distance = Math.hypot(
				a.box.x + a.box.w / 2 - b.box.x - b.box.w / 2,
				a.box.y + a.box.h / 2 - b.box.y - b.box.h / 2,
			);
		if (
			distance / seconds > 0.6 ||
			Math.abs(Math.log(b.box.w / a.box.w)) / seconds > Math.log(1.8) ||
			Math.abs(Math.log(b.box.h / a.box.h)) / seconds > Math.log(1.8)
		)
			return false;
		// Protect both measured endpoints rather than invent a tighter intermediate box.
		return contains(rect.data, a.box, 0.1) && contains(rect.data, b.box, 0.1);
	}
	return false;
}

export function isCompositionSubjectProtected(input: {
	document: CompositionDocument;
	clip: CompositionClip;
	frame: number;
	rect: NormalizedCropRect;
	sourceWidth: number;
	sourceHeight: number;
}): boolean {
	const context = compositionSubjectProtectionContext(
			input.document,
			input.clip,
		),
		part = input.clip.framing.find(
			(part) => input.frame >= part.fromFrame && input.frame < part.toFrame,
		);
	return (
		!!context &&
		context.sourceWidth === input.sourceWidth &&
		context.sourceHeight === input.sourceHeight &&
		part?.mode === "CROP" &&
		isSubjectProtectionValid({
			proof: input.clip.subjectProtection,
			context,
			frame: input.frame,
			rect: input.rect,
			origin: part.origin,
		})
	);
}
