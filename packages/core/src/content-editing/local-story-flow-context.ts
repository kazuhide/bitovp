import { canonicalEditingJson } from "./automatic-binding";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import type { LocalStoryEvent, LocalStoryInput } from "./local-story-contracts";
import {
	LOCAL_STORY_FLOW_H1_POLICY,
	type LocalStoryFlowClaimRef,
	type LocalStoryFlowContextOutput,
	type LocalStoryFlowWitnessRef,
	type LocalStoryFlowWorkflowIdentity,
	localStoryFlowContextOutputSchema,
} from "./local-story-flow-contracts";
import {
	type LocalStoryFlowLeafPage,
	type LocalStoryFlowManifest,
	type LocalStoryFlowManifestOptions,
	validateLocalStoryFlowLeafPages,
	validateLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import {
	validateLocalStoryFlowWorkflowIdentity,
	validateLocalStoryFlowWorkflowIdentityForModelPin,
} from "./local-story-flow-stages";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_CONTEXT_POLICY = Object.freeze({
	version: "local-story-flow-context-policy-v1",
	h1aPolicyHash: hash(LOCAL_STORY_FLOW_H1_POLICY),
	treeRecipe: "adjacent-level-pair-odd-carry-v1",
	refMapping: "node-owned-typed-global-v1",
	supportRule: "leaf-event-and-merge-witness-owner-in-supports-v1",
	flattenRule: "whole-child-bundle-union-h0-order-v1",
	publicViewVersion: "local-story-flow-context-public-view-v1",
	publicViewUtf8Bytes: 1800,
	eligibilityRule: "individual-max-lower-bound-legacy-five-beats-v1",
	legacyAlternativeMaxEvents: 5,
	nodeVersion: "local-story-flow-context-node-v1",
	treeVersion: "local-story-flow-context-tree-v1",
});
type ErrorCode =
	| "LOCAL_STORY_FLOW_CONTEXT_INVALID"
	| "LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH"
	| "LOCAL_STORY_FLOW_CONTEXT_PUBLIC_VIEW_LIMIT"
	| "LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID";
export class LocalStoryFlowContextError extends Error {
	constructor(readonly code: ErrorCode) {
		super(code);
		this.name = "LocalStoryFlowContextError";
	}
}
function requireContext(
	value: unknown,
	code: ErrorCode = "LOCAL_STORY_FLOW_CONTEXT_INVALID",
): asserts value {
	if (!value) throw new LocalStoryFlowContextError(code);
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function same(value: unknown, expected: unknown): boolean {
	if (value === null || typeof value !== "object")
		return Object.is(value, expected);
	if (
		expected === null ||
		typeof expected !== "object" ||
		Array.isArray(value) !== Array.isArray(expected)
	)
		return false;
	if (
		Object.getOwnPropertySymbols(value).length ||
		(!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
	)
		return false;
	if (
		Array.isArray(value) &&
		Array.isArray(expected) &&
		value.length !== expected.length
	)
		return false;
	const keys = Object.getOwnPropertyNames(value).sort(),
		other = Object.getOwnPropertyNames(expected).sort();
	return (
		keys.length === other.length &&
		keys.every(
			(key, index) =>
				key === other[index] &&
				same(Reflect.get(value, key), Reflect.get(expected, key)),
		)
	);
}
export type LocalStoryFlowContextPlan = {
	nodeId: string;
	pageFrom: number;
	pageToExclusive: number;
	edgeDepth: number;
} & (
	| { phase: "LEAF"; pageId: string }
	| { phase: "MERGE"; children: [string, string] }
);
export type LocalStoryFlowContextLayout = {
	version: "local-story-flow-context-layout-v1";
	recipe: typeof LOCAL_STORY_FLOW_CONTEXT_POLICY.treeRecipe;
	h1bPolicyHash: string;
	pages: { pageId: string; pageHash: string }[];
	nodes: LocalStoryFlowContextPlan[];
	rootNodeId: string;
	layoutHash: string;
};
export type LocalStoryFlowContextSourceBinding = {
	version: "local-story-flow-context-source-v1";
	manifestHash: string;
	inputHash: string;
	modelHash: string;
	timeMapHash: string;
	transcriptFingerprint: string;
	workflowIdentityHash: string;
	h1aPolicyHash: string;
	h1bPolicyHash: string;
	layoutHash: string;
};
export type SourceEvidence = {
	version: "local-story-flow-context-source-evidence-v1";
	sourceBinding: LocalStoryFlowContextSourceBinding;
	sourceBindingHash: string;
	input: LocalStoryInput;
	workflow: LocalStoryFlowWorkflowIdentity;
	manifest: LocalStoryFlowManifest;
	pages: LocalStoryFlowLeafPage[];
	layout: LocalStoryFlowContextLayout;
};
export type PreparedLocalStoryFlowContextSource = Readonly<{
	kind: "local-story-flow-context-source-handle-v1";
}>;
const sources = new WeakMap<
	PreparedLocalStoryFlowContextSource,
	SourceEvidence
>();
function sourceState(source: PreparedLocalStoryFlowContextSource) {
	const value = sources.get(source);
	requireContext(value);
	return value;
}
export function localStoryFlowContextSourceEvidence(
	source: PreparedLocalStoryFlowContextSource,
): SourceEvidence {
	return structuredClone(sourceState(source));
}
function layoutFor(
	pages: LocalStoryFlowLeafPage[],
	h1bPolicyHash: string,
): LocalStoryFlowContextLayout {
	requireContext(pages.length > 0 && pages.length <= 32);
	const nodes: LocalStoryFlowContextPlan[] = pages.map((page, index) => ({
		nodeId: "n" + index,
		phase: "LEAF",
		pageId: page.pageId,
		pageFrom: index,
		pageToExclusive: index + 1,
		edgeDepth: 0,
	}));
	let level = [...nodes];
	while (level.length > 1) {
		const next: LocalStoryFlowContextPlan[] = [];
		for (let i = 0; i < level.length; i += 2) {
			const left = level[i],
				right = level[i + 1];
			requireContext(left);
			if (!right) {
				next.push(left);
				continue;
			}
			requireContext(left.pageToExclusive === right.pageFrom);
			const node: LocalStoryFlowContextPlan = {
				nodeId: "n" + nodes.length,
				phase: "MERGE",
				children: [left.nodeId, right.nodeId],
				pageFrom: left.pageFrom,
				pageToExclusive: right.pageToExclusive,
				edgeDepth: 1 + Math.max(left.edgeDepth, right.edgeDepth),
			};
			nodes.push(node);
			next.push(node);
		}
		level = next;
	}
	const root = level[0];
	requireContext(
		root &&
			nodes.length === 2 * pages.length - 1 &&
			nodes.length <= 63 &&
			root.edgeDepth <= Math.ceil(Math.log2(pages.length)) &&
			root.edgeDepth <= 5 &&
			root.pageFrom === 0 &&
			root.pageToExclusive === pages.length,
	);
	const body = {
		version: "local-story-flow-context-layout-v1" as const,
		recipe: LOCAL_STORY_FLOW_CONTEXT_POLICY.treeRecipe,
		h1bPolicyHash,
		pages: pages.map(({ pageId, pageHash }) => ({ pageId, pageHash })),
		nodes,
		rootNodeId: root.nodeId,
	};
	return { ...body, layoutHash: hash(body) };
}
/** Pure source/structure binding only; native admission remains the caller's responsibility. */
export function prepareLocalStoryFlowContextSource(options: {
	h0: LocalStoryFlowManifestOptions;
	manifest: unknown;
	pages: unknown;
	workflow: unknown;
	config: LocalSemanticConfiguration;
	mode: "FLOW";
}): PreparedLocalStoryFlowContextSource {
	return prepareSource(options, () =>
		validateLocalStoryFlowWorkflowIdentity(
			options.workflow,
			options.config,
			options.mode,
		),
	);
}

/** Same owned source factory, with only a stored profile/configId pin. */
export function prepareLocalStoryFlowContextSourceFromPin(options: {
	h0: LocalStoryFlowManifestOptions;
	manifest: unknown;
	pages: unknown;
	workflow: unknown;
	pin: unknown;
	mode: "FLOW";
}): PreparedLocalStoryFlowContextSource {
	let plain: typeof options;
	try {
		requireContext(
			options && Object.getPrototypeOf(options) === Object.prototype,
		);
		const fields = ["h0", "manifest", "pages", "workflow", "pin", "mode"];
		const descriptors = Object.getOwnPropertyDescriptors(options);
		requireContext(
			Object.getOwnPropertySymbols(options).length === 0 &&
				Object.keys(descriptors).length === fields.length &&
				fields.every((field) => Object.hasOwn(descriptors, field)),
		);
		for (const d of Object.values(descriptors))
			requireContext(d.enumerable && "value" in d && d.value !== undefined);
		plain = Object.fromEntries(
			Object.entries(descriptors).map(([key, d]) => [key, d.value]),
		) as typeof options;
	} catch {
		throw new LocalStoryFlowContextError(
			"LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH",
		);
	}
	return prepareSource(plain, () =>
		validateLocalStoryFlowWorkflowIdentityForModelPin(
			plain.workflow,
			plain.pin,
			plain.mode,
		),
	);
}

function prepareSource(
	options: {
		h0: LocalStoryFlowManifestOptions;
		manifest: unknown;
		pages: unknown;
		mode: "FLOW";
	},
	expectedWorkflow: () => LocalStoryFlowWorkflowIdentity,
): PreparedLocalStoryFlowContextSource {
	requireContext(options.mode === "FLOW");
	const manifest = validateLocalStoryFlowManifest(options.manifest, options.h0);
	const pages = validateLocalStoryFlowLeafPages(options.pages, manifest);
	let workflow: LocalStoryFlowWorkflowIdentity;
	try {
		workflow = expectedWorkflow();
	} catch {
		throw new LocalStoryFlowContextError(
			"LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH",
		);
	}
	requireContext(
		canonicalEditingJson(workflow.baseModel) ===
			canonicalEditingJson(manifest.model),
		"LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH",
	);
	const h1bPolicyHash = hash(LOCAL_STORY_FLOW_CONTEXT_POLICY),
		layout = layoutFor(pages, h1bPolicyHash);
	const sourceBinding: LocalStoryFlowContextSourceBinding = {
		version: "local-story-flow-context-source-v1",
		manifestHash: manifest.manifestHash,
		inputHash: manifest.inputHash,
		modelHash: manifest.modelHash,
		timeMapHash: options.h0.input.timeMapHash,
		transcriptFingerprint: manifest.transcriptFingerprint,
		workflowIdentityHash: hash(workflow),
		h1aPolicyHash: workflow.policyHash,
		h1bPolicyHash,
		layoutHash: layout.layoutHash,
	};
	const state: SourceEvidence = {
		version: "local-story-flow-context-source-evidence-v1",
		sourceBinding,
		sourceBindingHash: hash(sourceBinding),
		input: structuredClone(options.h0.input),
		workflow,
		manifest,
		pages,
		layout,
	};
	const handle = Object.freeze({
		kind: "local-story-flow-context-source-handle-v1" as const,
	});
	sources.set(handle, freeze(structuredClone(state)));
	return handle;
}

export type LocalStoryFlowSummaryRef = { kind: "SUMMARY"; summaryId: string };
export type LocalStoryFlowEventRef = { kind: "EVENT"; eventId: string };
type ItemRef = LocalStoryFlowSummaryRef | LocalStoryFlowEventRef;
type ChildRef = { kind: "CHILD_NODE"; nodeId: string };
type OwnRef =
	| { kind: "OWN_CLAIM"; claimId: string }
	| { kind: "OWN_WITNESS"; claimId: string; witnessId: string };
type GlobalRef =
	| ItemRef
	| LocalStoryFlowClaimRef
	| LocalStoryFlowWitnessRef
	| ChildRef;
type RawRef = GlobalRef | OwnRef;
export type LocalStoryFlowContextRelation =
	| {
			kind: "REQUIRES";
			from:
				| LocalStoryFlowEventRef
				| LocalStoryFlowClaimRef
				| LocalStoryFlowWitnessRef;
			target: LocalStoryFlowEventRef | LocalStoryFlowClaimRef;
	  }
	| {
			kind: "CONTRADICTS";
			from: LocalStoryFlowClaimRef;
			target: LocalStoryFlowClaimRef;
	  };
export type LocalStoryFlowContextIssue = {
	ref: GlobalRef;
	reason: LocalStoryFlowContextOutput["unresolved"][number]["reason"];
};
export type LocalStoryFlowWitnessEligibility = {
	availability: "UNAVAILABLE" | "JOINT_UNVERIFIED";
	eventCount: number;
	minimumFramesLowerBound: number | null;
};
export type LocalStoryFlowWitnessProof = {
	ref: LocalStoryFlowWitnessRef;
	allOf: (LocalStoryFlowEventRef | LocalStoryFlowWitnessRef)[];
	events: {
		ref: LocalStoryFlowEventRef;
		eventHash: string;
		sourceOrder: number;
		role: LocalStoryEvent["role"];
		minimumFrames: number | null;
	}[];
	eligibility: LocalStoryFlowWitnessEligibility;
	unavailableReasons: (
		| "EVENT_MINIMUM_UNAVAILABLE"
		| "EVENT_COUNT_EXCEEDS_LEGACY_BEATS"
	)[];
};
export type LocalStoryFlowContextPublicView = {
	version: "local-story-flow-context-public-view-v1";
	nodeId: string;
	claims: {
		id: string;
		text: string;
		supports: (ItemRef | LocalStoryFlowClaimRef)[];
		witnesses: {
			id: string;
			allOf: (LocalStoryFlowEventRef | LocalStoryFlowWitnessRef)[];
			eligibility: LocalStoryFlowWitnessEligibility;
		}[];
	}[];
	relations: LocalStoryFlowContextRelation[];
	unresolved: LocalStoryFlowContextIssue[];
};
export type LocalStoryFlowContextInput = {
	version: "local-story-flow-context-input-v1";
	stage: "LOCAL_FLOW_CONTEXT_V1";
	phase: "LEAF" | "MERGE";
	nodeId: string;
	sourceBinding: LocalStoryFlowContextSourceBinding;
	sourceBindingHash: string;
	orderedInputProofs: (
		| { pageId: string; pageHash: string; dataHash: string }
		| { nodeId: string; nodeHash: string; publicViewHash: string }
	)[];
	data:
		| LocalStoryFlowLeafPage["data"]
		| { children: LocalStoryFlowContextPublicView[] };
	dataHash: string;
	dataUtf8Bytes: number;
	inputHash: string;
};
export type LocalStoryFlowContextNodeEvidence = {
	version: "local-story-flow-context-node-v1";
	sourceBinding: LocalStoryFlowContextSourceBinding;
	sourceBindingHash: string;
	nodeId: string;
	phase: "LEAF" | "MERGE";
	plan: LocalStoryFlowContextPlan;
	input: LocalStoryFlowContextInput;
	inputHash: string;
	rawOutput: LocalStoryFlowContextOutput;
	rawOutputHash: string;
	publicView: LocalStoryFlowContextPublicView;
	publicViewHash: string;
	publicViewUtf8Bytes: number;
	claimRefs: LocalStoryFlowClaimRef[];
	witnessProofs: LocalStoryFlowWitnessProof[];
	ownRelations: { index: number; relation: LocalStoryFlowContextRelation }[];
	ownIssues: { index: number; issue: LocalStoryFlowContextIssue }[];
	nodeHash: string;
};
export type BoundLocalStoryFlowContextNode = Readonly<{
	kind: "local-story-flow-context-node-handle-v1";
}>;
const nodes = new WeakMap<
	BoundLocalStoryFlowContextNode,
	LocalStoryFlowContextNodeEvidence
>();
function nodeState(node: BoundLocalStoryFlowContextNode) {
	const value = nodes.get(node);
	requireContext(value);
	return value;
}
export function localStoryFlowContextNodeEvidence(
	node: BoundLocalStoryFlowContextNode,
): LocalStoryFlowContextNodeEvidence {
	return structuredClone(nodeState(node));
}
type NodeInputOptions = {
	source: PreparedLocalStoryFlowContextSource;
	nodeId: string;
	children: readonly BoundLocalStoryFlowContextNode[];
};
const bytes = (value: unknown) =>
	new TextEncoder().encode(canonicalEditingJson(value)).byteLength;
function nodeInputs(options: NodeInputOptions) {
	const source = sourceState(options.source),
		plan = source.layout.nodes.find((n) => n.nodeId === options.nodeId);
	requireContext(plan);
	const children = options.children.map(nodeState);
	if (plan.phase === "LEAF") requireContext(children.length === 0);
	else {
		requireContext(children.length === 2);
		for (const [i, child] of children.entries())
			requireContext(
				child.sourceBindingHash === source.sourceBindingHash &&
					child.nodeId === plan.children[i],
				"LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH",
			);
	}
	return { source, plan, children };
}
export function localStoryFlowContextInputForNode(
	options: NodeInputOptions,
): LocalStoryFlowContextInput {
	const { source, plan, children } = nodeInputs(options);
	let data: LocalStoryFlowContextInput["data"],
		orderedInputProofs: LocalStoryFlowContextInput["orderedInputProofs"];
	if (plan.phase === "LEAF") {
		const page = source.pages[plan.pageFrom];
		requireContext(page && page.pageId === plan.pageId);
		data = structuredClone(page.data);
		orderedInputProofs = [
			{ pageId: page.pageId, pageHash: page.pageHash, dataHash: page.dataHash },
		];
	} else {
		data = {
			children: children.map((child) => structuredClone(child.publicView)),
		};
		orderedInputProofs = children.map(
			({ nodeId, nodeHash, publicViewHash }) => ({
				nodeId,
				nodeHash,
				publicViewHash,
			}),
		);
	}
	const dataUtf8Bytes = bytes(data);
	requireContext(dataUtf8Bytes <= 4096);
	const body = {
		version: "local-story-flow-context-input-v1" as const,
		stage: "LOCAL_FLOW_CONTEXT_V1" as const,
		phase: plan.phase,
		nodeId: plan.nodeId,
		sourceBinding: structuredClone(source.sourceBinding),
		sourceBindingHash: source.sourceBindingHash,
		orderedInputProofs,
		data,
		dataHash: hash(data),
		dataUtf8Bytes,
	};
	return { ...body, inputHash: hash(body) };
}
function globalRef(ref: RawRef, nodeId: string): GlobalRef {
	if (ref.kind === "OWN_CLAIM")
		return { kind: "CLAIM", nodeId, claimId: ref.claimId };
	if (ref.kind === "OWN_WITNESS")
		return {
			kind: "WITNESS",
			nodeId,
			claimId: ref.claimId,
			witnessId: ref.witnessId,
		};
	return structuredClone(ref);
}
function globalRelation(
	raw: LocalStoryFlowContextOutput["relations"][number],
	nodeId: string,
): LocalStoryFlowContextRelation {
	const from = globalRef(raw.from, nodeId),
		target = globalRef(raw.target, nodeId);
	if (raw.kind === "CONTRADICTS") {
		requireContext(from.kind === "CLAIM" && target.kind === "CLAIM");
		return { kind: "CONTRADICTS", from, target };
	}
	requireContext(
		(from.kind === "EVENT" ||
			from.kind === "CLAIM" ||
			from.kind === "WITNESS") &&
			(target.kind === "EVENT" || target.kind === "CLAIM"),
	);
	return { kind: "REQUIRES", from, target };
}
function parseOutput(value: unknown): LocalStoryFlowContextOutput {
	try {
		const result = localStoryFlowContextOutputSchema.safeParse(value);
		requireContext(result.success && same(value, result.data));
		return result.data;
	} catch {
		throw new LocalStoryFlowContextError("LOCAL_STORY_FLOW_CONTEXT_INVALID");
	}
}
function makeWitness(
	source: SourceEvidence,
	children: LocalStoryFlowContextNodeEvidence[],
	nodeId: string,
	claim: LocalStoryFlowContextOutput["claims"][number],
	witness: LocalStoryFlowContextOutput["claims"][number]["witnesses"][number],
): LocalStoryFlowWitnessProof {
	const ids = new Set<string>();
	for (const atom of witness.allOf) {
		if (atom.kind === "EVENT") {
			requireContext(
				claim.supports.some(
					(s) => s.kind === "EVENT" && s.eventId === atom.eventId,
				),
			);
			ids.add(atom.eventId);
		} else {
			requireContext(
				claim.supports.some(
					(s) =>
						s.kind === "CLAIM" &&
						s.nodeId === atom.nodeId &&
						s.claimId === atom.claimId,
				),
			);
			const child = children.find((c) => c.nodeId === atom.nodeId);
			const proof = child?.witnessProofs.find((w) => same(w.ref, atom));
			requireContext(proof);
			for (const event of proof.events) ids.add(event.ref.eventId);
		}
	}
	const events: LocalStoryFlowWitnessProof["events"] =
		source.manifest.items.flatMap((item) => {
			if (item.kind !== "GROUNDED_LEAF_EVENT_CARD" || !ids.has(item.id))
				return [];
			const original = source.manifest.corpus.events.find(
				(e) => e.id === item.id,
			);
			requireContext(original && hash(original) === item.eventHash);
			requireContext(
				item.minimumFrames === null ||
					(Number.isSafeInteger(item.minimumFrames) && item.minimumFrames > 0),
			);
			return [
				{
					ref: { kind: "EVENT" as const, eventId: item.id },
					eventHash: item.eventHash,
					sourceOrder: item.sourceOrder,
					role: item.role,
					minimumFrames: item.minimumFrames,
				},
			];
		});
	requireContext(
		events.length === ids.size && events.length > 0 && events.length <= 768,
	);
	const unavailableReasons: LocalStoryFlowWitnessProof["unavailableReasons"] =
		[];
	const unknown = events.some((e) => e.minimumFrames === null);
	if (unknown) unavailableReasons.push("EVENT_MINIMUM_UNAVAILABLE");
	if (
		events.length > LOCAL_STORY_FLOW_CONTEXT_POLICY.legacyAlternativeMaxEvents
	)
		unavailableReasons.push("EVENT_COUNT_EXCEEDS_LEGACY_BEATS");
	return {
		ref: { kind: "WITNESS", nodeId, claimId: claim.id, witnessId: witness.id },
		allOf: structuredClone(witness.allOf),
		events,
		eligibility: {
			availability: unavailableReasons.length
				? "UNAVAILABLE"
				: "JOINT_UNVERIFIED",
			eventCount: events.length,
			minimumFramesLowerBound: unknown
				? null
				: Math.max(...events.map((e) => e.minimumFrames ?? 0)),
		},
		unavailableReasons,
	};
}
/** Binds complete source input to a structural output; it does not certify native admission. */
export function buildLocalStoryFlowContextNode(
	options: NodeInputOptions & { output: unknown },
): BoundLocalStoryFlowContextNode {
	const { source, plan, children } = nodeInputs(options),
		input = localStoryFlowContextInputForNode(options);
	const rawOutput = parseOutput(options.output);
	requireContext(
		rawOutput.phase === plan.phase && rawOutput.nodeId === plan.nodeId,
	);
	let expected: ItemRef[] | ChildRef[];
	if (plan.phase === "LEAF") {
		const page = source.pages[plan.pageFrom];
		requireContext(
			page && rawOutput.phase === "LEAF" && rawOutput.pageId === plan.pageId,
		);
		expected = page.data.items.map((item) =>
			item.kind === "DERIVED_CHUNK_SUMMARY"
				? { kind: "SUMMARY" as const, summaryId: item.id }
				: { kind: "EVENT" as const, eventId: item.id },
		);
		requireContext(same(rawOutput.accountedItems, expected));
	} else {
		requireContext(rawOutput.phase === "MERGE");
		expected = plan.children.map((nodeId) => ({
			kind: "CHILD_NODE" as const,
			nodeId,
		}));
		requireContext(same(rawOutput.accountedChildren, expected));
	}
	const visible = (ref: RawRef): boolean => {
		if (ref.kind === "OWN_CLAIM" || ref.kind === "OWN_WITNESS") return true; // H1a checks existence in this output.
		if (ref.kind === "EVENT" || ref.kind === "SUMMARY")
			return plan.phase === "LEAF" && expected.some((e) => same(e, ref));
		if (plan.phase !== "MERGE") return false;
		const child = children.find((c) => c.nodeId === ref.nodeId);
		if (!child) return false;
		if (ref.kind === "CHILD_NODE") return true;
		return ref.kind === "CLAIM"
			? child.claimRefs.some((c) => same(c, ref))
			: child.witnessProofs.some((w) => same(w.ref, ref));
	};
	for (const claim of rawOutput.claims) {
		for (const ref of claim.supports) requireContext(visible(ref));
		for (const witness of claim.witnesses)
			for (const ref of witness.allOf) requireContext(visible(ref));
	}
	for (const relation of rawOutput.relations)
		requireContext(visible(relation.from) && visible(relation.target));
	for (const issue of rawOutput.unresolved) requireContext(visible(issue.ref));
	const claimRefs: LocalStoryFlowClaimRef[] = rawOutput.claims.map((claim) => ({
		kind: "CLAIM",
		nodeId: plan.nodeId,
		claimId: claim.id,
	}));
	const witnessProofs = rawOutput.claims.flatMap((claim) =>
		claim.witnesses.map((w) =>
			makeWitness(source, children, plan.nodeId, claim, w),
		),
	);
	const ownRelations = rawOutput.relations.map((relation, index) => ({
		index,
		relation: globalRelation(relation, plan.nodeId),
	}));
	const ownIssues = rawOutput.unresolved.map((issue, index) => ({
		index,
		issue: { ref: globalRef(issue.ref, plan.nodeId), reason: issue.reason },
	}));
	const publicView: LocalStoryFlowContextPublicView = {
		version: "local-story-flow-context-public-view-v1",
		nodeId: plan.nodeId,
		claims: rawOutput.claims.map((claim) => ({
			id: claim.id,
			text: claim.text,
			supports: structuredClone(claim.supports),
			witnesses: claim.witnesses.map((w) => {
				const proof = witnessProofs.find(
					(p) => p.ref.claimId === claim.id && p.ref.witnessId === w.id,
				);
				requireContext(proof);
				return {
					id: w.id,
					allOf: structuredClone(w.allOf),
					eligibility: structuredClone(proof.eligibility),
				};
			}),
		})),
		relations: structuredClone(ownRelations.map((r) => r.relation)),
		unresolved: structuredClone(ownIssues.map((r) => r.issue)),
	};
	const publicViewUtf8Bytes = bytes(publicView);
	requireContext(
		publicViewUtf8Bytes <= LOCAL_STORY_FLOW_CONTEXT_POLICY.publicViewUtf8Bytes,
		"LOCAL_STORY_FLOW_CONTEXT_PUBLIC_VIEW_LIMIT",
	);
	const body = {
		version: "local-story-flow-context-node-v1" as const,
		sourceBinding: structuredClone(source.sourceBinding),
		sourceBindingHash: source.sourceBindingHash,
		nodeId: plan.nodeId,
		phase: plan.phase,
		plan: structuredClone(plan),
		input,
		inputHash: input.inputHash,
		rawOutput,
		rawOutputHash: hash(rawOutput),
		publicView,
		publicViewHash: hash(publicView),
		publicViewUtf8Bytes,
		claimRefs,
		witnessProofs,
		ownRelations,
		ownIssues,
	};
	const handle = Object.freeze({
		kind: "local-story-flow-context-node-handle-v1" as const,
	});
	nodes.set(handle, freeze(structuredClone({ ...body, nodeHash: hash(body) })));
	return handle;
}
export function validateLocalStoryFlowContextNode(
	value: unknown,
	options: NodeInputOptions & { expectedOutput: unknown },
): BoundLocalStoryFlowContextNode {
	const expected = buildLocalStoryFlowContextNode({
		...options,
		output: options.expectedOutput,
	});
	try {
		requireContext(
			same(value, nodeState(expected)) &&
				canonicalEditingJson(value) ===
					canonicalEditingJson(nodeState(expected)),
		);
	} catch {
		throw new LocalStoryFlowContextError("LOCAL_STORY_FLOW_CONTEXT_INVALID");
	}
	return expected;
}
