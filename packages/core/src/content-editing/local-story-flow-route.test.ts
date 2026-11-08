import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import {
	localStoryIdentityForConfiguration,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import type { LocalStoryInput } from "./local-story-contracts";
import {
	type BoundLocalStoryFlowContextNode,
	buildLocalStoryFlowContextNode,
	localStoryFlowContextNodeEvidence,
	localStoryFlowContextSourceEvidence,
	prepareLocalStoryFlowContextSource,
} from "./local-story-flow-context";
import {
	buildLocalStoryFlowContextTree,
	localStoryFlowContextTreeEvidence,
} from "./local-story-flow-context-tree";
import {
	LOCAL_STORY_FLOW_H1_POLICY,
	type LocalStoryFlowContextOutput,
	localStoryFlowRouteOutputSchema,
} from "./local-story-flow-contracts";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import * as routeModule from "./local-story-flow-route";
import {
	buildLocalStoryFlowRouteExpectation,
	buildLocalStoryFlowRouteStep,
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	LocalStoryFlowRouteError,
	localStoryFlowRouteExpectationEvidence,
	localStoryFlowRouteStepEvidence,
	validateLocalStoryFlowRouteStep,
} from "./local-story-flow-route";
import {
	localStoryFlowIdentityForConfiguration,
	localStoryFlowStageRegistry,
} from "./local-story-flow-stages";
import { buildLocalStoryChunks } from "./local-story-input";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

const config: LocalSemanticConfiguration = {
	url: "https://fixture.invalid/",
	token: "synthetic-test-token-".repeat(3),
	caFile: "/never-read/fixture.pem",
	profile: "nvidia",
	configId: "44444444-4444-4444-8444-444444444444",
};
const event = (n: number) => ({ kind: "EVENT" as const, eventId: `l${n}_e0` });
type LeafOutput = Extract<LocalStoryFlowContextOutput, { phase: "LEAF" }>;
type MergeOutput = Extract<LocalStoryFlowContextOutput, { phase: "MERGE" }>;
function first<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("Missing authored synthetic value");
	return value;
}
function fixture(
	options: {
		count?: number;
		summaryChars?: number;
		selected?: number[];
		goalText?: string;
		subjects?: string[];
		label?: (index: number) => string;
		profile?: "nvidia" | "amd";
		mutate?: (input: LocalStoryInput) => void;
		leaf?: (output: LeafOutput) => void;
		merge?: (output: MergeOutput) => void;
	} = {},
) {
	const count = options.count ?? 2,
		configuration = { ...config, profile: options.profile ?? config.profile };
	const timeMap = cfrTimeMapSchema.parse({
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: count * 3_000_000,
		editingStartFrame: 0,
		editingEndFrame: count * 90,
		fps: { num: 30, den: 1 },
	});
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "鍵",
		description: "鍵を返す。",
		timeMap,
		timeMapHash: hash(timeMap),
		segments: [],
		scenes: [{ sceneId: "scene", text: "鍵を探す場面", fields: [] }],
		shots: Array.from({ length: count }, (_, i) => ({
			ref: `s${i}`,
			sceneId: "scene",
			shotIndex: i,
			fromFrame: i * 90,
			toFrame: (i + 1) * 90,
			text: `人物は鍵を見つける。${"あ".repeat(900)}`,
			fields: [
				{ kind: "AISA", pointer: `/shots/${i}`, text: "人物は鍵を見つける。" },
			],
		})),
		coverage: Array.from({ length: count }, (_, i) => ({
			ref: `s${i}`,
			status: "ELIGIBLE",
		})),
	};
	options.mutate?.(input);
	const chunks = buildLocalStoryChunks(input),
		model = localStoryIdentityForConfiguration(configuration);
	const ledgers = chunks.map((chunk, index) => ({
		summary: options.summaryChars
			? "あ".repeat(options.summaryChars)
			: "人物が鍵を見つける。",
		events: [
			{
				id: "e0",
				label: options.label?.(index) ?? "鍵を見つける",
				role: "ACTION" as const,
				refs: [chunk.refs[0] ?? "missing"],
				quotes: [
					{ ref: chunk.refs[0] ?? "missing", quote: "人物は鍵を見つける。" },
				],
				subjects: options.subjects ?? ["人物", "鍵"],
				uncertainty: "文脈は未確認",
			},
		],
	}));
	const transcriptFingerprint = "a".repeat(64),
		schemaHash = localStoryStageRegistry().stages.LOCAL_LEDGER_V1.schemaHash;
	const ledgerRefs = chunks.map((chunk, chunkIndex) => {
		const stageInputHash = hash({ chunk, transcriptFingerprint }),
			promptHash = hash("authored synthetic accepted prompt");
		return {
			chunkIndex,
			stageInputHash,
			promptHash,
			schemaHash,
			ledgerHash: hash(ledgers[chunkIndex]),
			stageKeyHash: hash({
				identity: model,
				stage: "LOCAL_LEDGER_V1",
				inputHash: stageInputHash,
				promptHash,
				schemaHash,
			}),
		};
	});
	const h0 = {
		input,
		chunks,
		ledgers,
		model,
		transcriptFingerprint,
		ledgerRefs,
	};
	const manifest = buildLocalStoryFlowManifest(h0),
		pages = buildLocalStoryFlowLeafPages(manifest);
	const source = prepareLocalStoryFlowContextSource({
		h0,
		manifest,
		pages,
		workflow: localStoryFlowIdentityForConfiguration(configuration, "FLOW"),
		config: configuration,
		mode: "FLOW",
	});
	const e = localStoryFlowContextSourceEvidence(source),
		byId = new Map<string, BoundLocalStoryFlowContextNode>(),
		nodes: BoundLocalStoryFlowContextNode[] = [];
	const selected = new Set(
		(options.selected ?? [0]).map((n) => event(n).eventId),
	);
	for (const plan of e.layout.nodes) {
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const child = byId.get(id);
						if (!child) throw new Error("Missing authored child");
						return child;
					});
		let output: LocalStoryFlowContextOutput;
		if (plan.phase === "LEAF") {
			const page = first(e.pages.filter((p) => p.pageId === plan.pageId));
			const accountedItems = page.data.items.map((i) =>
				i.kind === "DERIVED_CHUNK_SUMMARY"
					? { kind: "SUMMARY" as const, summaryId: i.id }
					: { kind: "EVENT" as const, eventId: i.id },
			);
			const events = accountedItems.filter(
					(r): r is ReturnType<typeof event> => r.kind === "EVENT",
				),
				chosen = events.filter((r) => selected.has(r.eventId));
			output = {
				version: "local-story-flow-context-output-v1",
				phase: "LEAF",
				mode: "FLOW",
				nodeId: plan.nodeId,
				pageId: page.pageId,
				accountedItems,
				claims: events.length
					? [
							{
								id: "c0",
								text: options.goalText ?? '目的　鍵を"返す"。',
								supports: events,
								witnesses: [
									{ id: "w0", allOf: chosen.length ? chosen : [first(events)] },
								],
							},
						]
					: [],
				relations: [],
				unresolved: [],
			};
			options.leaf?.(output);
		} else {
			const values = children.map(localStoryFlowContextNodeEvidence),
				chosen = values.filter((v) =>
					first(v.witnessProofs).events.some((e) =>
						selected.has(e.ref.eventId),
					),
				);
			output = {
				version: "local-story-flow-context-output-v1",
				phase: "MERGE",
				mode: "FLOW",
				nodeId: plan.nodeId,
				accountedChildren: plan.children.map((nodeId) => ({
					kind: "CHILD_NODE",
					nodeId,
				})),
				claims: [
					{
						id: "c0",
						text: options.goalText ?? '目的　鍵を"返す"。',
						supports: values.map((v) => first(v.claimRefs)),
						witnesses: [
							{
								id: "w0",
								allOf: (chosen.length ? chosen : [first(values)]).map(
									(v) => first(v.witnessProofs).ref,
								),
							},
						],
					},
				],
				relations: [],
				unresolved: [],
			};
			options.merge?.(output);
		}
		const node = buildLocalStoryFlowContextNode({
			source,
			nodeId: plan.nodeId,
			children,
			output,
		});
		byId.set(plan.nodeId, node);
		nodes.push(node);
	}
	return {
		source,
		tree: buildLocalStoryFlowContextTree({ source, nodes }),
		targetFrames: 300,
	};
}

