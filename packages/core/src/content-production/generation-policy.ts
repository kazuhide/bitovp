import { CAPTION_ALIGNMENT_POLICY } from "../content-editing/caption-alignment";
import {
	COMPOSITION_CAPTION_SELECTION_POLICY,
	COMPOSITION_CAPTION_SOURCE_VERSION,
} from "../content-editing/composition-caption-source";
import { LOCAL_STORY_PLAN_VALIDATION_POLICY } from "../content-editing/local-story-coherence";
import {
	LOCAL_STORY_SUBJECT_POLICY_VERSION,
	LOCAL_STORY_TRACKING_POLICY_VERSION,
} from "../content-editing/local-story-subjects";
import { COMPOSITION_SUBJECT_PRESENTATION_ADOPTION_VERSION } from "../content-editing/subject-presentation-adoption";
import { COMPOSITION_SUBJECT_PROTECTION_VERSION } from "../content-editing/subject-protection";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";

/** GENERATE-only cache namespace. ASR and accepted Ledger receipts deliberately
 * do not depend on this output policy or on the requested clip duration. */
export const GENERATION_POLICY_FINGERPRINT = hashEditingEvidence({
	version: "clip-generation-policy-v1",
	captionSource: COMPOSITION_CAPTION_SOURCE_VERSION,
	captionSelection: COMPOSITION_CAPTION_SELECTION_POLICY,
	captionAlignment: CAPTION_ALIGNMENT_POLICY,
	subjects: LOCAL_STORY_SUBJECT_POLICY_VERSION,
	protection: COMPOSITION_SUBJECT_PROTECTION_VERSION,
	manualPresentation: COMPOSITION_SUBJECT_PRESENTATION_ADOPTION_VERSION,
	storyPlan: LOCAL_STORY_PLAN_VALIDATION_POLICY,
	tracking: LOCAL_STORY_TRACKING_POLICY_VERSION,
});
