import { describe, expect, it } from "vitest";
import {
	canonicalEditingJson,
	editingAnalysisBindingSchema,
} from "./automatic-binding";
import { compileEditDocument } from "./compile";
import { editingDocumentSchema } from "./schema";

const mediaId = "11111111-1111-4111-8111-111111111111";
const analysisId = "22222222-2222-4222-8222-222222222222";
const map = {
	id: mediaId,
	mediaVersionId: mediaId,
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 3_000_000,
	editingStartFrame: 0,
	editingEndFrame: 90,
	fps: { num: 30, den: 1 },
};
const binding = {
	schemaVersion: 1,
	kind: "FIXTURE_AUTHORED",
	organizationId: mediaId,
	sourceId: mediaId,
	locale: "ja",
	analysisRevisionId: analysisId,
	analysisRawHash: "a".repeat(64),
	analysisDocumentHash: "b".repeat(64),
	mediaVersionId: mediaId,
	mediaSha256: "c".repeat(64),
	timeMapId: map.id,
	timeMapHash: "e".repeat(64),
	sourceStartUs: 0,
	sourceEndUs: 3_000_000,
	width: 640,
	height: 360,
};
function document(origin = "AUTO_POLICY") {
	return {
		schemaVersion: 1,
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		locale: "ja",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		timeMapId: map.id,
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		autoGeneration: {
			policyVersion: "aisa-shot-window-v1",
			requestHash: "d".repeat(64),
			requestedDurationFrames: 90,
			generatedDurationFrames: 90,
			reasonCodes: ["WHOLE_SHOT_WINDOW"],
			binding,
		},
		clips: [
			{
				id: mediaId,
				sourceInUs: 0,
				durationFrames: 90,
				timelineStartFrame: 0,
				framing: [{ fromFrame: 0, toFrame: 90, mode: "FIT", origin }],
				audio: { mode: "SOURCE" },
				evidence: { sceneId: analysisId, shotIndex: 0 },
			},
		],
	};
}

describe("automatic editing contracts", () => {
	it("keeps automatic policy acceptance distinct from editor confirmation", () => {
		const value = editingDocumentSchema.parse(document());
		expect(value.clips[0]?.framing[0]?.origin).toBe("AUTO_POLICY");
		expect(compileEditDocument(value, map).durationFrames).toBe(90);
	});
	it("still rejects an unconfirmed AISA proposal", () => {
		expect(() => compileEditDocument(document("AISA_PROPOSAL"), map)).toThrow(
			"UNCONFIRMED_FRAMING",
		);
	});
	it("does not accept automatic origins without their source evidence", () => {
		const value = document();
		const { autoGeneration: _ignored, ...withoutEvidence } = value;
		expect(editingDocumentSchema.safeParse(withoutEvidence).success).toBe(
			false,
		);
		value.autoGeneration.binding.mediaVersionId = analysisId;
		expect(editingDocumentSchema.safeParse(value).success).toBe(false);
	});
	it("binds the automatic provenance to the analysis and time map", () => {
		for (const field of ["analysisRevisionId", "timeMapId"] as const) {
			const value = document();
			value.autoGeneration.binding = {
				...binding,
				[field]: mediaId === binding[field] ? analysisId : mediaId,
			};
			expect(editingDocumentSchema.safeParse(value).success).toBe(false);
		}
	});
	it("preserves legacy manual documents without automatic metadata", () => {
		const { autoGeneration: _ignored, ...manual } = document("MANUAL");
		expect(compileEditDocument(manual, map).durationFrames).toBe(90);
	});
	it("bounds the generated intent and proof instead of accepting arbitrary JSON", () => {
		expect(
			editingAnalysisBindingSchema.safeParse({ ...binding, kind: "PROVEN" })
				.success,
		).toBe(false);
		expect(
			editingAnalysisBindingSchema.safeParse({
				...binding,
				mediaSha256: "unverified",
			}).success,
		).toBe(false);
		const value = document();
		value.autoGeneration.generatedDurationFrames = 91;
		expect(editingDocumentSchema.safeParse(value).success).toBe(false);
	});
	it("canonicalizes JSON object order while preserving shot and word order", () => {
		expect(canonicalEditingJson({ b: [2, { y: 1, x: 0 }], a: 3 })).toBe(
			canonicalEditingJson({ a: 3, b: [2, { x: 0, y: 1 }] }),
		);
		expect(canonicalEditingJson([1, 2])).not.toBe(canonicalEditingJson([2, 1]));
	});
});