describe("H1c-2 pre-choice route input", () => {
	it("binds the full owned tree and dedicated stage before any ROOT choice", () => {
		const f = fixture(),
			tree = localStoryFlowContextTreeEvidence(f.tree, f.source);
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "ROOT",
			...f,
		});
		const e = localStoryFlowRouteExpectationEvidence(expectation),
			root = tree.nodes[0];
		expect(e.continuation).toEqual({ kind: "ROOT_START" });
		expect(e.input.binding).toEqual({
			kind: "PRE_ROOT",
			rootSelectionPolicy: "source-grounded-flow-goal-v1",
		});
		expect(e.input.data).toEqual(root?.publicView);
		expect(e.input.treeHash).toBe(tree.treeHash);
		const stage = localStoryFlowStageRegistry().stages.LOCAL_FLOW_ROUTE_V1;
		expect(e.input.stage).toEqual({
			name: "LOCAL_FLOW_ROUTE_V1",
			promptVersion: stage.promptVersion,
			schemaHash: stage.schemaHash,
			maxOutputTokens: stage.maxOutputTokens,
		});
		expect(e.input.dataUtf8Bytes).toBe(
			Buffer.byteLength(canonicalEditingJson(e.input.data)),
		);
		expect(Object.isFrozen(expectation)).toBe(true);
	});
	it("rejects aliases, accessors and invalid duration without reading an accessor", () => {
		const f = fixture();
		let reads = 0;
		const options = { phase: "ROOT" as const, ...f };
		expect(() =>
			buildLocalStoryFlowRouteExpectation({ ...options, targetFrames: 0 }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_DURATION_INVALID");
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				...options,
				rootChoice: undefined,
			} as typeof options),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		Object.defineProperty(options, "targetFrames", {
			enumerable: true,
			get() {
				reads++;
				return 300;
			},
		});
		expect(() => buildLocalStoryFlowRouteExpectation(options)).toThrow(
			"LOCAL_STORY_FLOW_ROUTE_INVALID",
		);
		expect(reads).toBe(0);
	});
	it("binds a ROOT observation without a circular self step hash and fixes B", () => {
		const f = fixture(),
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				...f,
			});
		const output = rootOutput(),
			step = buildLocalStoryFlowRouteStep({ expectation, output });
		const e = localStoryFlowRouteStepEvidence(step);
		expect(e.after.closure.rootEvents.map((e) => e.ref)).toEqual([event(0)]);
		expect(e.after.closure.hardChoices).toEqual([]);
		expect(e.after.closureResult.status).toBe("COMPLETE");
		expect(e.after.seeds).toEqual([]);
		expect(e.after.navigation.branches).toEqual([]);
		expect(e.after.navigation.exposedPages).toEqual([]);
		expect(e.observationHash).toBe(
			hash({
				version: "local-story-flow-route-observation-v1",
				expectationHash: e.expectation.expectationHash,
				rawOutputHash: hash(output),
			}),
		);
		const { stepHash, ...body } = e;
		expect(stepHash).toBe(hash(body));
		expect(e).not.toHaveProperty("structuralRootStepHash");
		output.choice.claim.claimId = "c1";
		e.after.closure.rootEvents.length = 0;
		expect(localStoryFlowRouteStepEvidence(step).rawOutput).toEqual(
			rootOutput(),
		);
		expect(
			localStoryFlowRouteStepEvidence(step).after.closure.rootEvents,
		).toHaveLength(1);
	});
});

describe("H1c-2 exact pending WITNESS", () => {
	it("appends only the first requested whole hard witness using its owner's full view", () => {
		const f = fixture({
			leaf(output) {
				first(first(output.claims).witnesses).allOf = [event(1)];
				output.claims.push({
					id: "c1",
					text: "鍵を先に見つける。",
					supports: [event(0)],
					witnesses: [{ id: "w0", allOf: [event(0)] }],
				});
				output.relations.push({
					kind: "REQUIRES",
					from: event(1),
					target: { kind: "OWN_CLAIM", claimId: "c1" },
				});
			},
		});
		const root = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput(),
		});
		const before = localStoryFlowRouteStepEvidence(root);
		expect(before.after.closureResult.status).toBe("PENDING_HARD_CHOICE");
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "WITNESS",
			previousStep: root,
		});
		const e = localStoryFlowRouteExpectationEvidence(expectation),
			tree = localStoryFlowContextTreeEvidence(f.tree, f.source);
		expect(e.input.data).toEqual(tree.nodes[0]?.publicView);
		expect(e.input.control).toMatchObject({
			goalText: '目的　鍵を"返す"。',
			requestedClaim: { kind: "CLAIM", nodeId: "n0", claimId: "c1" },
		});
		expect(e.input.binding).toEqual({
			kind: "FOLLOWUP",
			structuralRootStepHash: before.stepHash,
			closureStateHash: before.after.closure.structuralStateHash,
			seedsHash: hash([]),
			pending: {
				origin: { ownerNodeId: "n0", index: 0 },
				requestedClaim: { kind: "CLAIM", nodeId: "n0", claimId: "c1" },
			},
		});
		const wrong = {
			...rootOutput(),
			phase: "WITNESS" as const,
			choice: { ...rootOutput().choice, kind: "HARD_REQUIREMENT" as const },
		};
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: wrong }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const output = {
			...wrong,
			choice: {
				kind: "HARD_REQUIREMENT" as const,
				claim: { kind: "CLAIM" as const, nodeId: "n0", claimId: "c1" },
				witness: {
					kind: "WITNESS" as const,
					nodeId: "n0",
					claimId: "c1",
					witnessId: "w0",
				},
			},
		};
		const step = buildLocalStoryFlowRouteStep({ expectation, output }),
			after = localStoryFlowRouteStepEvidence(step);
		expect(after.after.closureResult.status).toBe("COMPLETE");
		expect(after.after.closure.rootChoice).toEqual(
			before.after.closure.rootChoice,
		);
		expect(after.after.closure.rootEvents).toEqual(
			before.after.closure.rootEvents,
		);
		expect(after.after.seeds).toEqual([]);
		expect(after.after.closure.hardChoices).toHaveLength(1);
		expect(after.after.closureResult.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
		]);
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "WITNESS",
				previousStep: step,
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_NOT_READY");
		expect(localStoryFlowRouteStepEvidence(root)).toEqual(before);
	});
});

