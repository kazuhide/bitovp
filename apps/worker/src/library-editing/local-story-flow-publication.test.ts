import {
	canonicalEditingJson,
	hashEditingEvidence as hash,
} from "@bitovp/core";
import {
	type AcceptedLocalStoryFlowContextNode,
	type AcceptedLocalStoryFlowRouteStep,
	type BoundLocalStoryFlowAcceptedContext,
	type BoundLocalStoryFlowSourceArchive,
	type LocalStoryFlowArtifactProposal,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordKind,
	type LocalStoryFlowSourceTuple,
	type localStoryFlowAcceptedContextNodePublication,
	type localStoryFlowAcceptedContextPublication,
	type localStoryFlowAcceptedRoutePublication,
	type localStoryFlowNativeRootEvidence,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
	type localStoryFlowSourceArchiveEvidence,
	readLocalStoryFlowSealedRecord,
} from "@bitovp/core/local-story-flow-hierarchy";
import { beforeEach, expect, it, vi } from "vitest";
import {
	LocalStoryFlowPublicationError,
	localStoryFlowPreparedPublicationEvidence,
	prepareLocalStoryFlowContextPublication,
	prepareLocalStoryFlowRoutePublication,
} from "./local-story-flow-publication";

// Private unit fakes represent the already-tested core owned getters. P1a hashing
// and outer-seal validation below are real pure functions; no DB/native authority.
const mocked = vi.hoisted(() => ({
	nodes: new WeakMap<object, unknown>(),
	archives: new WeakMap<object, unknown>(),
	contexts: new WeakMap<object, unknown>(),
	routes: new WeakMap<object, unknown>(),
	roots: new WeakMap<object, unknown>(),
	node: vi.fn(),
	archive: vi.fn(),
	context: vi.fn(),
	route: vi.fn(),
	root: vi.fn(),
}));
vi.mock("@bitovp/core/local-story-flow-hierarchy", async (original) => ({
	...(await original<
		typeof import("@bitovp/core/local-story-flow-hierarchy")
	>()),
	localStoryFlowAcceptedContextNodePublication: mocked.node,
	localStoryFlowSourceArchiveEvidence: mocked.archive,
	localStoryFlowAcceptedContextPublication: mocked.context,
	localStoryFlowAcceptedRoutePublication: mocked.route,
	localStoryFlowNativeRootEvidence: mocked.root,
}));
type CorePublication = ReturnType<
	typeof localStoryFlowAcceptedContextNodePublication
>;
type ArchiveEvidence = ReturnType<typeof localStoryFlowSourceArchiveEvidence>;
type CoreContextPublication = ReturnType<
	typeof localStoryFlowAcceptedContextPublication
>;
type CoreRoutePublication = ReturnType<
	typeof localStoryFlowAcceptedRoutePublication
