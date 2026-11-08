import { z } from "zod";
import { isSupportedCaptionText } from "./composition-caption-translation";
import type {
	CompositionCaption,
	CompositionDocument,
} from "./composition-schema";
import { localStoryModelIdentitySchema } from "./local-story-contracts";
import type { EditDocument } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

export const LOCAL_CAPTION_PROMPT_VERSION = "caption-ja-v1" as const;
export const LOCAL_CAPTION_CONTEXT_PROMPT_VERSION = "caption-ja-v2" as const;
export const LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT = hashEditingEvidence({
	version: "caption-scene-context-v1",
	maxCueBytes: 2000,
	maxContextBytes: 1400,
	maxDataBytes: 4500,
	selection: "CURRENT_SOURCE_SPANS_OR_ANCHOR_WHOLE_FIELDS",
	consistency: "EXACT_SOURCE_SAME_BOUND_CONTEXT",
	style: "CONCISE_FAITHFUL",
});
export const LOCAL_CAPTION_MAX_BATCH_BYTES = 2000;
export const localCaptionModelIdentityV1Schema = localStoryModelIdentitySchema
	.omit({ version: true, promptVersion: true })
	.extend({
		version: z.literal("local-caption-model-v1"),
		promptVersion: z.literal(LOCAL_CAPTION_PROMPT_VERSION),
	});
export const localCaptionModelIdentityV2Schema = localStoryModelIdentitySchema
	.omit({ version: true, promptVersion: true })
	.extend({
		version: z.literal("local-caption-model-v2"),
		promptVersion: z.literal(LOCAL_CAPTION_CONTEXT_PROMPT_VERSION),
		contextPolicyFingerprint: z.literal(
			LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		),
	});
const frame = z.number().int().min(0).max(5400);
const nonblank = z.string().min(1).max(1000).refine(isSupportedCaptionText);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const localCaptionTranslationBatchSchema = z.strictObject({
	version: z.literal("caption-ja-input-v1"),
	sourceLanguage: z.enum(["ja", "en", "auto"]),
	targetLanguage: z.literal("ja"),
	qualityPolicyFingerprint: hash,
	cues: z
		.array(
			z.strictObject({
				id: z.string().regex(/^c\d{1,3}$/),
				captionId: z.uuid(),
				fromFrame: frame,
				toFrame: frame,
				anchorClipId: z.uuid().optional(),
				text: nonblank,
			}),
		)
		.min(1)
		.max(8),
});
export type LocalCaptionTranslationBatch = z.infer<
	typeof localCaptionTranslationBatchSchema
>;
export const localCaptionTranslationOutputSchema = z.strictObject({
	translations: z
		.array(
			z.strictObject({ id: z.string().regex(/^c\d{1,3}$/), text: nonblank }),
		)
		.min(1)
		.max(8),
});
export type LocalCaptionTranslationOutput = z.infer<
	typeof localCaptionTranslationOutputSchema
>;
export class LocalCaptionTranslationError extends Error {
	constructor(
		readonly code:
			| "LOCAL_CAPTION_TRANSLATION_INVALID"
			| "LOCAL_CAPTION_CONTEXT_LIMIT"
			| "LOCAL_CAPTION_SOURCE_CHANGED",
	) {
		super(code);
		this.name = "LocalCaptionTranslationError";
	}
}

export function buildLocalCaptionTranslationBatches(input: {
	captions: readonly CompositionCaption[];
	sourceLanguage: "ja" | "en" | "auto";
	qualityPolicyFingerprint: string;
}): LocalCaptionTranslationBatch[] {
	if (
		input.captions.length > 300 ||
		new Set(input.captions.map((c) => c.id)).size !== input.captions.length
	)
		throw new LocalCaptionTranslationError("LOCAL_CAPTION_TRANSLATION_INVALID");
	const batches: LocalCaptionTranslationBatch[] = [],
		current: LocalCaptionTranslationBatch["cues"] = [];
	const bytes = (cues: LocalCaptionTranslationBatch["cues"]) =>
		new TextEncoder().encode(
			JSON.stringify(cues.map(({ id, text }) => ({ id, text }))),
		).length;
	const flush = () => {
		if (current.length) {
			batches.push(
				localCaptionTranslationBatchSchema.parse({
					version: "caption-ja-input-v1",
					sourceLanguage: input.sourceLanguage,
					targetLanguage: "ja",
					qualityPolicyFingerprint: input.qualityPolicyFingerprint,
					cues: [...current],
				}),
			);
			current.length = 0;
		}
	};
	for (const [index, c] of input.captions.entries()) {
		if (c.toFrame <= c.fromFrame || !c.text.trim())
			throw new LocalCaptionTranslationError(
				"LOCAL_CAPTION_TRANSLATION_INVALID",
			);
		const cue = {
			id: `c${index}`,
			captionId: c.id,
			fromFrame: c.fromFrame,
			toFrame: c.toFrame,
			...(c.anchorClipId ? { anchorClipId: c.anchorClipId } : {}),
			text: c.text,
		};
		if (bytes([cue]) > LOCAL_CAPTION_MAX_BATCH_BYTES)
			throw new LocalCaptionTranslationError("LOCAL_CAPTION_CONTEXT_LIMIT");
		if (
			current.length === 8 ||
			bytes([...current, cue]) > LOCAL_CAPTION_MAX_BATCH_BYTES
		)
			flush();
		current.push(cue);
	}
	flush();
	return batches;
}

