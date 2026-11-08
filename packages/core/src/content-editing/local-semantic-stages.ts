import { z } from "zod";
import {
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	LOCAL_CAPTION_CONTEXT_PROMPT_VERSION,
	LOCAL_CAPTION_PROMPT_VERSION,
	localCaptionModelIdentityV2Schema,
	localCaptionTranslationOutputSchema,
} from "./local-caption-translation";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_OUTPUT_TOKENS,
	LOCAL_SEMANTIC_PROMPT_VERSION,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
} from "./local-semantic-protocol";
import {
	localStoryBlueprintSchema,
	localStoryLedgerSchema,
	localStoryModelIdentitySchema,
} from "./local-story-contracts";
import { hashEditingEvidence } from "./verify-automatic-binding";

export function localStoryStageRegistry() {
	const entry = (definition: z.ZodType, maxOutputTokens: number) => {
		const schema = z.toJSONSchema(definition);
		return {
			promptVersion: LOCAL_SEMANTIC_PROMPT_VERSION,
			schemaHash: hashEditingEvidence(schema),
			schema,
			maxOutputTokens,
		};
	};
	return {
		version: "bitovp-semantic-stages-v1" as const,
		stages: {
			LOCAL_LEDGER_V1: entry(
				localStoryLedgerSchema,
				LOCAL_SEMANTIC_OUTPUT_TOKENS.LOCAL_LEDGER_V1,
			),
			LOCAL_BLUEPRINT_V1: entry(
				localStoryBlueprintSchema,
				LOCAL_SEMANTIC_OUTPUT_TOKENS.LOCAL_BLUEPRINT_V1,
			),
		},
	};
}
export function localSemanticStageRegistry() {
	const story = localStoryStageRegistry();
	const schema = z.toJSONSchema(localCaptionTranslationOutputSchema);
	return {
		...story,
		stages: {
			...story.stages,
			LOCAL_CAPTION_JA_V1: {
				promptVersion: LOCAL_CAPTION_PROMPT_VERSION,
				schemaHash: hashEditingEvidence(schema),
				schema,
				maxOutputTokens: LOCAL_SEMANTIC_OUTPUT_TOKENS.LOCAL_CAPTION_JA_V1,
			},
			LOCAL_CAPTION_JA_V2: {
				promptVersion: LOCAL_CAPTION_CONTEXT_PROMPT_VERSION,
				schemaHash: hashEditingEvidence(schema),
				schema,
				maxOutputTokens: LOCAL_SEMANTIC_OUTPUT_TOKENS.LOCAL_CAPTION_JA_V2,
			},
		},
	};
}
export type LocalStoryModelPin = Pick<
	LocalSemanticConfiguration,
	"profile" | "configId"
>;
const modelPinSchema = z.strictObject({
	profile: z.enum(["amd", "nvidia"]),
	configId: z.uuid(),
});
function storyIdentity(config: LocalStoryModelPin) {
	return localStoryModelIdentitySchema.parse({
		version: "local-story-model-v1",
		provider: "LOCAL_OLLAMA",
		profile: config.profile,
		model: LOCAL_SEMANTIC_MODEL,
		modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
		runtimeVersion: LOCAL_SEMANTIC_RUNTIME_VERSION,
		promptVersion: LOCAL_SEMANTIC_PROMPT_VERSION,
		schemaHash: hashEditingEvidence(localStoryStageRegistry()),
		configId: config.configId,
		context: 8192,
		thinking: false,
	});
}
export function localStoryIdentityForConfiguration(
	config: LocalSemanticConfiguration,
) {
	return storyIdentity(config);
}

/** Reconstruct an identity from a stored non-secret pin, without a runtime config. */
export function localStoryIdentityForModelPin(value: unknown) {
	try {
		if (
			!value ||
			typeof value !== "object" ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Object.getOwnPropertySymbols(value).length
		)
			throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors);
		if (
			names.length !== 2 ||
			!names.every((name) => name === "profile" || name === "configId")
		)
			throw new Error();
		const profile = descriptors.profile,
			configId = descriptors.configId;
		if (
			!profile?.enumerable ||
			!configId?.enumerable ||
			!("value" in profile) ||
			!("value" in configId)
		)
			throw new Error();
		return storyIdentity(
			modelPinSchema.parse({
				profile: profile.value,
				configId: configId.value,
			}),
		);
	} catch {
		throw new Error("LOCAL_STORY_MODEL_PIN_INVALID");
	}
}
export function localCaptionIdentityForConfiguration(
	config: LocalSemanticConfiguration,
) {
	const story = localStoryIdentityForConfiguration(config);
	return localCaptionModelIdentityV2Schema.parse({
		...story,
		version: "local-caption-model-v2",
		promptVersion: LOCAL_CAPTION_CONTEXT_PROMPT_VERSION,
		contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		schemaHash: hashEditingEvidence(
			localSemanticStageRegistry().stages.LOCAL_CAPTION_JA_V2,
		),
	});
}