function rootOutput(nodeId = "n0") {
	return {
		version: "local-story-flow-route-output-v1" as const,
		phase: "ROOT" as const,
		mode: "FLOW" as const,
		nodeId,
		choice: {
			kind: "ROOT_GOAL" as const,
			claim: { kind: "CLAIM" as const, nodeId, claimId: "c0" },
			witness: {
				kind: "WITNESS" as const,
				nodeId,
				claimId: "c0",
				witnessId: "w0",
			},
		},
		unresolved: [],
	};
}

function leafOutput(
	f: ReturnType<typeof fixture>,
	candidates: ReturnType<typeof event>[] = [],
	nodeId = "n0",
) {
	const e = localStoryFlowContextSourceEvidence(f.source),
		plan = e.layout.nodes.find((n) => n.nodeId === nodeId);
	if (plan?.phase !== "LEAF") throw new Error("Missing authored leaf");
	const page = e.pages.find((p) => p.pageId === plan.pageId);
	if (!page) throw new Error("Missing authored page");
	return {
		version: "local-story-flow-route-output-v1" as const,
		phase: "LEAF" as const,
		mode: "FLOW" as const,
		nodeId,
		pageId: page.pageId,
		accountedItems: page.data.items.map((i) =>
			i.kind === "DERIVED_CHUNK_SUMMARY"
				? { kind: "SUMMARY" as const, summaryId: i.id }
				: { kind: "EVENT" as const, eventId: i.id },
		),
		candidates,
		unresolved: [],
	};
}

describe("H1c-2 whole leaf exposure", () => {
	it("uses original page data and retains monotonic source-ordered seeds while raw candidate order stays exact", () => {
		const f = fixture(),
			root = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
				}),
				output: rootOutput(),
			});
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "LEAF",
			previousStep: root,
			nodeId: "n0",
		});
		const e = localStoryFlowRouteExpectationEvidence(expectation),
			source = localStoryFlowContextSourceEvidence(f.source);
		expect(e.input.data).toEqual(source.pages[0]?.data);
		expect(e.input.control).toEqual({
			version: "local-story-flow-route-control-v1",
			mode: "FLOW",
			phase: "LEAF",
			targetFrames: 300,
			nodeId: "n0",
			goalText: '目的　鍵を"返す"。',
			requiredEvents: [event(0)],
		});
		const output = leafOutput(f, [event(1), event(0)]),
			step = buildLocalStoryFlowRouteStep({ expectation, output });
		const after = localStoryFlowRouteStepEvidence(step);
		expect(after.after.seeds).toEqual([event(0), event(1)]);
		expect(after.rawOutput).toEqual(output);
		expect(after.after.knownRequiredExposureGaps).toEqual([]);
		expect(after.after.navigation.exposedPages).toEqual([
			{
				nodeId: "n0",
				pageId: source.pages[0]?.pageId,
				pageHash: source.pages[0]?.pageHash,
				dataHash: source.pages[0]?.dataHash,
				observationHash: after.observationHash,
			},
		]);
		const repeated = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: step,
				nodeId: "n0",
			}),
			output: leafOutput(f),
		});
		expect(localStoryFlowRouteStepEvidence(repeated).after.seeds).toEqual([
			event(0),
			event(1),
		]);
		expect(
			localStoryFlowRouteStepEvidence(root).after.navigation.exposedPages,
		).toEqual([]);
	});
	it("refuses missing and forged page account even when the raw schema is self-consistent", () => {
		const f = fixture(),
			root = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
				}),
				output: rootOutput(),
			});
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "LEAF",
			previousStep: root,
			nodeId: "n0",
		});
		const missing = leafOutput(f);
		missing.accountedItems.pop();
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: missing }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const forged = leafOutput(f, [event(2)]);
		forged.accountedItems.push(event(2));
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: forged }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
	});
	it("requires accepted leaf exposure and builds complete FINALIZE cards and immutable commitments", () => {
		const f = fixture(),
			root = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
				}),
				output: rootOutput(),
			});
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "FINALIZE",
				previousStep: root,
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_EXPOSURE_INCOMPLETE");
		const leaf = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: root,
				nodeId: "n0",
			}),
			output: leafOutput(f),
		});
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "FINALIZE",
			previousStep: leaf,
		});
		const e = localStoryFlowRouteExpectationEvidence(expectation),
			source = localStoryFlowContextSourceEvidence(f.source);
		expect(e.input.data).toMatchObject({
			events: source.pages[0]?.data.items.filter((i) => i.id === "l0_e0"),
			constraints: {
				commitments: [
					{
						choice: rootOutput().choice,
						claimText: '目的　鍵を"返す"。',
						events: [event(0)],
					},
				],
				claims: [
					{ ref: rootOutput().choice.claim, text: '目的　鍵を"返す"。' },
				],
				requires: [],
			},
		});
		expect(e.input.data).not.toHaveProperty("events.0.eventHash");
		expect(e.input.orderedInputProofs.map((p) => p.kind)).toEqual([
			"CONTEXT_NODE",
			"EVENT",
			"CONSTRAINTS",
		]);
		const output = finalOutput([event(0)]),
			step = buildLocalStoryFlowRouteStep({ expectation, output });
		expect(
			localStoryFlowRouteStepEvidence(step).after.closureResult.clockStatus,
		).toBe("NOT_EVALUATED");
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: step,
				nodeId: "n0",
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_NOT_READY");
		const wrong = finalOutput([event(1)]);
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: wrong }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
	});
});

function finalOutput(events: ReturnType<typeof event>[], nodeId = "n0") {
	return {
		version: "local-story-flow-route-output-v1" as const,
		phase: "FINALIZE" as const,
		mode: "FLOW" as const,
		nodeId,
		accountedRoot: { kind: "CONTEXT_NODE" as const, nodeId },
		accountedEvents: events,
		blueprint: {
			mode: "FLOW" as const,
			message: "鍵を返す。",
			beats: [
				{
					id: "b0",
					role: "ACTION" as const,
					eventIds: [events[0]?.eventId ?? "missing"],
					requires: [],
				},
			],
			uncertainty: "意味的十分性は未検証",
		},
		unresolved: [],
	};
}

function branchOutput(
	f: ReturnType<typeof fixture>,
	nodeId: string,
	disposition: "DESCEND" | "CONTEXT_ONLY" = "CONTEXT_ONLY",
) {
	const node = localStoryFlowContextSourceEvidence(f.source).layout.nodes.find(
		(n) => n.nodeId === nodeId,
	);
	if (node?.phase !== "MERGE") throw new Error("Missing authored branch");
	const accountedChildren = node.children.map((nodeId) => ({
		kind: "CHILD_NODE" as const,
		nodeId,
	}));
	return {
		version: "local-story-flow-route-output-v1" as const,
		phase: "BRANCH" as const,
		mode: "FLOW" as const,
		nodeId,
		accountedChildren,
		dispositions: accountedChildren.map((child) => ({ child, disposition })),
		unresolved: [],
	};
}