/** Structural/source binding is verifiable; semantic translation accuracy remains model-dependent. */
export function validateLocalCaptionTranslation(
	batch: LocalCaptionTranslationBatch,
	value: unknown,
): LocalCaptionTranslationOutput {
	try {
		localCaptionTranslationBatchSchema.parse(batch);
		const parsed = localCaptionTranslationOutputSchema.parse(
			typeof value === "string" ? JSON.parse(value) : value,
		);
		const expected = new Set(batch.cues.map((c) => c.id)),
			actual = new Set(parsed.translations.map((c) => c.id));
		if (
			expected.size !== batch.cues.length ||
			actual.size !== parsed.translations.length ||
			actual.size !== expected.size ||
			[...actual].some((id) => !expected.has(id))
		)
			throw new Error("coverage");
		return parsed;
	} catch {
		throw new LocalCaptionTranslationError("LOCAL_CAPTION_TRANSLATION_INVALID");
	}
}

export function applyLocalCaptionTranslation(input: {
	captions: readonly CompositionCaption[];
	batch: LocalCaptionTranslationBatch;
	output: LocalCaptionTranslationOutput;
	evidenceHash: string;
}): CompositionCaption[] {
	const output = validateLocalCaptionTranslation(input.batch, input.output),
		translations = new Map(output.translations.map((v) => [v.id, v.text]));
	hash.parse(input.evidenceHash);
	for (const cue of input.batch.cues) {
		const matches = input.captions.filter((c) => c.id === cue.captionId),
			c = matches[0];
		if (
			matches.length !== 1 ||
			!c ||
			c.text !== cue.text ||
			c.fromFrame !== cue.fromFrame ||
			c.toFrame !== cue.toFrame ||
			c.anchorClipId !== cue.anchorClipId
		)
			throw new LocalCaptionTranslationError("LOCAL_CAPTION_SOURCE_CHANGED");
	}
	const cues = new Map(input.batch.cues.map((c) => [c.captionId, c]));
	return input.captions.map((c) => {
		const cue = cues.get(c.id);
		if (!cue) return { ...c };
		const translatedText = translations.get(cue.id);
		if (translatedText === undefined)
			throw new LocalCaptionTranslationError(
				"LOCAL_CAPTION_TRANSLATION_INVALID",
			);
		return {
			...c,
			translation: {
				targetLanguage: "ja",
				text: translatedText,
				sourceText: cue.text,
				sourceTextHash: hashEditingEvidence(cue.text),
				origin: "LOCAL_LLM",
				evidenceHash: input.evidenceHash,
			},
		};
	});
}

/** A manual save can preserve existing provenance, never mint a new native attestation. */
export function normalizeManualCaptionTranslationEdits(
	previous: CompositionDocument | EditDocument,
	next: CompositionDocument,
): CompositionDocument {
	const existing = new Map(
		(previous.schemaVersion === 2 ? (previous.captions ?? []) : []).map((c) => [
			c.id,
			c,
		]),
	);
	return {
		...next,
		...(next.captions
			? {
					captions: next.captions.map((c) => {
						const translation = c.translation;
						if (!translation) return { ...c };
						const old = existing.get(c.id)?.translation;
						if (
							old &&
							hashEditingEvidence(old) === hashEditingEvidence(translation)
						)
							return { ...c };
						const lineage = old?.evidenceHash ?? old?.derivedFromEvidenceHash;
						return {
							...c,
							translation: {
								targetLanguage: "ja" as const,
								text: translation.text,
								sourceText: c.text,
								sourceTextHash: hashEditingEvidence(c.text),
								origin: "MANUAL" as const,
								...(lineage ? { derivedFromEvidenceHash: lineage } : {}),
							},
						};
					}),
				}
			: {}),
	};
}

