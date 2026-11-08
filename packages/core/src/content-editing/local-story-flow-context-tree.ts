import { canonicalEditingJson } from "./automatic-binding";
import {
	type BoundLocalStoryFlowContextNode,
	buildLocalStoryFlowContextNode,
	LocalStoryFlowContextError,
	type LocalStoryFlowContextIssue,
	type LocalStoryFlowContextLayout,
	type LocalStoryFlowContextNodeEvidence,
	type LocalStoryFlowContextRelation,
	type LocalStoryFlowContextSourceBinding,
	type LocalStoryFlowEventRef,
	type LocalStoryFlowSummaryRef,
	type LocalStoryFlowWitnessProof,
	localStoryFlowContextInputForNode,
	localStoryFlowContextNodeEvidence,
	localStoryFlowContextSourceEvidence,
	type PreparedLocalStoryFlowContextSource,
} from "./local-story-flow-context";
import type {
	LocalStoryFlowClaimRef,
	LocalStoryFlowWitnessRef,
} from "./local-story-flow-contracts";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export type LocalStoryFlowContextGraph = {
	claims: {
		ref: LocalStoryFlowClaimRef;
		nodeHash: string;
		text: string;
		supports: (
			| LocalStoryFlowSummaryRef
			| LocalStoryFlowEventRef
			| LocalStoryFlowClaimRef
		)[];
		witnessRefs: LocalStoryFlowWitnessRef[];
	}[];
	witnesses: (LocalStoryFlowWitnessProof & { nodeHash: string })[];
	relations: {
		ownerNodeId: string;
		index: number;
		relation: LocalStoryFlowContextRelation;
	}[];
	unresolved: {
		ownerNodeId: string;
		index: number;
		issue: LocalStoryFlowContextIssue;
	}[];
};
export type LocalStoryFlowContextTreeEvidence = {
	version: "local-story-flow-context-tree-v1";
	sourceBinding: LocalStoryFlowContextSourceBinding;
	sourceBindingHash: string;
	layout: LocalStoryFlowContextLayout;
	rootNodeId: string;
	nodes: LocalStoryFlowContextNodeEvidence[];
	graph: LocalStoryFlowContextGraph;
	coverage: {
		pages: number;
		leafNodes: number;
		internalNodes: number;
		nodes: number;
		maxEdgeDepth: number;
		accountedItems: number;
		complete: true;
	};
	treeHash: string;
};
export type BoundLocalStoryFlowContextTree = Readonly<{
	kind: "local-story-flow-context-tree-handle-v1";
}>;
const trees = new WeakMap<
	BoundLocalStoryFlowContextTree,
	LocalStoryFlowContextTreeEvidence
