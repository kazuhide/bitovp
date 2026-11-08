import { z } from "zod";
import { isLocalStoryPolicy } from "./local-semantic-protocol";
import { localStoryEvidenceSchema } from "./local-story-contracts";
import {
	isContentHighlightPolicy,
	semanticEvidenceSchema,
} from "./semantic-evidence";
import { isStoryPolicy, storyEvidenceSchema } from "./story-contracts";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Server-owned evidence. A fixture annotation is never provider-analysis proof. */
export const editingAnalysisBindingSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		kind: z.enum(["CAPTURED_INPUT", "FIXTURE_AUTHORED", "EDITOR_ATTESTED"]),
		organizationId: z.uuid(),
		sourceId: z.uuid(),
		locale: z
			.string()
			.regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
			.max(35),
		analysisRevisionId: z.uuid(),
		analysisRawHash: sha256,
		analysisDocumentHash: sha256,
		mediaVersionId: z.uuid(),
		mediaSha256: sha256,
		timeMapId: z.uuid(),
		timeMapHash: sha256,
		sourceStartUs: integer,
		sourceEndUs: integer.positive(),
		width: integer.positive(),
		height: integer.positive(),
		attestation: z
			.strictObject({
				receiptId: z.uuid(),
				actor: z
					.string()
					.min(1)
					.max(256)
					.refine((actor) => actor === actor.trim()),
				confirmedAt: z.iso.datetime({ offset: true }),
				scope: z
					.array(z.enum(["TIME", "GEOMETRY", "CONTENT"]))
					.length(3)
					.refine((scope) => new Set(scope).size === 3),
			})
			.optional(),
	})
	.refine((value) => value.sourceEndUs > value.sourceStartUs)
	.superRefine((value, ctx) => {
		if (
			(value.kind === "EDITOR_ATTESTED") !==
			(value.attestation !== undefined)
		)
			ctx.addIssue({
				code: "custom",
				path: ["attestation"],
				message:
					"Only editor-attested associations require an immutable human audit receipt",
			});
	});
export type EditingAnalysisBinding = z.infer<
	typeof editingAnalysisBindingSchema
>;

export const automaticGenerationSchema = z
	.strictObject({
		policyVersion: z.enum([
			"aisa-shot-window-v1",
			"aisa-scene-cohesion-v2",
			"aisa-prepared-shot-window-v3",
			"aisa-prepared-scene-cohesion-v3",
			"aisa-content-highlight-v1",
			"aisa-prepared-content-highlight-v4",
			"aisa-story-window-v1",
			"aisa-prepared-story-window-v1",
			"aisa-local-story-window-v1",
			"aisa-prepared-local-story-window-v1",
		]),
		renderMode: z.literal("DRAFT").optional(),
		draftPolicyVersion: z.literal("duration-review-v2").optional(),
		requestHash: sha256,
		requestedDurationFrames: integer.min(30).max(5400),
		generatedDurationFrames: integer.positive().max(5400),
		reasonCodes: z.array(z.string().min(1).max(128)).max(40),
		binding: editingAnalysisBindingSchema,
		query: z.string().trim().max(512).optional(),
		normalizationReceiptHash: sha256.optional(),
		semanticEvidence: semanticEvidenceSchema.optional(),
		storyEvidence: storyEvidenceSchema.optional(),
		localStoryEvidence: localStoryEvidenceSchema.optional(),
	})
	.refine(
		(value) => value.generatedDurationFrames <= value.requestedDurationFrames,
	)
	.refine(
		(value) =>
			value.query === undefined ||
			value.policyVersion === "aisa-scene-cohesion-v2" ||
			value.policyVersion === "aisa-prepared-scene-cohesion-v3",
		"Semantic query requires a semantic selection policy",
	)
	.refine(
		(value) =>
			(value.policyVersion === "aisa-prepared-shot-window-v3" ||
				value.policyVersion === "aisa-prepared-scene-cohesion-v3" ||
				value.policyVersion === "aisa-prepared-content-highlight-v4" ||
				value.policyVersion === "aisa-prepared-story-window-v1" ||
				value.policyVersion === "aisa-prepared-local-story-window-v1") ===
			(value.normalizationReceiptHash !== undefined),
		"Prepared policies require the immutable normalization receipt hash",
	)
	.refine(
		(value) =>
			isContentHighlightPolicy(value.policyVersion) ===
				(value.semanticEvidence !== undefined) &&
			(!isContentHighlightPolicy(value.policyVersion) ||
				value.renderMode === "DRAFT"),
		"Content selection requires versioned evidence and an explicit DRAFT",
	)
	.refine(
		(value) =>
			isStoryPolicy(value.policyVersion) ===
				(value.storyEvidence !== undefined) &&
			(!isStoryPolicy(value.policyVersion) || value.renderMode === "DRAFT"),
		"Story selection requires model evidence and an explicit DRAFT",
	)
	.refine(
		(value) =>
			isLocalStoryPolicy(value.policyVersion) ===
				(value.localStoryEvidence !== undefined) &&
			(!isLocalStoryPolicy(value.policyVersion) ||
				value.renderMode === "DRAFT"),
		"Local story requires separate model evidence and an explicit DRAFT",
	)
	.refine(
		(value) =>
			!value.reasonCodes.includes("SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED") ||
			((isContentHighlightPolicy(value.policyVersion) ||
				isStoryPolicy(value.policyVersion)) &&
				value.renderMode === "DRAFT"),
		"Search-limit speech fallback requires an automatic content DRAFT",
	)
	.refine(
		(value) =>
			((value.renderMode !== undefined) ===
				(value.draftPolicyVersion !== undefined) ||
				((isContentHighlightPolicy(value.policyVersion) ||
					isStoryPolicy(value.policyVersion) ||
					isLocalStoryPolicy(value.policyVersion)) &&
					value.renderMode === "DRAFT")) &&
			(!value.reasonCodes.includes("SPEECH_DURATION_REVIEW_REQUIRED") ||
				(value.renderMode === "DRAFT" &&
					value.draftPolicyVersion === "duration-review-v2")),
		"Duration review metadata requires an explicitly versioned draft proposal",
	);

/** Stable across JSONB object-key ordering; array ordering remains meaningful. */
export function canonicalEditingJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map((item) => (item === undefined ? "null" : canonicalEditingJson(item))).join(",")}]`;
	if (typeof value !== "object" || value === undefined)
		throw new TypeError("Expected JSON editing evidence");
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalEditingJson(record[key])}`)
		.join(",")}}`;
}