>;
type RootEvidence = ReturnType<typeof localStoryFlowNativeRootEvidence>;
beforeEach(() => {
	mocked.node.mockReset().mockImplementation((node: object) => {
		const stored = mocked.nodes.get(node) as CorePublication | undefined;
		if (!stored) throw Error("SYNTHETIC_UNOWNED_NODE");
		return {
			...stored,
			children: [...stored.children],
			observation: structuredClone(stored.observation),
			node: structuredClone(stored.node),
			cache: structuredClone(stored.cache),
		};
	});
	mocked.archive.mockReset().mockImplementation((archive: object) => {
		const stored = mocked.archives.get(archive);
		if (!stored) throw Error("SYNTHETIC_UNOWNED_ARCHIVE");
		return structuredClone(stored);
	});
	mocked.context.mockReset().mockImplementation((context: object) => {
		const stored = mocked.contexts.get(context) as
			| CoreContextPublication
			| undefined;
		if (!stored) throw Error("SYNTHETIC_UNOWNED_CONTEXT");
		return { nodes: [...stored.nodes], tree: structuredClone(stored.tree) };
	});
	mocked.route.mockReset().mockImplementation((step: object) => {
		const stored = mocked.routes.get(step) as CoreRoutePublication | undefined;
		if (!stored) throw Error("SYNTHETIC_UNOWNED_STEP");
		return {
			...stored,
			observation: structuredClone(stored.observation),
			step: structuredClone(stored.step),
			cache: structuredClone(stored.cache),
		};
	});
	mocked.root.mockReset().mockImplementation((root: object) => {
		const stored = mocked.roots.get(root) as RootEvidence | undefined;
		if (!stored) throw Error("SYNTHETIC_UNOWNED_ROOT");
		return structuredClone(stored);
	});
});
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tuple: LocalStoryFlowSourceTuple = {
	version: "local-story-flow-source-tuple-v1",
	organizationId: id(1),
	sourceId: id(2),
	mediaVersionId: id(3),
	mediaSha256: "a".repeat(64),
	timeMapHash: "b".repeat(64),
	analysisRevisionId: id(4),
	analysisRawHash: "c".repeat(64),
	analysisDocumentHash: "d".repeat(64),
	bindingHash: "e".repeat(64),
	preparedShotClockHash: null,
	normalizationReceiptHash: null,
};
function archiveFixture(taskId = id(5)) {
	const archive = Object.freeze({}) as BoundLocalStoryFlowSourceArchive;
	const key: LocalStoryFlowRecordKey = {
		version: "local-story-flow-record-key-v1",
		purpose: "SOURCE_ARCHIVE",
		keyBody: {
			sourceTuple: tuple,
			taskId,
			taskPayloadHash: hash({ taskId }),
			taskPinHash: hash("SYNTHETIC_TASK_PIN"),
			sourceRecipeHash: hash("SYNTHETIC_RECIPE"),
		},
	};
	const evidence: ArchiveEvidence = {
		key,
		payload: {
			version: "local-story-flow-source-archive-v1",
			purpose: "SOURCE_ARCHIVE",
			taskId,
			sourceTuple: tuple,
			mediaSnapshot: {
				durationUs: "9000000",
				storage: { bucket: "synthetic-only" },
				probe: { streams: [{ codec_type: "video" }] },
			},
			fullInput: { shots: [{ label: "日本語の原文", refs: ["s0"] }] },
			pages: [{ items: ["complete synthetic item"] }],
			archiveHash: hash({ taskId, recipe: "synthetic" }),
		},
		requiredLegacyRefs: [
			{
				kind: "LOCAL_STORY_TRANSCRIPT_V1",
				receiptId: id(7),
				cacheHash: hash("TRANSCRIPT_CACHE"),
				inputKeyHash: hash("TRANSCRIPT_INPUT"),
				proofHash: hash("TRANSCRIPT_PROOF"),
			},
			{
				kind: "LOCAL_STORY_LEDGER_V1",
				receiptId: id(8),
				cacheHash: hash("LEDGER_CACHE"),
				inputKeyHash: hash("LEDGER_INPUT"),
				proofHash: hash("LEDGER_PROOF"),
			},
		],
	};
	mocked.archives.set(archive, evidence);
	return { archive, evidence };
}
function proposal(
	kind: LocalStoryFlowRecordKind,
	key: LocalStoryFlowRecordKey,
	payload: Record<string, unknown>,
): LocalStoryFlowArtifactProposal {
	const identity = localStoryFlowRecordIdentity({
		sourceTuple: tuple,
		kind,
		key,
	});
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: canonicalEditingJson(payload),
	};
	return {
		sourceTuple: tuple,
		kind,
		key,
		payload,
		ref: { kind, ...identity, proofHash: hash(proof) },
	};
}
function nodeFixture(
	source: ReturnType<typeof archiveFixture>,
	nodeId = "n0",
	children: AcceptedLocalStoryFlowContextNode[] = [],
) {
	const node = Object.freeze({}) as AcceptedLocalStoryFlowContextNode;
	const native = Object.freeze({}),
		expectation = Object.freeze({});
	const make = (purpose: "NODE" | "NATIVE_CACHE" | "NATIVE_OBSERVATION") =>
		proposal(
			"LOCAL_FLOW_CONTEXT_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose,
				keyBody: { nodeId, syntheticKey: hash(purpose) },
			},
			{
				purpose,
				nodeId,
				nodeHash: hash(nodeId),
				nested: { ordered: ["a", "b"] },
				terminalJob: {
					result: {
						content: ' \n{"full":"original"}\n',
						receipt: { all: true },
					},
				},
			},
		);
	const publication = {
		archive: source.archive,
		work: Object.freeze({}),
		expectation,
		native,
		children,
		observation: make("NATIVE_OBSERVATION"),
		node: make("NODE"),
		cache: make("NATIVE_CACHE"),
	};
	mocked.nodes.set(node, publication);
	return { node, publication, native, expectation };
}
it("prepares the exact closed core records and original handles without re-admitting native", () => {
	const source = archiveFixture(),
		child = nodeFixture(source, "n0");
	const parent = nodeFixture(source, "n1", [child.node]);
	const value = contextEvidence(
		prepareLocalStoryFlowContextPublication({ node: parent.node }),
	);
	expect(value.category).toBe("CONTEXT");
	expect(value.acceptedNode).toBe(parent.node);
	expect(value.archive).toBe(source.archive);
	expect(value.expectation).toBe(parent.expectation);
	expect(value.native).toBe(parent.native);
	expect(value.children[0]).toBe(child.node);
	expect(value.observation).toEqual(parent.publication.observation);
	expect(value.artifact).toEqual(parent.publication.node);
	expect(value.cache).toEqual(parent.publication.cache);
	expect(value.sourceArchive.key).toEqual(source.evidence.key);
	expect(value.sourceArchive.payload).toEqual(source.evidence.payload);
	const p = value.sourceArchive;
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: p.ref.cacheHash,
		valueJson: canonicalEditingJson(p.payload),
	};
	const sealed = readLocalStoryFlowSealedRecord({
		sourceTuple: tuple,
		kind: "LOCAL_FLOW_MANIFEST_V1",
		key: source.evidence.key,
		ref: p.ref,
		row: {
			id: p.ref.receiptId,
			organizationId: tuple.organizationId,
			sourceId: tuple.sourceId,
			mediaVersionId: tuple.mediaVersionId,
			analysisRevisionId: tuple.analysisRevisionId,
			kind: "LOCAL_FLOW_MANIFEST_V1",
			proof,
			proofHash: hash(proof),
		},
	});
	expect(localStoryFlowSealedRecordEvidence(sealed).payload).toEqual(
		source.evidence.payload,
	);
});
it("computes the full source proposal once per owned archive and preserves task wrappers", () => {
	const source = archiveFixture(),
		a = nodeFixture(source, "n0"),
		b = nodeFixture(source, "n1");
	const pa = contextEvidence(
		prepareLocalStoryFlowContextPublication({ node: a.node }),
	);
	const pb = contextEvidence(
		prepareLocalStoryFlowContextPublication({ node: b.node }),
	);
	expect(mocked.archive).toHaveBeenCalledTimes(1);
	expect(pa.sourceArchive).toEqual(pb.sourceArchive);
	const other = archiveFixture(id(6)),
		n = nodeFixture(other);
	const pc = contextEvidence(
		prepareLocalStoryFlowContextPublication({ node: n.node }),
	);
	expect(mocked.archive).toHaveBeenCalledTimes(2);
	expect(pc.sourceArchive.sourceTuple).toEqual(pa.sourceArchive.sourceTuple);
	expect(pc.sourceArchive.ref).not.toEqual(pa.sourceArchive.ref);
});
it("rejects unknown or copied nodes and unknown prepared handles with a fixed code", () => {
	const n = nodeFixture(archiveFixture());
	for (const node of [{}, { ...n.node }, null, 3])
		expect(() =>
			prepareLocalStoryFlowContextPublication({ node } as never),
		).toThrow(LocalStoryFlowPublicationError);
	expect(() => localStoryFlowPreparedPublicationEvidence({})).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
});