>();
function requireTree(value: unknown): asserts value {
	if (!value)
		throw new LocalStoryFlowContextError(
			"LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID",
		);
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
export function localStoryFlowContextTreeEvidence(
	tree: BoundLocalStoryFlowContextTree,
	source: PreparedLocalStoryFlowContextSource,
): LocalStoryFlowContextTreeEvidence {
	const state = trees.get(tree);
	requireTree(state);
	if (
		state.sourceBindingHash !==
		localStoryFlowContextSourceEvidence(source).sourceBindingHash
	)
		throw new LocalStoryFlowContextError(
			"LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH",
		);
	return structuredClone(state);
}
/** Every node and child origin is retained. This does not establish ROOT, scope or native admission. */
export function buildLocalStoryFlowContextTree(options: {
	source: PreparedLocalStoryFlowContextSource;
	nodes: readonly BoundLocalStoryFlowContextNode[];
}): BoundLocalStoryFlowContextTree {
	const source = localStoryFlowContextSourceEvidence(options.source),
		layout = source.layout;
	requireTree(options.nodes.length === layout.nodes.length);
	const nodes = options.nodes.map(localStoryFlowContextNodeEvidence);
	const byId = new Map(
		layout.nodes.map((plan, index) => [plan.nodeId, options.nodes[index]]),
	);
	const accounted: (LocalStoryFlowSummaryRef | LocalStoryFlowEventRef)[] = [];
	for (const [index, node] of nodes.entries()) {
		const plan = layout.nodes[index];
		requireTree(plan);
		requireTree(
			node.nodeId === plan.nodeId &&
				same(node.plan, plan) &&
				node.sourceBindingHash === source.sourceBindingHash,
		);
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const child = byId.get(id);
						requireTree(child);
						return child;
					});
		const input = localStoryFlowContextInputForNode({
			source: options.source,
			nodeId: plan.nodeId,
			children,
		});
		requireTree(same(node.input, input) && node.inputHash === input.inputHash);
		if (node.rawOutput.phase === "LEAF")
			accounted.push(...node.rawOutput.accountedItems);
	}
	const expectedItems = source.manifest.items.map((item) =>
		item.kind === "DERIVED_CHUNK_SUMMARY"
			? { kind: "SUMMARY" as const, summaryId: item.id }
			: { kind: "EVENT" as const, eventId: item.id },
	);
	requireTree(same(accounted, expectedItems));
	const graph: LocalStoryFlowContextGraph = {
		claims: [],
		witnesses: [],
		relations: [],
		unresolved: [],
	};
	for (const node of nodes) {
		for (const [index, claim] of node.rawOutput.claims.entries()) {
			const ref = node.claimRefs[index];
			requireTree(ref);
			graph.claims.push({
				ref: structuredClone(ref),
				nodeHash: node.nodeHash,
				text: claim.text,
				supports: structuredClone(claim.supports),
				witnessRefs: node.witnessProofs
					.filter((w) => w.ref.claimId === claim.id)
					.map((w) => structuredClone(w.ref)),
			});
		}
		for (const proof of node.witnessProofs)
			graph.witnesses.push({
				...structuredClone(proof),
				nodeHash: node.nodeHash,
			});
		for (const record of node.ownRelations)
			graph.relations.push({
				ownerNodeId: node.nodeId,
				index: record.index,
				relation: structuredClone(record.relation),
			});
		for (const record of node.ownIssues)
			graph.unresolved.push({
				ownerNodeId: node.nodeId,
				index: record.index,
				issue: structuredClone(record.issue),
			});
	}
	requireTree(
		graph.claims.length <= 252 &&
			graph.witnesses.length <= 756 &&
			graph.relations.length <= 1008 &&
			graph.unresolved.length <= 2016,
	);
	const pages = source.pages.length;
	const body = {
		version: "local-story-flow-context-tree-v1" as const,
		sourceBinding: structuredClone(source.sourceBinding),
		sourceBindingHash: source.sourceBindingHash,
		layout: structuredClone(layout),
		rootNodeId: layout.rootNodeId,
		nodes,
		graph,
		coverage: {
			pages,
			leafNodes: pages,
			internalNodes: pages - 1,
			nodes: nodes.length,
			maxEdgeDepth: Math.max(...layout.nodes.map((n) => n.edgeDepth)),
			accountedItems: accounted.length,
			complete: true as const,
		},
	};
	const handle = Object.freeze({
		kind: "local-story-flow-context-tree-handle-v1" as const,
	});
	trees.set(handle, freeze(structuredClone({ ...body, treeHash: hash(body) })));
	return handle;
}
export function validateLocalStoryFlowContextTree(
	value: unknown,
	options: {
		source: PreparedLocalStoryFlowContextSource;
		expectedOutputs: readonly { nodeId: string; output: unknown }[];
	},
): BoundLocalStoryFlowContextTree {
	const source = localStoryFlowContextSourceEvidence(options.source);
	requireTree(options.expectedOutputs.length === source.layout.nodes.length);
	const nodes: BoundLocalStoryFlowContextNode[] = [],
		byId = new Map<string, BoundLocalStoryFlowContextNode>();
	for (const [index, plan] of source.layout.nodes.entries()) {
		const observation = options.expectedOutputs[index];
		requireTree(observation && observation.nodeId === plan.nodeId);
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const child = byId.get(id);
						requireTree(child);
						return child;
					});
		const node = buildLocalStoryFlowContextNode({
			source: options.source,
			nodeId: plan.nodeId,
			children,
			output: observation.output,
		});
		nodes.push(node);
		byId.set(plan.nodeId, node);
	}
	const tree = buildLocalStoryFlowContextTree({
		source: options.source,
		nodes,
	});
	const expected = localStoryFlowContextTreeEvidence(tree, options.source);
	try {
		requireTree(
			same(value, expected) &&
				canonicalEditingJson(value) === canonicalEditingJson(expected),
		);
	} catch {
		throw new LocalStoryFlowContextError(
			"LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID",
		);
	}
	return tree;
}
