import { describe, expect, it } from "vitest";
import {
	buildContextualLocalCaptionBatch,
	captionTranslationConsistencyKey,
	type LocalCaptionCueContext,
	localCaptionContextData,
	validateContextualLocalCaptionTranslation,
} from "./local-caption-context";
import { buildLocalCaptionTranslationBatches } from "./local-caption-translation";
import { hashEditingEvidence } from "./verify-automatic-binding";

const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw Error("missing fixture");
	return value;
};
const hash = (s: string) => hashEditingEvidence(s);
const batch = () =>
	required(
		buildLocalCaptionTranslationBatches({
			captions: [1, 2].map((n) => ({
				id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
				fromFrame: n * 30,
				toFrame: n * 30 + 29,
				text: "Bank.",
			})),
			sourceLanguage: "en",
			qualityPolicyFingerprint: hash("asr"),
		})[0],
	);
const context = (scope = "river"): LocalCaptionCueContext => ({
	sourceHash: hash(scope),
	scopeHash: hash(scope),
	fields: [{ sourceHash: hash(`${scope}:field`), kind: "SCENE", text: scope }],
});
const contexts = () =>
	new Map(batch().cues.map((c) => [c.captionId, context()]));

describe("bounded, source-bound translation context", () => {
	it("binds context and source changes even when source text is identical", () => {
		const b = batch(),
			first = buildContextualLocalCaptionBatch({
				batch: b,
				contexts: contexts(),
			});
		const changed = contexts();
		changed.set(required(b.cues[1]).captionId, context("finance"));
		const second = buildContextualLocalCaptionBatch({
			batch: b,
			contexts: changed,
		});
		expect(hashEditingEvidence(first)).not.toBe(hashEditingEvidence(second));
		expect(captionTranslationConsistencyKey(first, "c0")).toBe(
			captionTranslationConsistencyKey(first, "c1"),
		);
		expect(captionTranslationConsistencyKey(second, "c0")).not.toBe(
			captionTranslationConsistencyKey(second, "c1"),
		);
		expect(first.cues).toEqual(b.cues);
	});
	it("keeps whole optional source fields within both UTF8 budgets and never truncates cues", () => {
		const b = batch(),
			fields = contexts();
		fields.set(required(b.cues[0]).captionId, {
			...context(),
			fields: [
				{ sourceHash: hash("huge"), kind: "SCENE", text: "界".repeat(1000) },
				{ sourceHash: hash("quoted"), kind: "CHARACTER", text: 'Name \\"\n' },
			],
		});
		const value = buildContextualLocalCaptionBatch({
			batch: b,
			contexts: fields,
		});
		expect(value.contextFields.some((f) => f.text === "界".repeat(1000))).toBe(
			false,
		);
		expect(value.contextFields.some((f) => f.text === 'Name \\"\n')).toBe(true);
		expect(
			new TextEncoder().encode(JSON.stringify(value.contextFields)).length,
		).toBeLessThanOrEqual(1400);
		expect(
			new TextEncoder().encode(JSON.stringify(localCaptionContextData(value)))
				.length,
		).toBeLessThanOrEqual(4500);
		expect(value.cues).toEqual(b.cues);
	});
	it("requires identical accepted translations only within the same bound context", () => {
		const first = buildContextualLocalCaptionBatch({
			batch: batch(),
			contexts: contexts(),
		});
		expect(() =>
			validateContextualLocalCaptionTranslation(first, {
				translations: [
					{ id: "c0", text: "岸。" },
					{ id: "c1", text: "銀行。" },
				],
			}),
		).toThrow("LOCAL_CAPTION_TRANSLATION_INVALID");
		const changed = contexts();
		changed.set(required(first.cues[1]).captionId, context("finance"));
		const second = buildContextualLocalCaptionBatch({
			batch: batch(),
			contexts: changed,
		});
		expect(
			validateContextualLocalCaptionTranslation(second, {
				translations: [
					{ id: "c0", text: "岸。" },
					{ id: "c1", text: "銀行。" },
				],
			}).translations,
		).toHaveLength(2);
	});
	it("binds prior accepted wording without exposing another context or dropping required memory", () => {
		const first = buildContextualLocalCaptionBatch({
			batch: batch(),
			contexts: contexts(),
		});
		const key = captionTranslationConsistencyKey(first, "c0");
		const second = buildContextualLocalCaptionBatch({
			batch: batch(),
			contexts: contexts(),
			accepted: new Map([[key, "岸。"]]),
		});
		expect(second.memory).toHaveLength(2);
		expect(() =>
			validateContextualLocalCaptionTranslation(second, {
				translations: [
					{ id: "c0", text: "銀行。" },
					{ id: "c1", text: "銀行。" },
				],
			}),
		).toThrow("LOCAL_CAPTION_TRANSLATION_INVALID");
		const unknown = buildContextualLocalCaptionBatch({
			batch: batch(),
			contexts: new Map(),
		});
		expect(captionTranslationConsistencyKey(unknown, "c0")).not.toBe(
			captionTranslationConsistencyKey(unknown, "c1"),
		);
		expect(() =>
			buildContextualLocalCaptionBatch({
				batch: batch(),
				contexts: contexts(),
				accepted: new Map([[key, "界".repeat(1000)]]),
			}),
		).toThrow("LOCAL_CAPTION_CONTEXT_LIMIT");
	});
});