describe("H1c-2 source-ordered navigation", () => {
	it("keeps odd-carry child order and forces the ROOT bundle's path without rewriting CONTEXT_ONLY", () => {
		const f = fixture({ count: 9, summaryChars: 320, selected: [6] }),
			source = localStoryFlowContextSourceEvidence(f.source);
		expect(source.pages).toHaveLength(3);
		expect(source.layout.rootNodeId).toBe("n4");
		const root = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput("n4"),
		});
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: root,
				nodeId: "n2",
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "BRANCH",
			previousStep: root,
			nodeId: "n4",
		});
		const input = localStoryFlowRouteExpectationEvidence(expectation).input;
		expect(
			input.orderedInputProofs.map((p) => ("nodeId" in p ? p.nodeId : "wrong")),
		).toEqual(["n3", "n2"]);
		expect(input.control).toHaveProperty("requiredChildren", [
			{ kind: "CHILD_NODE", nodeId: "n2" },
		]);
		const output = branchOutput(f, "n4"),
			step = buildLocalStoryFlowRouteStep({ expectation, output });
		const leaf = buildLocalStoryFlowRouteExpectation({
			phase: "LEAF",
			previousStep: step,
			nodeId: "n2",
		});
		const e = localStoryFlowRouteExpectationEvidence(leaf);
		expect(e.continuation).toMatchObject({
			traversal: [
				{
					parentNodeId: "n4",
					childNodeId: "n2",
					branchObservationHash:
						localStoryFlowRouteStepEvidence(step).observationHash,
					rawDisposition: "CONTEXT_ONLY",
					effectiveDisposition: "DESCEND",
					force: {
						requiredEvents: [event(6)],
						rootEvents: [event(6)],
						seedEvents: [],
						hard: [],
					},
				},
			],
		});
		expect(localStoryFlowRouteStepEvidence(step).rawOutput).toEqual(output);
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: step,
				nodeId: "n3",
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
	});
	it("rejects a full but reordered pair and issues for a hidden grandchild", () => {
		const f = fixture({ count: 9, summaryChars: 320, selected: [6] }),
			root = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
				}),
				output: rootOutput("n4"),
			});
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "BRANCH",
			previousStep: root,
			nodeId: "n4",
		});
		const wrong = branchOutput(f, "n4");
		wrong.accountedChildren.reverse();
		wrong.dispositions.reverse();
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: wrong }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const hidden = {
			...branchOutput(f, "n4"),
			unresolved: [
				{
					ref: { kind: "CLAIM", nodeId: "n0", claimId: "c0" },
					reason: "SOURCE_CONTEXT_UNCLEAR",
				},
			],
		};
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: hidden }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
	});
	it("opens an unvisited pending owner, then retains all ancestor force origins and whole hard prerequisites", () => {
		const f = fixture({
			count: 9,
			summaryChars: 320,
			selected: [6],
			merge(output) {
				if (output.nodeId === "n4")
					output.relations.push({
						kind: "REQUIRES",
						from: { kind: "OWN_CLAIM", claimId: "c0" },
						target: { kind: "CLAIM", nodeId: "n3", claimId: "c0" },
					});
			},
		});
		const root = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput("n4"),
		});
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "WITNESS",
			previousStep: root,
		});
		expect(
			localStoryFlowRouteExpectationEvidence(expectation).input.nodeId,
		).toBe("n3");
		const witness = {
			...rootOutput("n3"),
			phase: "WITNESS",
			choice: { ...rootOutput("n3").choice, kind: "HARD_REQUIREMENT" },
		};
		let step = buildLocalStoryFlowRouteStep({ expectation, output: witness });
		expect(
			localStoryFlowRouteStepEvidence(
				step,
			).after.closureResult.requiredEvents.map((e) => e.ref),
		).toEqual([event(0), event(6)]);
		step = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: step,
				nodeId: "n4",
			}),
			output: branchOutput(f, "n4"),
		});
		const branch = buildLocalStoryFlowRouteExpectation({
			phase: "BRANCH",
			previousStep: step,
			nodeId: "n3",
		});
		expect(
			localStoryFlowRouteExpectationEvidence(branch).continuation,
		).toMatchObject({
			traversal: [
				{
					force: {
						requiredEvents: [event(0)],
						rootEvents: [],
						seedEvents: [],
						hard: [
							{ origin: { ownerNodeId: "n4", index: 0 }, events: [event(0)] },
						],
					},
				},
			],
		});
		step = buildLocalStoryFlowRouteStep({
			expectation: branch,
			output: branchOutput(f, "n3"),
		});
		const leaf = buildLocalStoryFlowRouteExpectation({
			phase: "LEAF",
			previousStep: step,
			nodeId: "n0",
		});
		const continuation =
			localStoryFlowRouteExpectationEvidence(leaf).continuation;
		if (continuation.kind !== "AFTER_STEP")
			throw new Error("Missing authored continuation");
		expect(
			continuation.traversal.map((r) => [r.parentNodeId, r.childNodeId]),
		).toEqual([
			["n4", "n3"],
			["n3", "n0"],
		]);
		expect(
			continuation.traversal.every(
				(r) => r.force?.hard[0]?.origin.ownerNodeId === "n4",
			),
		).toBe(true);
		step = buildLocalStoryFlowRouteStep({
			expectation: leaf,
			output: leafOutput(f, [], "n0"),
		});
		step = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: step,
				nodeId: "n2",
			}),
			output: leafOutput(f, [], "n2"),
		});
		const final = localStoryFlowRouteExpectationEvidence(
			buildLocalStoryFlowRouteExpectation({
				phase: "FINALIZE",
				previousStep: step,
			}),
		);
		expect(final.input.data).toMatchObject({
			events: [{ id: "l0_e0" }, { id: "l6_e0" }],
			constraints: {
				commitments: [
					{ choice: { kind: "ROOT_GOAL" }, events: [event(6)] },
					{ choice: { kind: "HARD_REQUIREMENT" }, events: [event(0)] },
				],
				requires: [
					{
						origin: { ownerNodeId: "n4", index: 0 },
						guardEvents: [event(6)],
						prerequisites: [event(0)],
					},
				],
			},
		});
	});
});

