import { canonicalEditingJson } from "./automatic-binding";
import {
	type BoundLocalStoryFlowClosure,
	evaluateLocalStoryFlowClosure,
	extendLocalStoryFlowHardChoice,
	LOCAL_STORY_FLOW_CLOSURE_POLICY,
	type LocalStoryFlowClosureResult,
	type LocalStoryFlowClosureStateEvidence,
	localStoryFlowClosureStateEvidence,
	prepareLocalStoryFlowClosure,
} from "./local-story-flow-closure";
import {
	type LocalStoryFlowContextPublicView,
	type LocalStoryFlowContextRelation,
	localStoryFlowContextSourceEvidence,
	type PreparedLocalStoryFlowContextSource,
	type SourceEvidence,
} from "./local-story-flow-context";
import {
	type BoundLocalStoryFlowContextTree,
	type LocalStoryFlowContextTreeEvidence,
	localStoryFlowContextTreeEvidence,
} from "./local-story-flow-context-tree";
import {
	type LocalStoryFlowClaimRef,
	type LocalStoryFlowRouteOutput,
	type LocalStoryFlowWitnessRef,
	localStoryFlowRouteOutputSchema,
} from "./local-story-flow-contracts";
import type { LocalStoryFlowLeafPage } from "./local-story-flow-manifest";
import { localStoryFlowStageRegistry } from "./local-story-flow-stages";
import { MAX_EDIT_DURATION_FRAMES } from "./schema";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_ROUTE_POLICY = Object.freeze({
	version: "local-story-flow-route-policy-v1",
	inputVersion: "local-story-flow-route-input-v1",
	controlVersion: "local-story-flow-route-control-v1",
	rootSelectionPolicy: "source-grounded-flow-goal-v1",
	rootRule: "pre-choice-owned-full-tree-v1",
	continuationRule: "previous-owned-step-v1",
	seedRule: "leaf-candidate-union-no-removal-v1",
	hardChoiceRule: "pending-only-immutable-whole-witness-v1",
	navigationRule: "latest-branch-required-path-v1",
	exposureRule: "accepted-whole-leaf-data-v1",
	unresolvedRule: "retained-stop-followup-v1",
	finalizeRule: "full-root-cards-conditional-requires-and-commitments-v1",
	maxDataUtf8Bytes: 4096,
	maxControlUtf8Bytes: 480,
});
export type LocalStoryFlowRouteErrorCode =
	| "LOCAL_STORY_FLOW_ROUTE_INVALID"
	| "LOCAL_STORY_FLOW_ROUTE_DURATION_INVALID"
	| "LOCAL_STORY_FLOW_ROUTE_NOT_READY"
	| "LOCAL_STORY_FLOW_ROUTE_DATA_LIMIT"
	| "LOCAL_STORY_FLOW_ROUTE_CONTROL_LIMIT"
	| "LOCAL_STORY_FLOW_ROUTE_EXPOSURE_INCOMPLETE"
	| "LOCAL_STORY_FLOW_ROUTE_SEED_LIMIT";
