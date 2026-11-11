import {
	canonicalEditingJson,
	hashEditingEvidence as hash,
} from "@bitovp/core";
import {
	type AcceptedLocalStoryFlowContextNode,
	type AcceptedLocalStoryFlowRouteStep,
	type AdmittedFlowNative,
	type BoundLocalStoryFlowAcceptedContext,
	type BoundLocalStoryFlowNativeExpectation,
	type BoundLocalStoryFlowNativeRoot,
	type BoundLocalStoryFlowSourceArchive,
	type LocalStoryFlowArtifactProposal,
	type LocalStoryFlowSourceTuple,
	localStoryFlowAcceptedContextNodePublication,
	localStoryFlowAcceptedContextPublication,
	localStoryFlowAcceptedRoutePublication,
	localStoryFlowNativeRootEvidence,
	localStoryFlowRecordIdentity,
	localStoryFlowSourceArchiveEvidence,
} from "@bitovp/core/local-story-flow-hierarchy";

export type PreparedLocalStoryFlowPublication = Readonly<object>;
type CommonPublicationEvidence = {
	archive: BoundLocalStoryFlowSourceArchive;
	expectation: BoundLocalStoryFlowNativeExpectation;
	native: AdmittedFlowNative;
	sourceArchive: LocalStoryFlowArtifactProposal;
	observation: LocalStoryFlowArtifactProposal;
	artifact: LocalStoryFlowArtifactProposal;
	cache: LocalStoryFlowArtifactProposal;
	requiredLegacyRefs: ReturnType<
		typeof localStoryFlowSourceArchiveEvidence
	>["requiredLegacyRefs"];
};
type ContextPublicationEvidence = CommonPublicationEvidence & {
	category: "CONTEXT";
	acceptedNode: AcceptedLocalStoryFlowContextNode;
	children: readonly AcceptedLocalStoryFlowContextNode[];
};
type RoutePublicationEvidence = CommonPublicationEvidence & {
	category: "ROUTE";
	acceptedStep: AcceptedLocalStoryFlowRouteStep;
	context: BoundLocalStoryFlowAcceptedContext;
	contextNodes: readonly AcceptedLocalStoryFlowContextNode[];
	previous: AcceptedLocalStoryFlowRouteStep | null;
	nativeRoot: BoundLocalStoryFlowNativeRoot;
	nativeRootProof: string;
	progressHash: string;
	tree: LocalStoryFlowArtifactProposal;
};
export type LocalStoryFlowPreparedPublicationEvidence =
	| ContextPublicationEvidence
	| RoutePublicationEvidence;
export class LocalStoryFlowPublicationError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowPublicationError";
	}
}
function requirePublication(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowPublicationError();
}
function checked<T>(read: () => T): T {
	try {
		return read();
	} catch {
		throw new LocalStoryFlowPublicationError();
	}
}
function requestedMember(options: unknown, field: "node" | "step"): unknown {
	requirePublication(
		options !== null &&
			typeof options === "object" &&
			Object.getPrototypeOf(options) === Object.prototype &&
			Object.getOwnPropertySymbols(options).length === 0,
	);
	const descriptors = Object.getOwnPropertyDescriptors(options);
	requirePublication(Object.keys(descriptors).length === 1);
	const member = descriptors[field];
	requirePublication(member?.enumerable && "value" in member);
	return member.value;
}
type Bodies = Pick<
	CommonPublicationEvidence,
	"sourceArchive" | "observation" | "artifact" | "cache" | "requiredLegacyRefs"
>;
type ArchiveProposal = Pick<Bodies, "sourceArchive" | "requiredLegacyRefs">;
const archives = new WeakMap<
	BoundLocalStoryFlowSourceArchive,
	ArchiveProposal
>();
function archiveProposal(archive: BoundLocalStoryFlowSourceArchive) {
	const cached = archives.get(archive);
	if (cached) return cached;
	const evidence = localStoryFlowSourceArchiveEvidence(archive);
	const sourceTuple = evidence.payload.sourceTuple as LocalStoryFlowSourceTuple;
	const kind = "LOCAL_FLOW_MANIFEST_V1";
	const identity = localStoryFlowRecordIdentity({
		sourceTuple,
		kind,
		key: evidence.key,
	});
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: canonicalEditingJson(evidence.payload),
	};
	const value: ArchiveProposal = {
		sourceArchive: {
			sourceTuple,
			kind,
			key: evidence.key,
			payload: evidence.payload,
			ref: { kind, ...identity, proofHash: hash(proof) },
		},
		requiredLegacyRefs: evidence.requiredLegacyRefs,
	};
	archives.set(archive, value);
	return value;
}
type CommonHandles = Pick<
	CommonPublicationEvidence,
	"archive" | "expectation" | "native"
