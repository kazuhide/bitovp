import { describe, expect, it } from "vitest";
import { TRANSCRIPTION_POLICY_FINGERPRINT } from "../content-production/transcription-quality";
import {
	applyLocalCaptionTranslation,
	buildLocalCaptionTranslationBatches,
	localCaptionModelIdentityV1Schema,
	normalizeManualCaptionTranslationEdits,
	validateLocalCaptionTranslation,
} from "./local-caption-translation";
import {
	localCaptionIdentityForConfiguration,
	localSemanticStageRegistry,
	localStoryIdentityForConfiguration,
} from "./local-semantic-stages";
import { hashEditingEvidence } from "./verify-automatic-binding";

const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw Error("missing test fixture");
	return value;
};

const cue = (index: number, text = "Hello world.") => ({
	id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
	fromFrame: index * 30,
	toFrame: index * 30 + 29,
	text,
});
const batches = (cues = [cue(1), cue(2)]) =>
	buildLocalCaptionTranslationBatches({
		captions: cues,
		sourceLanguage: "en",
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
	});

describe("local Japanese caption translation contract", () => {
	it("covers every original cue exactly without exposing clock editing to the model", () => {
		const all = Array.from({ length: 23 }, (_, i) => cue(i + 1));
		const result = batches(all);
		expect(result.flatMap((b) => b.cues.map((c) => c.captionId))).toEqual(
			all.map((c) => c.id),
		);
		expect(result.every((b) => b.cues.length <= 8)).toBe(true);
	});
	it.each([
		{ translations: [{ id: "c0", text: "こんにちは。" }] },
		{
			translations: [
				{ id: "c0", text: "こんにちは。" },
				{ id: "c0", text: "もう一つ。" },
			],
		},
		{
			translations: [
				{ id: "c0", text: "こんにちは。" },
				{ id: "other", text: "世界。" },
			],
		},
		{
			translations: [
				{ id: "c0", text: "こんにちは。", fromFrame: 0 },
				{ id: "c1", text: "世界。" },
			],
		},
		{
			translations: [
				{ id: "c0", text: " " },
				{ id: "c1", text: "世界。" },
			],
		},
		{
			translations: [
				{ id: "c0", text: "\u0000不正" },
				{ id: "c1", text: "世界。" },
			],
		},
	])("rejects missing, duplicate, unknown, time-bearing or empty outputs %#", (output) => {
		expect(() =>
			validateLocalCaptionTranslation(required(batches()[0]), output),
		).toThrow("LOCAL_CAPTION_TRANSLATION_INVALID");
	});
	it("retains source measured timing, ids and text when attaching validated translations", () => {
		const batch = required(batches()[0]);
		const output = validateLocalCaptionTranslation(batch, {
			translations: [
				{ id: "c1", text: "世界。" },
				{ id: "c0", text: "こんにちは。" },
			],
		});
		const result = applyLocalCaptionTranslation({
			captions: [cue(1), cue(2)],
			batch,
			output,
			evidenceHash: "b".repeat(64),
		});
		expect(result.map(({ translation, ...c }) => c)).toEqual([cue(1), cue(2)]);
		expect(result[0]?.translation).toMatchObject({
			text: "こんにちは。",
			sourceText: cue(1).text,
			sourceTextHash: hashEditingEvidence(cue(1).text),
			origin: "LOCAL_LLM",
		});
		expect(() =>
			applyLocalCaptionTranslation({
				captions: [cue(1, "Changed."), cue(2)],
				batch,
				output,
				evidenceHash: "b".repeat(64),
			}),
		).toThrow("LOCAL_CAPTION_SOURCE_CHANGED");
	});
	it("skips empty speech, rejects an oversized cue instead of truncating it", () => {
		expect(batches([])).toEqual([]);
		expect(() => batches([cue(1, "界".repeat(1000))])).toThrow(
			"LOCAL_CAPTION_CONTEXT_LIMIT",
		);
	});
	it("adds a separate third-stage identity without invalidating any old story stage identity", () => {
		const config = {
			profile: "nvidia" as const,
			configId: "11111111-1111-4111-8111-111111111111",
		} as Parameters<typeof localStoryIdentityForConfiguration>[0];
		expect(localStoryIdentityForConfiguration(config).schemaHash).toBe(
			"c6e24f37dddb8dbf8ff046f91d82142f130463f3fa6ddecb66a74eadad5c0189",
		);
		expect(localCaptionIdentityForConfiguration(config)).toMatchObject({
			version: "local-caption-model-v2",
			promptVersion: "caption-ja-v2",
			context: 8192,
			thinking: false,
		});
		expect(
			localSemanticStageRegistry().stages.LOCAL_CAPTION_JA_V1.maxOutputTokens,
		).toBe(1536);
		expect(
			localCaptionModelIdentityV1Schema.parse({
				...localStoryIdentityForConfiguration(config),
				version: "local-caption-model-v1",
				promptVersion: "caption-ja-v1",
			}),
		).toMatchObject({ version: "local-caption-model-v1" });
	});
	it("manual saves cannot reuse a native receipt for changed or newly attached translations", () => {
		const original = {
			...cue(1),
			translation: {
				targetLanguage: "ja" as const,
				text: "こんにちは",
				sourceText: cue(1).text,
				sourceTextHash: hashEditingEvidence(cue(1).text),
				origin: "LOCAL_LLM" as const,
				evidenceHash: "b".repeat(64),
			},
		};
		const previous = { schemaVersion: 2, captions: [original] } as Parameters<
			typeof normalizeManualCaptionTranslationEdits
		>[1];
		const next = {
			schemaVersion: 2,
			captions: [
				{
					...original,
					translation: { ...original.translation, text: "人が編集した訳" },
				},
				{ ...original, id: cue(2).id },
			],
		} as Parameters<typeof normalizeManualCaptionTranslationEdits>[1];
		const normalized = normalizeManualCaptionTranslationEdits(previous, next);
		expect(normalized.captions?.[0]?.translation).toMatchObject({
			text: "人が編集した訳",
			origin: "MANUAL",
			derivedFromEvidenceHash: "b".repeat(64),
		});
		expect(
			normalized.captions?.every(
				(c) => c.translation?.evidenceHash === undefined,
			),
		).toBe(true);
		expect(
			normalized.captions?.[1]?.translation?.derivedFromEvidenceHash,
		).toBeUndefined();
		expect(previous.captions?.[0]?.translation?.origin).toBe("LOCAL_LLM");
		const stale = normalizeManualCaptionTranslationEdits(previous, {
			...previous,
			captions: [{ ...original, text: "Edited original." }],
		});
		expect(stale.captions?.[0]?.translation).toEqual(original.translation);
	});
});
