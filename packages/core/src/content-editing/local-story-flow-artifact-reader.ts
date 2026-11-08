import { canonicalEditingJson } from "./automatic-binding";
import {
	type BoundLocalStoryFlowContextNode,
	buildLocalStoryFlowContextNode,
	type LocalStoryFlowContextNodeEvidence,
	localStoryFlowContextNodeEvidence,
	localStoryFlowContextSourceEvidence,
} from "./local-story-flow-context";
import {
	type BoundLocalStoryFlowContextTree,
	buildLocalStoryFlowContextTree,
	type LocalStoryFlowContextTreeEvidence,
	localStoryFlowContextTreeEvidence,
} from "./local-story-flow-context-tree";
import {
	type AdmittedFlowNative,
	admitFlowNativeObservation,
	admittedFlowNativeEvidence,
	admittedFlowNativeOutput,
	type BoundLocalStoryFlowNativeExpectation,
	contextNativeExpectation,
	type LocalStoryFlowNativeObservation,
	localStoryFlowNativeExpectationEvidence,
} from "./local-story-flow-native";
import {
	admitLocalStoryFlowAcceptedOrigin,
	type BoundLocalStoryFlowRuntimeIdentity,
	localStoryFlowAcceptedOriginEvidence,
	localStoryFlowRuntimeIdentityEvidence,
} from "./local-story-flow-runtime-history";
import {
	type BoundLocalStoryFlowSealedRecord,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordKind,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
} from "./local-story-flow-seals";
import {
	type BoundLocalStoryFlowSourceArchive,
	localStoryFlowSourceArchiveContext,
	localStoryFlowSourceArchiveEvidence,
} from "./local-story-flow-source-archive";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

/** RAM proposals only. DB authority, retention, terminal hydration and delivery are separate. */
export const LOCAL_STORY_FLOW_ARTIFACT_READER_POLICY = Object.freeze({
	version: "local-story-flow-artifact-reader-policy-v1",
	contextNodes: 63,
	immediateChildren: 2,
	nativeRule: "owned-admitted-output-only-full-native-key-v1",
	childNativeRule: "same-context-relevant-policies-owned-subtree-v1",
	outputRule: "decoded-output-full-field-preservation-v1",
	contextReadRule: "independent-fixed-origin-cache-full-native-node-tree-v1",
	treeRule: "all-layout-nodes-ordered-full-graph-v1",
	wrapperRule: "task-archive-tree-separate-global-native-v1",
});
export class LocalStoryFlowArtifactReadError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowArtifactReadError";
	}
}
function requireArtifact(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowArtifactReadError();
}
function checked<T>(read: () => T): T {
	try {
		return read();
	} catch {
		throw new LocalStoryFlowArtifactReadError();
	}
}
const same = (a: unknown, b: unknown) =>
	canonicalEditingJson(a) === canonicalEditingJson(b);
