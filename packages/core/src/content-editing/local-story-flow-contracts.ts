import { z } from "zod";
import {
	localStoryBlueprintSchema,
	localStoryModelIdentitySchema,
} from "./local-story-contracts";

export const LOCAL_STORY_FLOW_CONTEXT_PROMPT_VERSION =
	"local-story-flow-context-v1";
export const LOCAL_STORY_FLOW_ROUTE_PROMPT_VERSION =
	"local-story-flow-route-v1";
export const LOCAL_STORY_FLOW_H1_POLICY = Object.freeze({
	version: "local-story-flow-h1-policy-v1",
	mode: "FLOW",
	leafPageLimits: Object.freeze({
		context: 8192,
		maxOutputTokens: 1536,
		maxPromptUtf8Bytes: 5632,
		instructionUtf8Bytes: 1536,
		maxDataUtf8Bytes: 4096,
		maxItems: 32,
		maxPages: 32,
	}),
	formatting: Object.freeze({
		instructionOnlyUtf8Bytes: 1024,
		controlJsonUtf8Bytes: 480,
		controlMarkerUtf8Bytes: 9,
		dataMarkerUtf8Bytes: 6,
		publicViewUtf8Bytes: 1800,
	}),
	output: Object.freeze({
		claims: 4,
		claimTextJsonUtf8Bytes: 160,
		supportsPerClaim: 32,
		witnessesPerClaim: 3,
		atomsPerWitness: 8,
		relations: 16,
		unresolved: 32,
		candidateEvents: 32,
	}),
	tree: Object.freeze({
		recipe: "adjacent-level-pair-odd-carry-v1",
		nodes: 63,
		edgeDepth: 5,
	}),
	invocations: Object.freeze({
		context: 63,
		route: 64,
		total: 127,
		allNewAttemptsIncluded: true,
	}),
	closure: "nonempty-root-commitment-and-hard-witness-all-v1",
});

const fullString = (pattern: RegExp) =>
	z
		.string()
		.regex(pattern)
		.refine((value) => pattern.exec(value)?.[0] === value);
const chunkOrdinal = "(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])";
const summaryId = fullString(new RegExp(`^u${chunkOrdinal}$`));
const eventId = fullString(new RegExp(`^l${chunkOrdinal}_e[0-5]$`));
const claimId = fullString(/^c[0-3]$/);
const witnessId = fullString(/^w[0-2]$/);
export const localStoryFlowPageIdSchema = fullString(
	/^flow-page(?:[0-9]|[12][0-9]|3[01])$/,
);
export const localStoryFlowNodeIdSchema = fullString(
	/^n(?:[0-9]|[1-5][0-9]|6[0-2])$/,
);
export const localStoryFlowSummaryRefSchema = z.strictObject({
	kind: z.literal("SUMMARY"),
	summaryId,
});
export const localStoryFlowEventRefSchema = z.strictObject({
	kind: z.literal("EVENT"),
	eventId,
});
export const localStoryFlowClaimRefSchema = z.strictObject({
	kind: z.literal("CLAIM"),
	nodeId: localStoryFlowNodeIdSchema,
	claimId,
});
export const localStoryFlowWitnessRefSchema = z.strictObject({
	kind: z.literal("WITNESS"),
	nodeId: localStoryFlowNodeIdSchema,
	claimId,
	witnessId,
});
export type LocalStoryFlowClaimRef = z.infer<
	typeof localStoryFlowClaimRefSchema
>;
export type LocalStoryFlowWitnessRef = z.infer<
	typeof localStoryFlowWitnessRefSchema
>;

const limits = LOCAL_STORY_FLOW_H1_POLICY.output;
const childRef = z.strictObject({
	kind: z.literal("CHILD_NODE"),
	nodeId: localStoryFlowNodeIdSchema,
});
const contextRef = z.strictObject({
	kind: z.literal("CONTEXT_NODE"),
	nodeId: localStoryFlowNodeIdSchema,
});
const ownClaimRef = z.strictObject({ kind: z.literal("OWN_CLAIM"), claimId });
const ownWitnessRef = z.strictObject({
	kind: z.literal("OWN_WITNESS"),
	claimId,
	witnessId,
});
const itemRef = z.union([
	localStoryFlowSummaryRefSchema,
	localStoryFlowEventRefSchema,
]);
const inputClaimRef = localStoryFlowClaimRefSchema;
const inputWitnessRef = localStoryFlowWitnessRefSchema;
const allRef = z.union([
	localStoryFlowSummaryRefSchema,
	localStoryFlowEventRefSchema,
	inputClaimRef,
	inputWitnessRef,
	childRef,
	contextRef,
	ownClaimRef,
	ownWitnessRef,
]);
type FlowRef = z.infer<typeof allRef>;
const key = (value: unknown) => JSON.stringify(value);
const unique = (values: readonly unknown[]) =>
	new Set(values.map(key)).size === values.length;
const list = <T extends z.ZodType>(schema: T, max: number, min = 0) =>
	z.array(schema).min(min).max(max).refine(unique, "Duplicate flow values");