function first<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw Error("Missing synthetic test value");
	return value;
}
it("keeps all nonempty dependency refs, bodies and ordered children detached across plans", () => {
	const source = archiveFixture();
	const left = nodeFixture(source, "n0"),
		right = nodeFixture(source, "n1");
	const parent = nodeFixture(source, "n2", [left.node, right.node]);
	const prepared = prepareLocalStoryFlowContextPublication({
		node: parent.node,
	});
	const sibling = prepareLocalStoryFlowContextPublication({ node: left.node });
	const before = contextEvidence(prepared);
	const beforeJson = canonicalEditingJson(before);
	const copy = contextEvidence(prepared);
	(copy.artifact.payload.nested as { ordered: string[] }).ordered.reverse();
	copy.observation.payload.terminalJob = { replaced: true };
	copy.cache.ref.proofHash = "0".repeat(64);
	copy.sourceArchive.payload.fullInput = { erased: true };
	first(copy.requiredLegacyRefs).proofHash = "0".repeat(64);
	(copy.children as AcceptedLocalStoryFlowContextNode[]).reverse();
	copy.native = Object.freeze({});
	copy.expectation = Object.freeze({});
	const after = contextEvidence(prepared);
	expect(after).toEqual(before);
	expect(canonicalEditingJson(after)).toBe(beforeJson);
	expect(after.native).toBe(parent.native);
	expect(after.expectation).toBe(parent.expectation);
	expect(after.children[0]).toBe(left.node);
	expect(after.children[1]).toBe(right.node);
	expect(after.requiredLegacyRefs).toHaveLength(2);
	expect(contextEvidence(sibling).sourceArchive).toEqual(before.sourceArchive);
});
it("owns preparation independently of a later caller options mutation or copied getter DTO", () => {
	const source = archiveFixture(),
		original = nodeFixture(source),
		other = nodeFixture(source, "n1");
	const options = { node: original.node };
	const prepared = prepareLocalStoryFlowContextPublication(options);
	options.node = other.node;
	const evidence = contextEvidence(prepared);
	expect(evidence.acceptedNode).toBe(original.node);
	expect(() =>
		localStoryFlowPreparedPublicationEvidence({ ...prepared }),
	).toThrow(LocalStoryFlowPublicationError);
	expect(() => localStoryFlowPreparedPublicationEvidence(evidence)).toThrow(
		LocalStoryFlowPublicationError,
	);
	expect(() =>
		localStoryFlowPreparedPublicationEvidence(
			JSON.parse(JSON.stringify(prepared)),
		),
	).toThrow(LocalStoryFlowPublicationError);
});
it("retains exact native/expectation handles without enumerating their private properties", () => {
	const source = archiveFixture(),
		n = nodeFixture(source);
	let reads = 0;
	const opaque = () =>
		Object.defineProperty({}, "private", {
			enumerable: true,
			get() {
				reads++;
				throw Error("PRIVATE_HANDLE");
			},
		});
	const native = opaque(),
		expectation = opaque();
	mocked.nodes.set(n.node, { ...n.publication, native, expectation });
	const value = contextEvidence(
		prepareLocalStoryFlowContextPublication({ node: n.node }),
	);
	expect(value.native).toBe(native);
	expect(value.expectation).toBe(expectation);
	expect(reads).toBe(0);
});
it.each([
	"NULL",
	"UNDEFINED",
	"NUMBER",
	"STRING",
	"ARRAY",
	"NULL_PROTOTYPE",
	"CUSTOM_PROTOTYPE",
	"SYMBOL",
	"NONENUMERABLE",
	"EXTRA",
	"PROTO_KEY",
] as const)("rejects unsupported options data before consulting core: %s", (mode) => {
	const n = nodeFixture(archiveFixture());
	let input: unknown = { node: n.node };
	if (mode === "NULL") input = null;
	if (mode === "UNDEFINED") input = undefined;
	if (mode === "NUMBER") input = 7;
	if (mode === "STRING") input = "PRIVATE";
	if (mode === "ARRAY") input = [n.node];
	if (mode === "NULL_PROTOTYPE")
		input = Object.assign(Object.create(null), { node: n.node });
	if (mode === "CUSTOM_PROTOTYPE")
		input = Object.assign(Object.create({ inherited: true }), { node: n.node });
	if (mode === "SYMBOL") input = { node: n.node, [Symbol("PRIVATE")]: true };
	if (mode === "NONENUMERABLE")
		input = Object.defineProperty({}, "node", { value: n.node });
	if (mode === "EXTRA") input = { node: n.node, native: n.native };
	if (mode === "PROTO_KEY")
		Object.defineProperty(input, "__proto__", {
			enumerable: true,
			value: true,
		});
	expect(() => prepareLocalStoryFlowContextPublication(input as never)).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
	expect(mocked.node).not.toHaveBeenCalled();
});
it("rejects accessors without executing them and returns fresh code-only errors", () => {
	const n = nodeFixture(archiveFixture());
	let reads = 0;
	const hostile = Object.defineProperty({}, "node", {
		enumerable: true,
		get() {
			reads++;
			throw Error("PRIVATE_NODE");
		},
	});
	let error: unknown;
	try {
		prepareLocalStoryFlowContextPublication(hostile as never);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(LocalStoryFlowPublicationError);
	expect(error).toMatchObject({
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(error).not.toHaveProperty("cause");
	expect(error).not.toHaveProperty("metadata");
	expect(String(error)).not.toContain("PRIVATE_NODE");
	expect(reads).toBe(0);
	expect(mocked.node).not.toHaveBeenCalled();
	const good = prepareLocalStoryFlowContextPublication(
		Object.freeze({ node: n.node }),
	);
	expect(contextEvidence(good).acceptedNode).toBe(n.node);
});
it.each([
	"PROTOTYPE",
	"DESCRIPTORS",
] as const)("fixes hostile proxy exceptions: %s", (mode) => {
	const n = nodeFixture(archiveFixture());
	const privateError = Error("PRIVATE_PROXY");
	const hostile = new Proxy(
		{ node: n.node },
		mode === "PROTOTYPE"
			? {
					getPrototypeOf() {
						throw privateError;
					},
				}
			: {
					ownKeys() {
						throw privateError;
					},
				},
	);
	let error: unknown;
	try {
		prepareLocalStoryFlowContextPublication(hostile);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(LocalStoryFlowPublicationError);
	expect(error).not.toBe(privateError);
	expect(String(error)).toBe(
		"LocalStoryFlowPublicationError: LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
	expect(error).not.toHaveProperty("cause");
});
it("does not expose raw core errors or retain a failed archive preparation as an empty fallback", () => {
	const n = nodeFixture(archiveFixture());
	const privateError = Object.assign(Error("PRIVATE_CORE"), {
		cause: "PRIVATE",
		metadata: { raw: true },
	});
	mocked.archive.mockImplementationOnce(() => {
		throw privateError;
	});
	let error: unknown;
	try {
		prepareLocalStoryFlowContextPublication({ node: n.node });
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(LocalStoryFlowPublicationError);
	expect(error).not.toBe(privateError);
	expect(String(error)).not.toContain("PRIVATE");
	expect(error).not.toHaveProperty("cause");
	expect(error).not.toHaveProperty("metadata");
	const value = contextEvidence(
		prepareLocalStoryFlowContextPublication({ node: n.node }),
	);
	expect(value.sourceArchive.payload.fullInput).toEqual({
		shots: [{ label: "日本語の原文", refs: ["s0"] }],
	});
	expect(mocked.archive).toHaveBeenCalledTimes(2);
});
it("exposes only the adopted closed CONTEXT contract without runtime authority or route stubs", () => {
	const n = nodeFixture(archiveFixture());
	const value = contextEvidence(
		prepareLocalStoryFlowContextPublication({ node: n.node }),
	);
	expect(Object.keys(value).sort()).toEqual(
		[
			"category",
			"acceptedNode",
			"archive",
			"expectation",
			"native",
			"children",
			"sourceArchive",
			"observation",
			"artifact",
			"cache",
			"requiredLegacyRefs",
		].sort(),
	);
	expect(value).not.toHaveProperty("capture");
	expect(value).not.toHaveProperty("tx");
	expect(value).not.toHaveProperty("ready");
});

function contextEvidence(
	prepared: Parameters<typeof localStoryFlowPreparedPublicationEvidence>[0],
) {
	const value = localStoryFlowPreparedPublicationEvidence(prepared);
	if (value.category !== "CONTEXT") throw Error("Expected CONTEXT publication");
	return value;
}

function contextFixture(source: ReturnType<typeof archiveFixture>) {
	const context = Object.freeze({}) as BoundLocalStoryFlowAcceptedContext;
	const left = nodeFixture(source, "n0"),
		right = nodeFixture(source, "n1"),
		parent = nodeFixture(source, "n2", [left.node, right.node]);
	const nodes = [left.node, right.node, parent.node];
	const sourceRef = proposal(
		"LOCAL_FLOW_MANIFEST_V1",
		source.evidence.key,
		source.evidence.payload,
	).ref;
	const orderedNodeRefs = [left, right, parent].map(
		(n) => n.publication.node.ref,
	);
	const tree = proposal(
		"LOCAL_FLOW_CONTEXT_V1",
		{
			version: "local-story-flow-record-key-v1",
			purpose: "TREE",
			keyBody: { sourceArchiveRef: sourceRef, orderedNodeRefs },
		},
		{
			purpose: "TREE",
			sourceArchiveRef: sourceRef,
			orderedNodeRefs,
			treeEvidence: { all: ["left", "right", "parent"] },
			treeHash: hash("COMPLETE_SYNTHETIC_TREE"),
		},
	);
	mocked.contexts.set(context, { nodes, tree });
	return { context, nodes, tree, left, right, parent };
}
let routeSequence = 0;
function routeFixture(
	source: ReturnType<typeof archiveFixture>,
	context = contextFixture(source),
	previous?: {
		step: AcceptedLocalStoryFlowRouteStep;
		nativeRoot: Readonly<object>;
	},
) {
	const ordinal = ++routeSequence,
		step = Object.freeze({}) as AcceptedLocalStoryFlowRouteStep,
		native = Object.freeze({}),
		expectation = Object.freeze({}),
		nativeRoot = previous?.nativeRoot ?? Object.freeze({});
	const make = (purpose: "STEP" | "NATIVE_OBSERVATION" | "NATIVE_CACHE") =>
		proposal(
			"LOCAL_FLOW_ROUTE_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose,
				keyBody: { syntheticStep: ordinal, discriminator: hash(purpose) },
			},
			{
				purpose,
				stepHash: hash({ ordinal }),
				nested: { ordered: ["original", "wire"] },
				terminalJob: { result: { content: ' \n{"phase":"original"}\n' } },
			},
		);
	const publication = {
		archive: source.archive,
		context: context.context,
		work: Object.freeze({}),
		expectation,
		native,
		previous: previous?.step ?? null,
		nativeRoot,
		progressHash: hash({ progress: ordinal }),
		observation: make("NATIVE_OBSERVATION"),
		step: make("STEP"),
		cache: make("NATIVE_CACHE"),
	};
	if (!previous)
		mocked.roots.set(nativeRoot, {
			version: "local-story-flow-native-root-proof-v1",
			sourceBindingHash: hash("SOURCE_BINDING"),
			treeHash: context.tree.payload.treeHash,
			targetFrames: 90,
			rootCoreInputHash: hash("ROOT_INPUT"),
			rootObservationRef: publication.observation.ref,
			rootContentUtf8Hash: hash("ROOT_CONTENT"),
			rootCoreStepHash: hash("ROOT_CORE_STEP"),
			nativeRootProof: hash({ root: ordinal }),
		});
	mocked.routes.set(step, publication);
	return { step, publication, native, expectation, nativeRoot, context };
}
function routeEvidence(
	prepared: Parameters<typeof localStoryFlowPreparedPublicationEvidence>[0],
) {
	const value = localStoryFlowPreparedPublicationEvidence(prepared);
	if (value.category !== "ROUTE") throw Error("Expected ROUTE publication");
	return value;
}
it("prepares exactly the closed ROUTE17 contract with every original context node", () => {
	const source = archiveFixture(),
		r = routeFixture(source);
	const value = routeEvidence(
		prepareLocalStoryFlowRoutePublication({ step: r.step }),
	);
	expect(Object.keys(value).sort()).toEqual(
		[
			"category",
			"acceptedStep",
			"archive",
			"expectation",
			"native",
			"sourceArchive",
			"observation",
			"artifact",
			"cache",
			"requiredLegacyRefs",
			"context",
			"contextNodes",
			"previous",
			"nativeRoot",
			"nativeRootProof",
			"progressHash",
			"tree",
		].sort(),
	);
	expect(value.acceptedStep).toBe(r.step);
	expect(value.archive).toBe(source.archive);
	expect(value.context).toBe(r.context.context);
	expect(value.expectation).toBe(r.expectation);
	expect(value.native).toBe(r.native);
	expect(value.previous).toBeNull();
	expect(value.nativeRoot).toBe(r.nativeRoot);
	expect(value.nativeRootProof).toBe(
		(mocked.roots.get(r.nativeRoot) as RootEvidence).nativeRootProof,
	);
	expect(value.nativeRootProof).not.toBe(r.publication.step.payload.stepHash);
	expect(value.progressHash).toBe(r.publication.progressHash);
	expect(value.contextNodes).toHaveLength(3);
	for (const [index, node] of r.context.nodes.entries())
		expect(value.contextNodes[index]).toBe(node);
	expect(value.observation).toEqual(r.publication.observation);
	expect(value.artifact).toEqual(r.publication.step);
	expect(value.cache).toEqual(r.publication.cache);
	expect(value.tree).toEqual(r.context.tree);
	expect(value.sourceArchive.payload).toEqual(source.evidence.payload);
	expect(value.requiredLegacyRefs).toEqual(source.evidence.requiredLegacyRefs);
	expect(value).not.toHaveProperty("work");
	expect(value).not.toHaveProperty("children");
	expect(value).not.toHaveProperty("tx");
});
it("preserves previous and the same owned ROOT on followup without reconstructing native", () => {
	const source = archiveFixture(),
		root = routeFixture(source),
		followup = routeFixture(source, root.context, root);
	const a = routeEvidence(
			prepareLocalStoryFlowRoutePublication({ step: root.step }),
		),
		b = routeEvidence(
			prepareLocalStoryFlowRoutePublication({ step: followup.step }),
		);
	expect(b.previous).toBe(root.step);
	expect(b.nativeRoot).toBe(a.nativeRoot);
	expect(b.nativeRootProof).toBe(a.nativeRootProof);
	expect(b.native).toBe(followup.native);
	expect(b.expectation).toBe(followup.expectation);
	expect(b.progressHash).not.toBe(a.progressHash);
	expect(b.artifact).toEqual(followup.publication.step);
});
it("detaches every ROUTE DTO and node array across plans and getters", () => {
	const source = archiveFixture(),
		r = routeFixture(source),
		followup = routeFixture(source, r.context, r);
	const prepared = prepareLocalStoryFlowRoutePublication({ step: r.step }),
		other = prepareLocalStoryFlowRoutePublication({ step: followup.step });
	const before = routeEvidence(prepared),
		beforeOther = routeEvidence(other),
		copy = routeEvidence(prepared);
	const beforeJson = canonicalEditingJson(before),
		beforeOtherJson = canonicalEditingJson(beforeOther);
	(copy.contextNodes as AcceptedLocalStoryFlowContextNode[]).reverse();
	(copy.tree.payload.treeEvidence as { all: string[] }).all.pop();
	copy.tree.ref.proofHash = "0".repeat(64);
	(copy.artifact.payload.nested as { ordered: string[] }).ordered.reverse();
	copy.observation.payload.terminalJob = { erased: true };
	copy.cache.ref.proofHash = "0".repeat(64);
	copy.sourceArchive.payload.fullInput = { erased: true };
	first(copy.requiredLegacyRefs).proofHash = "0".repeat(64);
	copy.previous = {};
	copy.nativeRoot = {};
	copy.nativeRootProof = "0".repeat(64);
	expect(routeEvidence(prepared)).toEqual(before);
	expect(routeEvidence(other)).toEqual(beforeOther);
	expect(canonicalEditingJson(routeEvidence(prepared))).toBe(beforeJson);
	expect(canonicalEditingJson(routeEvidence(other))).toBe(beforeOtherJson);
	expect(routeEvidence(prepared).contextNodes[0]).toBe(r.context.nodes[0]);
});
it("shares archive and complete context preparation once across CONTEXT and ROUTE steps", () => {
	const source = archiveFixture(),
		r = routeFixture(source),
		followup = routeFixture(source, r.context, r);
	prepareLocalStoryFlowContextPublication({ node: r.context.left.node });
	const a = routeEvidence(
			prepareLocalStoryFlowRoutePublication({ step: r.step }),
		),
		b = routeEvidence(
			prepareLocalStoryFlowRoutePublication({ step: followup.step }),
		);
	expect(mocked.archive).toHaveBeenCalledTimes(1);
	expect(mocked.context).toHaveBeenCalledTimes(1);
	expect(a.sourceArchive).toEqual(b.sourceArchive);
	expect(a.tree).toEqual(b.tree);
	const equalArchive = Object.freeze({}) as BoundLocalStoryFlowSourceArchive;
	mocked.archives.set(equalArchive, structuredClone(source.evidence));
	const sameBytes = routeFixture(
		{ ...source, archive: equalArchive },
		r.context,
	);
	const equal = routeEvidence(
		prepareLocalStoryFlowRoutePublication({ step: sameBytes.step }),
	);
	expect(equal.archive).toBe(equalArchive);
	expect(equal.sourceArchive).toEqual(a.sourceArchive);
	expect(mocked.archive).toHaveBeenCalledTimes(2);
	expect(mocked.context).toHaveBeenCalledTimes(1);
});
it.each([
	"KEY",
	"PAYLOAD",
] as const)("rejects a TREE with a different %s source association without empty memo fallback", (where) => {
	const source = archiveFixture(),
		r = routeFixture(source),
		bad = structuredClone(r.context.tree);
	const ref = {
		...(bad.payload.sourceArchiveRef as LocalStoryFlowArtifactProposal["ref"]),
		proofHash: "0".repeat(64),
	};
	if (where === "KEY") bad.key.keyBody.sourceArchiveRef = ref;
	else bad.payload.sourceArchiveRef = ref;
	mocked.context.mockImplementationOnce(() => ({
		nodes: [...r.context.nodes],
		tree: bad,
	}));
	expect(() => prepareLocalStoryFlowRoutePublication({ step: r.step })).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
	expect(
		routeEvidence(prepareLocalStoryFlowRoutePublication({ step: r.step })).tree,
	).toEqual(r.context.tree);
});
it.each([
	"PROBE",
	"STORAGE",
	"TASK",
] as const)("rejects same-T %s archive replacement even with the same context tree hash", (field) => {
	const source = archiveFixture(),
		r = routeFixture(source),
		other = Object.freeze({}) as BoundLocalStoryFlowSourceArchive,
		evidence = structuredClone(source.evidence);
	if (field === "TASK") {
		evidence.payload.taskId = id(99);
		evidence.key.keyBody.taskId = id(99);
	} else {
		const media = evidence.payload.mediaSnapshot as Record<string, unknown>;
		media[field === "PROBE" ? "probe" : "storage"] = { changed: true };
	}
	mocked.archives.set(other, evidence);
	mocked.routes.set(r.step, { ...r.publication, archive: other });
	expect(() => prepareLocalStoryFlowRoutePublication({ step: r.step })).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
});
it.each([
	"",
	"not a proof",
	"0".repeat(63),
] as const)("rejects malformed owned root digest %j without exposing a root DTO", (nativeRootProof) => {
	const r = routeFixture(archiveFixture());
	mocked.roots.set(r.nativeRoot, {
		...(mocked.roots.get(r.nativeRoot) as RootEvidence),
		nativeRootProof,
	});
	expect(() => prepareLocalStoryFlowRoutePublication({ step: r.step })).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
});
it.each([
	"NULL",
	"UNDEFINED",
	"NUMBER",
	"ARRAY",
	"NULL_PROTOTYPE",
	"CUSTOM_PROTOTYPE",
	"SYMBOL",
	"HIDDEN",
	"EXTRA",
	"PROTO_KEY",
] as const)("rejects ROUTE %s options before reading a core handle", (mode) => {
	const r = routeFixture(archiveFixture());
	let options: unknown = { step: r.step };
	if (mode === "NULL") options = null;
	if (mode === "UNDEFINED") options = undefined;
	if (mode === "NUMBER") options = 1;
	if (mode === "ARRAY") options = [r.step];
	if (mode === "NULL_PROTOTYPE")
		options = Object.assign(Object.create(null), { step: r.step });
	if (mode === "CUSTOM_PROTOTYPE")
		options = Object.assign(Object.create({ inherited: true }), {
			step: r.step,
		});
	if (mode === "SYMBOL") options = { step: r.step, [Symbol("private")]: true };
	if (mode === "HIDDEN")
		options = Object.defineProperty({}, "step", { value: r.step });
	if (mode === "EXTRA") options = { step: r.step, previous: null };
	if (mode === "PROTO_KEY")
		Object.defineProperty(options, "__proto__", {
			value: true,
			enumerable: true,
		});
	expect(() => prepareLocalStoryFlowRoutePublication(options as never)).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
	expect(mocked.route).not.toHaveBeenCalled();
});
it("does not execute ROUTE option or opaque handle getters and fixes private exceptions", () => {
	const r = routeFixture(archiveFixture()),
		getter = vi.fn(() => {
			throw Error("PRIVATE_STEP");
		});
	const options = Object.defineProperty({}, "step", {
		get: getter,
		enumerable: true,
	});
	expect(() => prepareLocalStoryFlowRoutePublication(options as never)).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
	expect(getter).not.toHaveBeenCalled();
	expect(mocked.route).not.toHaveBeenCalled();
	const opaque = Object.defineProperty({}, "private", {
		get: getter,
		enumerable: true,
	});
	mocked.routes.set(r.step, {
		...r.publication,
		native: opaque,
		expectation: opaque,
	});
	const value = routeEvidence(
		prepareLocalStoryFlowRoutePublication({ step: r.step }),
	);
	expect(value.native).toBe(opaque);
	expect(value.expectation).toBe(opaque);
	expect(getter).not.toHaveBeenCalled();
	for (const step of [{}, { ...r.step }, value])
		expect(() => prepareLocalStoryFlowRoutePublication({ step })).toThrow(
			LocalStoryFlowPublicationError,
		);
});
it.each([
	"route",
	"context",
	"root",
] as const)("rejects %s getter failure with a fresh code-only error", (which) => {
	const r = routeFixture(archiveFixture()),
		privateError = Object.assign(Error("PRIVATE_CORE"), {
			cause: "PRIVATE",
			metadata: true,
		});
	mocked[which].mockImplementationOnce(() => {
		throw privateError;
	});
	let error: unknown;
	try {
		prepareLocalStoryFlowRoutePublication({ step: r.step });
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(LocalStoryFlowPublicationError);
	expect(error).not.toBe(privateError);
	expect(String(error)).not.toContain("PRIVATE_CORE");
	expect(error).not.toHaveProperty("cause");
	expect(error).not.toHaveProperty("metadata");
});
