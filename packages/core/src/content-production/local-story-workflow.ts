import { z } from "zod";
import type { LocalSemanticConfiguration } from "../content-editing/local-semantic-config";
import { localStoryFlowIdentityForConfiguration } from "../content-editing/local-story-flow-stages";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";

export const LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION = "hierarchical-flow-v1";
/** Keep the FLOW v1 base immutable so ordinary caption-policy changes cannot
 * invalidate sealed TaskPins. New base semantics require a new workflow version. */
const FLOW_V1_BASE_GENERATION_POLICY_FINGERPRINT =
	"3cb7431ddb13a44a90f1ee2dc80eb8f9582696b89c0b2bced9de3357cc25ffc7";
const hash = z
	.string()
	.length(64)
	.regex(/^[a-f0-9]{64}$/);
export const localStoryFlowTaskPolicyPartsSchema = z.strictObject({
	version: z.literal("local-story-flow-task-policies-v1"),
	workflowPolicyHash: hash,
	contextPolicyHash: hash,
	closurePolicyHash: hash,
	routePolicyHash: hash,
	scopePolicyHash: hash,
	promptPolicyHash: hash,
	engineValidationPolicyHash: hash,
	deliveryPolicyHash: hash,
});
export type LocalStoryFlowTaskPolicyParts = z.infer<
	typeof localStoryFlowTaskPolicyPartsSchema
>;

/** Parts must come from compiled policies; this pure fragment does not admit a task. */
export function localStoryFlowGenerationPolicyFingerprint(parts: unknown) {
	return hashEditingEvidence({
		version: "clip-generation-hierarchical-flow-policy-v1",
		baseGenerationPolicyFingerprint: FLOW_V1_BASE_GENERATION_POLICY_FINGERPRINT,
		storyWorkflowVersion: LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION,
		policies: localStoryFlowTaskPolicyPartsSchema.parse(parts),
	});
}

export function localStoryFlowTaskIdentityForConfiguration(
	config: LocalSemanticConfiguration,
	parts: unknown,
) {
	return {
		localStoryWorkflow: localStoryFlowIdentityForConfiguration(config, "FLOW"),
		generationPolicyFingerprint:
			localStoryFlowGenerationPolicyFingerprint(parts),
	};
}

const parameterRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.getPrototypeOf(value) === Object.prototype;

/** Missing means legacy. Explicit markers never fall back or coerce a selection mode. */
export function resolveLocalStoryWorkflow(parameters: unknown) {
	if (!parameterRecord(parameters))
		throw new Error("LOCAL_STORY_WORKFLOW_INVALID");
	if (!Object.hasOwn(parameters, "storyWorkflowVersion"))
		return parameters.policy === "LOCAL_STORY"
			? ("LEGACY_FLAT" as const)
			: ("NOT_LOCAL_STORY" as const);
	if (
		parameters.storyWorkflowVersion !==
			LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION ||
		parameters.policy !== "LOCAL_STORY" ||
		parameters.storyMode !== "FLOW" ||
		parameters.renderMode !== "DRAFT"
	)
		throw new Error("LOCAL_STORY_WORKFLOW_INVALID");
	return "HIERARCHICAL_FLOW_V1" as const;
}
