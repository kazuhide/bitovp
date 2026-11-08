import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
const ref = z.string().regex(/^i\d{1,5}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const STORY_PROMPT_VERSION = "aisa-story-prompt-v1" as const;
export const storyModelIdentitySchema = z.strictObject({
	version: z.literal("aisa-story-model-v1"),
	provider: z.literal("CODEX_CLI"),
	model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
	promptVersion: z.literal(STORY_PROMPT_VERSION),
	schemaHash: sha256,
	configId: z.uuid(),
});
export type StoryModelIdentity = z.infer<typeof storyModelIdentitySchema>;
export const storyInputCoverageSchema = z
	.strictObject({
		totalIntervals: z.number().int().min(0).max(10_000),
		includedIntervals: z.number().int().min(0).max(192),
		truncated: z.boolean(),
	})
	.refine(
		(v) =>
			v.includedIntervals <= v.totalIntervals &&
			v.truncated === v.includedIntervals < v.totalIntervals,
	);
export const storyModelInputSchema = z.strictObject({
	version: z.literal("aisa-story-input-v1"),
	asset: z.strictObject({
		title: z.string().max(512),
		description: z.string().max(2400),
	}),
	coverage: storyInputCoverageSchema,
	intervals: z
		.array(
			z.strictObject({
				ref,
				sceneId: z.uuid(),
				shotIndex: z.number().int().min(0).max(9999).optional(),
				startInSeconds: z.number().finite().nonnegative(),
				endInSeconds: z.number().finite().positive(),
				text: text(960),
				entities: z.array(text(80)).max(4),
			}),
		)
		.max(192),
});
export type StoryModelInput = z.infer<typeof storyModelInputSchema>;

/** Model claims reference supplied text; the model cannot supply media geometry or times. */
export const storyGraphSchema = z.strictObject({
	version: z.literal("aisa-story-graph-v1"),
	summary: text(1600),
	keyEntities: z
		.array(
			z.strictObject({
				id,
				label: text(160),
				kind: z.enum(["CHARACTER", "OBJECT"]),
				refs: z.array(ref).min(1).max(8),
			}),
		)
		.max(16),
	events: z
		.array(
			z.strictObject({
				id,
				label: text(160),
				role: z.enum(["SETUP", "CHANGE", "OUTCOME", "REACTION", "CONTEXT"]),
				entityIds: z.array(id).max(8),
				evidence: z
					.array(z.strictObject({ ref, quote: text(240).min(4) }))
					.min(1)
					.max(4),
				dependsOn: z.array(id).max(4),
				importance: z.number().int().min(1).max(5),
			}),
		)
		.max(32),
	arcs: z
		.array(
			z.strictObject({
				id,
				title: text(160),
				eventIds: z.array(id).min(1).max(8),
			}),
		)
		.max(8),
});
export type StoryGraph = z.infer<typeof storyGraphSchema>;
export function storyGraphOutputJsonSchema() {
	return z.toJSONSchema(storyGraphSchema);
}
export const storyModelRequestSchema = z.strictObject({
	identity: storyModelIdentitySchema,
	input: storyModelInputSchema,
});
export const storySelectionSchema = z.strictObject({
	selectedArcId: id.optional(),
	selectedEventIds: z.array(id).max(32),
	reason: z.enum([
		"CONNECTED_ARC",
		"PARTIAL_ARC",
		"METADATA_INSUFFICIENT",
		"SEARCH_BUDGET",
	]),
});
export type StorySelection = z.infer<typeof storySelectionSchema>;
export const storyArtifactSchema = z.strictObject({
	version: z.literal("aisa-story-artifact-v1"),
	identity: storyModelIdentitySchema,
	inputHash: sha256,
	graph: storyGraphSchema,
});
export type StoryArtifact = z.infer<typeof storyArtifactSchema>;
export const storyEvidenceSchema = z
	.strictObject({
		version: z.literal("aisa-story-evidence-v1"),
		method: z.literal("MODEL_EVENT_GRAPH"),
		model: storyModelIdentitySchema,
		inputHash: sha256,
		artifactHash: sha256,
		graph: storyGraphSchema,
		selection: storySelectionSchema,
		inputCoverage: storyInputCoverageSchema,
	})
	.superRefine((value, ctx) => {
		const events = new Map(
			value.graph.events.map((event) => [event.id, event]),
		);
		const selected = new Set(value.selection.selectedEventIds);
		const arc = value.graph.arcs.find(
			(a) => a.id === value.selection.selectedArcId,
		);
		const closures = new Map<string, Set<string>>();
		let validDependencies = true;
		const closure = (id: string, visiting = new Set<string>()): Set<string> => {
			const cached = closures.get(id);
			if (cached) return cached;
			const event = events.get(id);
			if (!event || visiting.has(id)) {
				validDependencies = false;
				return new Set();
			}
			visiting.add(id);
			const ids = new Set([id]);
			for (const dependency of event.dependsOn)
				for (const previous of closure(dependency, visiting)) ids.add(previous);
			visiting.delete(id);
			closures.set(id, ids);
			return ids;
		};
		let connected = false;
		if (value.selection.reason === "CONNECTED_ARC" && arc) {
			const required = new Set(arc.eventIds.flatMap((id) => [...closure(id)]));
			connected =
				validDependencies &&
				[...required].every((id) => selected.has(id)) &&
				[...required].some(
					(outcome) =>
						events.get(outcome)?.role === "OUTCOME" &&
						[...closure(outcome)].some(
							(change) =>
								events.get(change)?.role === "CHANGE" &&
								[...closure(change)].some(
									(setup) => events.get(setup)?.role === "SETUP",
								),
						),
				);
		}
		if (
			events.size !== value.graph.events.length ||
			selected.size !== value.selection.selectedEventIds.length ||
			[...selected].some((id) => !events.has(id)) ||
			(value.selection.selectedArcId !== undefined && !arc) ||
			(value.selection.reason === "METADATA_INSUFFICIENT" &&
				selected.size > 0) ||
			(value.selection.reason === "PARTIAL_ARC" && selected.size === 0) ||
			(value.selection.reason === "CONNECTED_ARC" && !connected)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Story selection must reference its inferred graph and supported dependencies",
			});
		}
	});
export type StoryEvidence = z.infer<typeof storyEvidenceSchema>;
export function isStoryPolicy(version: string): boolean {
	return (
		version === "aisa-story-window-v1" ||
		version === "aisa-prepared-story-window-v1"
	);
}