describe("H1c-2 strict cached step reader", () => {
	it("rebuilds from owned expectation and independent accepted output, rejecting a consistent but different cached reply", () => {
		const f = fixture(),
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				...f,
			}),
			expectedOutput = rootOutput();
		const step = buildLocalStoryFlowRouteStep({
				expectation,
				output: expectedOutput,
			}),
			value = localStoryFlowRouteStepEvidence(step);
		expect(
			localStoryFlowRouteStepEvidence(
				validateLocalStoryFlowRouteStep(value, { expectation, expectedOutput }),
			),
		).toEqual(value);
		const other = {
			...rootOutput(),
			unresolved: [
				{
					ref: { kind: "CONTEXT_NODE", nodeId: "n0" },
					reason: "SOURCE_CONTEXT_UNCLEAR",
				},
			],
		};
		const replacement = localStoryFlowRouteStepEvidence(
			buildLocalStoryFlowRouteStep({ expectation, output: other }),
		);
		expect(() =>
			validateLocalStoryFlowRouteStep(replacement, {
				expectation,
				expectedOutput,
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		for (const corrupt of [
			{ ...value, extra: undefined },
			{ ...value, [Symbol("extra")]: true },
			{ ...value, stepHash: "a".repeat(64) },
		]) {
			expect(() =>
				validateLocalStoryFlowRouteStep(corrupt, {
					expectation,
					expectedOutput,
				}),
			).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		}
		let reads = 0;
		const accessor = { ...value };
		Object.defineProperty(accessor, "stepHash", {
			enumerable: true,
			get() {
				reads++;
				return value.stepHash;
			},
		});
		expect(() =>
			validateLocalStoryFlowRouteStep(accessor, {
				expectation,
				expectedOutput,
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		expect(reads).toBe(0);
		expect(Object.keys(routeModule).sort()).toEqual(
			[
				"LOCAL_STORY_FLOW_ROUTE_POLICY",
				"LocalStoryFlowRouteError",
				"buildLocalStoryFlowRouteExpectation",
				"buildLocalStoryFlowRouteStep",
				"localStoryFlowRouteExpectationEvidence",
				"localStoryFlowRouteStepEvidence",
				"validateLocalStoryFlowRouteStep",
			].sort(),
		);
	});
	it("compares numeric primitives exactly even where canonical hashes serialize -0 as 0", () => {
		const f = fixture(),
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				...f,
			}),
			expectedOutput = rootOutput();
		const value = localStoryFlowRouteStepEvidence(
			buildLocalStoryFlowRouteStep({ expectation, output: expectedOutput }),
		);
		first(value.after.closure.rootEvents).sourceOrder = -0;
		expect(() =>
			validateLocalStoryFlowRouteStep(value, { expectation, expectedOutput }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
	});
});

describe("H1c-2 changing obligations keep accepted branch observations", () => {
	it("uses current M after a new WITNESS to open an older CONTEXT_ONLY child without a replacement BRANCH", () => {
		const f = fixture({
			count: 9,
			summaryChars: 320,
			selected: [6],
			leaf(output) {
				if (output.nodeId === "n2")
					output.claims.push({
						id: "c1",
						text: "新しい手掛かり。",
						supports: [event(7)],
						witnesses: [{ id: "w0", allOf: [event(7)] }],
					});
			},
			merge(output) {
				if (output.nodeId !== "n4") return;
				output.claims.push({
					id: "c1",
					text: "別の前提が必要。",
					supports: [{ kind: "CLAIM", nodeId: "n2", claimId: "c1" }],
					witnesses: [
						{
							id: "w0",
							allOf: [
								{
									kind: "WITNESS",
									nodeId: "n2",
									claimId: "c1",
									witnessId: "w0",
								},
							],
						},
					],
				});
				output.relations.push({
					kind: "REQUIRES",
					from: { kind: "OWN_CLAIM", claimId: "c1" },
					target: { kind: "CLAIM", nodeId: "n3", claimId: "c0" },
				});
			},
		});
		const root = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput("n4"),
		});
		const branch = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: root,
				nodeId: "n4",
			}),
			output: branchOutput(f, "n4"),
		});
		const old = localStoryFlowRouteStepEvidence(branch);
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: branch,
				nodeId: "n3",
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const leaf = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: branch,
				nodeId: "n2",
			}),
			output: leafOutput(f, [event(7)], "n2"),
		});
		expect(
			localStoryFlowRouteStepEvidence(leaf).after.closureResult.status,
		).toBe("PENDING_HARD_CHOICE");
		const w = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "WITNESS",
				previousStep: leaf,
			}),
			output: {
				...rootOutput("n3"),
				phase: "WITNESS",
				choice: { ...rootOutput("n3").choice, kind: "HARD_REQUIREMENT" },
			},
		});
		const next = localStoryFlowRouteExpectationEvidence(
			buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: w,
				nodeId: "n3",
			}),
		);
		expect(next.continuation).toMatchObject({
			traversal: [
				{
					branchObservationHash: old.observationHash,
					rawDisposition: "CONTEXT_ONLY",
					force: {
						requiredEvents: [event(0)],
						hard: [
							{ origin: { ownerNodeId: "n4", index: 0 }, events: [event(0)] },
						],
					},
				},
			],
		});
		expect(
			localStoryFlowRouteStepEvidence(w).after.navigation.branches,
		).toEqual(old.after.navigation.branches);
		expect(localStoryFlowRouteStepEvidence(branch)).toEqual(old);
	});
	it("reuses a whole exposed page when WITNESS adds another event on that page", () => {
		const f = fixture({
			count: 3,
			leaf(output) {
				output.claims.push({
					id: "c1",
					text: "先に必要な出来事。",
					supports: [event(2)],
					witnesses: [{ id: "w0", allOf: [event(2)] }],
				});
				output.relations.push({
					kind: "REQUIRES",
					from: event(1),
					target: { kind: "OWN_CLAIM", claimId: "c1" },
				});
			},
		});
		const root = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput(),
		});
		const leaf = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: root,
				nodeId: "n0",
			}),
			output: leafOutput(f, [event(1)]),
		});
		const w = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "WITNESS",
				previousStep: leaf,
			}),
			output: {
				...rootOutput(),
				phase: "WITNESS",
				choice: {
					kind: "HARD_REQUIREMENT",
					claim: { kind: "CLAIM", nodeId: "n0", claimId: "c1" },
					witness: {
						kind: "WITNESS",
						nodeId: "n0",
						claimId: "c1",
						witnessId: "w0",
					},
				},
			},
		});
		expect(
			localStoryFlowRouteStepEvidence(w).after.knownRequiredExposureGaps,
		).toEqual([]);
		expect(
			localStoryFlowRouteStepEvidence(w).after.closureResult.requiredEvents.map(
				(e) => e.ref,
			),
		).toEqual([event(0), event(1), event(2)]);
		expect(
			localStoryFlowRouteExpectationEvidence(
				buildLocalStoryFlowRouteExpectation({
					phase: "FINALIZE",
					previousStep: w,
				}),
			).input.phase,
		).toBe("FINALIZE");
	});
});

