import { z } from "zod";

export const AISA_TRANSLATION_PROMPT_VERSION = "aisa-observation-ja-v1";
export const AISA_TRANSLATION_MAX_ITEMS = 32;
export const AISA_TRANSLATION_MAX_TEXT = 12_000;
const identifier = z.string().min(1).max(512);
const sourceText = z.string().min(1).max(AISA_TRANSLATION_MAX_TEXT);
const translatedText = z.string().trim().min(1).max(AISA_TRANSLATION_MAX_TEXT);
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIds = z
	.array(identifier)
	.min(1)
	.max(AISA_TRANSLATION_MAX_ITEMS)
	.refine((values) => new Set(values).size === values.length);

/** Client writes cannot choose a provider, model, or provenance. */
export const aisaTranslationBodySchema = z.discriminatedUnion("action", [
	z.strictObject({
		bitmovinAccountId: z.uuid(),
		encodingId: z.uuid(),
		action: z.literal("translate"),
		observationIds: sourceIds,
	}),
	z.strictObject({
		bitmovinAccountId: z.uuid(),
		encodingId: z.uuid(),
		action: z.literal("save"),
		translations: z
			.array(
				z.strictObject({
					observationId: identifier,
					sourceText,
					sourceTextHash: sourceHash,
					text: translatedText,
				}),
			)
			.min(1)
			.max(AISA_TRANSLATION_MAX_ITEMS)
			.refine(
				(values) =>
					new Set(values.map((v) => v.observationId)).size === values.length,
			),
	}),
]);

const common = {
	observationId: identifier,
	sourceText,
	sourceTextHash: sourceHash,
	text: translatedText,
	targetLanguage: z.literal("ja"),
	sourceSequence: z.number().int().positive().safe(),
	createdAt: z.iso.datetime(),
};
/** The original provider snapshot is never rewritten with these derived strings. */
export const aisaTranslationSchema = z.discriminatedUnion("origin", [
	z.strictObject({
		...common,
		origin: z.literal("LOCAL_MODEL"),
		provider: z.literal("LOCAL_OPENAI_COMPATIBLE"),
		model: z.string().min(1).max(200),
		promptVersion: z.literal(AISA_TRANSLATION_PROMPT_VERSION),
	}),
	z.strictObject({
		...common,
		origin: z.literal("MANUAL"),
		provider: z.literal("OPERATOR"),
		model: z.null(),
		promptVersion: z.null(),
	}),
]);

export const aisaTranslationsResponseSchema = z.object({
	analysisId: z.uuid(),
	encodingId: z.uuid(),
	targetLanguage: z.literal("ja"),
	automatic: z.object({
		available: z.boolean(),
		provider: z.literal("LOCAL_OPENAI_COMPATIBLE").nullable(),
		model: z.string().min(1).max(200).nullable(),
	}),
	translations: z.array(aisaTranslationSchema).max(2_000),
});
export type AisaTranslation = z.infer<typeof aisaTranslationSchema>;
export type AisaTranslationBody = z.infer<typeof aisaTranslationBodySchema>;
export type AisaTranslationsResponse = z.infer<
	typeof aisaTranslationsResponseSchema
>;

export function translationForObservation(
	response: AisaTranslationsResponse | undefined,
	observation: {
		analysisId: string;
		encodingId: string;
		id: string;
		text: string;
	},
): AisaTranslation | undefined {
	if (
		response?.analysisId !== observation.analysisId ||
		response.encodingId !== observation.encodingId
	)
		return undefined;
	return response.translations.find(
		(entry) =>
			entry.observationId === observation.id &&
			entry.sourceText === observation.text,
	);
}