>;
type Publication =
	| {
			category: "CONTEXT";
			handles: CommonHandles & Pick<ContextPublicationEvidence, "acceptedNode">;
			children: AcceptedLocalStoryFlowContextNode[];
			bodies: Bodies;
	  }
	| {
			category: "ROUTE";
			handles: CommonHandles &
				Pick<
					RoutePublicationEvidence,
					| "acceptedStep"
					| "context"
					| "previous"
					| "nativeRoot"
					| "nativeRootProof"
					| "progressHash"
				>;
			contextNodes: AcceptedLocalStoryFlowContextNode[];
			bodies: Bodies & Pick<RoutePublicationEvidence, "tree">;
	  };
const contexts = new WeakMap<
	BoundLocalStoryFlowAcceptedContext,
	ReturnType<typeof localStoryFlowAcceptedContextPublication>
>();
function contextPublication(
	context: BoundLocalStoryFlowAcceptedContext,
	sourceArchive: LocalStoryFlowArtifactProposal,
) {
	const cached = contexts.get(context),
		value = cached ?? localStoryFlowAcceptedContextPublication(context);
	// Compare the small task-specific association; the owned core pair already
	// checked the complete archive bytes. Equal owned archive handles are allowed.
	requirePublication(
		value.tree.kind === "LOCAL_FLOW_CONTEXT_V1" &&
			value.tree.key.purpose === "TREE" &&
			canonicalEditingJson(value.tree.sourceTuple) ===
				canonicalEditingJson(sourceArchive.sourceTuple) &&
			canonicalEditingJson(value.tree.key.keyBody.sourceArchiveRef) ===
				canonicalEditingJson(sourceArchive.ref) &&
			canonicalEditingJson(value.tree.payload.sourceArchiveRef) ===
				canonicalEditingJson(sourceArchive.ref),
	);
	if (!cached) contexts.set(context, value);
	return value;
}
const publications = new WeakMap<
	PreparedLocalStoryFlowPublication,
	Publication
>();

/** RAM preparation only. It does not attest a capture, DB row, retention or commit. */
export function prepareLocalStoryFlowContextPublication(options: {
	node: AcceptedLocalStoryFlowContextNode;
}): PreparedLocalStoryFlowPublication {
	return checked(() => {
		// The core getter, rather than this opaque cast, admits the handle.
		const node = requestedMember(
			options,
			"node",
		) as AcceptedLocalStoryFlowContextNode;
		const p = localStoryFlowAcceptedContextNodePublication(node);
		const source = archiveProposal(p.archive);
		const handle = Object.freeze({});
		publications.set(handle, {
			category: "CONTEXT",
			handles: {
				acceptedNode: node,
				archive: p.archive,
				expectation: p.expectation,
				native: p.native,
			},
			children: [...p.children],
			bodies: {
				sourceArchive: source.sourceArchive,
				observation: p.observation,
				artifact: p.node,
				cache: p.cache,
				requiredLegacyRefs: source.requiredLegacyRefs,
			},
		});
		return handle;
	});
}
/** CURRENT ROUTE preparation only; PREFIX/OUTCOME and DB authority stay in runtime. */
export function prepareLocalStoryFlowRoutePublication(options: {
	step: AcceptedLocalStoryFlowRouteStep;
}): PreparedLocalStoryFlowPublication {
	return checked(() => {
		const step = requestedMember(
			options,
			"step",
		) as AcceptedLocalStoryFlowRouteStep;
		const p = localStoryFlowAcceptedRoutePublication(step),
			source = archiveProposal(p.archive),
			context = contextPublication(p.context, source.sourceArchive),
			nativeRootProof = localStoryFlowNativeRootEvidence(
				p.nativeRoot,
			).nativeRootProof;
		requirePublication(/^[a-f0-9]{64}$/.test(nativeRootProof));
		const handle = Object.freeze({});
		publications.set(handle, {
			category: "ROUTE",
			handles: {
				acceptedStep: step,
				archive: p.archive,
				expectation: p.expectation,
				native: p.native,
				context: p.context,
				previous: p.previous,
				nativeRoot: p.nativeRoot,
				nativeRootProof,
				progressHash: p.progressHash,
			},
			contextNodes: [...context.nodes],
			bodies: {
				sourceArchive: source.sourceArchive,
				observation: p.observation,
				artifact: p.step,
				cache: p.cache,
				requiredLegacyRefs: source.requiredLegacyRefs,
				tree: context.tree,
			},
		});
		return handle;
	});
}
/** Preserve owned handles; expose fresh detached DTO bodies and ordered child arrays. */
export function localStoryFlowPreparedPublicationEvidence(
	prepared: PreparedLocalStoryFlowPublication,
): LocalStoryFlowPreparedPublicationEvidence {
	return checked(() => {
		const value = publications.get(prepared);
		requirePublication(value);
		if (value.category === "ROUTE")
			return {
				category: "ROUTE",
				...value.handles,
				contextNodes: [...value.contextNodes],
				...structuredClone(value.bodies),
			};
		return {
			category: "CONTEXT",
			...value.handles,
			children: [...value.children],
			...structuredClone(value.bodies),
		};
	});
}
