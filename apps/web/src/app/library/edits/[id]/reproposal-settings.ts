import {
	type CompositionDocument,
	compositionDurationFrames,
	describeLocalStorySelection,
	normalizeManualCaptionSourceEvidenceEdits,
	normalizeManualCaptionTranslationEdits,
	normalizeManualSubjectProtectionEdits,
	setCompositionPresentation,
} from "@bitovp/core";
import type { GenerationSettingsValue } from "../../[id]/edits/generation-settings";

const savedPolicies: Readonly<
	Record<string, GenerationSettingsValue["policy"]>
> = {
	"aisa-scene-cohesion-v2": "COHESION",
	"aisa-prepared-scene-cohesion-v3": "COHESION",
	"aisa-shot-window-v1": "DURATION",
	"aisa-prepared-shot-window-v3": "DURATION",
	"aisa-content-highlight-v1": "AUTO",
	"aisa-prepared-content-highlight-v4": "AUTO",
};

/** New proposals keep source facts and intent; the original timeline is never mutated. */
export function reproposalDefaults(
	document: CompositionDocument,
	available: { localStory: boolean; japanese: boolean },
): { targetDurationFrames: number; settings: GenerationSettingsValue } {
	const requested =
		document.autoGeneration?.requestedDurationFrames ??
		compositionDurationFrames(document);
	const targetDurationFrames = Math.max(30, Math.min(5400, requested));
	const story = document.autoGeneration?.localStoryEvidence
		? describeLocalStorySelection(document.autoGeneration.localStoryEvidence)
		: undefined;
	const policy =
		savedPolicies[document.autoGeneration?.policyVersion ?? ""] ??
		(available.localStory ? "LOCAL_STORY" : "AUTO");
	return {
		targetDurationFrames,
		settings: {
			policy,
			...(policy === "LOCAL_STORY" ? { storyMode: story?.mode ?? "AUTO" } : {}),
			...(policy === "COHESION" && document.autoGeneration?.query
				? { query: document.autoGeneration.query }
				: {}),
			templateId:
				document.canvas.width === document.canvas.height
					? "square-clean"
					: document.canvas.width > document.canvas.height
						? "landscape-clean"
						: "portrait-clean",
			variants: 1,
			captions: document.captions?.length
				? document.captionDisplayLanguage === "ja" && available.japanese
					? "JAPANESE"
					: "ORIGINAL"
				: "OFF",
			tracking: true,
			language: "auto",
			presentation: {
				version: "portrait-layout-v1",
				videoFit: document.presentation?.videoFit ?? "AUTO",
				fallbackFraming:
					document.presentation?.fallbackFraming ?? "PRESERVE_SOURCE_V1",
				captionPlacement: document.presentation?.captionPlacement ?? "OVERLAY",
			},
		},
	};
}

export function reframeCurrentComposition(
	document: CompositionDocument,
	videoFit: "AUTO" | "FILL" | "FIT",
): CompositionDocument {
	return setCompositionPresentation(document, { videoFit });
}

/** The draft-save API adopts automatic framing without changing its geometry. */
export function expectedReproposalSave(
	document: CompositionDocument,
	original?: CompositionDocument,
) {
	const saved = normalizeManualSubjectProtectionEdits(original, document);
	for (const clip of saved.clips)
		for (const part of clip.framing)
			if (part.origin === "AUTO_POLICY") part.origin = "MANUAL";
	const previous = original ?? { ...saved, captions: [] };
	return normalizeManualCaptionSourceEvidenceEdits(
		previous,
		normalizeManualCaptionTranslationEdits(previous, saved),
	);
}