describe("H1c-2 exact bytes and finite seeds", () => {
	it("measures complete FINALIZE DATA at the exact byte boundary", () => {
		for (const extra of [0, 1]) {
			const label = `題"\\${"X".repeat(58 + extra)}`;
			const f = fixture({
				count: 4,
				subjects: ["甲".repeat(80), "乙".repeat(80), "丙".repeat(50)],
				label: (i) => (i === 0 ? label : "事件"),
			});
			const step = exposeAll(
				f,
				Array.from({ length: 4 }, (_, i) => event(i)),
			);
			if (extra)
				expect(() =>
					buildLocalStoryFlowRouteExpectation({
						phase: "FINALIZE",
						previousStep: step,
					}),
				).toThrow("LOCAL_STORY_FLOW_ROUTE_DATA_LIMIT");
			else {
				const e = localStoryFlowRouteExpectationEvidence(
					buildLocalStoryFlowRouteExpectation({
						phase: "FINALIZE",
						previousStep: step,
					}),
				);
				expect(e.input.dataUtf8Bytes).toBe(4096);
				expect(e.input.dataUtf8Bytes).toBe(
					Buffer.byteLength(canonicalEditingJson(e.input.data)),
				);
				expect(e.input.dataHash).toBe(hash(e.input.data));
				expect(e.input.data).toHaveProperty("events.0.label", label);
				if (!("events" in e.input.data))
					throw new Error("Missing authored FINALIZE DATA");
				expect(e.input.data.events).toEqual(
					localStoryFlowContextSourceEvidence(f.source).pages.flatMap((p) =>
						p.data.items.filter((i) => i.kind === "GROUNDED_LEAF_EVENT_CARD"),
					),
				);
			}
			expect(
				localStoryFlowRouteStepEvidence(step).after.closureResult
					.requiredEvents,
			).toHaveLength(4);
		}
	});
	it("measures canonical CONTROL including Unicode and escapes at 480/481 bytes without shortening obligations", () => {
		const prefix = '語"\\\n',
			requiredEvents = Array.from({ length: 6 }, (_, i) => event(i));
		const control = (goalText: string) => ({
			version: "local-story-flow-route-control-v1",
			mode: "FLOW",
			phase: "LEAF",
			targetFrames: 300,
			nodeId: "n0",
			goalText,
			requiredEvents,
		});
		const baseBytes = Buffer.byteLength(canonicalEditingJson(control(prefix)));
		const goal = prefix + "x".repeat(480 - baseBytes);
		expect(Buffer.byteLength(JSON.stringify(goal))).toBeLessThanOrEqual(160);
		for (const extra of [0, 1]) {
			const f = fixture({
				count: 6,
				selected: [0, 1, 2, 3, 4],
				goalText: goal + "x".repeat(extra),
			});
			const root = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
				}),
				output: rootOutput(),
			});
			const leaf = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "LEAF",
					previousStep: root,
					nodeId: "n0",
				}),
				output: leafOutput(f, [event(5)]),
			});
			if (extra)
				expect(() =>
					buildLocalStoryFlowRouteExpectation({
						phase: "LEAF",
						previousStep: leaf,
						nodeId: "n0",
					}),
				).toThrow("LOCAL_STORY_FLOW_ROUTE_CONTROL_LIMIT");
			else {
				const e = localStoryFlowRouteExpectationEvidence(
					buildLocalStoryFlowRouteExpectation({
						phase: "LEAF",
						previousStep: leaf,
						nodeId: "n0",
					}),
				);
				expect(e.input.controlUtf8Bytes).toBe(480);
				expect(e.input.control).toEqual(control(goal));
			}
			expect(
				localStoryFlowRouteStepEvidence(leaf).after.closureResult
					.requiredEvents,
			).toHaveLength(6);
		}
	});
	it("accepts all 32 seeds and rejects the 33rd instead of dropping existing events", () => {
		const f = fixture({ count: 33, summaryChars: 320 }),
			source = localStoryFlowContextSourceEvidence(f.source);
		let step = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput(source.layout.rootNodeId),
		});
		for (const node of [...source.layout.nodes].reverse())
			if (node.phase === "MERGE")
				step = buildLocalStoryFlowRouteStep({
					expectation: buildLocalStoryFlowRouteExpectation({
						phase: "BRANCH",
						previousStep: step,
						nodeId: node.nodeId,
					}),
					output: branchOutput(f, node.nodeId, "DESCEND"),
				});
		for (const node of source.layout.nodes)
			if (node.phase === "LEAF") {
				const output = leafOutput(f, [], node.nodeId);
				output.candidates = output.accountedItems.filter(
					(r): r is ReturnType<typeof event> =>
						r.kind === "EVENT" && r.eventId !== "l32_e0",
				);
				step = buildLocalStoryFlowRouteStep({
					expectation: buildLocalStoryFlowRouteExpectation({
						phase: "LEAF",
						previousStep: step,
						nodeId: node.nodeId,
					}),
					output,
				});
			}
		const before = localStoryFlowRouteStepEvidence(step);
		expect(before.after.seeds).toEqual(
			Array.from({ length: 32 }, (_, i) => event(i)),
		);
		const last = first(
			source.layout.nodes.filter(
				(n) => n.phase === "LEAF" && n.pageToExclusive === source.pages.length,
			),
		);
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "LEAF",
			previousStep: step,
			nodeId: last.nodeId,
		});
		expect(() =>
			buildLocalStoryFlowRouteStep({
				expectation,
				output: leafOutput(f, [event(32)], last.nodeId),
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_SEED_LIMIT");
		expect(localStoryFlowRouteStepEvidence(step)).toEqual(before);
	});
	it("preserves a valid raw LEAF and UNREACHED evidence when complete speech makes its new seed unavailable", () => {
		const f = fixture({
				count: 4,
				mutate(input) {
					input.shots.splice(1, 1);
					first(input.coverage.filter((r) => r.ref === "s1")).status =
						"EXCLUDED";
					input.segments = [
						{
							startUs: 4_000_000,
							endUs: 8_000_000,
							text: "途切れない合成発話",
						},
					];
				},
			}),
			source = localStoryFlowContextSourceEvidence(f.source);
		expect(
			first(source.manifest.items.filter((i) => i.id === "l1_e0")),
		).toHaveProperty("minimumFrames", null);
		const root = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput(),
		});
		const output = leafOutput(f, [event(1)]),
			step = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "LEAF",
					previousStep: root,
					nodeId: "n0",
				}),
				output,
			});
		expect(localStoryFlowRouteStepEvidence(step)).toMatchObject({
			rawOutput: output,
			after: {
				closureResult: {
					status: "UNREACHED",
					failure: { reason: "REQUIRED_EVENT_UNAVAILABLE", ref: event(1) },
				},
			},
		});
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: step,
				nodeId: "n0",
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_NOT_READY");
	});
});

function exposeAll(
	f: ReturnType<typeof fixture>,
	candidates: ReturnType<typeof event>[],
) {
	const source = localStoryFlowContextSourceEvidence(f.source),
		ids = new Set(candidates.map((r) => r.eventId));
	let step = buildLocalStoryFlowRouteStep({
		expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
		output: rootOutput(source.layout.rootNodeId),
	});
	for (const node of [...source.layout.nodes].reverse())
		if (node.phase === "MERGE")
			step = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "BRANCH",
					previousStep: step,
					nodeId: node.nodeId,
				}),
				output: branchOutput(f, node.nodeId, "DESCEND"),
			});
	for (const node of source.layout.nodes)
		if (node.phase === "LEAF") {
			const output = leafOutput(f, [], node.nodeId);
			output.candidates = output.accountedItems.filter(
				(r): r is ReturnType<typeof event> =>
					r.kind === "EVENT" && ids.has(r.eventId),
			);
			step = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "LEAF",
					previousStep: step,
					nodeId: node.nodeId,
				}),
				output,
			});
		}
	return step;
}