const invalid = (ctx: z.RefinementCtx) =>
	ctx.addIssue({
		code: "custom",
		message: "Flow output is not self-consistent",
	});
const reason = z.enum([
	"SOURCE_CONTEXT_UNCLEAR",
	"NO_GROUNDED_WITNESS",
	"DEPENDENCY_UNRESOLVED",
	"CONTRADICTORY_INPUT",
	"RELATION_UNCLEAR",
]);
const issues = <T extends z.ZodType>(ref: T) =>
	list(z.strictObject({ ref, reason }), limits.unresolved);
const claimSchema = <S extends z.ZodType, A extends z.ZodType>(
	support: S,
	atom: A,
) =>
	z.strictObject({
		id: claimId,
		text: z
			.string()
			.min(1)
			.refine(
				(value) =>
					value.trim().length > 0 &&
					new TextEncoder().encode(JSON.stringify(value)).byteLength <=
						limits.claimTextJsonUtf8Bytes,
			),
		supports: list(support, limits.supportsPerClaim, 1),
		witnesses: z
			.array(
				z.strictObject({
					id: witnessId,
					allOf: list(atom, limits.atomsPerWitness, 1),
				}),
			)
			.max(limits.witnessesPerClaim),
	});
const leafAnchor = z.union([
	localStoryFlowEventRefSchema,
	ownClaimRef,
	ownWitnessRef,
]);
const mergeAnchor = z.union([
	inputClaimRef,
	inputWitnessRef,
	ownClaimRef,
	ownWitnessRef,
]);
const relationSchema = <
	A extends z.ZodType,
	P extends z.ZodType,
	C extends z.ZodType,
>(
	anchor: A,
	prerequisite: P,
	claim: C,
) =>
	list(
		z.discriminatedUnion("kind", [
			z.strictObject({
				kind: z.literal("REQUIRES"),
				from: anchor,
				target: prerequisite,
			}),
			z.strictObject({
				kind: z.literal("CONTRADICTS"),
				from: claim,
				target: claim,
			}),
		]),
		limits.relations,
	);
const contextCommon = {
	version: z.literal("local-story-flow-context-output-v1"),
	mode: z.literal("FLOW"),
	nodeId: localStoryFlowNodeIdSchema,
};
const leafContext = z.strictObject({
	...contextCommon,
	phase: z.literal("LEAF"),
	pageId: localStoryFlowPageIdSchema,
	accountedItems: list(itemRef, 32, 1),
	claims: z
		.array(claimSchema(itemRef, localStoryFlowEventRefSchema))
		.max(limits.claims),
	relations: relationSchema(
		leafAnchor,
		z.union([localStoryFlowEventRefSchema, ownClaimRef]),
		ownClaimRef,
	),
	unresolved: issues(z.union([itemRef, ownClaimRef, ownWitnessRef])),
});
const mergeContext = z.strictObject({
	...contextCommon,
	phase: z.literal("MERGE"),
	accountedChildren: list(childRef, 2, 2),
	claims: z
		.array(claimSchema(inputClaimRef, inputWitnessRef))
		.max(limits.claims),
	relations: relationSchema(
		mergeAnchor,
		z.union([inputClaimRef, ownClaimRef]),
		z.union([inputClaimRef, ownClaimRef]),
	),
	unresolved: issues(
		z.union([
			childRef,
			inputClaimRef,
			inputWitnessRef,
			ownClaimRef,
			ownWitnessRef,
		]),
	),
});
type ContextBody = z.infer<typeof leafContext> | z.infer<typeof mergeContext>;

/** Checks only output-local consistency. Expected input membership belongs to H1b. */
function checkContext(value: ContextBody, ctx: z.RefinementCtx) {
	const refs: FlowRef[] = [];
	for (const [index, claim] of value.claims.entries()) {
		if (claim.id !== `c${index}`) invalid(ctx);
		refs.push(...claim.supports);
		for (const [ordinal, witness] of claim.witnesses.entries()) {
			if (witness.id !== `w${ordinal}`) invalid(ctx);
			refs.push(...witness.allOf);
		}
	}
	const relationKeys = new Set<string>();
	for (const relation of value.relations) {
		refs.push(relation.from, relation.target);
		const pair = [key(relation.from), key(relation.target)];
		if (pair[0] === pair[1]) invalid(ctx);
		if (relation.kind === "CONTRADICTS") pair.sort();
		const relationKey = key([relation.kind, pair]);
		if (relationKeys.has(relationKey)) invalid(ctx);
		relationKeys.add(relationKey);
	}
	refs.push(...value.unresolved.map((issue) => issue.ref));
	const accounted = new Set(
		value.phase === "LEAF"
			? value.accountedItems.map(key)
			: value.accountedChildren.map((ref) => ref.nodeId),
	);
	if (value.phase === "MERGE" && accounted.has(value.nodeId)) invalid(ctx);
	for (const ref of refs) {
		if (ref.kind === "OWN_CLAIM" || ref.kind === "OWN_WITNESS") {
			const claim = value.claims.find((claim) => claim.id === ref.claimId);
			if (
				!claim ||
				(ref.kind === "OWN_WITNESS" &&
					!claim.witnesses.some((w) => w.id === ref.witnessId))
			)
				invalid(ctx);
		} else if (value.phase === "LEAF") {
			if (!accounted.has(key(ref))) invalid(ctx);
		} else if (
			!("nodeId" in ref) ||
			ref.nodeId === value.nodeId ||
			!accounted.has(ref.nodeId)
		)
			invalid(ctx);
	}
}
export const localStoryFlowContextOutputSchema = z
	.discriminatedUnion("phase", [leafContext, mergeContext])
	.superRefine(checkContext);