function plain(value: unknown, fields: readonly string[]) {
	requireArtifact(
		value !== null &&
			typeof value === "object" &&
			Object.getPrototypeOf(value) === Object.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const names = Object.keys(descriptors);
	requireArtifact(
		names.length === fields.length && fields.every((f) => names.includes(f)),
	);
	return Object.fromEntries(
		fields.map((name) => {
			const d = descriptors[name];
			requireArtifact(d?.enumerable && "value" in d);
			return [name, d.value];
		}),
	);
}
function handles<T extends object>(value: unknown, max: number): T[] {
	requireArtifact(
		Array.isArray(value) &&
			Object.getPrototypeOf(value) === Array.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const descriptors = Object.getOwnPropertyDescriptors(value as object),
		length = descriptors.length;
	requireArtifact(
		length &&
			"value" in length &&
			typeof length.value === "number" &&
			Number.isSafeInteger(length.value) &&
			length.value >= 0 &&
			length.value <= max,
	);
	requireArtifact(Object.keys(descriptors).length === length.value + 1);
	return Array.from({ length: length.value as number }, (_, i) => {
		const d = descriptors[String(i)];
		requireArtifact(
			d?.enumerable &&
				"value" in d &&
				d.value !== null &&
				typeof d.value === "object",
		);
		return d.value as T;
	});
}
/** A computed save proposal is not a row read from a database or a retention proof. */
export type LocalStoryFlowArtifactProposal<
	P extends object = Record<string, unknown>,
> = {
	sourceTuple: LocalStoryFlowSourceTuple;
	kind: LocalStoryFlowRecordKind;
	key: LocalStoryFlowRecordKey;
	payload: P;
	ref: LocalStoryFlowRecordRef;
};
type NodePayload = {
	version: "local-story-flow-node-artifact-v1";
	purpose: "NODE";
	sourceBindingHash: string;
	nodeId: string;
	observationRef: LocalStoryFlowRecordRef;
	nodeEvidence: LocalStoryFlowContextNodeEvidence;
	nodeHash: string;
};
type CachePayload = {
	version: "local-story-flow-native-cache-v1";
	purpose: "NATIVE_CACHE";
	nativeKeyHash: string;
	observationRef: LocalStoryFlowRecordRef;
	observationHash: string;
};
type TreePayload = {
	version: "local-story-flow-tree-artifact-v1";
	purpose: "TREE";
	sourceArchiveRef: LocalStoryFlowRecordRef;
	orderedNodeRefs: LocalStoryFlowRecordRef[];
	treeEvidence: LocalStoryFlowContextTreeEvidence;
	treeHash: string;
};
function proposal<P extends object>(
	sourceTuple: LocalStoryFlowSourceTuple,
	kind: LocalStoryFlowRecordKind,
	key: LocalStoryFlowRecordKey,
	payload: P,
): LocalStoryFlowArtifactProposal<P> {
	const identity = localStoryFlowRecordIdentity({ sourceTuple, kind, key });
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: canonicalEditingJson(payload),
	};
	return {
		sourceTuple,
		kind,
		key,
		payload,
		ref: { kind, ...identity, proofHash: hash(proof) },
	};
}
type ArchiveState = {
	handle: BoundLocalStoryFlowSourceArchive;
	source: ReturnType<typeof localStoryFlowSourceArchiveContext>;
	sourceEvidence: ReturnType<typeof localStoryFlowContextSourceEvidence>;
	evidence: ReturnType<typeof localStoryFlowSourceArchiveEvidence>;
	sourceTuple: LocalStoryFlowSourceTuple;
	sourceArchive: LocalStoryFlowArtifactProposal;
	nativePin: {
		modelPin: { profile: "amd" | "nvidia"; configId: string };
		policies: unknown;
	};
};
const archiveStates = new WeakMap<
	BoundLocalStoryFlowSourceArchive,
	ArchiveState
>();
function archiveState(handle: BoundLocalStoryFlowSourceArchive): ArchiveState {
	const old = archiveStates.get(handle);
	if (old) return old;
	const evidence = localStoryFlowSourceArchiveEvidence(handle),
		source = localStoryFlowSourceArchiveContext(handle),
		sourceEvidence = localStoryFlowContextSourceEvidence(source);
	const sourceTuple = evidence.payload.sourceTuple as LocalStoryFlowSourceTuple;
	const taskPin = evidence.payload.taskPin as { policies: unknown };
	const baseModel = sourceEvidence.workflow.baseModel;
	const state: ArchiveState = {
		handle,
		source,
		sourceEvidence,
		evidence,
		sourceTuple,
		nativePin: {
			modelPin: { profile: baseModel.profile, configId: baseModel.configId },
			policies: taskPin.policies,
		},
		sourceArchive: proposal(
			sourceTuple,
			"LOCAL_FLOW_MANIFEST_V1",
			evidence.key,
			evidence.payload,
		),
	};
	archiveStates.set(handle, state);
	return state;
}
export type BoundLocalStoryFlowContextWork = Readonly<object>;
export type AcceptedLocalStoryFlowContextNode = Readonly<object>;
export type BoundLocalStoryFlowAcceptedContext = Readonly<object>;
type WorkState = {
	archive: ArchiveState;
	nodeId: string;
	children: AcceptedLocalStoryFlowContextNode[];
	coreChildren: BoundLocalStoryFlowContextNode[];
	expectation: BoundLocalStoryFlowNativeExpectation;
};
type NodeState = {
	work: BoundLocalStoryFlowContextWork;
	w: WorkState;
	native: AdmittedFlowNative;
	core: BoundLocalStoryFlowContextNode;
	observation: LocalStoryFlowArtifactProposal<LocalStoryFlowNativeObservation>;
	node: LocalStoryFlowArtifactProposal<NodePayload>;
	cache: LocalStoryFlowArtifactProposal<CachePayload>;
};
const works = new WeakMap<BoundLocalStoryFlowContextWork, WorkState>(),
	nodes = new WeakMap<AcceptedLocalStoryFlowContextNode, NodeState>();
const contexts = new WeakMap<
	BoundLocalStoryFlowAcceptedContext,
	{
		archive: ArchiveState;
		nodes: NodeState[];
		nodeHandles: AcceptedLocalStoryFlowContextNode[];
		tree: BoundLocalStoryFlowContextTree;
		proposal: LocalStoryFlowArtifactProposal<TreePayload>;
	}
>();
function workState(handle: BoundLocalStoryFlowContextWork) {
	const value = works.get(handle);
	requireArtifact(value);
	return value;
}
function nodeState(handle: AcceptedLocalStoryFlowContextNode) {
	const value = nodes.get(handle);
	requireArtifact(value);
	return value;
}
/** The same work expectation must be used for reservation, capture and publication. */
export function prepareLocalStoryFlowContextWork(options: {
	archive: BoundLocalStoryFlowSourceArchive;
	nodeId: string;
	children: readonly AcceptedLocalStoryFlowContextNode[];
}): BoundLocalStoryFlowContextWork {
	return checked(() => {
		const o = plain(options, ["archive", "nodeId", "children"]);
		const archive = archiveState(o.archive as BoundLocalStoryFlowSourceArchive);
		requireArtifact(typeof o.nodeId === "string");
		const plan = archive.sourceEvidence.layout.nodes.find(
			(p) => p.nodeId === o.nodeId,
		);
		requireArtifact(plan);
		const children = handles<AcceptedLocalStoryFlowContextNode>(
			o.children,
			LOCAL_STORY_FLOW_ARTIFACT_READER_POLICY.immediateChildren,
		);
		const states = children.map(nodeState);
		const expectedIds = plan.phase === "LEAF" ? [] : plan.children;
		requireArtifact(
			same(
				states.map((c) => c.node.payload.nodeId),
				expectedIds,
			),
		);
		requireArtifact(
			states.every((c) => same(c.w.archive.sourceTuple, archive.sourceTuple)),
		);
		const coreChildren = states.map((c) => c.core);
		const expectation = contextNativeExpectation({
			source: archive.source,
			nodeId: plan.nodeId,
			children: coreChildren,
			pin: archive.nativePin,
		});
		const expectedKey =
			localStoryFlowNativeExpectationEvidence(expectation).nativeKey;
		// Core child hashes do not encode native admission policies. Keep the
		// entire owned subtree on the same relevant CONTEXT policy and model pin.
		requireArtifact(
			states.every((child) => {
				const key = child.observation.payload.nativeKey;
				return (
					same(key.workflowIdentity, expectedKey.workflowIdentity) &&
					same(key.relevantPolicyHashes, expectedKey.relevantPolicyHashes)
				);
			}),
		);
		const handle = Object.freeze({});
		works.set(handle, {
			archive,
			nodeId: plan.nodeId,
			children,
			coreChildren,
			expectation,
		});
		return handle;
	});
}
export function localStoryFlowContextWorkExpectation(
	work: BoundLocalStoryFlowContextWork,
) {
	return checked(() => workState(work).expectation);
}
export function acceptLocalStoryFlowContextWork(options: {
	work: BoundLocalStoryFlowContextWork;
	native: AdmittedFlowNative;
}): AcceptedLocalStoryFlowContextNode {
	return checked(() => {
		const o = plain(options, ["work", "native"]);
		const work = o.work as BoundLocalStoryFlowContextWork,
			w = workState(work);
		const native = o.native as AdmittedFlowNative,
			observationValue = admittedFlowNativeEvidence(native),
			expected = localStoryFlowNativeExpectationEvidence(w.expectation);
		requireArtifact(same(observationValue.nativeKey, expected.nativeKey));
		const output = admittedFlowNativeOutput(native);
		const core = buildLocalStoryFlowContextNode({
			source: w.archive.source,
			nodeId: w.nodeId,
			children: w.coreChildren,
			output,
		});
		const nodeEvidence = localStoryFlowContextNodeEvidence(core);
		// Preserve every field from decoded native output, including own __proto__.
		requireArtifact(same(output, nodeEvidence.rawOutput));
		const observation = proposal(
			w.archive.sourceTuple,
			"LOCAL_FLOW_CONTEXT_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose: "NATIVE_OBSERVATION",
				keyBody: {
					nativeKeyHash: expected.nativeKeyHash,
					originTaskId: observationValue.origin.originTaskId,
					slot: observationValue.origin.slot,
				},
			},
			observationValue,
		);
		const node = proposal<NodePayload>(
			w.archive.sourceTuple,
			"LOCAL_FLOW_CONTEXT_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose: "NODE",
				keyBody: {
					inputHash: nodeEvidence.inputHash,
					observationHash: observationValue.observationHash,
					contextPolicyHash:
						expected.nativeKey.relevantPolicyHashes.contextPolicyHash,
				},
			},
			{
				version: "local-story-flow-node-artifact-v1",
				purpose: "NODE",
				sourceBindingHash: nodeEvidence.sourceBindingHash,
				nodeId: w.nodeId,
				observationRef: observation.ref,
				nodeEvidence,
				nodeHash: nodeEvidence.nodeHash,
			},
		);
		const cache = proposal<CachePayload>(
			w.archive.sourceTuple,
			"LOCAL_FLOW_CONTEXT_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose: "NATIVE_CACHE",
				keyBody: { nativeKeyHash: expected.nativeKeyHash },
			},
			{
				version: "local-story-flow-native-cache-v1",
				purpose: "NATIVE_CACHE",
				nativeKeyHash: expected.nativeKeyHash,
				observationRef: observation.ref,
				observationHash: observationValue.observationHash,
			},
		);
		const handle = Object.freeze({});
		nodes.set(handle, { work, w, native, core, observation, node, cache });
		return handle;
	});
}
/** Full proposal bodies are detached; owned capture/expectation/children retain their identity. */
export function localStoryFlowAcceptedContextNodePublication(
	node: AcceptedLocalStoryFlowContextNode,
) {
	return checked(() => {
		const n = nodeState(node);
		return {
			archive: n.w.archive.handle,
			work: n.work,
			expectation: n.w.expectation,
			native: n.native,
			children: [...n.w.children],
			observation: structuredClone(n.observation),
			node: structuredClone(n.node),
			cache: structuredClone(n.cache),
		};
	});
}
export function buildLocalStoryFlowAcceptedContext(options: {
	archive: BoundLocalStoryFlowSourceArchive;
	nodes: readonly AcceptedLocalStoryFlowContextNode[];
}): BoundLocalStoryFlowAcceptedContext {
	return checked(() => {
		const o = plain(options, ["archive", "nodes"]),
			archive = archiveState(o.archive as BoundLocalStoryFlowSourceArchive),
			handlesList = handles<AcceptedLocalStoryFlowContextNode>(
				o.nodes,
				LOCAL_STORY_FLOW_ARTIFACT_READER_POLICY.contextNodes,
			),
			states = handlesList.map(nodeState),
			layout = archive.sourceEvidence.layout.nodes;
		requireArtifact(states.length === layout.length);
		requireArtifact(
			states.every(
				(n, i) =>
					n.node.payload.nodeId === layout[i]?.nodeId &&
					same(n.w.archive.sourceTuple, archive.sourceTuple),
			),
		);
		const byId = new Map(
			states.map((n, i) => [n.node.payload.nodeId, handlesList[i]]),
		);
		for (const [index, n] of states.entries()) {
			if (n.w.archive === archive) continue;
			const plan = layout[index];
			requireArtifact(plan);
			const children =
				plan.phase === "LEAF"
					? []
					: plan.children.map((id) => {
							const c = byId.get(id);
							requireArtifact(c);
							return c;
						});
			const work = prepareLocalStoryFlowContextWork({
				archive: archive.handle,
				nodeId: plan.nodeId,
				children,
			});
			requireArtifact(
				same(
					localStoryFlowNativeExpectationEvidence(workState(work).expectation)
						.nativeKey,
					admittedFlowNativeEvidence(n.native).nativeKey,
				),
			);
		}
		const tree = buildLocalStoryFlowContextTree({
				source: archive.source,
				nodes: states.map((n) => n.core),
			}),
			treeEvidence = localStoryFlowContextTreeEvidence(tree, archive.source),
			orderedNodeRefs = states.map((n) => n.node.ref),
			firstNode = states[0];
		requireArtifact(firstNode);
		const firstExpectation = localStoryFlowNativeExpectationEvidence(
			firstNode.w.expectation,
		);
		const treeProposal = proposal<TreePayload>(
			archive.sourceTuple,
			"LOCAL_FLOW_CONTEXT_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose: "TREE",
				keyBody: {
					sourceArchiveRef: archive.sourceArchive.ref,
					sourceBindingHash: treeEvidence.sourceBindingHash,
					orderedNodeRefs,
					orderedNodeHashes: states.map((n) => n.node.payload.nodeHash),
					contextPolicyHash:
						firstExpectation.nativeKey.relevantPolicyHashes.contextPolicyHash,
				},
			},
			{
				version: "local-story-flow-tree-artifact-v1",
				purpose: "TREE",
				sourceArchiveRef: archive.sourceArchive.ref,
				orderedNodeRefs,
				treeEvidence,
				treeHash: treeEvidence.treeHash,
			},
		);
		const handle = Object.freeze({});
		contexts.set(handle, {
			archive,
			nodes: states,
			nodeHandles: handlesList,
			tree,
			proposal: treeProposal,
		});
		return handle;
	});
}
function contextState(handle: BoundLocalStoryFlowAcceptedContext) {
	const state = contexts.get(handle);
	requireArtifact(state);
	return state;
}
export function localStoryFlowAcceptedContextEvidence(
	context: BoundLocalStoryFlowAcceptedContext,
) {
	return checked(() => {
		const c = contextState(context);
		return {
			sourceArchive: structuredClone(c.archive.sourceArchive),
			nodes: c.nodes.map((n) => structuredClone(n.node)),
			tree: structuredClone(c.proposal),
			requiredLegacyRefs: structuredClone(
				c.archive.evidence.requiredLegacyRefs,
			),
		};
	});
}
export function localStoryFlowAcceptedContextTree(
	context: BoundLocalStoryFlowAcceptedContext,
) {
	return checked(() => contextState(context).tree);
}

