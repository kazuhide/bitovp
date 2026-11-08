import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	automaticGenerationSchema,
	editingAnalysisBindingSchema,
} from "./automatic-binding";
import {
	hashEditingEvidence,
	verifyAutomaticAnalysisBinding,
} from "./verify-automatic-binding";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const organizationId = id(1);
	const map = {
		id: id(4),
		mediaVersionId: id(2),
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 1_000_000,
		editingStartFrame: 0,
		editingEndFrame: 30,
		fps: { num: 30, den: 1 },
	};
	const media = {
		id: id(2),
		organizationId,
		sourceId: id(3),
		sha256: "a".repeat(64),
		width: 320,
		height: 180,
		timeMap: map,
	};
	const analysis = {
		id: id(5),
		organizationId,
		sourceId: id(3),
		locale: "ja",
		rawHash: "b".repeat(64),
		document: normalizeSceneAnalysis({
			metadata: { version: "attestation-test" },
			duration: 1,
			scenes: [],
		}),
	};
	const proof = {
		schemaVersion: 1,
		kind: "EDITOR_ATTESTED",
		organizationId,
		sourceId: id(3),
		locale: "ja",
		analysisRevisionId: analysis.id,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		mediaVersionId: media.id,
		mediaSha256: media.sha256,
		timeMapId: map.id,
		timeMapHash: hashEditingEvidence(map),
		sourceStartUs: 0,
		sourceEndUs: 1_000_000,
		width: 320,
		height: 180,
		attestation: {
			receiptId: id(6),
			actor: `user:${id(7)}`,
			confirmedAt: "2026-11-02T00:00:00.000Z",
			scope: ["TIME", "GEOMETRY", "CONTENT"],
		},
	};
	return { organizationId, media, analysis, proof };
}
describe("audited human association is separate from provider capture", () => {
	it("retains a trimmed bounded semantic query only for the v2 policy", () => {
		const generation = {
			policyVersion: "aisa-scene-cohesion-v2",
			requestHash: "f".repeat(64),
			requestedDurationFrames: 30,
			generatedDurationFrames: 30,
			reasonCodes: [],
			binding: fixture().proof,
			query: "  explain this scene  ",
		};
		expect(automaticGenerationSchema.parse(generation).query).toBe(
			"explain this scene",
		);
		expect(
			automaticGenerationSchema.safeParse({
				...generation,
				policyVersion: "aisa-shot-window-v1",
			}).success,
		).toBe(false);
		expect(
			automaticGenerationSchema.safeParse({
				...generation,
				query: "x".repeat(513),
			}).success,
		).toBe(false);
	});
	it("accepts only the exact stored editor-attested tuple without upgrading its kind", () => {
		const f = fixture();
		expect(
			verifyAutomaticAnalysisBinding({
				...f,
				binding: f.proof,
				bindings: [f.proof],
			}),
		).toEqual(f.proof);
	});
	it.each([
		undefined,
		null,
		{},
		{
			receiptId: id(6),
			actor: "",
			confirmedAt: "2026-11-02T00:00:00Z",
			scope: ["TIME", "GEOMETRY", "CONTENT"],
		},
		{
			receiptId: id(6),
			actor: "operator",
			confirmedAt: "invalid",
			scope: ["TIME", "GEOMETRY", "CONTENT"],
		},
		{
			receiptId: id(6),
			actor: "operator",
			confirmedAt: "2026-11-02T00:00:00Z",
			scope: ["TIME", "TIME", "CONTENT"],
		},
	])("refuses missing or incomplete human audit metadata", (attestation) => {
		expect(
			editingAnalysisBindingSchema.safeParse({
				...fixture().proof,
				attestation,
			}).success,
		).toBe(false);
	});
	it.each([
		"CAPTURED_INPUT",
		"FIXTURE_AUTHORED",
	])("does not attach human association metadata to %s", (kind) => {
		expect(
			editingAnalysisBindingSchema.safeParse({ ...fixture().proof, kind })
				.success,
		).toBe(false);
	});
	it("does not accept a client snapshot without a server-owned binding row", () => {
		const f = fixture();
		expect(() =>
			verifyAutomaticAnalysisBinding({ ...f, binding: f.proof, bindings: [] }),
		).toThrow();
	});
	it("does not replace the stored receipt or principal with a client claim", () => {
		const f = fixture();
		expect(() =>
			verifyAutomaticAnalysisBinding({
				...f,
				bindings: [f.proof],
				binding: {
					...f.proof,
					attestation: { ...f.proof.attestation, actor: "another principal" },
				},
			}),
		).toThrow();
	});
});
