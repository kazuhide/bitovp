import { z } from "zod";
import type { CfrTimeMap } from "./schema";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const ref = z.string().regex(/^s\d{1,5}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const LOCAL_STORY_PROMPT_VERSION = "local-story-v1" as const;
export const LOCAL_STORY_MAX_CHUNK_BYTES = 4500;
export const LOCAL_STORY_MAX_CHUNKS = 128;
export const localStoryModeSchema = z.enum(["AUTO", "FLOW", "THEME"]);
export type LocalStoryMode = z.infer<typeof localStoryModeSchema>;

/** This identity cannot describe or reactivate a historical coding-agent receipt. */
export const localStoryModelIdentitySchema = z.strictObject({
	version: z.literal("local-story-model-v1"),
	provider: z.literal("LOCAL_OLLAMA"),
	profile: z.enum(["amd", "nvidia"]),
	model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
	modelDigest: hash,
	runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
	promptVersion: z.literal(LOCAL_STORY_PROMPT_VERSION),
	schemaHash: hash,
	configId: z.uuid(),
	context: z.literal(8192),
	thinking: z.literal(false),
});
export type LocalStoryModelIdentity = z.infer<
	typeof localStoryModelIdentitySchema
>;
export const localStoryRoleSchema = z.enum([
	"CONTEXT",
	"ACTION",
	"CHANGE",
	"OUTCOME",
	"POINT",
]);
export const localStoryEventSchema = z.strictObject({
	id,
	label: text(120),
	role: localStoryRoleSchema,
	refs: z.array(ref).min(1).max(3),
	quotes: z
		.array(
			z.strictObject({
				ref,
				// Preserve exact whitespace: this is a quotation, not a display label.
				quote: z
					.string()
					.min(4)
					.max(200)
					.refine((v) => v.trim().length >= 4),
			}),
		)
		.min(1)
		.max(3),
	subjects: z.array(text(80)).max(4),
	uncertainty: z.string().max(240),
});
export type LocalStoryEvent = z.infer<typeof localStoryEventSchema>;
/** Model output for one complete input chunk. No scores, clock values or render commands. */
export const localStoryLedgerSchema = z.strictObject({
	summary: text(320),
	events: z.array(localStoryEventSchema).max(6),
});
export type LocalStoryLedger = z.infer<typeof localStoryLedgerSchema>;
export const localStoryCorpusSchema = z.strictObject({
	version: z.literal("local-story-corpus-v1"),
	summaries: z.array(text(320)).min(1).max(LOCAL_STORY_MAX_CHUNKS),
	events: z.array(localStoryEventSchema).max(LOCAL_STORY_MAX_CHUNKS * 6),
	coveredRefs: z.array(ref).max(10_000),
});
export type LocalStoryCorpus = z.infer<typeof localStoryCorpusSchema>;
export const localStoryBlueprintSchema = z
	.strictObject({
		mode: z.enum(["FLOW", "THEME"]),
		message: text(240),
		beats: z
			.array(
				z.strictObject({
					id,
					role: localStoryRoleSchema,
					// Alternatives for this beat, not an importance ranking or mandatory top-K.
					eventIds: z.array(id).min(1).max(4),
					requires: z.array(id).max(4),
				}),
			)
			.min(1)
			.max(5),
		uncertainty: z.string().max(320),
	})
	.superRefine((value, ctx) => {
		const seen = new Set<string>();
		for (const beat of value.beats) {
			if (
				seen.has(beat.id) ||
				new Set(beat.eventIds).size !== beat.eventIds.length ||
				new Set(beat.requires).size !== beat.requires.length ||
				beat.requires.some((id) => !seen.has(id))
			) {
				ctx.addIssue({
					code: "custom",
					message: "Beat context must refer to unique earlier beats",
				});
			}
			seen.add(beat.id);
		}
	});
export type LocalStoryBlueprint = z.infer<typeof localStoryBlueprintSchema>;

export type LocalStoryField = {
	pointer: string;
	kind: "AISA" | "ASR";
	text: string;
	startUs?: number;
	endUs?: number;
};
export type LocalStoryShot = {
	ref: string;
	sceneId: string;
	shotIndex?: number;
	fromFrame: number;
	toFrame: number;
	text: string;
	fields: LocalStoryField[];
};
export type LocalStoryInput = {
	version: "local-story-input-v1";
	title: string;
	description: string;
	timeMap: CfrTimeMap;
	timeMapHash: string;
	normalizationReceiptHash?: string;
	scenes: { sceneId: string; text: string; fields: LocalStoryField[] }[];
	shots: LocalStoryShot[];
	coverage: {
		ref: string;
		status: "ELIGIBLE" | "EXCLUDED" | "OUTSIDE_MEDIA" | "UNREPRESENTABLE";
	}[];
	segments: { startUs: number; endUs: number; text: string }[];
};
export type LocalStoryChunk = {
	id: string;
	refs: string[];
	context: { sceneId: string; text: string }[];
	shots: { ref: string; sceneId: string; text: string }[];
};
export const localStorySelectionSchema = z.strictObject({
	selectedBeatIds: z.array(id).min(1).max(5),
	selectedEventIds: z.array(id).min(1).max(5),
	reason: z.literal("COMPLETE_BEATS"),
});
export type LocalStorySelection = z.infer<typeof localStorySelectionSchema>;
export const localStoryInputCoverageSchema = z
	.strictObject({
		totalShots: z.number().int().min(0).max(10_000),
		eligibleShots: z.number().int().min(0).max(10_000),
		processedShots: z.number().int().min(0).max(10_000),
		excludedShots: z.number().int().min(0).max(10_000),
		truncated: z.literal(false),
	})
	.refine(
		(v) =>
			v.processedShots === v.eligibleShots &&
			v.eligibleShots + v.excludedShots === v.totalShots,
	);
export const localStoryEvidenceSchema = z
	.strictObject({
		version: z.literal("local-story-evidence-v1"),
		method: z.literal("LOCAL_LLM_BEAT_PLAN"),
		model: localStoryModelIdentitySchema,
		inputHash: hash,
		artifactHash: hash,
		ledgerHash: hash,
		blueprintHash: hash,
		ledger: localStoryCorpusSchema,
		blueprint: localStoryBlueprintSchema,
		selection: localStorySelectionSchema,
		inputCoverage: localStoryInputCoverageSchema,
	})
	.superRefine((value, ctx) => {
		const events = new Set(value.ledger.events.map((v) => v.id));
		const beats = new Map(value.blueprint.beats.map((v) => [v.id, v]));
		if (
			events.size !== value.ledger.events.length ||
			beats.size !== value.blueprint.beats.length ||
			new Set(value.ledger.coveredRefs).size !==
				value.ledger.coveredRefs.length ||
			value.ledger.coveredRefs.length !== value.inputCoverage.processedShots ||
			value.ledger.events.some((e) =>
				e.refs.some((ref) => !value.ledger.coveredRefs.includes(ref)),
			) ||
			value.selection.selectedBeatIds.length !== beats.size ||
			new Set(value.selection.selectedBeatIds).size !== beats.size ||
			value.selection.selectedBeatIds.some((v) => !beats.has(v)) ||
			new Set(value.selection.selectedEventIds).size !==
				value.selection.selectedEventIds.length ||
			value.selection.selectedEventIds.length !== beats.size ||
			value.selection.selectedEventIds.some((v) => !events.has(v)) ||
			value.blueprint.beats.some(
				(b, i) =>
					value.selection.selectedBeatIds[i] !== b.id ||
					!b.eventIds.includes(value.selection.selectedEventIds[i] ?? ""),
			)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Local story selection must fulfill its declared complete blueprint",
			});
		}
	});
export type LocalStoryEvidence = z.infer<typeof localStoryEvidenceSchema>;
