import { z } from "zod";

export const LOCAL_SEMANTIC_MODEL = "qwen3.8:27b-q8_0";
export const LOCAL_SEMANTIC_MODEL_DIGEST =
	"8f5fb6b71ea00052cbe8545738c55ce61112c4e571cb60ca4dad00b131766039";
export const LOCAL_SEMANTIC_RUNTIME_VERSION = "0.40.14";
export const LOCAL_SEMANTIC_PROMPT_VERSION = "local-story-v1";
export function isLocalStoryPolicy(version: string): boolean {
	return (
		version === "aisa-local-story-window-v1" ||
		version === "aisa-prepared-local-story-window-v1"
	);
}
export const localSemanticStageSchema = z.enum([
	"LOCAL_LEDGER_V1",
	"LOCAL_BLUEPRINT_V1",
	"LOCAL_STORY_CHOICE_V1",
	"LOCAL_CAPTION_JA_V1",
	"LOCAL_CAPTION_JA_V2",
	"LOCAL_FLOW_CONTEXT_V1",
	"LOCAL_FLOW_ROUTE_V1",
]);
export type LocalSemanticStage = z.infer<typeof localSemanticStageSchema>;
export const LOCAL_SEMANTIC_OUTPUT_TOKENS = {
	LOCAL_LEDGER_V1: 1024,
	LOCAL_BLUEPRINT_V1: 1536,
	LOCAL_STORY_CHOICE_V1: 512,
	LOCAL_CAPTION_JA_V1: 1536,
	LOCAL_CAPTION_JA_V2: 1536,
	LOCAL_FLOW_CONTEXT_V1: 1536,
	LOCAL_FLOW_ROUTE_V1: 1536,
} as const;
export function localSemanticPromptVersion(stage: LocalSemanticStage) {
	if (stage === "LOCAL_STORY_CHOICE_V1")
		return "local-story-choice-v1" as const;
	if (stage === "LOCAL_FLOW_CONTEXT_V1")
		return "local-story-flow-context-v1" as const;
	if (stage === "LOCAL_FLOW_ROUTE_V1")
		return "local-story-flow-route-v1" as const;
	if (stage === "LOCAL_CAPTION_JA_V2") return "caption-ja-v2" as const;
	return stage === "LOCAL_CAPTION_JA_V1"
		? ("caption-ja-v1" as const)
		: LOCAL_SEMANTIC_PROMPT_VERSION;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const localSemanticJobRequestSchema = z
	.strictObject({
		version: z.literal("bitovp-semantic-job-v1"),
		requestKey: z.uuid(),
		organizationId: z.uuid(),
		profile: z.enum(["amd", "nvidia"]),
		stage: localSemanticStageSchema,
		prompt: z.string().min(1).max(65536),
		inputHash: hash,
		promptVersion: z.enum([
			LOCAL_SEMANTIC_PROMPT_VERSION,
			"local-story-choice-v1",
			"caption-ja-v1",
			"caption-ja-v2",
			"local-story-flow-context-v1",
			"local-story-flow-route-v1",
		]),
		schemaHash: hash,
	})
	.refine(
		(value) => value.promptVersion === localSemanticPromptVersion(value.stage),
		"Prompt version must match its registered stage",
	);
export const localSemanticReceiptSchema = z.strictObject({
	version: z.literal("bitovp-semantic-receipt-v1"),
	profile: z.enum(["amd", "nvidia"]),
	model: z.literal(LOCAL_SEMANTIC_MODEL),
	modelDigest: z.literal(LOCAL_SEMANTIC_MODEL_DIGEST),
	runtimeVersion: z.literal(LOCAL_SEMANTIC_RUNTIME_VERSION),
	inputHash: hash,
	promptHash: hash,
	schemaHash: hash,
	promptVersion: z.enum([
		LOCAL_SEMANTIC_PROMPT_VERSION,
		"local-story-choice-v1",
		"caption-ja-v1",
		"caption-ja-v2",
		"local-story-flow-context-v1",
		"local-story-flow-route-v1",
	]),
	context: z.literal(8192),
	maxOutputTokens: z.union([z.literal(512), z.literal(1024), z.literal(1536)]),
	thinking: z.literal(false),
	requestHash: hash,
	elapsedMs: z.number().finite().nonnegative(),
	apiStats: z.strictObject({
		promptEvalCount: count,
		evalCount: count,
		doneReason: z.literal("stop"),
		loadDurationNs: count,
		promptEvalDurationNs: count,
		evalDurationNs: count,
	}),
	placement: z
		.array(
			z.strictObject({
				name: z.string().min(1).max(256),
				size: count,
				sizeVram: count.positive(),
				contextLength: z.literal(8192),
			}),
		)
		.min(1)
		.max(2),
	cleanupConfirmed: z.literal(true),
	schemaVerified: z.literal(false),
});
export type LocalSemanticReceipt = z.infer<typeof localSemanticReceiptSchema>;
export const localSemanticJobSchema = z.strictObject({
	id: z.uuid(),
	state: z.enum([
		"QUEUED",
		"LOADING",
		"RUNNING",
		"VALIDATING",
		"CANCELLING",
		"SUCCEEDED",
		"FAILED",
		"CANCELLED",
	]),
	stage: localSemanticStageSchema,
	requestHash: hash,
	cleanupConfirmed: z.boolean(),
	result: z
		.strictObject({
			content: z
				.string()
				.min(2)
				.max(128 * 1024),
			receipt: localSemanticReceiptSchema,
		})
		.optional(),
	errorCode: z
		.string()
		.regex(/^[A-Z][A-Z0-9_]{0,95}$/)
		.optional(),
});
export type LocalSemanticJob = z.infer<typeof localSemanticJobSchema>;