// Translation-only experimental identity; never part of the Story receipt union.
export const PLAMO_CAPTION_TEMPLATE = {
	version: "plamo-pfml3-caption-v1",
	dataset: "<|plamo:tag|>dataset<|plamo:msg|>translation",
	context: "<|plamo:tag|>context<|plamo:msg|>",
	input: "<|plamo:tag|>input",
	output: "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja",
	message: "<|plamo:msg|>",
	language: "<|plamo:key|>lang<|plamo:val|>",
	glossary: "<|plamo:tag|>glossary",
	term: "<|plamo:index|>",
	definition: "<|plamo:item|>",
	style: "<|plamo:key|>form<|plamo:val|>plain",
	stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
} as const;
export const PLAMO_CAPTION_TEMPLATE_HASH = hashEditingEvidence(
	PLAMO_CAPTION_TEMPLATE,
);
const plamoHash = z.string().regex(/^[a-f0-9]{64}$/);
export const plamoCaptionModelIdentitySchema = z.strictObject({
	version: z.literal("plamo-caption-model-v1"),
	provider: z.literal("LOCAL_LLAMA_CPP"),
	profile: z.enum(["amd", "nvidia"]),
	modelId: z.literal("pfnet/plamo-3-translate-31b"),
	sourceRevision: z.literal("01eac57bf80ef8114decd998f8f3a803ba795557"),
	weightSha256: plamoHash,
	quantization: z.enum(["BF16", "F16", "Q8_0", "Q4_K_M"]),
	conversionRecipeHash: plamoHash.optional(),
	runtimeSourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
	runtimeBinarySha256: plamoHash,
	promptTemplateHash: z.literal(PLAMO_CAPTION_TEMPLATE_HASH),
	configId: z.uuid(),
	context: z.literal(8192),
	maxOutputTokens: z.literal(1536),
	temperature: z.literal(0),
	seed: z.literal(41),
	thinking: z.literal(false),
});
export type PlamoCaptionModelIdentity = z.infer<
	typeof plamoCaptionModelIdentitySchema
>;
const plamoPlain = (maximum: number) =>
	z
		.string()
		.min(1)
		.max(maximum)
		.refine(isSupportedCaptionText)
		.refine((value) => !value.includes("<|plamo:"));
export const localPlamoCaptionOutputSchema = z.strictObject({
	id: z.string().regex(/^c\d{1,3}$/),
	text: plamoPlain(1000),
});
export const PLAMO_CAPTION_VALIDATION_POLICY_FINGERPRINT = hashEditingEvidence({
	version: "plamo-caption-validation-v1",
	output: "PLAIN_EXACT_SOURCE_ID",
	reservedTokens: "REJECT",
	sourceClock: "IMMUTABLE",
	maximumPromptBytes: 5632,
});
export const localCaptionModelIdentityV3Schema = plamoCaptionModelIdentitySchema
	.omit({ version: true })
	.extend({
		version: z.literal("local-caption-model-v3"),
		promptVersion: z.literal(PLAMO_CAPTION_TEMPLATE.version),
		contextPolicyFingerprint: z.literal(
			LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		),
		validationPolicyFingerprint: z.literal(
			PLAMO_CAPTION_VALIDATION_POLICY_FINGERPRINT,
		),
		schemaHash: plamoHash,
		manifestHash: plamoHash,
		weightBytes: z
			.number()
			.int()
			.positive()
			.max(128 * 1024 ** 3),
		runtimeBuildRecipeHash: plamoHash.optional(),
		runtimeBackend: z.enum(["CUDA", "ROCM", "VULKAN"]).optional(),
	})
	.superRefine((value, context) => {
		if (
			value.runtimeBackend !== undefined &&
			(value.profile === "nvidia"
				? value.runtimeBackend !== "CUDA"
				: value.runtimeBackend === "CUDA")
		)
			context.addIssue({
				code: "custom",
				path: ["runtimeBackend"],
				message: "Runtime backend does not match profile",
			});
	});
export const plamoCaptionInputSchema = z.strictObject({
	identity: z.union([
		plamoCaptionModelIdentitySchema,
		localCaptionModelIdentityV3Schema,
	]),
	cueId: z.string().regex(/^c\d{1,3}$/),
	sourceText: plamoPlain(1000),
	sourceLanguage: z.enum(["ja", "en", "auto"]),
	sourceBindingHash: plamoHash,
	contextScopeHash: plamoHash,
	context: plamoPlain(64000).optional(),
	glossary: z
		.array(z.strictObject({ source: plamoPlain(512), target: plamoPlain(512) }))
		.max(32),
	history: z
		.array(
			z.strictObject({
				sourceText: plamoPlain(1000),
				translatedText: plamoPlain(1000),
				contextScopeHash: plamoHash,
			}),
		)
		.max(4),
});
export type PlamoCaptionInput = z.infer<typeof plamoCaptionInputSchema>;

export const localCaptionModelIdentitySchema = z.discriminatedUnion("version", [
	localCaptionModelIdentityV1Schema,
	localCaptionModelIdentityV2Schema,
	localCaptionModelIdentityV3Schema,
]);
export type LocalCaptionModelIdentity = z.infer<
	typeof localCaptionModelIdentitySchema
>;
export const localCaptionTranslationResultSchema = z
	.strictObject({
		version: z.literal("local-caption-translation-v1"),
		model: localCaptionModelIdentitySchema,
		targetLanguage: z.literal("ja"),
		captionCount: z.number().int().min(0).max(900),
		artifactHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(150),
	})
	.refine((v) => (v.captionCount === 0) === (v.artifactHashes.length === 0));
