import { z } from "zod";
import { localSemanticStageRegistry } from "./local-semantic-stages";
import {
	LOCAL_STORY_CHOICE_PROMPT_VERSION,
	localStoryChoiceSchema,
} from "./local-story-choice";
import { hashEditingEvidence } from "./verify-automatic-binding";

/** Planning is an additive component; legacy story/model/cache identities stay fixed. */
export function localStoryChoiceStageRegistry() {
	const schema = z.toJSONSchema(localStoryChoiceSchema);
	return {
		version: "local-story-choice-stages-v1" as const,
		stages: {
			LOCAL_STORY_CHOICE_V1: {
				promptVersion: LOCAL_STORY_CHOICE_PROMPT_VERSION,
				schemaHash: hashEditingEvidence(schema),
				schema,
				maxOutputTokens: 512 as const,
			},
		},
	};
}
export function localSemanticPlanningStageRegistry() {
	const legacy = localSemanticStageRegistry(),
		choice = localStoryChoiceStageRegistry();
	return {
		version: "bitovp-semantic-stages-planning-v1" as const,
		legacyRegistryHash: hashEditingEvidence(legacy),
		choiceRegistryHash: hashEditingEvidence(choice),
		stages: structuredClone({ ...legacy.stages, ...choice.stages }),
	};
}