export type LocalStoryFlowContextOutput = z.infer<
	typeof localStoryFlowContextOutputSchema
>;

const choiceSchema = <K extends "ROOT_GOAL" | "HARD_REQUIREMENT">(kind: K) =>
	z
		.strictObject({
			kind: z.literal(kind),
			claim: inputClaimRef,
			witness: inputWitnessRef,
		})
		.refine(
			(value) =>
				value.claim.nodeId === value.witness.nodeId &&
				value.claim.claimId === value.witness.claimId,
			"Witness owner must match its claim",
		);
const routeCommon = {
	version: z.literal("local-story-flow-route-output-v1"),
	mode: z.literal("FLOW"),
	nodeId: localStoryFlowNodeIdSchema,
};
const ownerIssues = issues(
	z.union([contextRef, inputClaimRef, inputWitnessRef]),
);
const rootRoute = z.strictObject({
	...routeCommon,
	phase: z.literal("ROOT"),
	choice: choiceSchema("ROOT_GOAL"),
	unresolved: ownerIssues,
});
const witnessRoute = z.strictObject({
	...routeCommon,
	phase: z.literal("WITNESS"),
	choice: choiceSchema("HARD_REQUIREMENT"),
	unresolved: ownerIssues,
});
const branchRoute = z.strictObject({
	...routeCommon,
	phase: z.literal("BRANCH"),
	accountedChildren: list(childRef, 2, 2),
	dispositions: z
		.array(
			z.strictObject({
				child: childRef,
				disposition: z.enum(["DESCEND", "CONTEXT_ONLY"]),
			}),
		)
		.length(2),
	unresolved: issues(z.union([childRef, inputClaimRef, inputWitnessRef])),
});
const leafRoute = z.strictObject({
	...routeCommon,
	phase: z.literal("LEAF"),
	pageId: localStoryFlowPageIdSchema,
	accountedItems: list(itemRef, 32, 1),
	candidates: list(localStoryFlowEventRefSchema, limits.candidateEvents),
	unresolved: issues(itemRef),
});
const finalRoute = z.strictObject({
	...routeCommon,
	phase: z.literal("FINALIZE"),
	accountedRoot: contextRef,
	accountedEvents: list(
		localStoryFlowEventRefSchema,
		limits.candidateEvents,
		1,
	),
	blueprint: localStoryBlueprintSchema.safeExtend({ mode: z.literal("FLOW") }),
	unresolved: issues(
		z.union([
			contextRef,
			localStoryFlowEventRefSchema,
			inputClaimRef,
			inputWitnessRef,
		]),
	),
});

/** Schema-only output; this does not establish B, expected scope, or native provenance. */
export const localStoryFlowRouteOutputSchema = z
	.discriminatedUnion("phase", [
		rootRoute,
		witnessRoute,
		branchRoute,
		leafRoute,
		finalRoute,
	])
	.superRefine((value, ctx) => {
		if (value.phase === "ROOT" || value.phase === "WITNESS") {
			if (value.choice.claim.nodeId !== value.nodeId) invalid(ctx);
		} else if (value.phase === "BRANCH") {
			if (
				value.accountedChildren.some(
					(ref, i) =>
						ref.nodeId === value.nodeId ||
						key(ref) !== key(value.dispositions[i]?.child),
				)
			)
				invalid(ctx);
		} else if (value.phase === "LEAF") {
			const known = new Set(value.accountedItems.map(key));
			if (
				[
					...value.candidates,
					...value.unresolved.map((issue) => issue.ref),
				].some((ref) => !known.has(key(ref)))
			)
				invalid(ctx);
		} else {
			const known = new Set(value.accountedEvents.map((ref) => ref.eventId));
			if (
				value.accountedRoot.nodeId !== value.nodeId ||
				value.blueprint.beats.some((beat) =>
					beat.eventIds.some((id) => !known.has(id)),
				)
			)
				invalid(ctx);
		}
	});
export type LocalStoryFlowRouteOutput = z.infer<
	typeof localStoryFlowRouteOutputSchema
>;

const digest = fullString(/^[a-f0-9]{64}$/);
export const localStoryFlowWorkflowIdentitySchema = z.strictObject({
	version: z.literal("local-story-flow-workflow-v1"),
	mode: z.literal("FLOW"),
	baseModel: localStoryModelIdentitySchema,
	legacyStoryRegistryHash: digest,
	legacySemanticRegistryHash: digest,
	flowRegistryHash: digest,
	policyHash: digest,
});
export type LocalStoryFlowWorkflowIdentity = z.infer<
	typeof localStoryFlowWorkflowIdentitySchema
>;
