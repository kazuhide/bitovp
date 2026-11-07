import { describe, expect, it } from "vitest";
import {
	aisaTranslationBodySchema,
	aisaTranslationsResponseSchema,
	translationForObservation,
} from "./translations";

const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const analysisId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const encodingId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const entry = {
	observationId: "observation-1",
	sourceText: "The player scores a goal.",
	sourceTextHash: "a".repeat(64),
	text: "選手がゴールを決めます。",
	targetLanguage: "ja",
	origin: "LOCAL_MODEL",
	provider: "LOCAL_OPENAI_COMPATIBLE",
	model: "installed-local-model",
	promptVersion: "aisa-observation-ja-v1",
	sourceSequence: 2,
	createdAt: "2026-11-07T00:00:00.000Z",
} as const;
const response = {
	analysisId,
	encodingId,
	targetLanguage: "ja",
	automatic: { available: true, provider: entry.provider, model: entry.model },
	translations: [entry],
};

describe("AISA Live translation contracts", () => {
	it("keeps a translation separate from its exact immutable source", () => {
		const parsed = aisaTranslationsResponseSchema.parse(response);
		expect(
			translationForObservation(parsed, {
				analysisId,
				encodingId,
				id: entry.observationId,
				text: entry.sourceText,
			}),
		).toEqual(entry);
		expect(parsed.translations[0]?.sourceText).toBe(entry.sourceText);
	});
	it("never shows stale or foreign translations", () => {
		const parsed = aisaTranslationsResponseSchema.parse(response);
		for (const identity of [
			{
				analysisId: accountId,
				encodingId,
				id: entry.observationId,
				text: entry.sourceText,
			},
			{
				analysisId,
				encodingId: accountId,
				id: entry.observationId,
				text: entry.sourceText,
			},
			{ analysisId, encodingId, id: "withdrawn", text: entry.sourceText },
			{
				analysisId,
				encodingId,
				id: entry.observationId,
				text: "Revised source",
			},
		])
			expect(translationForObservation(parsed, identity)).toBeUndefined();
	});
	it("accepts only bounded translation actions and unique source identifiers", () => {
		const request = {
			bitmovinAccountId: accountId,
			encodingId,
			action: "translate",
			observationIds: [entry.observationId],
		};
		expect(aisaTranslationBodySchema.parse(request)).toEqual(request);
		expect(
			aisaTranslationBodySchema.safeParse({ ...request, observationIds: [] })
				.success,
		).toBe(false);
		expect(
			aisaTranslationBodySchema.safeParse({
				...request,
				observationIds: ["a", "a"],
			}).success,
		).toBe(false);
		expect(
			aisaTranslationBodySchema.safeParse({ ...request, provider: "cloud" })
				.success,
		).toBe(false);
	});
	it("manual writes carry exact source text and hash but cannot forge model provenance", () => {
		const request = {
			bitmovinAccountId: accountId,
			encodingId,
			action: "save",
			translations: [
				{
					observationId: entry.observationId,
					sourceText: entry.sourceText,
					sourceTextHash: entry.sourceTextHash,
					text: entry.text,
				},
			],
		};
		expect(aisaTranslationBodySchema.safeParse(request).success).toBe(true);
		expect(
			aisaTranslationBodySchema.safeParse({ ...request, origin: "LOCAL_MODEL" })
				.success,
		).toBe(false);
		expect(
			aisaTranslationBodySchema.safeParse({
				...request,
				translations: [{ ...request.translations[0], sourceTextHash: "wrong" }],
			}).success,
		).toBe(false);
	});
});
