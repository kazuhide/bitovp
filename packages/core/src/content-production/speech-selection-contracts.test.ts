import { describe, expect, it } from "vitest";
import {
	generationTaskResultSchema,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIdentitySchema,
	mediaTaskIntentHash,
} from "./index";

const id = "00000000-0000-4000-8000-000000000001";
const legacy = {
	organizationId: id,
	mediaSha256: "a".repeat(64),
	modelSha256: null,
	analysisDocumentHash: "b".repeat(64),
	analysisRawHash: "c".repeat(64),
	timeMapHash: "d".repeat(64),
	bindingHash: null,
};
const input = mediaTaskCreateSchema.parse({
	kind: "GENERATE",
	mediaVersionId: id,
	analysisRevisionId: id,
	requestKey: id,
	parameters: { contentId: id, targetDurationFrames: 900 },
});
const evidence = {
	schemaVersion: 1,
	policyVersion: "asr-boundary-v1",
	status: "APPLIED",
	observedWindow: { fromFrame: 30, toFrame: 150 },
	sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
	mediaSha256: "a".repeat(64),
	timeMapHash: "d".repeat(64),
	modelSha256: "e".repeat(64),
	transcriptFingerprint: "f".repeat(64),
	intervals: [{ startUs: 1_500_000, endUs: 2_500_000 }],
	rejectedBoundaryCount: 1,
};
const result = (selectionEvidence?: unknown) => ({
	projectId: id,
	projectIds: [id],
	requestedFrames: 900,
	actualFrames: 870,
	warnings: [],
	policyVersion: "aisa-scene-cohesion-v2",
	presetIds: ["portrait-clean"],
	metrics: {},
	cacheable: true,
	...(selectionEvidence === undefined ? {} : { selectionEvidence }),
});

describe("versioned observed speech selection evidence", () => {
	it("accepts a pinned new policy without changing an absent legacy policy or its hashes", () => {
		expect(mediaTaskIdentitySchema.parse(legacy)).not.toHaveProperty(
			"speechSelectionPolicyVersion",
		);
		expect(mediaTaskIntentHash(input)).toBe(
			"7ddd9fdad5d945682181117edaab0b73a0042105e3fb3a6662d7bae9ea627d13",
		);
		expect(mediaTaskCacheKey(input, legacy)).toBe(
			"82a4b4b9852498742c4650605063a077d2e1f9fbfc4a47bd11d500d150e704fa",
		);
		const pinned = mediaTaskIdentitySchema.parse({
			...legacy,
			speechSelectionPolicyVersion: "asr-boundary-v1",
		});
		expect(pinned).toHaveProperty(
			"speechSelectionPolicyVersion",
			"asr-boundary-v1",
		);
		expect(mediaTaskCacheKey(input, pinned)).not.toBe(
			mediaTaskCacheKey(input, legacy),
		);
	});
	it("retains real immutable evidence and leaves an old completed result byte-compatible", () => {
		expect(generationTaskResultSchema.parse(result())).toEqual(result());
		expect(generationTaskResultSchema.parse(result(evidence))).toHaveProperty(
			"selectionEvidence",
			evidence,
		);
	});
	it.each([
		{ ...evidence, observedWindow: undefined },
		{ ...evidence, modelSha256: null },
		{ ...evidence, transcriptFingerprint: undefined },
		{ ...evidence, intervals: undefined },
		{ ...evidence, intervals: [] },
		{ ...evidence, reason: "NO_SPEECH" },
	])("refuses APPLIED without observed speech, model and coverage %j", (value) => {
		expect(generationTaskResultSchema.safeParse(result(value)).success).toBe(
			false,
		);
	});
	it("records an unobserved fallback without inventing a model or observed window", () => {
		const fallback = {
			...evidence,
			status: "FALLBACK",
			reason: "ASR_UNAVAILABLE",
			observedWindow: undefined,
			modelSha256: null,
			transcriptFingerprint: undefined,
			intervals: undefined,
			rejectedBoundaryCount: 0,
		};
		expect(generationTaskResultSchema.parse(result(fallback))).toHaveProperty(
			"selectionEvidence.status",
			"FALLBACK",
		);
		expect(
			generationTaskResultSchema.safeParse(
				result({ ...fallback, observedWindow: evidence.observedWindow }),
			).success,
		).toBe(false);
	});
	it.each([
		{ ...evidence, observedWindow: { fromFrame: 0, toFrame: 5401 } },
		{ ...evidence, observedWindow: { fromFrame: 2, toFrame: 2 } },
		{ ...evidence, rejectedBoundaryCount: 20001 },
		{ ...evidence, intervals: [{ startUs: 2, endUs: 2 }] },
		{
			...evidence,
			intervals: [
				{ startUs: 3, endUs: 5 },
				{ startUs: 4, endUs: 6 },
			],
		},
		{
			...evidence,
			intervals: Array.from({ length: 5001 }, (_, i) => ({
				startUs: i * 2,
				endUs: i * 2 + 1,
			})),
		},
	])("refuses unbounded or fabricated observation receipts %j", (value) => {
		expect(generationTaskResultSchema.safeParse(result(value)).success).toBe(
			false,
		);
	});
});
