import { describe, expect, it } from "vitest";
import {
	automaticGenerationSchema,
	canonicalEditingJson,
} from "./automatic-binding";
import { preparedClockFixture } from "./prepared-shot-partition.test-fixtures";
import { hashEditingEvidence } from "./verify-automatic-binding";

function value(policyVersion: string) {
	const f = preparedClockFixture();
	return {
		policyVersion,
		requestHash: "e".repeat(64),
		requestedDurationFrames: 60,
		generatedDurationFrames: 60,
		reasonCodes: ["WHOLE_SHOT_WINDOW"],
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: f.proof.organizationId,
			sourceId: f.proof.sourceId,
			locale: "en",
			analysisRevisionId: "55555555-5555-4555-8555-555555555555",
			analysisRawHash: "d".repeat(64),
			analysisDocumentHash: hashEditingEvidence(f.analysis),
			mediaVersionId: f.proof.mediaVersionId,
			mediaSha256: f.proof.preparedSha256,
			timeMapId: f.timeMap.id,
			timeMapHash: hashEditingEvidence(f.timeMap),
			sourceStartUs: 0,
			sourceEndUs: 2000000,
			width: 1600,
			height: 900,
		},
	};
}
describe("recorded v3 normalization identity with legacy exact compatibility", () => {
	it.each([
		"aisa-shot-window-v1",
		"aisa-scene-cohesion-v2",
	])("preserves %s canonical JSON and rejects a silent new clock", (policy) => {
		const old = value(policy);
		expect(canonicalEditingJson(automaticGenerationSchema.parse(old))).toBe(
			canonicalEditingJson(old),
		);
		expect(() =>
			automaticGenerationSchema.parse({
				...old,
				normalizationReceiptHash: "a".repeat(64),
			}),
		).toThrow();
	});
	it.each([
		"aisa-prepared-shot-window-v3",
		"aisa-prepared-scene-cohesion-v3",
	])("requires a pinned normalization hash for %s", (policy) => {
		const v = value(policy);
		expect(() => automaticGenerationSchema.parse(v)).toThrow();
		expect(
			automaticGenerationSchema.parse({
				...v,
				normalizationReceiptHash: "a".repeat(64),
			}),
		).toMatchObject({
			policyVersion: policy,
			normalizationReceiptHash: "a".repeat(64),
		});
	});
	it("allows query only for semantic prepared policy", () => {
		expect(
			automaticGenerationSchema.parse({
				...value("aisa-prepared-scene-cohesion-v3"),
				normalizationReceiptHash: "a".repeat(64),
				query: "keep",
			}),
		).toHaveProperty("query", "keep");
		expect(() =>
			automaticGenerationSchema.parse({
				...value("aisa-prepared-shot-window-v3"),
				normalizationReceiptHash: "a".repeat(64),
				query: "keep",
			}),
		).toThrow();
	});
});