describe("H1c-2 phase-specific issue membership", () => {
	it.each([
		"ROOT",
		"WITNESS",
		"BRANCH",
		"LEAF",
		"FINALIZE",
	] as const)("%s retains all visible issues, stops followups and rejects hidden references", (phase) => {
		const f = fixture(),
			rootExpectation = buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				...f,
			});
		const root = buildLocalStoryFlowRouteStep({
			expectation: rootExpectation,
			output: rootOutput(),
		});
		let expectation = rootExpectation,
			output: unknown = rootOutput(),
			visible: unknown = { kind: "CONTEXT_NODE", nodeId: "n0" },
			hidden: unknown = { kind: "CLAIM", nodeId: "n0", claimId: "c2" },
			nextNode = "n0";
		if (phase === "WITNESS") {
			const pending = fixture({
				selected: [1],
				leaf(o) {
					o.claims.push({
						id: "c1",
						text: "先に必要。",
						supports: [event(0)],
						witnesses: [{ id: "w0", allOf: [event(0)] }],
					});
					o.relations.push({
						kind: "REQUIRES",
						from: event(1),
						target: { kind: "OWN_CLAIM", claimId: "c1" },
					});
				},
			});
			const p = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...pending,
				}),
				output: rootOutput(),
			});
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "WITNESS",
				previousStep: p,
			});
			output = {
				...rootOutput(),
				phase: "WITNESS",
				choice: {
					kind: "HARD_REQUIREMENT",
					claim: { kind: "CLAIM", nodeId: "n0", claimId: "c1" },
					witness: {
						kind: "WITNESS",
						nodeId: "n0",
						claimId: "c1",
						witnessId: "w0",
					},
				},
			};
			visible = { kind: "CLAIM", nodeId: "n0", claimId: "c0" };
		} else if (phase === "BRANCH") {
			const multi = fixture({ count: 9, summaryChars: 320, selected: [6] });
			const p = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...multi,
				}),
				output: rootOutput("n4"),
			});
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: p,
				nodeId: "n4",
			});
			output = branchOutput(multi, "n4");
			visible = { kind: "CLAIM", nodeId: "n3", claimId: "c0" };
			hidden = { kind: "CLAIM", nodeId: "n4", claimId: "c0" };
			nextNode = "n2";
		} else if (phase === "LEAF") {
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: root,
				nodeId: "n0",
			});
			output = leafOutput(f);
			visible = { kind: "SUMMARY", summaryId: "u0" };
			hidden = { kind: "SUMMARY", summaryId: "u127" };
		} else if (phase === "FINALIZE") {
			const leaf = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "LEAF",
					previousStep: root,
					nodeId: "n0",
				}),
				output: leafOutput(f),
			});
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "FINALIZE",
				previousStep: leaf,
			});
			output = finalOutput([event(0)]);
			visible = event(0);
			hidden = event(1);
		}
		const raw = localStoryFlowRouteOutputSchema.parse(output);
		const unresolved = [
			{ ref: visible, reason: "SOURCE_CONTEXT_UNCLEAR" },
			{ ref: visible, reason: "RELATION_UNCLEAR" },
		];
		const accepted = { ...raw, unresolved };
		expect(localStoryFlowRouteOutputSchema.safeParse(accepted).success).toBe(
			true,
		);
		const step = buildLocalStoryFlowRouteStep({
				expectation,
				output: accepted,
			}),
			evidence = localStoryFlowRouteStepEvidence(step);
		expect(evidence.rawOutput.unresolved).toEqual(unresolved);
		expect(
			localStoryFlowRouteStepEvidence(
				validateLocalStoryFlowRouteStep(evidence, {
					expectation,
					expectedOutput: accepted,
				}),
			),
		).toEqual(evidence);
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: step,
				nodeId: nextNode,
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_NOT_READY");
		const invalid =
			raw.phase === "LEAF"
				? {
						...raw,
						accountedItems: [...raw.accountedItems, hidden],
						unresolved: [{ ref: hidden, reason: "SOURCE_CONTEXT_UNCLEAR" }],
					}
				: {
						...raw,
						unresolved: [{ ref: hidden, reason: "SOURCE_CONTEXT_UNCLEAR" }],
					};
		expect(localStoryFlowRouteOutputSchema.safeParse(invalid).success).toBe(
			true,
		);
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: invalid }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
	});
});