export class LocalStoryFlowRouteError extends Error {
	constructor(readonly code: LocalStoryFlowRouteErrorCode) {
		super(code);
		this.name = "LocalStoryFlowRouteError";
	}
}
function requireRoute(
	value: unknown,
	code: LocalStoryFlowRouteErrorCode = "LOCAL_STORY_FLOW_ROUTE_INVALID",
): asserts value {
	if (!value) throw new LocalStoryFlowRouteError(code);
}
function plain<T>(value: T, fields: string[]): T & Record<string, unknown> {
	try {
		requireRoute(
			value !== null &&
				typeof value === "object" &&
				Object.getPrototypeOf(value) === Object.prototype &&
				!Array.isArray(value),
		);
		const d = Object.getOwnPropertyDescriptors(value);
		requireRoute(
			Object.getOwnPropertySymbols(value).length === 0 &&
				Object.keys(d).length === fields.length &&
				fields.every((k) => Object.hasOwn(d, k)),
		);
		for (const p of Object.values(d))
			requireRoute("value" in p && p.enumerable && p.value !== undefined);
		return Object.fromEntries(
			Object.entries(d).map(([k, p]) => [k, p.value]),
		) as T & Record<string, unknown>;
	} catch {
		throw new LocalStoryFlowRouteError("LOCAL_STORY_FLOW_ROUTE_INVALID");
	}
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
type EventRef = { kind: "EVENT"; eventId: string };
type Origin = { ownerNodeId: string; index: number };
type Phase = LocalStoryFlowRouteOutput["phase"];
type RootOptions = {
	phase: "ROOT";
	source: PreparedLocalStoryFlowContextSource;
	tree: BoundLocalStoryFlowContextTree;
	targetFrames: number;
};
type Options =
	| RootOptions
	| {
			phase: "WITNESS" | "FINALIZE";
			previousStep: BoundLocalStoryFlowRouteStep;
	  }
	| {
			phase: "BRANCH" | "LEAF";
			previousStep: BoundLocalStoryFlowRouteStep;
			nodeId: string;
	  };
type NodeProof = {
	kind: "CONTEXT_NODE";
	nodeId: string;
	nodeHash: string;
	publicViewHash: string;
};
type InputProof =
	| NodeProof
	| {
			kind: "LEAF_PAGE";
			nodeId: string;
			pageId: string;
			pageHash: string;
			dataHash: string;
	  }
	| { kind: "EVENT"; eventId: string; eventHash: string }
	| { kind: "CONSTRAINTS"; constraintsHash: string };
type FollowupBinding = {
	kind: "FOLLOWUP";
	structuralRootStepHash: string;
	closureStateHash: string;
	seedsHash: string;
	pending?: { origin: Origin; requestedClaim: LocalStoryFlowClaimRef };
};
type Control = {
	version: "local-story-flow-route-control-v1";
	mode: "FLOW";
	targetFrames: number;
	nodeId: string;
} & (
	| { phase: "ROOT" }
	| {
			phase: "WITNESS";
			goalText: string;
			requestedClaim: LocalStoryFlowClaimRef;
	  }
	| {
			phase: "BRANCH";
			goalText: string;
			requiredChildren: { kind: "CHILD_NODE"; nodeId: string }[];
	  }
	| { phase: "LEAF"; goalText: string; requiredEvents: EventRef[] }
	| { phase: "FINALIZE"; goalText: string }
);
type EventCard = Extract<
	LocalStoryFlowLeafPage["data"]["items"][number],
	{ kind: "GROUNDED_LEAF_EVENT_CARD" }
>;
type FinalizeData = {
	root: LocalStoryFlowContextPublicView;
	events: EventCard[];
	constraints: {
		claims: { ref: LocalStoryFlowClaimRef; text: string }[];
		commitments: {
			choice:
				| LocalStoryFlowClosureStateEvidence["rootChoice"]
				| LocalStoryFlowClosureStateEvidence["hardChoices"][number]["choice"];
			claimText: string;
			events: EventRef[];
		}[];
		requires: {
			origin: Origin;
			relation: Extract<LocalStoryFlowContextRelation, { kind: "REQUIRES" }>;
			guardEvents: EventRef[];
			prerequisites: EventRef[];
		}[];
	};
};
type TraversalRow = {
	parentNodeId: string;
	childNodeId: string;
	branchObservationHash: string;
	rawDisposition: "DESCEND" | "CONTEXT_ONLY";
	effectiveDisposition: "DESCEND";
	force: null | {
		requiredEvents: EventRef[];
		rootEvents: EventRef[];
		seedEvents: EventRef[];
		hard: { origin: Origin; events: EventRef[] }[];
	};
};
type Navigation = {
	version: "local-story-flow-route-navigation-v1";
	sourceBindingHash: string;
	treeHash: string;
	branches: {
		nodeId: string;
		observationHash: string;
		dispositions: Extract<
			LocalStoryFlowRouteOutput,
			{ phase: "BRANCH" }
		>["dispositions"];
	}[];
	exposedPages: {
		nodeId: string;
		pageId: string;
		pageHash: string;
		dataHash: string;
		observationHash: string;
	}[];
	navigationHash: string;
};
export type BoundLocalStoryFlowRouteExpectation = Readonly<object>;
export type LocalStoryFlowRouteInput = {
	version: "local-story-flow-route-input-v1";
	mode: "FLOW";
	phase: Phase;
	nodeId: string;
	stage: {
		name: "LOCAL_FLOW_ROUTE_V1";
		promptVersion: string;
		schemaHash: string;
		maxOutputTokens: number;
	};
	sourceBindingHash: string;
	treeHash: string;
	workflowIdentityHash: string;
	closurePolicyHash: string;
	policyHash: string;
	targetFrames: number;
	orderedInputProofs: InputProof[];
	data:
		| LocalStoryFlowContextPublicView
		| { children: LocalStoryFlowContextPublicView[] }
		| LocalStoryFlowLeafPage["data"]
		| FinalizeData;
	control: Control;
	dataHash: string;
	controlHash: string;
	dataUtf8Bytes: number;
	controlUtf8Bytes: number;
	binding:
		| {
				kind: "PRE_ROOT";
				rootSelectionPolicy: typeof LOCAL_STORY_FLOW_ROUTE_POLICY.rootSelectionPolicy;
		  }
		| FollowupBinding;
	inputHash: string;
};
export type LocalStoryFlowRouteExpectationEvidence = {
	version: "local-story-flow-route-expectation-v1";
	input: LocalStoryFlowRouteInput;
	continuation:
		| { kind: "ROOT_START" }
		| {
				kind: "AFTER_STEP";
				previousStepHash: string;
				navigationHash: string;
				traversal: TraversalRow[];
		  };
	expectationHash: string;
};
type ExpectationState = {
	source: RootOptions["source"];
	tree: RootOptions["tree"];
	fullSource: SourceEvidence;
	fullTree: LocalStoryFlowContextTreeEvidence;
	evidence: LocalStoryFlowRouteExpectationEvidence;
	previous?: StepState;
};
const expectations = new WeakMap<
	BoundLocalStoryFlowRouteExpectation,
	ExpectationState
>();
type Base = Pick<
	ExpectationState,
	"source" | "tree" | "fullSource" | "fullTree"
>;
function nodeProof(
	node: LocalStoryFlowContextTreeEvidence["nodes"][number],
): NodeProof {
	return {
		kind: "CONTEXT_NODE",
		nodeId: node.nodeId,
		nodeHash: node.nodeHash,
		publicViewHash: node.publicViewHash,
	};
}
function publishExpectation(
	base: Base,
	parts: Pick<
		LocalStoryFlowRouteInput,
		| "phase"
		| "nodeId"
		| "targetFrames"
		| "data"
		| "control"
		| "orderedInputProofs"
		| "binding"
	>,
	continuation: LocalStoryFlowRouteExpectationEvidence["continuation"],
	previous?: StepState,
) {
	const { promptVersion, schemaHash, maxOutputTokens } =
		localStoryFlowStageRegistry().stages.LOCAL_FLOW_ROUTE_V1;
	const dataUtf8Bytes = new TextEncoder().encode(
			canonicalEditingJson(parts.data),
		).byteLength,
		controlUtf8Bytes = new TextEncoder().encode(
			canonicalEditingJson(parts.control),
		).byteLength;
	requireRoute(
		dataUtf8Bytes <= LOCAL_STORY_FLOW_ROUTE_POLICY.maxDataUtf8Bytes,
		"LOCAL_STORY_FLOW_ROUTE_DATA_LIMIT",
	);
	requireRoute(
		controlUtf8Bytes <= LOCAL_STORY_FLOW_ROUTE_POLICY.maxControlUtf8Bytes,
		"LOCAL_STORY_FLOW_ROUTE_CONTROL_LIMIT",
	);
	const body = {
		version: "local-story-flow-route-input-v1" as const,
		mode: "FLOW" as const,
		...parts,
		stage: {
			name: "LOCAL_FLOW_ROUTE_V1" as const,
			promptVersion,
			schemaHash,
			maxOutputTokens,
		},
		sourceBindingHash: base.fullSource.sourceBindingHash,
		treeHash: base.fullTree.treeHash,
		workflowIdentityHash: base.fullSource.sourceBinding.workflowIdentityHash,
		closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		policyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
		dataHash: hash(parts.data),
		controlHash: hash(parts.control),
		dataUtf8Bytes,
		controlUtf8Bytes,
	};
	const evidenceBody = {
		version: "local-story-flow-route-expectation-v1" as const,
		input: { ...body, inputHash: hash(body) },
		continuation,
	};
	const evidence = freeze(
			structuredClone({ ...evidenceBody, expectationHash: hash(evidenceBody) }),
		),
		handle = Object.freeze({});
	expectations.set(handle, {
		source: base.source,
		tree: base.tree,
		fullSource: base.fullSource,
		fullTree: base.fullTree,
		evidence,
		previous,
	});
	return handle;
}
const same = (a: unknown, b: unknown) =>
	canonicalEditingJson(a) === canonicalEditingJson(b);
function equalData(value: unknown, expected: unknown): boolean {
	if (value === null || typeof value !== "object")
		return Object.is(value, expected);
	if (
		expected === null ||
		typeof expected !== "object" ||
		Array.isArray(value) !== Array.isArray(expected)
	)
		return false;
	const keys = Object.keys(value).sort(),
		other = Object.keys(expected).sort();
	return (
		keys.length === other.length &&
		keys.every(
			(k, i) =>
				k === other[i] &&
				equalData(Reflect.get(value, k), Reflect.get(expected, k)),
		)
	);
}
function guardEvents(
	tree: LocalStoryFlowContextTreeEvidence,
	source: SourceEvidence,
	ref: EventRef | LocalStoryFlowClaimRef | LocalStoryFlowWitnessRef,
): EventRef[] {
	let ids: string[];
	if (ref.kind === "EVENT") ids = [ref.eventId];
	else if (ref.kind === "WITNESS") {
		const w = tree.graph.witnesses.find((w) => same(w.ref, ref));
		requireRoute(w);
		ids = w.events.map((e) => e.ref.eventId);
	} else {
		const c = tree.graph.claims.find((c) => same(c.ref, ref));
		requireRoute(c);
		ids = c.witnessRefs.flatMap((r) => {
			const w = tree.graph.witnesses.find((w) => same(w.ref, r));
			requireRoute(w);
			return w.events.map((e) => e.ref.eventId);
		});
	}
	const set = new Set(ids);
	return source.manifest.items.flatMap((i) =>
		i.kind === "GROUNDED_LEAF_EVENT_CARD" && set.has(i.id)
			? [{ kind: "EVENT" as const, eventId: i.id }]
			: [],
	);
}
function finalizeParts(previous: StepState): {
	data: FinalizeData;
	orderedInputProofs: InputProof[];
} {
	const { fullSource: source, fullTree: tree } = previous,
		after = previous.evidenceStep.after;
	requireRoute(
		after.knownRequiredExposureGaps.length === 0,
		"LOCAL_STORY_FLOW_ROUTE_EXPOSURE_INCOMPLETE",
	);
	const root = tree.nodes.find((n) => n.nodeId === tree.rootNodeId);
	requireRoute(root);
	const refs = after.closureResult.requiredEvents.map((e) => e.ref),
		ids = new Set(refs.map((r) => r.eventId));
	const events = source.pages.flatMap((p) =>
		p.data.items.flatMap((i) =>
			i.kind === "GROUNDED_LEAF_EVENT_CARD" && ids.has(i.id) ? [i] : [],
		),
	);
	requireRoute(events.length === refs.length && refs.length <= 32);
	const commitments: FinalizeData["constraints"]["commitments"] = [
		{
			choice: after.closure.rootChoice,
			claimText: after.closure.rootGoalText,
			events: after.closure.rootEvents.map((e) => e.ref),
		},
	];
	for (const ref of after.closureResult.usedHardClaims) {
		const h = after.closure.hardChoices.find((c) => same(c.choice.claim, ref)),
			c = tree.graph.claims.find((c) => same(c.ref, ref));
		requireRoute(h && c);
		commitments.push({
			choice: h.choice,
			claimText: c.text,
			events: h.events.map((e) => e.ref),
		});
	}
	const requires = after.closureResult.firedRequires.map((origin) => {
		const row = tree.graph.relations.find(
				(r) => r.ownerNodeId === origin.ownerNodeId && r.index === origin.index,
			),
			resolved = after.closureResult.resolvedRequires.find((r) =>
				same(r.origin, origin),
			);
		requireRoute(row?.relation.kind === "REQUIRES" && resolved);
		return {
			origin,
			relation: row.relation,
			guardEvents: guardEvents(tree, source, row.relation.from),
			prerequisites: resolved.events,
		};
	});
	const needed = new Set(
		commitments.map((c) => canonicalEditingJson(c.choice.claim)),
	);
	for (const r of requires)
		for (const ref of [r.relation.from, r.relation.target]) {
			if (ref.kind === "CLAIM") needed.add(canonicalEditingJson(ref));
			else if (ref.kind === "WITNESS")
				needed.add(
					canonicalEditingJson({
						kind: "CLAIM",
						nodeId: ref.nodeId,
						claimId: ref.claimId,
					}),
				);
		}
	const constraints = {
		claims: tree.graph.claims
			.filter((c) => needed.has(canonicalEditingJson(c.ref)))
			.map((c) => ({ ref: c.ref, text: c.text })),
		commitments,
		requires,
	};
	return {
		data: { root: root.publicView, events, constraints },
		orderedInputProofs: [
			nodeProof(root),
			...after.closureResult.requiredEvents.map((e) => ({
				kind: "EVENT" as const,
				eventId: e.ref.eventId,
				eventHash: e.eventHash,
			})),
			{ kind: "CONSTRAINTS", constraintsHash: hash(constraints) },
		],
	};
}
function subtreeEvents(
	source: SourceEvidence,
	nodeId: string,
	refs: EventRef[],
): EventRef[] {
	const node = source.layout.nodes.find((n) => n.nodeId === nodeId);
	requireRoute(node);
	const ids = new Set(
		source.pages
			.slice(node.pageFrom, node.pageToExclusive)
			.flatMap((p) =>
				p.data.items
					.filter((i) => i.kind === "GROUNDED_LEAF_EVENT_CARD")
					.map((i) => i.id),
			),
	);
	return refs.filter((r) => ids.has(r.eventId));
}
function traversalTo(previous: StepState, nodeId: string): TraversalRow[] {
	const source = previous.fullSource,
		after = previous.evidenceStep.after;
	requireRoute(source.layout.nodes.some((n) => n.nodeId === nodeId));
	const path: { parentNodeId: string; childNodeId: string }[] = [];
	let childNodeId = nodeId;
	while (childNodeId !== source.layout.rootNodeId) {
		const parent = source.layout.nodes.find(
			(n) => n.phase === "MERGE" && n.children.includes(childNodeId),
		);
		requireRoute(parent && path.length < 5);
		path.unshift({ parentNodeId: parent.nodeId, childNodeId });
		childNodeId = parent.nodeId;
	}
	return path.map(({ parentNodeId, childNodeId }) => {
		const branch = after.navigation.branches.find(
				(b) => b.nodeId === parentNodeId,
			),
			disposition = branch?.dispositions.find(
				(d) => d.child.nodeId === childNodeId,
			);
		requireRoute(branch && disposition);
		let force: TraversalRow["force"] = null;
		if (disposition.disposition === "CONTEXT_ONLY") {
			const requiredEvents = subtreeEvents(
				source,
				childNodeId,
				after.closureResult.requiredEvents.map((e) => e.ref),
			);
			requireRoute(requiredEvents.length > 0);
			force = {
				requiredEvents,
				rootEvents: subtreeEvents(
					source,
					childNodeId,
					after.closure.rootEvents.map((e) => e.ref),
				),
				seedEvents: subtreeEvents(source, childNodeId, after.seeds),
				hard: after.closureResult.resolvedRequires.flatMap((r) => {
					const events = subtreeEvents(source, childNodeId, r.events);
					return events.length ? [{ origin: r.origin, events }] : [];
				}),
			};
		}
		return {
			parentNodeId,
			childNodeId,
			branchObservationHash: branch.observationHash,
			rawDisposition: disposition.disposition,
			effectiveDisposition: "DESCEND",
			force,
		};
	});
}
function publicRefs(
	view: LocalStoryFlowContextPublicView,
): (LocalStoryFlowClaimRef | LocalStoryFlowWitnessRef)[] {
	return view.claims.flatMap((c) => [
		{ kind: "CLAIM" as const, nodeId: view.nodeId, claimId: c.id },
		...c.witnesses.map((w) => ({
			kind: "WITNESS" as const,
			nodeId: view.nodeId,
			claimId: c.id,
			witnessId: w.id,
		})),
	]);
}
export function buildLocalStoryFlowRouteExpectation(
	options: Options,
): BoundLocalStoryFlowRouteExpectation {
	let phase: unknown;
	try {
		phase = Object.getOwnPropertyDescriptor(options, "phase")?.value;
	} catch {
		throw new LocalStoryFlowRouteError("LOCAL_STORY_FLOW_ROUTE_INVALID");
	}
	options = plain(
		options,
		phase === "ROOT"
			? ["phase", "source", "tree", "targetFrames"]
			: phase === "BRANCH" || phase === "LEAF"
				? ["phase", "previousStep", "nodeId"]
				: ["phase", "previousStep"],
	);
	requireRoute(
		["ROOT", "WITNESS", "BRANCH", "LEAF", "FINALIZE"].includes(options.phase),
	);
	if (options.phase === "ROOT") {
		requireRoute(
			Number.isSafeInteger(options.targetFrames) &&
				options.targetFrames >= 1 &&
				options.targetFrames <= MAX_EDIT_DURATION_FRAMES,
			"LOCAL_STORY_FLOW_ROUTE_DURATION_INVALID",
		);
		const fullSource = freeze(
				localStoryFlowContextSourceEvidence(options.source),
			),
			fullTree = freeze(
				localStoryFlowContextTreeEvidence(options.tree, options.source),
			);
		const root = fullTree.nodes.find((n) => n.nodeId === fullTree.rootNodeId);
		requireRoute(root);
		const base = {
				source: options.source,
				tree: options.tree,
				fullSource,
				fullTree,
			},
			nodeId = root.nodeId,
			targetFrames = options.targetFrames;
		return publishExpectation(
			base,
			{
				phase: "ROOT",
				nodeId,
				targetFrames,
				data: root.publicView,
				control: {
					version: "local-story-flow-route-control-v1",
					mode: "FLOW",
					phase: "ROOT",
					targetFrames,
					nodeId,
				},
				orderedInputProofs: [nodeProof(root)],
				binding: {
					kind: "PRE_ROOT",
					rootSelectionPolicy:
						LOCAL_STORY_FLOW_ROUTE_POLICY.rootSelectionPolicy,
				},
			},
			{ kind: "ROOT_START" },
		);
	}
	const previous = steps.get(options.previousStep);
	requireRoute(previous);
	const after = previous.evidenceStep.after;
	requireRoute(
		previous.evidenceStep.phase !== "FINALIZE" &&
			previous.evidenceStep.rawOutput.unresolved.length === 0 &&
			after.closureResult.status !== "UNREACHED",
		"LOCAL_STORY_FLOW_ROUTE_NOT_READY",
	);
	requireRoute(
		options.phase === "WITNESS"
			? after.closureResult.status === "PENDING_HARD_CHOICE"
			: after.closureResult.status === "COMPLETE",
		"LOCAL_STORY_FLOW_ROUTE_NOT_READY",
	);
	const targetFrames = previous.evidence.input.targetFrames;
	const binding: FollowupBinding = {
		kind: "FOLLOWUP",
		structuralRootStepHash: previous.rootStepHash,
		closureStateHash: after.closure.structuralStateHash,
		seedsHash: hash(after.seeds),
	};
	let nodeId: string,
		data: LocalStoryFlowRouteInput["data"],
		orderedInputProofs: InputProof[],
		control: Control;
	let traversal: TraversalRow[] = [];
	if (options.phase === "WITNESS") {
		requireRoute(after.closureResult.status === "PENDING_HARD_CHOICE");
		const pending = after.closureResult.pending;
		const node = previous.fullTree.nodes.find(
			(n) => n.nodeId === pending.requestedClaim.nodeId,
		);
		requireRoute(node);
		nodeId = node.nodeId;
		data = node.publicView;
		orderedInputProofs = [nodeProof(node)];
		binding.pending = pending;
		control = {
			version: "local-story-flow-route-control-v1",
			mode: "FLOW",
			phase: "WITNESS",
			targetFrames,
			nodeId,
			goalText: after.closure.rootGoalText,
			requestedClaim: pending.requestedClaim,
		};
	} else if (options.phase === "FINALIZE") {
		nodeId = previous.fullTree.rootNodeId;
		({ data, orderedInputProofs } = finalizeParts(previous));
		control = {
			version: "local-story-flow-route-control-v1",
			mode: "FLOW",
			phase: "FINALIZE",
			targetFrames,
			nodeId,
			goalText: after.closure.rootGoalText,
		};
	} else if (options.phase === "BRANCH") {
		nodeId = options.nodeId;
		const node = previous.fullSource.layout.nodes.find(
			(n) => n.nodeId === nodeId,
		);
		requireRoute(node && node.phase === "MERGE");
		traversal = traversalTo(previous, nodeId);
		const children = node.children.map((id) => {
			const child = previous.fullTree.nodes.find((n) => n.nodeId === id);
			requireRoute(child);
			return child;
		});
		data = { children: children.map((n) => n.publicView) };
		orderedInputProofs = children.map(nodeProof);
		const required = after.closureResult.requiredEvents.map((e) => e.ref);
		control = {
			version: "local-story-flow-route-control-v1",
			mode: "FLOW",
			phase: "BRANCH",
			targetFrames,
			nodeId,
			goalText: after.closure.rootGoalText,
			requiredChildren: children
				.filter(
					(n) =>
						subtreeEvents(previous.fullSource, n.nodeId, required).length > 0,
				)
				.map((n) => ({ kind: "CHILD_NODE", nodeId: n.nodeId })),
		};
	} else {
		requireRoute(options.phase === "LEAF");
		nodeId = options.nodeId;
		const node = previous.fullSource.layout.nodes.find(
			(n) => n.nodeId === nodeId,
		);
		requireRoute(node && node.phase === "LEAF");
		traversal = traversalTo(previous, nodeId);
		const page = previous.fullSource.pages.find(
			(p) => p.pageId === node.pageId,
		);
		requireRoute(page);
		data = page.data;
		orderedInputProofs = [
			{
				kind: "LEAF_PAGE",
				nodeId,
				pageId: page.pageId,
				pageHash: page.pageHash,
				dataHash: page.dataHash,
			},
		];
		const ids = new Set(page.data.items.map((i) => i.id));
		control = {
			version: "local-story-flow-route-control-v1",
			mode: "FLOW",
			phase: "LEAF",
			targetFrames,
			nodeId,
			goalText: after.closure.rootGoalText,
			requiredEvents: after.closureResult.requiredEvents
				.filter((e) => ids.has(e.ref.eventId))
				.map((e) => e.ref),
		};
	}
	return publishExpectation(
		previous,
		{
			phase: options.phase,
			nodeId,
			targetFrames,
			data,
			control,
			orderedInputProofs,
			binding,
		},
		{
			kind: "AFTER_STEP",
			previousStepHash: previous.evidenceStep.stepHash,
			navigationHash: after.navigation.navigationHash,
			traversal,
		},
		previous,
	);
}
export function localStoryFlowRouteExpectationEvidence(
	expectation: BoundLocalStoryFlowRouteExpectation,
): LocalStoryFlowRouteExpectationEvidence {
	const state = expectations.get(expectation);
	requireRoute(state);
	return structuredClone(state.evidence);
}

export type BoundLocalStoryFlowRouteStep = Readonly<object>;
export type LocalStoryFlowRouteStepEvidence = {
	version: "local-story-flow-route-step-v1";
	phase: LocalStoryFlowRouteOutput["phase"];
	expectation: LocalStoryFlowRouteExpectationEvidence;
	rawOutput: LocalStoryFlowRouteOutput;
	rawOutputHash: string;
	observationHash: string;
	after: {
		closure: LocalStoryFlowClosureStateEvidence;
		closureResult: LocalStoryFlowClosureResult;
		seeds: EventRef[];
		navigation: Navigation;
		knownRequiredExposureGaps: {
			nodeId: string;
			pageId: string;
			events: EventRef[];
		}[];
	};
	stepHash: string;
};
type StepState = ExpectationState & {
	closure: BoundLocalStoryFlowClosure;
	evidenceStep: LocalStoryFlowRouteStepEvidence;
	rootStepHash: string;
};
const steps = new WeakMap<BoundLocalStoryFlowRouteStep, StepState>();
function safeData(value: unknown, active = new Set<object>()): unknown {
	try {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		)
			return value;
		if (typeof value === "number") {
			requireRoute(Number.isFinite(value));
			return value;
		}
		requireRoute(typeof value === "object" && !active.has(value));
		active.add(value);
		requireRoute(Object.getOwnPropertySymbols(value).length === 0);
		const d = Object.getOwnPropertyDescriptors(value);
		let copy: unknown;
		if (Array.isArray(value)) {
			const length = d.length?.value;
			requireRoute(
				Object.getPrototypeOf(value) === Array.prototype &&
					Number.isSafeInteger(length) &&
					length >= 0 &&
					Object.keys(d).length === length + 1,
			);
			copy = Array.from({ length }, (_, i) => {
				const p = d[String(i)];
				requireRoute(p && "value" in p && p.enumerable);
				return safeData(p.value, active);
			});
		} else {
			requireRoute(Object.getPrototypeOf(value) === Object.prototype);
			copy = Object.fromEntries(
				Object.entries(d).map(([k, p]) => {
					requireRoute("value" in p && p.enumerable);
					return [k, safeData(p.value, active)];
				}),
			);
		}
		active.delete(value);
		return copy;
	} catch {
		throw new LocalStoryFlowRouteError("LOCAL_STORY_FLOW_ROUTE_INVALID");
	}
}
function outputFor(value: unknown): LocalStoryFlowRouteOutput {
	try {
		const data = safeData(value),
			parsed = localStoryFlowRouteOutputSchema.safeParse(data);
		requireRoute(parsed.success && equalData(data, parsed.data));
		return parsed.data;
	} catch {
		throw new LocalStoryFlowRouteError("LOCAL_STORY_FLOW_ROUTE_INVALID");
	}
}
function ownerMembership(
	output: LocalStoryFlowRouteOutput,
	state: ExpectationState,
) {
	const node = state.fullTree.nodes.find((n) => n.nodeId === output.nodeId);
	requireRoute(node);
	const refs = [
		{ kind: "CONTEXT_NODE", nodeId: node.nodeId },
		...node.publicView.claims.flatMap((c) => [
			{ kind: "CLAIM", nodeId: node.nodeId, claimId: c.id },
			...c.witnesses.map((w) => ({
				kind: "WITNESS",
				nodeId: node.nodeId,
				claimId: c.id,
				witnessId: w.id,
			})),
		]),
	].map(canonicalEditingJson);
	for (const issue of output.unresolved)
		requireRoute(refs.includes(canonicalEditingJson(issue.ref)));
}
export function buildLocalStoryFlowRouteStep(options: {
	expectation: BoundLocalStoryFlowRouteExpectation;
	output: unknown;
}): BoundLocalStoryFlowRouteStep {
	options = plain(options, ["expectation", "output"]);
	const state = expectations.get(options.expectation);
	requireRoute(state);
	const rawOutput = outputFor(options.output);
	requireRoute(
		rawOutput.phase === state.evidence.input.phase &&
			rawOutput.nodeId === state.evidence.input.nodeId,
	);
	if (rawOutput.phase === "ROOT" || rawOutput.phase === "WITNESS")
		ownerMembership(rawOutput, state);
	let closure: BoundLocalStoryFlowClosure;
	if (rawOutput.phase === "ROOT")
		closure = prepareLocalStoryFlowClosure({
			source: state.source,
			tree: state.tree,
			targetFrames: state.evidence.input.targetFrames,
			rootChoice: rawOutput.choice,
		});
	else if (rawOutput.phase === "WITNESS") {
		const p = state.previous;
		requireRoute(
			p && p.evidenceStep.after.closureResult.status === "PENDING_HARD_CHOICE",
		);
		const requestedClaim =
			p.evidenceStep.after.closureResult.pending.requestedClaim;
		requireRoute(
			canonicalEditingJson(rawOutput.choice.claim) ===
				canonicalEditingJson(requestedClaim),
		);
		closure = extendLocalStoryFlowHardChoice({
			state: p.closure,
			requestedClaim,
			choice: rawOutput.choice,
		});
	} else {
		const p = state.previous;
		requireRoute(p);
		closure = p.closure;
	}
	let seeds = state.previous?.evidenceStep.after.seeds ?? [];
	if (rawOutput.phase === "LEAF") {
		const data = state.evidence.input.data;
		requireRoute("items" in data);
		const proof = state.evidence.input.orderedInputProofs[0];
		requireRoute(
			proof?.kind === "LEAF_PAGE" && rawOutput.pageId === proof.pageId,
		);
		const refs = data.items.map((i) =>
			i.kind === "DERIVED_CHUNK_SUMMARY"
				? { kind: "SUMMARY", summaryId: i.id }
				: { kind: "EVENT", eventId: i.id },
		);
		requireRoute(
			canonicalEditingJson(rawOutput.accountedItems) ===
				canonicalEditingJson(refs),
		);
		const ids = new Set(
			refs.filter((r) => r.kind === "EVENT").map((r) => r.eventId),
		);
		requireRoute(rawOutput.candidates.every((e) => ids.has(e.eventId)));
		const known = new Set(refs.map(canonicalEditingJson));
		for (const i of rawOutput.unresolved)
			requireRoute(known.has(canonicalEditingJson(i.ref)));
		const union = new Set(
			[...seeds, ...rawOutput.candidates].map((e) => e.eventId),
		);
		requireRoute(union.size <= 32, "LOCAL_STORY_FLOW_ROUTE_SEED_LIMIT");
		seeds = state.fullSource.manifest.items.flatMap((i) =>
			i.kind === "GROUNDED_LEAF_EVENT_CARD" && union.has(i.id)
				? [{ kind: "EVENT" as const, eventId: i.id }]
				: [],
		);
	}
	if (rawOutput.phase === "BRANCH") {
		const data = state.evidence.input.data;
		requireRoute("children" in data);
		const expected = data.children.map((n) => ({
			kind: "CHILD_NODE",
			nodeId: n.nodeId,
		}));
		requireRoute(same(rawOutput.accountedChildren, expected));
		const visible = [...expected, ...data.children.flatMap(publicRefs)];
		for (const i of rawOutput.unresolved)
			requireRoute(visible.some((r) => same(r, i.ref)));
	}
	if (rawOutput.phase === "FINALIZE") {
		const data = state.evidence.input.data;
		requireRoute("constraints" in data && state.previous);
		const expected =
			state.previous.evidenceStep.after.closureResult.requiredEvents.map(
				(e) => e.ref,
			);
		requireRoute(
			same(rawOutput.accountedRoot, {
				kind: "CONTEXT_NODE",
				nodeId: state.fullTree.rootNodeId,
			}) && same(rawOutput.accountedEvents, expected),
		);
		const visible = [
			{ kind: "CONTEXT_NODE", nodeId: data.root.nodeId },
			...expected,
			...data.root.claims.flatMap((c) => [
				{ kind: "CLAIM", nodeId: data.root.nodeId, claimId: c.id },
				...c.witnesses.map((w) => ({
					kind: "WITNESS",
					nodeId: data.root.nodeId,
					claimId: c.id,
					witnessId: w.id,
				})),
			]),
			...data.constraints.claims.map((c) => c.ref),
			...data.constraints.commitments.flatMap((c) => [
				c.choice.claim,
				c.choice.witness,
			]),
			...data.constraints.requires.flatMap((r) => [
				r.relation.from,
				r.relation.target,
			]),
		];
		for (const i of rawOutput.unresolved)
			requireRoute(
				visible.some((r) => same(r, i.ref)) &&
					(i.ref.kind !== "EVENT" || expected.some((r) => same(r, i.ref))),
			);
	}
	const closureResult = evaluateLocalStoryFlowClosure({
		state: closure,
		seeds,
	});
	const rawOutputHash = hash(rawOutput),
		observationHash = hash({
			version: "local-story-flow-route-observation-v1",
			expectationHash: state.evidence.expectationHash,
			rawOutputHash,
		});
	const navBody = {
		version: "local-story-flow-route-navigation-v1" as const,
		sourceBindingHash: state.fullSource.sourceBindingHash,
		treeHash: state.fullTree.treeHash,
		branches: [],
		exposedPages: [],
	};
	const previousNav = state.previous?.evidenceStep.after.navigation;
	const nav: Omit<Navigation, "navigationHash"> = previousNav
		? {
				version: previousNav.version,
				sourceBindingHash: previousNav.sourceBindingHash,
				treeHash: previousNav.treeHash,
				branches: structuredClone(previousNav.branches),
				exposedPages: structuredClone(previousNav.exposedPages),
			}
		: navBody;
	if (rawOutput.phase === "BRANCH") {
		nav.branches = [
			...nav.branches.filter((b) => b.nodeId !== rawOutput.nodeId),
			{
				nodeId: rawOutput.nodeId,
				observationHash,
				dispositions: rawOutput.dispositions,
			},
		];
		nav.branches.sort(
			(a, b) =>
				state.fullSource.layout.nodes.findIndex((n) => n.nodeId === a.nodeId) -
				state.fullSource.layout.nodes.findIndex((n) => n.nodeId === b.nodeId),
		);
	}
	if (rawOutput.phase === "LEAF") {
		const page = state.fullSource.pages.find(
			(p) => p.pageId === rawOutput.pageId,
		);
		requireRoute(page);
		nav.exposedPages = [
			...nav.exposedPages.filter((p) => p.pageId !== page.pageId),
			{
				nodeId: rawOutput.nodeId,
				pageId: page.pageId,
				pageHash: page.pageHash,
				dataHash: page.dataHash,
				observationHash,
			},
		];
		nav.exposedPages.sort(
			(a, b) =>
				state.fullSource.pages.findIndex((p) => p.pageId === a.pageId) -
				state.fullSource.pages.findIndex((p) => p.pageId === b.pageId),
		);
	}
	const navigation: Navigation = { ...nav, navigationHash: hash(nav) };
	const knownRequiredExposureGaps = state.fullSource.pages.flatMap((p) => {
		const ids = new Set(p.data.items.map((i) => i.id)),
			events = closureResult.requiredEvents
				.filter((e) => ids.has(e.ref.eventId))
				.map((e) => e.ref);
		const node = state.fullSource.layout.nodes.find(
			(n) => n.phase === "LEAF" && n.pageId === p.pageId,
		);
		requireRoute(node);
		return events.length &&
			!navigation.exposedPages.some(
				(row) =>
					row.pageId === p.pageId &&
					row.pageHash === p.pageHash &&
					row.dataHash === p.dataHash,
			)
			? [{ nodeId: node.nodeId, pageId: p.pageId, events }]
			: [];
	});
	const body = {
		version: "local-story-flow-route-step-v1" as const,
		phase: rawOutput.phase,
		expectation: state.evidence,
		rawOutput,
		rawOutputHash,
		observationHash,
		after: {
			closure: localStoryFlowClosureStateEvidence(closure),
			closureResult,
			seeds,
			navigation,
			knownRequiredExposureGaps,
		},
	};
	const evidenceStep = freeze(
			structuredClone({ ...body, stepHash: hash(body) }),
		),
		handle = Object.freeze({});
	steps.set(handle, {
		...state,
		closure,
		evidenceStep,
		rootStepHash: state.previous?.rootStepHash ?? evidenceStep.stepHash,
	});
	return handle;
}
export function localStoryFlowRouteStepEvidence(
	step: BoundLocalStoryFlowRouteStep,
): LocalStoryFlowRouteStepEvidence {
	const state = steps.get(step);
	requireRoute(state);
	return structuredClone(state.evidenceStep);
}

/** Rebuilds structural evidence only. H2 must independently admit the native output. */
export function validateLocalStoryFlowRouteStep(
	value: unknown,
	options: {
		expectation: BoundLocalStoryFlowRouteExpectation;
		expectedOutput: unknown;
	},
): BoundLocalStoryFlowRouteStep {
	options = plain(options, ["expectation", "expectedOutput"]);
	const rebuilt = buildLocalStoryFlowRouteStep({
		expectation: options.expectation,
		output: options.expectedOutput,
	});
	requireRoute(
		equalData(safeData(value), localStoryFlowRouteStepEvidence(rebuilt)),
	);
	return rebuilt;
}
