import { describe, expect, it } from "vitest";
import { automaticGenerationSchema } from "../content-editing/automatic-binding";
import {
	generationTaskParametersSchema,
	generationTaskResultSchema,
} from "./schema";

const id = "00000000-0000-4000-8000-000000000001";
const evidence = {
	version: "aisa-content-evidence-v1",
	method: "METADATA_HEURISTIC",
	profile: "GENERAL",
	keyEntities: [{ kind: "OBJECT", label: "完成した模型", sceneIds: [id] }],
	selectedMoments: [
		{
			sceneId: id,
			shotIndex: 0,
			label: "模型が完成する",
			score: 400,
			reasonCodes: ["STATE_CHANGE"],
		},
	],
	selectionReason: "CONTENT_RANKED",
};
function result() {
	return {
		projectId: id,
		projectIds: [id],
		renderMode: "DRAFT",
		requestedFrames: 450,
		actualFrames: 450,
		warnings: [],
		policyVersion: "aisa-content-highlight-v1",
		presetIds: ["portrait-clean"],
		metrics: {},
		cacheable: true,
		semanticEvidence: evidence,
	};
}
function provenance() {
	return {
		policyVersion: "aisa-content-highlight-v1",
		renderMode: "DRAFT",
		draftPolicyVersion: "duration-review-v2",
		requestHash: "a".repeat(64),
		requestedDurationFrames: 450,
		generatedDurationFrames: 450,
		reasonCodes: ["CONTENT_RANKED"],
		semanticEvidence: evidence,
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: id,
			sourceId: id,
			locale: "ja",
			analysisRevisionId: id,
			analysisRawHash: "b".repeat(64),
			analysisDocumentHash: "c".repeat(64),
			mediaVersionId: id,
			mediaSha256: "d".repeat(64),
			timeMapId: id,
			timeMapHash: "e".repeat(64),
			sourceStartUs: 0,
			sourceEndUs: 30_000_000,
			width: 1920,
			height: 1080,
		},
	};
}
describe("automatic content selection is versioned and draft first", () => {
	it("accepts no-hint AUTO drafts without changing historical defaults", () => {
		const base = { contentId: id, targetDurationFrames: 450 };
		expect(generationTaskParametersSchema.parse(base).policy).toBe("COHESION");
		expect(
			generationTaskParametersSchema.parse({
				...base,
				policy: "AUTO",
				renderMode: "DRAFT",
			}).policy,
		).toBe("AUTO");
		for (const change of [
			{ renderMode: undefined },
			{ renderMode: "EXPORT" },
			{ query: "人物を選ぶ" },
			{ query: "" },
			{ query: "  \t\n" },
		])
			expect(
				generationTaskParametersSchema.safeParse({
					...base,
					policy: "AUTO",
					renderMode: "DRAFT",
					...change,
				}).success,
			).toBe(false);
	});
	it("retains observed search-limit evidence as an AUTO draft without claiming safe speech", () => {
		const selectionEvidence = {
			schemaVersion: 1,
			policyVersion: "asr-boundary-v1",
			status: "FALLBACK",
			reason: "SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED",
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			mediaSha256: "a".repeat(64),
			timeMapHash: "b".repeat(64),
			modelSha256: "c".repeat(64),
			observedWindow: { fromFrame: 0, toFrame: 510 },
			transcriptFingerprint: "d".repeat(64),
			intervals: [{ startUs: 14_000_000, endUs: 16_000_000 }],
			rejectedBoundaryCount: 0,
		};
		const value = { ...result(), selectionEvidence };
		expect(generationTaskResultSchema.parse(value)).toEqual(value);
		for (const change of [
			{ renderMode: "EXPORT" },
			{
				policyVersion: "aisa-scene-cohesion-v2",
				semanticEvidence: undefined,
			},
			{ selectionEvidence: { ...selectionEvidence, status: "APPLIED" } },
			{ selectionEvidence: { ...selectionEvidence, intervals: [] } },
			{ selectionEvidence: { ...selectionEvidence, modelSha256: null } },
		])
			expect(
				generationTaskResultSchema.safeParse({ ...value, ...change }).success,
			).toBe(false);
	});
	it("requires bounded typed evidence only for the new content policies", () => {
		expect(generationTaskResultSchema.parse(result())).toEqual(result());
		for (const change of [
			{ semanticEvidence: undefined },
			{ renderMode: "EXPORT" },
			{ policyVersion: "aisa-scene-cohesion-v2" },
			{ semanticEvidence: { ...evidence, method: "MODEL_CONFIDENCE" } },
			{ semanticEvidence: { ...evidence, selectedMoments: [] } },
			{
				semanticEvidence: {
					...evidence,
					keyEntities: Array.from(
						{ length: 13 },
						() => evidence.keyEntities[0],
					),
				},
			},
		])
			expect(
				generationTaskResultSchema.safeParse({ ...result(), ...change })
					.success,
			).toBe(false);
	});
	it("binds prepared AUTO provenance to the real normalization receipt", () => {
		expect(automaticGenerationSchema.parse(provenance())).toEqual(provenance());
		expect(
			automaticGenerationSchema.safeParse({
				...provenance(),
				draftPolicyVersion: undefined,
			}).success,
		).toBe(true);
		const prepared = {
			...provenance(),
			policyVersion: "aisa-prepared-content-highlight-v4",
			normalizationReceiptHash: "f".repeat(64),
		};
		expect(automaticGenerationSchema.parse(prepared)).toEqual(prepared);
		for (const value of [
			{ ...prepared, normalizationReceiptHash: undefined },
			{ ...provenance(), normalizationReceiptHash: "f".repeat(64) },
			{ ...prepared, semanticEvidence: undefined },
			{ ...prepared, query: "模型" },
		])
			expect(automaticGenerationSchema.safeParse(value).success).toBe(false);
	});
});