describe("H1c-2 owned structural boundaries", () => {
	it("rejects reordered FINALIZE account and normalized replies while leaving alternative closure to C3", () => {
		const f = fixture({ selected: [0, 1] }),
			step = exposeAll(f, []);
		const expectation = buildLocalStoryFlowRouteExpectation({
			phase: "FINALIZE",
			previousStep: step,
		});
		const output = finalOutput([event(0), event(1)]),
			wrong = finalOutput([event(1), event(0)]);
		expect(localStoryFlowRouteOutputSchema.safeParse(wrong).success).toBe(true);
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: wrong }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const padded = {
			...output,
			blueprint: { ...output.blueprint, message: "  鍵を返す。  " },
		};
		expect(localStoryFlowRouteOutputSchema.safeParse(padded).success).toBe(
			true,
		);
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: padded }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const structural = localStoryFlowRouteStepEvidence(
			buildLocalStoryFlowRouteStep({ expectation, output }),
		);
		expect(structural.rawOutput).toEqual(output);
		expect(structural).not.toHaveProperty("scopeProof");
		expect(structural).not.toHaveProperty("nativeReceipt");
		expect(structural.after.closureResult.clockStatus).toBe("NOT_EVALUATED");
	});
	it("copies expectation inputs and rejects hidden descriptors and cycles in cached evidence", () => {
		const f = fixture(),
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				...f,
			}),
			original = localStoryFlowRouteExpectationEvidence(expectation);
		const copy = localStoryFlowRouteExpectationEvidence(expectation);
		if (!("claims" in copy.input.data))
			throw new Error("Missing authored ROOT view");
		first(copy.input.data.claims).text = "mutated outside";
		const proof = first(copy.input.orderedInputProofs);
		if (proof.kind !== "CONTEXT_NODE")
			throw new Error("Missing authored node proof");
		proof.nodeHash = "f".repeat(64);
		expect(localStoryFlowRouteExpectationEvidence(expectation)).toEqual(
			original,
		);
		const expectedOutput = rootOutput(),
			step = buildLocalStoryFlowRouteStep({
				expectation,
				output: expectedOutput,
			}),
			value = localStoryFlowRouteStepEvidence(step);
		Object.defineProperty(value.after, "extra", {
			value: true,
			enumerable: false,
		});
		expect(() =>
			validateLocalStoryFlowRouteStep(value, { expectation, expectedOutput }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() =>
			validateLocalStoryFlowRouteStep(cycle, { expectation, expectedOutput }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
	});
	it("keeps fixed policy caps and code-only errors", () => {
		expect(LOCAL_STORY_FLOW_ROUTE_POLICY.maxDataUtf8Bytes).toBe(
			LOCAL_STORY_FLOW_H1_POLICY.leafPageLimits.maxDataUtf8Bytes,
		);
		expect(LOCAL_STORY_FLOW_ROUTE_POLICY.maxControlUtf8Bytes).toBe(
			LOCAL_STORY_FLOW_H1_POLICY.formatting.controlJsonUtf8Bytes,
		);
		expect(Object.isFrozen(LOCAL_STORY_FLOW_ROUTE_POLICY)).toBe(true);
		const error = new LocalStoryFlowRouteError(
			"LOCAL_STORY_FLOW_ROUTE_INVALID",
		);
		expect(error.name).toBe("LocalStoryFlowRouteError");
		expect(error.message).toBe(error.code);
		expect(error.cause).toBeUndefined();
	});
	it("binds source, clock, GPU model identity and target independently of identical root text", () => {
		const variants = [
			fixture(),
			fixture({ profile: "amd" }),
			fixture({
				mutate(input) {
					input.timeMap.id = "55555555-5555-4555-8555-555555555555";
					input.timeMapHash = hash(input.timeMap);
				},
			}),
		];
		const inputs = variants.map(
			(f) =>
				localStoryFlowRouteExpectationEvidence(
					buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
				).input,
		);
		expect(new Set(inputs.map((i) => i.sourceBindingHash)).size).toBe(3);
		expect(new Set(inputs.map((i) => i.treeHash)).size).toBe(3);
		expect(new Set(inputs.map((i) => i.inputHash)).size).toBe(3);
		expect(inputs[0]?.data).toEqual(inputs[1]?.data);
		const f = first(variants),
			changed = localStoryFlowRouteExpectationEvidence(
				buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
					targetFrames: 301,
				}),
			);
		expect(changed.input.inputHash).not.toBe(inputs[0]?.inputHash);
		expect(() =>
			buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				source: f.source,
				tree: first(variants.slice(1)).tree,
				targetFrames: 300,
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH");
	});
	it("accepts pre-choice duration endpoints while preserving C1 unavailable and choice errors", () => {
		const f = fixture();
		for (const targetFrames of [1, 5400])
			expect(
				localStoryFlowRouteExpectationEvidence(
					buildLocalStoryFlowRouteExpectation({
						phase: "ROOT",
						...f,
						targetFrames,
					}),
				).input.targetFrames,
			).toBe(targetFrames);
		for (const targetFrames of [0, 5401, 1.5, NaN, Infinity])
			expect(() =>
				buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
					targetFrames,
				}),
			).toThrow("LOCAL_STORY_FLOW_ROUTE_DURATION_INVALID");
		expect(() =>
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
					targetFrames: 1,
				}),
				output: rootOutput(),
			}),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE");
		const expectation = buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				...f,
			}),
			invalid = rootOutput();
		invalid.choice.witness.witnessId = "w2";
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: invalid }),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID");
	});
	it("rejects forged handles and continuation aliases without sharing getter or output references", () => {
		const f = fixture(),
			expectation = buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				...f,
			}),
			root = buildLocalStoryFlowRouteStep({
				expectation,
				output: rootOutput(),
			});
		expect(() =>
			localStoryFlowRouteExpectationEvidence({ ...expectation }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		expect(() => localStoryFlowRouteStepEvidence({ ...root })).toThrow(
			"LOCAL_STORY_FLOW_ROUTE_INVALID",
		);
		const followup = {
			phase: "LEAF" as const,
			previousStep: root,
			nodeId: "n0",
		};
		for (const alias of [
			"rootChoice",
			"hardChoices",
			"closure",
			"seeds",
			"source",
			"tree",
			"targetFrames",
			"rootCommitmentProofHash",
		])
			expect(() =>
				buildLocalStoryFlowRouteExpectation({
					...followup,
					[alias]: undefined,
				}),
			).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		let reads = 0;
		const raw = rootOutput();
		Object.defineProperty(raw.choice.claim, "nodeId", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_SYNTHETIC_GETTER");
			},
		});
		expect(() =>
			buildLocalStoryFlowRouteStep({ expectation, output: raw }),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		const leaf = leafOutput(f);
		Object.defineProperty(leaf.accountedItems, "0", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_SYNTHETIC_GETTER");
			},
		});
		expect(() =>
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation(followup),
				output: leaf,
			}),
		).toThrow("LOCAL_STORY_FLOW_ROUTE_INVALID");
		expect(reads).toBe(0);
	});
	it("updates only the latest navigation index while retaining old raw dispositions and allowing a separate pure fork", () => {
		const f = fixture({ count: 9, summaryChars: 320, selected: [6] }),
			root = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
				}),
				output: rootOutput("n4"),
			});
		const firstBranch = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "BRANCH",
					previousStep: root,
					nodeId: "n4",
				}),
				output: branchOutput(f, "n4"),
			}),
			before = localStoryFlowRouteStepEvidence(firstBranch);
		const latest = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: firstBranch,
				nodeId: "n4",
			}),
			output: branchOutput(f, "n4", "DESCEND"),
		});
		const e = localStoryFlowRouteExpectationEvidence(
			buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: latest,
				nodeId: "n3",
			}),
		);
		expect(e.continuation).toMatchObject({
			traversal: [
				{
					rawDisposition: "DESCEND",
					force: null,
					branchObservationHash:
						localStoryFlowRouteStepEvidence(latest).observationHash,
				},
			],
		});
		expect(localStoryFlowRouteStepEvidence(firstBranch)).toEqual(before);
		const fork = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: root,
				nodeId: "n4",
			}),
			output: branchOutput(f, "n4", "DESCEND"),
		});
		expect(localStoryFlowRouteStepEvidence(fork).stepHash).not.toBe(
			before.stepHash,
		);
	});
	it("preserves same-composite prerequisite union and complete guards without inventing temporal A-B cycles", () => {
		const f = fixture({
			count: 3,
			selected: [0, 1, 2],
			leaf(o) {
				o.relations.push(
					{
						kind: "REQUIRES",
						from: { kind: "OWN_CLAIM", claimId: "c0" },
						target: event(0),
					},
					{
						kind: "REQUIRES",
						from: { kind: "OWN_CLAIM", claimId: "c0" },
						target: event(1),
					},
				);
			},
		});
		const step = exposeAll(f, []),
			after = localStoryFlowRouteStepEvidence(step).after;
		expect(after.closureResult.status).toBe("COMPLETE");
		expect(after.closureResult.temporalRequirements).toEqual(
			[0, 1].map((i) => ({
				origin: { ownerNodeId: "n0", index: i },
				prerequisites: [event(i)],
				dependents: [event(2)],
			})),
		);
		const final = localStoryFlowRouteExpectationEvidence(
			buildLocalStoryFlowRouteExpectation({
				phase: "FINALIZE",
				previousStep: step,
			}),
		);
		expect(final.input.data).toMatchObject({
			constraints: {
				requires: [0, 1].map((i) => ({
					origin: { ownerNodeId: "n0", index: i },
					guardEvents: [event(0), event(1), event(2)],
					prerequisites: [event(i)],
				})),
			},
		});
	});
});