/** Preserve original admitted node handles for publication; saved proposals stay detached. */
export function localStoryFlowAcceptedContextPublication(
	context: BoundLocalStoryFlowAcceptedContext,
) {
	return checked(() => {
		const c = contextState(context);
		return { nodes: [...c.nodeHandles], tree: structuredClone(c.proposal) };
	});
}

export type LocalStoryFlowContextHydrationSnapshot = {
	sourceArchive: BoundLocalStoryFlowSealedRecord;
	tree: BoundLocalStoryFlowSealedRecord;
	nodes: readonly BoundLocalStoryFlowSealedRecord[];
	nativeCaches: readonly BoundLocalStoryFlowSealedRecord[];
	observations: readonly BoundLocalStoryFlowSealedRecord[];
	origins: readonly {
		identity: BoundLocalStoryFlowRuntimeIdentity;
		start: BoundLocalStoryFlowSealedRecord;
		attempt: BoundLocalStoryFlowSealedRecord;
		outcome: BoundLocalStoryFlowSealedRecord;
	}[];
};
function matchingRecord<P extends object>(
	actual: BoundLocalStoryFlowSealedRecord,
	expected: LocalStoryFlowArtifactProposal<P>,
) {
	requireArtifact(same(localStoryFlowSealedRecordEvidence(actual), expected));
}
function contextRecord(
	archive: ArchiveState,
	handle: BoundLocalStoryFlowSealedRecord,
	kind: LocalStoryFlowRecordKind,
	purpose: LocalStoryFlowRecordKey["purpose"],
) {
	const value = localStoryFlowSealedRecordEvidence(handle);
	requireArtifact(
		same(value.sourceTuple, archive.sourceTuple) &&
			value.kind === kind &&
			value.key.purpose === purpose,
	);
	return value;
}
function contextRecordGroup(
	archive: ArchiveState,
	value: unknown,
	purpose: "NODE" | "NATIVE_CACHE" | "NATIVE_OBSERVATION",
) {
	const list = handles<BoundLocalStoryFlowSealedRecord>(
		value,
		LOCAL_STORY_FLOW_ARTIFACT_READER_POLICY.contextNodes,
	);
	const records = list.map((handle) => ({
		handle,
		evidence: contextRecord(archive, handle, "LOCAL_FLOW_CONTEXT_V1", purpose),
	}));
	const byId = new Map<string, (typeof records)[number]>(),
		byKey = new Map<string, (typeof records)[number]>();
	for (const record of records) {
		const id = record.evidence.ref.receiptId,
			key = canonicalEditingJson(record.evidence.key);
		requireArtifact(!byId.has(id) && !byKey.has(key));
		byId.set(id, record);
		byKey.set(key, record);
	}
	return { records, byId, byKey };
}
/**
 * Reconstructs context from independent source and retained original native records.
 * Current task runtime/owner links/pins, routes, C3 and delivery still belong to later layers.
 */
