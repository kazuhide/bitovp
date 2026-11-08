import { z } from "zod";

/** Derived metadata ranking, never calibrated model confidence or tracking proof. */
export const semanticEvidenceSchema = z.strictObject({
	version: z.literal("aisa-content-evidence-v1"),
	method: z.literal("METADATA_HEURISTIC"),
	profile: z.enum([
		"NARRATIVE",
		"PRODUCT",
		"INSTRUCTION",
		"SPORT",
		"CONVERSATION",
		"GENERAL",
	]),
	keyEntities: z
		.array(
			z.strictObject({
				kind: z.enum(["CHARACTER", "OBJECT"]),
				label: z.string().trim().min(1).max(160),
				sceneIds: z.array(z.uuid()).min(1).max(8),
			}),
		)
		.max(12),
	selectedMoments: z
		.array(
			z.strictObject({
				sceneId: z.uuid(),
				shotIndex: z.number().int().nonnegative().optional(),
				label: z.string().trim().min(1).max(240),
				score: z.number().int().min(0).max(1000),
				reasonCodes: z.array(z.string().min(1).max(64)).max(8),
			}),
		)
		.min(1)
		.max(20),
	selectionReason: z.enum([
		"CONTENT_RANKED",
		"INSUFFICIENT_METADATA",
		"SEARCH_BUDGET",
	]),
});
export type SemanticEvidence = z.infer<typeof semanticEvidenceSchema>;

export function isContentHighlightPolicy(version: string): boolean {
	return (
		version === "aisa-content-highlight-v1" ||
		version === "aisa-prepared-content-highlight-v4"
	);
}
