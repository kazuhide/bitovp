import { describe, expect, it } from "vitest";
import { automaticGenerationSchema } from "../content-editing/automatic-binding";
import {
	generationTaskResultSchema,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	speechSelectionEvidenceSchema,
} from "./index";

const id = "00000000-0000-4000-8000-000000000001";
const version = "duration-review-v2";
function request(mode: unknown = "DRAFT", policy: unknown = version) {
	return {
		kind: "GENERATE",
		mediaVersionId: id,
		analysisRevisionId: id,
		requestKey: id,
		parameters: {
			contentId: id,
			targetDurationFrames: 100,
			...(mode === undefined ? {} : { renderMode: mode }),
			...(policy === undefined ? {} : { draftPolicyVersion: policy }),
		},
	};
}
const identity = {
	organizationId: id,
	mediaSha256: "a".repeat(64),
	modelSha256: "b".repeat(64),
	analysisDocumentHash: "c".repeat(64),
	analysisRawHash: "d".repeat(64),
	timeMapHash: "e".repeat(64),
};
const binding = {
	schemaVersion: 1,
	kind: "FIXTURE_AUTHORED",
	organizationId: id,
	sourceId: id,
	locale: "en",
	analysisRevisionId: id,
	analysisRawHash: "d".repeat(64),
	analysisDocumentHash: "c".repeat(64),
	mediaVersionId: id,
	mediaSha256: "a".repeat(64),
	timeMapId: id,
	timeMapHash: "e".repeat(64),
	sourceStartUs: 0,
	sourceEndUs: 6000000,
	width: 640,
	height: 360,
};
const automatic = {
	policyVersion: "aisa-shot-window-v1",
	requestHash: "f".repeat(64),
	requestedDurationFrames: 100,
	generatedDurationFrames: 100,
	reasonCodes: ["WHOLE_SHOT_WINDOW"],
	binding,
};
function evidence() {
	return {
		schemaVersion: 1,
		policyVersion: "asr-boundary-v1",
		draftPolicyVersion: version,
		status: "FALLBACK",
		reason: "SPEECH_DURATION_REVIEW_REQUIRED",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		mediaSha256: "a".repeat(64),
		timeMapHash: "e".repeat(64),
		modelSha256: "b".repeat(64),
		observedWindow: { fromFrame: 0, toFrame: 180 },
		transcriptFingerprint: "f".repeat(64),
		intervals: [{ startUs: 500000, endUs: 1000000 }],
		rejectedBoundaryCount: 0,
	};
}
function result() {
	return {
		renderMode: "DRAFT",
		draftPolicyVersion: version,
		projectId: id,
		projectIds: [id],
		requestedFrames: 100,
		actualFrames: 100,
		warnings: ["SPEECH_DURATION_REVIEW_REQUIRED"],
		policyVersion: "aisa-shot-window-v1",
		presetIds: ["portrait-clean"],
		metrics: {},
		cacheable: true,
		selectionEvidence: evidence(),
	};
}
describe("explicit duration-review-v2 draft contracts", () => {
	it("retains the explicit policy and binds distinct intent/cache hashes without changing missing-version DRAFT", () => {
		const current = mediaTaskCreateSchema.parse(request());
		const historical = request();
		delete (historical.parameters as Record<string, unknown>)
			.draftPolicyVersion;
		const old = mediaTaskCreateSchema.parse(historical);
		expect(current.parameters).toHaveProperty("draftPolicyVersion", version);
		expect(Object.hasOwn(old.parameters, "draftPolicyVersion")).toBe(false);
		expect(mediaTaskIntentHash(current)).not.toBe(mediaTaskIntentHash(old));
		expect(mediaTaskCacheKey(current, identity)).not.toBe(
			mediaTaskCacheKey(old, identity),
		);
		expect(mediaTaskCreateSchema.parse(old)).toEqual(old);
	});
	it.each([
		undefined,
		"EXPORT",
	])("rejects the v2 policy with mode %s", (mode) => {
		const value = request();
		if (mode === undefined)
			delete (value.parameters as Record<string, unknown>).renderMode;
		else Object.assign(value.parameters, { renderMode: mode });
		expect(mediaTaskCreateSchema.safeParse(value).success).toBe(false);
	});
	it.each([
		null,
		"",
		"duration-review-v1",
		{},
		true,
	])("rejects unknown policy %j", (policy) => {
		expect(
			mediaTaskCreateSchema.safeParse(request("DRAFT", policy)).success,
		).toBe(false);
	});
	it("preserves real zero rejection evidence only for the distinct duration-review reason", () => {
		expect(speechSelectionEvidenceSchema.parse(evidence())).toEqual(evidence());
		expect(generationTaskResultSchema.parse(result())).toEqual(result());
		expect(
			speechSelectionEvidenceSchema.safeParse({
				...evidence(),
				reason: "SPEECH_REVIEW_REQUIRED",
			}).success,
		).toBe(false);
	});
	it("rejects missing observation, version, wrong status or invented review reason on old results", () => {
		for (const delta of [
			{ draftPolicyVersion: undefined },
			{ status: "APPLIED" },
			{ modelSha256: null },
			{ observedWindow: undefined },
			{ transcriptFingerprint: undefined },
			{ intervals: [] },
		]) {
			expect(
				speechSelectionEvidenceSchema.safeParse({ ...evidence(), ...delta })
					.success,
			).toBe(false);
		}
		for (const delta of [
			{ draftPolicyVersion: undefined },
			{ renderMode: "EXPORT" },
			{ renderMode: undefined },
		]) {
			expect(
				generationTaskResultSchema.safeParse({ ...result(), ...delta }).success,
			).toBe(false);
		}
		expect(
			generationTaskResultSchema.safeParse({
				...result(),
				draftPolicyVersion: version,
				selectionEvidence: { ...evidence(), draftPolicyVersion: undefined },
			}).success,
		).toBe(false);
	});
	it("stamps a v2 draft document explicitly and keeps old automatic metadata byte-shape unchanged", () => {
		expect(automaticGenerationSchema.parse(automatic)).toEqual(automatic);
		const marked = {
			...automatic,
			renderMode: "DRAFT",
			draftPolicyVersion: version,
			reasonCodes: [
				...automatic.reasonCodes,
				"SPEECH_DURATION_REVIEW_REQUIRED",
			],
		};
		expect(automaticGenerationSchema.parse(marked)).toEqual(marked);
		for (const delta of [
			{ renderMode: undefined },
			{ renderMode: "EXPORT" },
			{ draftPolicyVersion: undefined },
		]) {
			expect(
				automaticGenerationSchema.safeParse({ ...marked, ...delta }).success,
			).toBe(false);
		}
		expect(
			automaticGenerationSchema.safeParse({
				...automatic,
				reasonCodes: ["SPEECH_DURATION_REVIEW_REQUIRED"],
			}).success,
		).toBe(false);
	});
});