export function hydrateLocalStoryFlowContextArtifacts(options: {
	archive: BoundLocalStoryFlowSourceArchive;
	snapshot: LocalStoryFlowContextHydrationSnapshot;
}): BoundLocalStoryFlowAcceptedContext {
	return checked(() => {
		const o = plain(options, ["archive", "snapshot"]),
			archive = archiveState(o.archive as BoundLocalStoryFlowSourceArchive),
			s = plain(o.snapshot, [
				"sourceArchive",
				"tree",
				"nodes",
				"nativeCaches",
				"observations",
				"origins",
			]);
		const sourceArchive = s.sourceArchive as BoundLocalStoryFlowSealedRecord;
		matchingRecord(sourceArchive, archive.sourceArchive);
		const storedNodes = contextRecordGroup(archive, s.nodes, "NODE"),
			caches = contextRecordGroup(archive, s.nativeCaches, "NATIVE_CACHE"),
			observations = contextRecordGroup(
				archive,
				s.observations,
				"NATIVE_OBSERVATION",
			),
			originInput = handles<object>(
				s.origins,
				LOCAL_STORY_FLOW_ARTIFACT_READER_POLICY.contextNodes,
			),
			count = archive.sourceEvidence.layout.nodes.length;
		requireArtifact(
			storedNodes.records.length === count &&
				caches.records.length === count &&
				observations.records.length === count &&
				originInput.length === count,
		);
		const origins = new Map<
			string,
			{
				identity: BoundLocalStoryFlowRuntimeIdentity;
				start: BoundLocalStoryFlowSealedRecord;
				attempt: BoundLocalStoryFlowSealedRecord;
				outcome: BoundLocalStoryFlowSealedRecord;
			}
		>();
		for (const origin of originInput) {
			const bundle = plain(origin, ["identity", "start", "attempt", "outcome"]);
			const identity = bundle.identity as BoundLocalStoryFlowRuntimeIdentity;
			requireArtifact(
				same(
					localStoryFlowRuntimeIdentityEvidence(identity).sourceTuple,
					archive.sourceTuple,
				),
			);
			const attempt = bundle.attempt as BoundLocalStoryFlowSealedRecord;
			const e = contextRecord(
				archive,
				attempt,
				"LOCAL_FLOW_PLAN_V1",
				"ATTEMPT",
			);
			requireArtifact(!origins.has(e.ref.receiptId));
			origins.set(e.ref.receiptId, {
				identity,
				attempt,
				start: bundle.start as BoundLocalStoryFlowSealedRecord,
				outcome: bundle.outcome as BoundLocalStoryFlowSealedRecord,
			});
		}
		const accepted: AcceptedLocalStoryFlowContextNode[] = [],
			byNode = new Map<string, AcceptedLocalStoryFlowContextNode>(),
			usedCache = new Set<string>(),
			usedObs = new Set<string>(),
			usedOrigin = new Set<string>();
		for (const [index, plan] of archive.sourceEvidence.layout.nodes.entries()) {
			const children =
				plan.phase === "LEAF"
					? []
					: plan.children.map((id) => {
							const node = byNode.get(id);
							requireArtifact(node);
							return node;
						});
			const work = prepareLocalStoryFlowContextWork({
					archive: archive.handle,
					nodeId: plan.nodeId,
					children,
				}),
				expectation = localStoryFlowContextWorkExpectation(work),
				expected = localStoryFlowNativeExpectationEvidence(expectation);
			const cacheKey: LocalStoryFlowRecordKey = {
				version: "local-story-flow-record-key-v1",
				purpose: "NATIVE_CACHE",
				keyBody: { nativeKeyHash: expected.nativeKeyHash },
			};
			const cached = caches.byKey.get(canonicalEditingJson(cacheKey));
			requireArtifact(cached && !usedCache.has(cached.evidence.ref.receiptId));
			const c = plain(cached.evidence.payload, [
				"version",
				"purpose",
				"nativeKeyHash",
				"observationRef",
				"observationHash",
			]);
			requireArtifact(
				c.version === "local-story-flow-native-cache-v1" &&
					c.purpose === "NATIVE_CACHE" &&
					c.nativeKeyHash === expected.nativeKeyHash,
			);
			const hint = plain(c.observationRef, [
				"kind",
				"receiptId",
				"cacheHash",
				"inputKeyHash",
				"proofHash",
			]);
			requireArtifact(typeof hint.receiptId === "string");
			const observation = observations.byId.get(hint.receiptId);
			requireArtifact(
				observation &&
					!usedObs.has(hint.receiptId) &&
					same(observation.evidence.ref, c.observationRef),
			);
			const obsOrigin = plain(observation.evidence.payload.origin, [
					"organizationId",
					"originTaskId",
					"startRef",
					"attemptRef",
					"slot",
				]),
				attemptHint = plain(obsOrigin.attemptRef, [
					"kind",
					"receiptId",
					"cacheHash",
					"inputKeyHash",
					"proofHash",
				]);
			requireArtifact(typeof attemptHint.receiptId === "string");
			const original = origins.get(attemptHint.receiptId);
			requireArtifact(original && !usedOrigin.has(attemptHint.receiptId));
			const origin = admitLocalStoryFlowAcceptedOrigin({
				...original,
				expectation,
				observation: observation.handle,
			});
			const native = admitFlowNativeObservation(expectation, {
				resolvedOrigin: localStoryFlowAcceptedOriginEvidence(origin),
				observation: observation.evidence.payload,
			});
			const node = acceptLocalStoryFlowContextWork({ work, native }),
				p = localStoryFlowAcceptedContextNodePublication(node),
				actualNode = storedNodes.records[index];
			requireArtifact(actualNode);
			matchingRecord(observation.handle, p.observation);
			matchingRecord(cached.handle, p.cache);
			matchingRecord(actualNode.handle, p.node);
			const outcome = localStoryFlowSealedRecordEvidence(original.outcome);
			requireArtifact(
				same(outcome.payload.acceptedArtifactRef, p.node.ref) &&
					outcome.payload.acceptedArtifactHash === p.node.payload.nodeHash,
			);
			accepted.push(node);
			byNode.set(plan.nodeId, node);
			usedCache.add(cached.evidence.ref.receiptId);
			usedObs.add(hint.receiptId);
			usedOrigin.add(attemptHint.receiptId);
		}
		requireArtifact(
			usedCache.size === count &&
				usedObs.size === count &&
				usedOrigin.size === count,
		);
		const context = buildLocalStoryFlowAcceptedContext({
			archive: archive.handle,
			nodes: accepted,
		});
		matchingRecord(
			s.tree as BoundLocalStoryFlowSealedRecord,
			localStoryFlowAcceptedContextEvidence(context).tree,
		);
		return context;
	});
}
