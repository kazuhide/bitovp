import { describe, expect, it, vi } from "vitest";

// Authored synthetic metadata only. No native/model/ASR/media or DB operations.

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

import type { LocalStoryFlowContextOutput } from "./local-story-flow-contracts";

import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";

import {
	buildLocalStoryFlowRouteExpectation,
	buildLocalStoryFlowRouteStep,
	localStoryFlowRouteStepEvidence,
} from "./local-story-flow-route";

import { localStoryFlowIdentityForConfiguration } from "./local-story-flow-stages";

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
		subjectsForIndex?: (index: number) => string[];
		ledger?: (
			ledger: {
				summary: string;
				events: import("./local-story-contracts").LocalStoryEvent[];
			},
			index: number,
		) => void;
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
				subjects: options.subjectsForIndex?.(index) ??
					options.subjects ?? ["人物", "鍵"],
				uncertainty: "文脈は未確認",
			},
		],
	}));
	ledgers.forEach((ledger, index) => {
		options.ledger?.(ledger, index);
	});
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

import type { LocalStoryBlueprint } from "./local-story-contracts";
import {
	evaluateLocalStoryFlowClosure,
	prepareLocalStoryFlowClosure,
} from "./local-story-flow-closure";
import { selectLocalStoryClips } from "./local-story-planner";

type Fake = ReturnType<typeof fixture>;

function authored(value: unknown): asserts value {
	if (!value) throw new Error("SYNTHETIC_FIXTURE_UNAVAILABLE");
}

const beat = (
	index: number,
	eventIds: string[],
	requires: string[] = index ? [`b${index - 1}`] : [],
	role: LocalStoryBlueprint["beats"][number]["role"] = "ACTION",
) => ({ id: `b${index}`, role, eventIds, requires });

const blueprint = (
	beats: LocalStoryBlueprint["beats"],
): LocalStoryBlueprint => ({
	mode: "FLOW",
	message: "鍵を見つける。",
	beats,
	uncertainty: "合成fixture、意味品質は未評価",
});

function makeTrace(
	f: Fake,
	value: LocalStoryBlueprint,
	candidates: ReturnType<typeof event>[] = [],
) {
	const source = localStoryFlowContextSourceEvidence(f.source),
		tree = localStoryFlowContextTreeEvidence(f.tree, f.source);
	const steps = [
		buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({ phase: "ROOT", ...f }),
			output: rootOutput(tree.rootNodeId),
		}),
	];
	const latest = () => first(steps.slice(-1));
	const pending = () => {
		for (let guard = 0; guard < 4; guard++) {
			const state = localStoryFlowRouteStepEvidence(latest()).after
				.closureResult;
			if (state.status !== "PENDING_HARD_CHOICE") {
				authored(state.status === "COMPLETE");
				return;
			}
			const ref = state.pending.requestedClaim;
			steps.push(
				buildLocalStoryFlowRouteStep({
					expectation: buildLocalStoryFlowRouteExpectation({
						phase: "WITNESS",
						previousStep: latest(),
					}),
					output: {
						version: "local-story-flow-route-output-v1",
						phase: "WITNESS",
						mode: "FLOW",
						nodeId: ref.nodeId,
						choice: {
							kind: "HARD_REQUIREMENT",
							claim: ref,
							witness: {
								kind: "WITNESS",
								nodeId: ref.nodeId,
								claimId: ref.claimId,
								witnessId: "w0",
							},
						},
						unresolved: [],
					},
				}),
			);
		}
		throw new Error("SYNTHETIC_FIXTURE_PENDING_BOUND");
	};
	pending();
	const wanted = new Set(candidates.map((r) => r.eventId));
	const visit = (nodeId: string) => {
		const node = source.layout.nodes.find((n) => n.nodeId === nodeId);
		authored(node);
		if (node.phase === "MERGE") {
			steps.push(
				buildLocalStoryFlowRouteStep({
					expectation: buildLocalStoryFlowRouteExpectation({
						phase: "BRANCH",
						previousStep: latest(),
						nodeId,
					}),
					output: branchOutput(f, nodeId, "DESCEND"),
				}),
			);
			for (const child of node.children) visit(child);
		} else {
			const output = leafOutput(f, [], nodeId);
			output.candidates = output.accountedItems.filter(
				(r): r is ReturnType<typeof event> =>
					r.kind === "EVENT" && wanted.has(r.eventId),
			);
			steps.push(
				buildLocalStoryFlowRouteStep({
					expectation: buildLocalStoryFlowRouteExpectation({
						phase: "LEAF",
						previousStep: latest(),
						nodeId,
					}),
					output,
				}),
			);
			pending();
		}
	};
	visit(tree.rootNodeId);
	const current = localStoryFlowRouteStepEvidence(latest());
	const expectation = buildLocalStoryFlowRouteExpectation({
		phase: "FINALIZE",
		previousStep: latest(),
	});
	steps.push(
		buildLocalStoryFlowRouteStep({
			expectation,
			output: {
				...finalOutput(
					current.after.closureResult.requiredEvents.map((e) => e.ref),
					tree.rootNodeId,
				),
				blueprint: value,
			},
		}),
	);
	return { f, source, tree, steps, blueprint: value };
}

import * as scopeModule from "./local-story-flow-scope";
import {
	buildLocalStoryFlowScope,
	LOCAL_STORY_FLOW_SCOPE_POLICY,
	LocalStoryFlowScopeError,
	localStoryFlowPlanEvidence,
	localStoryFlowScopeEvidence,
	selectLocalStoryFlowPlan,
	validateLocalStoryFlowPlan,
	validateLocalStoryFlowScope,
} from "./local-story-flow-scope";
import * as plannerModule from "./local-story-planner";

function inputs(trace: ReturnType<typeof makeTrace>) {
	return { source: trace.f.source, tree: trace.f.tree, steps: trace.steps };
}
describe("H1c-3 full structural scope", () => {
	it("rebuilds the whole ROOT-to-FINALIZE trace without claiming a validated clock", () => {
		const f = fixture({ subjects: [], label: () => "E", goalText: "key" }),
			trace = makeTrace(f, blueprint([beat(0, ["l0_e0"])]));
		const scope = buildLocalStoryFlowScope(inputs(trace)),
			e = localStoryFlowScopeEvidence(scope);
		expect(e.trace.refs.map((r) => r.phase)).toEqual([
			"ROOT",
			"LEAF",
			"FINALIZE",
		]);
		expect(e.trace.acceptedStepCount).toBe(3);
		expect(e.clockStatus).toBe("PENDING");
		expect(e.candidateCards.map((c) => c.id)).toEqual(["l0_e0"]);
		expect(e.blueprint).toEqual(trace.blueprint);
		expect(e.combinationCount).toBe(1);
		expect(e.alternatives).toHaveLength(1);
		const { scopeHash, ...body } = e;
		expect(scopeHash).toBe(hash(body));
		expect(Object.isFrozen(scope)).toBe(true);
	});
	it("allows ROOT pending, exact WITNESS, then complete exposure instead of demanding COMPLETE at every prefix", () => {
		const f = fixture({
			subjects: [],
			selected: [1],
			leaf(o) {
				o.claims.push({
					id: "c1",
					text: "先の前提。",
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
		const trace = makeTrace(
			f,
			blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0"])]),
		);
		expect(
			trace.steps.map(
				(s) => localStoryFlowRouteStepEvidence(s).after.closureResult.status,
			),
		).toEqual(["PENDING_HARD_CHOICE", "COMPLETE", "COMPLETE", "COMPLETE"]);
		const e = localStoryFlowScopeEvidence(
			buildLocalStoryFlowScope(inputs(trace)),
		);
		expect(e.trace.acceptedStepCount).toBe(4);
		expect(e.candidateCards.map((c) => c.id)).toEqual(["l0_e0", "l1_e0"]);
	});
	it("rejects missing, reordered and forked trace rows, closed options aliases and forged DTO handles", () => {
		const f = fixture({ subjects: [] }),
			b = blueprint([beat(0, ["l0_e0"])]),
			trace = makeTrace(f, b),
			option = inputs(trace);
		expect(() =>
			buildLocalStoryFlowScope({ ...option, steps: trace.steps.slice(1) }),
		).toThrow("LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
		const fork = makeTrace(f, { ...b, message: "別の合成目的。" });
		expect(() =>
			buildLocalStoryFlowScope({
				...option,
				steps: [
					first(trace.steps),
					first(fork.steps.slice(-1)),
					first(trace.steps.slice(-1)),
				],
			}),
		).toThrow("LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
		for (const alias of [
			"rootChoice",
			"hardChoices",
			"targetFrames",
			"blueprint",
			"corpus",
		])
			expect(() =>
				buildLocalStoryFlowScope({ ...option, [alias]: undefined }),
			).toThrow("LOCAL_STORY_FLOW_SCOPE_INVALID");
		expect(() =>
			buildLocalStoryFlowScope({
				...option,
				steps: trace.steps.map((s) => ({ ...s })),
			}),
		).toThrow();
	});
	it("accepts a real 64-row structural trace and rejects all 32 pages' 65 rows independently of native counters", () => {
		const valid = makeTrace(
			heavyweight(47, [1]),
			blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0"])]),
		);
		expect(valid.source.pages).toHaveLength(31);
		expect(valid.steps).toHaveLength(64);
		expect(
			localStoryFlowScopeEvidence(buildLocalStoryFlowScope(inputs(valid))).trace
				.acceptedStepCount,
		).toBe(64);
		const invalid = makeTrace(
			heavyweight(48, [0]),
			blueprint([beat(0, ["l0_e0"])]),
		);
		expect(invalid.source.pages).toHaveLength(32);
		expect(invalid.steps).toHaveLength(65);
		expect(() => buildLocalStoryFlowScope(inputs(invalid))).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_TRACE_LIMIT",
		);
	});
});

function heavyweight(count: number, selected: number[]) {
	return fixture({
		count,
		summaryChars: 320,
		selected,
		label: (i) => (i ? "重".repeat(120) : "E"),
		subjectsForIndex: (i) =>
			i ? ["甲", "乙", "丙", "丁"].map((s) => s.repeat(80)) : [],
		leaf(o) {
			if (selected[0] === 1 && o.nodeId === "n0") {
				o.claims.push({
					id: "c1",
					text: "先に鍵を見つける。",
					supports: [event(0)],
					witnesses: [{ id: "w0", allOf: [event(0)] }],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: event(1),
					target: { kind: "OWN_CLAIM", claimId: "c1" },
				});
			}
		},
	});
}
const minimal = { subjects: [], label: () => "E", goalText: "key" };
describe("H1c-3 all original Cartesian alternatives", () => {
	it("rejects edges-free ROOT B={A,B} when a tuple includes only A", () => {
		const trace = makeTrace(
			fixture({ ...minimal, selected: [0, 1] }),
			blueprint([beat(0, ["l0_e0"])]),
		);
		expect(() => buildLocalStoryFlowScope(inputs(trace))).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_ALTERNATIVE_INVALID",
		);
	});
	it("does not turn a stored but unfired hard choice into a seed", () => {
		const f = fixture({
			...minimal,
			count: 3,
			leaf(o) {
				o.claims.push({
					id: "c1",
					text: "別の前提。",
					supports: [event(2)],
					witnesses: [{ id: "w0", allOf: [event(2)] }],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: event(1),
					target: { kind: "OWN_CLAIM", claimId: "c1" },
				});
			},
		});
		const e = localStoryFlowScopeEvidence(
			buildLocalStoryFlowScope(
				inputs(makeTrace(f, blueprint([beat(0, ["l0_e0"])]), [event(1)])),
			),
		);
		expect(e.closure.hardChoices).toHaveLength(1);
		expect(e.candidateCards).toHaveLength(3);
		expect(e.alternatives).toHaveLength(1);
	});
	it("rejects the whole blueprint when only its second alternative lacks its prerequisite", () => {
		const f = fixture({
				...minimal,
				count: 4,
				leaf(o) {
					o.relations.push({
						kind: "REQUIRES",
						from: event(2),
						target: event(3),
					});
				},
			}),
			trace = makeTrace(
				f,
				blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0", "l2_e0"])]),
				[event(1), event(2)],
			);
		try {
			buildLocalStoryFlowScope(inputs(trace));
			throw new Error("Expected alternative rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(LocalStoryFlowScopeError);
			expect(error).toMatchObject({
				code: "LOCAL_STORY_FLOW_SCOPE_ALTERNATIVE_INVALID",
				detail: { alternativeIndex: 1 },
			});
		}
	});
	it("rejects a cross-beat duplicate tuple even though the legacy selector could skip it", () => {
		const trace = makeTrace(
			fixture(minimal),
			blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0", "l0_e0"])]),
			[event(1)],
		);
		expect(() => buildLocalStoryFlowScope(inputs(trace))).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_ALTERNATIVE_INVALID",
		);
	});
	it("checks all 256 valid tuples in original order and rejects root-missing tuples in syntactic 1024", () => {
		const f = { ...fixture({ ...minimal, count: 17 }), targetFrames: 450 },
			b = blueprint([
				beat(0, ["l0_e0"]),
				...Array.from({ length: 4 }, (_, i) =>
					beat(
						i + 1,
						Array.from({ length: 4 }, (_, j) => `l${1 + i * 4 + j}_e0`),
					),
				),
			]);
		const e = localStoryFlowScopeEvidence(
			buildLocalStoryFlowScope(
				inputs(
					makeTrace(
						f,
						b,
						Array.from({ length: 17 }, (_, i) => event(i)),
					),
				),
			),
		);
		expect(e.combinationCount).toBe(256);
		expect(e.alternatives).toHaveLength(256);
		expect(e.alternatives.map((a) => a.index)).toEqual(
			Array.from({ length: 256 }, (_, i) => i),
		);
		expect(e.alternatives[0]?.choices.map((c) => c.eventId)).toEqual([
			"l0_e0",
			"l1_e0",
			"l5_e0",
			"l9_e0",
			"l13_e0",
		]);
		expect(e.alternatives[1]?.choices.at(-1)?.eventId).toBe("l14_e0");
		expect(e.alternatives[255]?.choices.map((c) => c.eventId)).toEqual([
			"l0_e0",
			"l4_e0",
			"l8_e0",
			"l12_e0",
			"l16_e0",
		]);
		const bad = { ...fixture({ ...minimal, count: 20 }), targetFrames: 450 },
			bb = blueprint(
				Array.from({ length: 5 }, (_, i) =>
					beat(
						i,
						Array.from({ length: 4 }, (_, j) => `l${i * 4 + j}_e0`),
					),
				),
			);
		try {
			buildLocalStoryFlowScope(
				inputs(
					makeTrace(
						bad,
						bb,
						Array.from({ length: 20 }, (_, i) => event(i)),
					),
				),
			);
			throw new Error("Expected tuple rejection");
		} catch (error) {
			expect(error).toMatchObject({
				code: "LOCAL_STORY_FLOW_SCOPE_ALTERNATIVE_INVALID",
				detail: { alternativeIndex: 256 },
			});
		}
	});
	it("requires an earlier prerequisite beat and its transitive requires membership", () => {
		const f = fixture({
			...minimal,
			count: 3,
			selected: [2],
			leaf(o) {
				o.relations.push({
					kind: "REQUIRES",
					from: event(2),
					target: event(1),
				});
			},
		});
		const normal = makeTrace(
			f,
			blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0"]), beat(2, ["l2_e0"])]),
			[event(0)],
		);
		expect(
			localStoryFlowScopeEvidence(buildLocalStoryFlowScope(inputs(normal)))
				.combinationCount,
		).toBe(1);
		const missing = makeTrace(
			f,
			blueprint([
				beat(0, ["l0_e0"]),
				beat(1, ["l1_e0"]),
				beat(2, ["l2_e0"], ["b0"]),
			]),
			[event(0)],
		);
		expect(() => buildLocalStoryFlowScope(inputs(missing))).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID",
		);
		const future = makeTrace(
			f,
			blueprint([beat(0, ["l2_e0"]), beat(1, ["l1_e0"])]),
		);
		expect(() => buildLocalStoryFlowScope(inputs(future))).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID",
		);
	});
});

describe("H1c-3 unchanged legacy selection", () => {
	it("calls the old selector once with full source/corpus and preserves every result field including prepared policy and under-target reasons", () => {
		const trace = makeTrace(
			fixture({
				...minimal,
				count: 52,
				mutate(input) {
					input.normalizationReceiptHash = "d".repeat(64);
				},
			}),
			blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0"]), beat(2, ["l2_e0"])]),
			[event(1), event(2)],
		);
		const scope = buildLocalStoryFlowScope(inputs(trace)),
			before = localStoryFlowScopeEvidence(scope);
		const expected = selectLocalStoryClips({
			input: trace.source.input,
			ledger: trace.source.manifest.corpus,
			blueprint: trace.blueprint,
			targetDurationFrames: trace.f.targetFrames,
		});
		const spy = vi.spyOn(plannerModule, "selectLocalStoryClips");
		try {
			const plan = selectLocalStoryFlowPlan({ scope }),
				e = localStoryFlowPlanEvidence(plan);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0]).toEqual({
				input: trace.source.input,
				ledger: trace.source.manifest.corpus,
				blueprint: trace.blueprint,
				targetDurationFrames: trace.f.targetFrames,
			});
			expect(e.selection).toEqual(expected);
			expect(e.selectionHash).toBe(hash(expected));
			expect(e.selection.policyVersion).toBe(
				"aisa-prepared-local-story-window-v1",
			);
			expect(e.selection.normalizationReceiptHash).toBe("d".repeat(64));
			expect(e.selection.reasonCodes).toContain("DURATION_UNDER_TARGET");
			expect(e.clock).toEqual({
				status: "LEGACY_FORWARD_COVERAGE_VALIDATED",
				strictEventMomentOrder: "NOT_PROVEN",
			});
			expect(localStoryFlowScopeEvidence(scope)).toEqual(before);
			expect(before.clockStatus).toBe("PENDING");
			const { planHash, ...body } = e;
			expect(planHash).toBe(hash(body));
			expect(Object.isFrozen(plan)).toBe(true);
			expect(before).not.toHaveProperty("planHash");
		} finally {
			spy.mockRestore();
		}
	});
	it("allows shared same-shot coverage while keeping strict event moment order NOT_PROVEN", () => {
		const f = fixture({
			...minimal,
			count: 1,
			ledger(l) {
				first(l.events).role = "CONTEXT";
				l.events.push({
					...structuredClone(first(l.events)),
					id: "e1",
					label: "返す",
					role: "OUTCOME",
				});
			},
			leaf(o) {
				first(first(o.claims).witnesses).allOf = [
					event(0),
					{ kind: "EVENT", eventId: "l0_e1" },
				];
				o.relations.push({
					kind: "REQUIRES",
					from: { kind: "EVENT", eventId: "l0_e1" },
					target: event(0),
				});
			},
		});
		const trace = makeTrace(
				f,
				blueprint([
					beat(0, ["l0_e0"], [], "CONTEXT"),
					beat(1, ["l0_e1"], ["b0"], "OUTCOME"),
				]),
			),
			scope = buildLocalStoryFlowScope(inputs(trace));
		const e = localStoryFlowPlanEvidence(selectLocalStoryFlowPlan({ scope }));
		expect(e.selection.clips).toHaveLength(1);
		expect(e.selection.actualDurationFrames).toBe(90);
		expect(e.selection.localStorySelection.selectedEventIds).toEqual([
			"l0_e0",
			"l0_e1",
		]);
		expect(e.clock.strictEventMomentOrder).toBe("NOT_PROVEN");
	});
	it("keeps structural success separate from old NO_FITTING_PLAN and never tries another wrapper plan", () => {
		const f = fixture({
				...minimal,
				count: 2,
				leaf(o) {
					o.relations.push({
						kind: "REQUIRES",
						from: event(0),
						target: event(1),
					});
				},
			}),
			trace = makeTrace(f, blueprint([beat(0, ["l1_e0"]), beat(1, ["l0_e0"])]));
		const scope = buildLocalStoryFlowScope(inputs(trace));
		expect(localStoryFlowScopeEvidence(scope).clockStatus).toBe("PENDING");
		const spy = vi.spyOn(plannerModule, "selectLocalStoryClips");
		try {
			expect(() => selectLocalStoryFlowPlan({ scope })).toThrow(
				"LOCAL_STORY_NO_FITTING_PLAN",
			);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});
	it("preserves old role, FLOW coherence and selected unsupported numeric-claim failures", () => {
		const f = fixture(minimal),
			wrong = makeTrace(f, blueprint([beat(0, ["l0_e0"], [], "OUTCOME")]));
		expect(() => buildLocalStoryFlowScope(inputs(wrong))).toThrow(
			"LOCAL_STORY_BLUEPRINT_ROLE_MISMATCH",
		);
		const incoherent = makeTrace(
			f,
			blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0"], [])]),
			[event(1)],
		);
		expect(() => buildLocalStoryFlowScope(inputs(incoherent))).toThrow(
			"LOCAL_STORY_BLUEPRINT_COHERENCE_INVALID",
		);
		const numeric = makeTrace(f, {
				...blueprint([beat(0, ["l0_e0"])]),
				message: "100個の鍵を見つける。",
			}),
			scope = buildLocalStoryFlowScope(inputs(numeric));
		expect(() => selectLocalStoryFlowPlan({ scope })).toThrow(
			"LOCAL_STORY_SELECTION_COHERENCE_INVALID",
		);
	});
});

describe("H1c-3 independent unknown readers", () => {
	it("rebuilds the whole scope from independent owned inputs and rejects self-rehashed changed cards or primitives", () => {
		const trace = makeTrace(fixture(minimal), blueprint([beat(0, ["l0_e0"])])),
			options = inputs(trace),
			scope = buildLocalStoryFlowScope(options),
			value = localStoryFlowScopeEvidence(scope);
		expect(
			localStoryFlowScopeEvidence(validateLocalStoryFlowScope(value, options)),
		).toEqual(value);
		const changed = structuredClone(value);
		first(changed.candidateCards).label = "changed outside";
		const { scopeHash: _, ...body } = changed;
		changed.scopeHash = hash(body);
		expect(() => validateLocalStoryFlowScope(changed, options)).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_INVALID",
		);
		const negativeZero = structuredClone(value);
		first(negativeZero.candidateCards).sourceOrder = -0;
		expect(() => validateLocalStoryFlowScope(negativeZero, options)).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_INVALID",
		);
		for (const invalid of [
			{ ...value, extra: undefined },
			{ ...value, [Symbol("extra")]: true },
		])
			expect(() => validateLocalStoryFlowScope(invalid, options)).toThrow(
				"LOCAL_STORY_FLOW_SCOPE_INVALID",
			);
		let reads = 0;
		const getter = structuredClone(value);
		Object.defineProperty(first(getter.trace.refs), "nodeId", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("SYNTHETIC_PRIVATE_VALUE");
			},
		});
		expect(() => validateLocalStoryFlowScope(getter, options)).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_INVALID",
		);
		expect(reads).toBe(0);
	});
	it("calls the old selector once per unknown plan read and compares every selection field, not just IDs", () => {
		const trace = makeTrace(fixture(minimal), blueprint([beat(0, ["l0_e0"])])),
			scope = buildLocalStoryFlowScope(inputs(trace)),
			value = localStoryFlowPlanEvidence(selectLocalStoryFlowPlan({ scope }));
		const spy = vi.spyOn(plannerModule, "selectLocalStoryClips");
		try {
			expect(
				localStoryFlowPlanEvidence(
					validateLocalStoryFlowPlan(value, { scope }),
				),
			).toEqual(value);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
		const mutations = [
			(e: typeof value) => {
				first(e.selection.clips).sourceInUs++;
			},
			(e: typeof value) => {
				e.selection.reasonCodes.reverse();
			},
			(e: typeof value) => {
				first(e.selection.clips).durationFrames++;
				e.selection.actualDurationFrames++;
			},
			(e: typeof value) => {
				e.selection.normalizationReceiptHash = undefined;
			},
		];
		for (const mutate of mutations) {
			const changed = structuredClone(value);
			mutate(changed);
			changed.selectionHash = hash(changed.selection);
			const { planHash: _, ...body } = changed;
			changed.planHash = hash(body);
			expect(() => validateLocalStoryFlowPlan(changed, { scope })).toThrow(
				"LOCAL_STORY_FLOW_PLAN_INVALID",
			);
		}
		const getter = structuredClone(value);
		let reads = 0;
		Object.defineProperty(first(getter.selection.clips), "sceneId", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("SYNTHETIC_PRIVATE_VALUE");
			},
		});
		expect(() => validateLocalStoryFlowPlan(getter, { scope })).toThrow(
			"LOCAL_STORY_FLOW_PLAN_INVALID",
		);
		expect(reads).toBe(0);
	});
	it("keeps scope/plan handles opaque and all copied arrays independent of caller mutation", () => {
		const trace = makeTrace(fixture(minimal), blueprint([beat(0, ["l0_e0"])])),
			options = inputs(trace),
			scope = buildLocalStoryFlowScope(options),
			original = localStoryFlowScopeEvidence(scope),
			plan = selectLocalStoryFlowPlan({ scope }),
			expected = localStoryFlowPlanEvidence(plan);
		expect(() => localStoryFlowScopeEvidence({ ...scope })).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_INVALID",
		);
		expect(() => localStoryFlowPlanEvidence({ ...plan })).toThrow(
			"LOCAL_STORY_FLOW_PLAN_INVALID",
		);
		const outside = localStoryFlowScopeEvidence(scope);
		outside.candidateCards.length = 0;
		outside.trace.refs.reverse();
		first(outside.alternatives).choices.length = 0;
		const selected = localStoryFlowPlanEvidence(plan);
		selected.selection.clips.length = 0;
		selected.selection.reasonCodes.length = 0;
		options.steps.reverse();
		expect(localStoryFlowScopeEvidence(scope)).toEqual(original);
		expect(localStoryFlowPlanEvidence(plan)).toEqual(expected);
	});
});

describe("H1c-3 complete source and prefix boundaries", () => {
	it("maps the actual legacy choice to its original non-first Cartesian alternative", () => {
		const f = { ...fixture({ ...minimal, count: 17 }), targetFrames: 450 },
			b = blueprint([
				beat(0, ["l0_e0"]),
				...Array.from({ length: 4 }, (_, i) =>
					beat(
						i + 1,
						Array.from({ length: 4 }, (_, j) => `l${1 + i * 4 + j}_e0`),
					),
				),
			]),
			trace = makeTrace(
				f,
				b,
				Array.from({ length: 17 }, (_, i) => event(i)),
			);
		const scope = buildLocalStoryFlowScope(inputs(trace)),
			e = localStoryFlowScopeEvidence(scope),
			plan = localStoryFlowPlanEvidence(selectLocalStoryFlowPlan({ scope }));
		const oracle = selectLocalStoryClips({
			input: trace.source.input,
			ledger: trace.source.manifest.corpus,
			blueprint: b,
			targetDurationFrames: f.targetFrames,
		});
		const index = e.alternatives.findIndex((a) =>
			a.choices.every(
				(c, i) => c.eventId === oracle.localStorySelection.selectedEventIds[i],
			),
		);
		expect(index).toBeGreaterThan(0);
		expect(plan.selectedAlternativeIndex).toBe(index);
		expect(plan.selection).toEqual(oracle);
	});
	it("exports only its eight closed APIs and rejects plan source/selection/draft overrides", () => {
		expect(Object.keys(scopeModule).sort()).toEqual(
			[
				"LOCAL_STORY_FLOW_SCOPE_POLICY",
				"LocalStoryFlowScopeError",
				"buildLocalStoryFlowScope",
				"validateLocalStoryFlowScope",
				"localStoryFlowScopeEvidence",
				"selectLocalStoryFlowPlan",
				"validateLocalStoryFlowPlan",
				"localStoryFlowPlanEvidence",
			].sort(),
		);
		const trace = makeTrace(fixture(minimal), blueprint([beat(0, ["l0_e0"])])),
			scope = buildLocalStoryFlowScope(inputs(trace));
		for (const alias of [
			"source",
			"targetFrames",
			"selection",
			"blueprint",
			"currentDraft",
		])
			expect(() =>
				selectLocalStoryFlowPlan({ scope, [alias]: undefined }),
			).toThrow("LOCAL_STORY_FLOW_SCOPE_INVALID");
		const plan = localStoryFlowPlanEvidence(
				selectLocalStoryFlowPlan({ scope }),
			),
			other = makeTrace({ ...trace.f, targetFrames: 301 }, trace.blueprint),
			otherScope = buildLocalStoryFlowScope(inputs(other));
		expect(() =>
			validateLocalStoryFlowPlan(plan, { scope: otherScope }),
		).toThrow("LOCAL_STORY_FLOW_PLAN_INVALID");
	});
	it("rebuilds late mandatory force against an older CONTEXT_ONLY branch without replacing its observation", () => {
		const f = fixture({
			count: 9,
			summaryChars: 320,
			selected: [6],
			leaf(o) {
				if (o.nodeId === "n2")
					o.claims.push({
						id: "c1",
						text: "新しい手掛かり。",
						supports: [event(7)],
						witnesses: [{ id: "w0", allOf: [event(7)] }],
					});
			},
			merge(o) {
				if (o.nodeId === "n4") {
					o.claims.push({
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
					o.relations.push({
						kind: "REQUIRES",
						from: { kind: "OWN_CLAIM", claimId: "c1" },
						target: { kind: "CLAIM", nodeId: "n3", claimId: "c0" },
					});
				}
			},
		});
		const steps = [
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...f,
				}),
				output: rootOutput("n4"),
			}),
		];
		const latest = () => first(steps.slice(-1));
		steps.push(
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "BRANCH",
					previousStep: latest(),
					nodeId: "n4",
				}),
				output: branchOutput(f, "n4"),
			}),
		);
		const oldBranch = localStoryFlowRouteStepEvidence(latest());
		steps.push(
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "LEAF",
					previousStep: latest(),
					nodeId: "n2",
				}),
				output: leafOutput(f, [event(7)], "n2"),
			}),
		);
		steps.push(
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "WITNESS",
					previousStep: latest(),
				}),
				output: {
					...rootOutput("n3"),
					phase: "WITNESS",
					choice: { ...rootOutput("n3").choice, kind: "HARD_REQUIREMENT" },
				},
			}),
		);
		steps.push(
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "BRANCH",
					previousStep: latest(),
					nodeId: "n3",
				}),
				output: branchOutput(f, "n3"),
			}),
		);
		steps.push(
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "LEAF",
					previousStep: latest(),
					nodeId: "n0",
				}),
				output: leafOutput(f, [], "n0"),
			}),
		);
		const before = localStoryFlowRouteStepEvidence(latest()),
			b = blueprint([
				beat(0, ["l0_e0"]),
				beat(1, ["l6_e0"]),
				beat(2, ["l7_e0"]),
			]);
		steps.push(
			buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "FINALIZE",
					previousStep: latest(),
				}),
				output: {
					...finalOutput(
						before.after.closureResult.requiredEvents.map((e) => e.ref),
						"n4",
					),
					blueprint: b,
				},
			}),
		);
		const scope = buildLocalStoryFlowScope({
				source: f.source,
				tree: f.tree,
				steps,
			}),
			e = localStoryFlowScopeEvidence(scope);
		expect(e.trace.refs).toHaveLength(7);
		expect(e.trace.refs[1]?.observationHash).toBe(oldBranch.observationHash);
		expect(e.leafExposures.map((r) => r.nodeId)).toEqual(["n0", "n2"]);
		expect(e.candidateCards.map((c) => c.id)).toEqual([
			"l0_e0",
			"l6_e0",
			"l7_e0",
		]);
		expect(
			localStoryFlowRouteStepEvidence(first(steps.slice(1))).rawOutput,
		).toEqual(oldBranch.rawOutput);
	});
	it("rejects an owned UNREACHED prefix even when a valid complete FINALIZE from a different continuation is supplied", () => {
		const f = fixture({
				...minimal,
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
			good = makeTrace(f, blueprint([beat(0, ["l0_e0"])]));
		const bad = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "LEAF",
				previousStep: first(good.steps),
				nodeId: "n0",
			}),
			output: leafOutput(f, [event(1)]),
		});
		expect(
			localStoryFlowRouteStepEvidence(bad).after.closureResult.status,
		).toBe("UNREACHED");
		expect(() =>
			buildLocalStoryFlowScope({
				...inputs(good),
				steps: [first(good.steps), bad, first(good.steps.slice(-1))],
			}),
		).toThrow("LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
	});
	it("recomputes the original same-composite P-union and dependency hash for all origins", () => {
		const f = fixture({
				...minimal,
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
			}),
			b = blueprint([
				beat(0, ["l0_e0"]),
				beat(1, ["l1_e0"]),
				beat(2, ["l2_e0"]),
			]),
			trace = makeTrace(f, b);
		const e = localStoryFlowScopeEvidence(
				buildLocalStoryFlowScope(inputs(trace)),
			),
			choices = b.beats.map((b) => ({
				beatId: b.id,
				eventId: first(b.eventIds),
			})),
			last = localStoryFlowRouteStepEvidence(first(trace.steps.slice(-1)));
		const state = prepareLocalStoryFlowClosure({
				source: f.source,
				tree: f.tree,
				targetFrames: f.targetFrames,
				rootChoice: last.after.closure.rootChoice,
				hardChoices: last.after.closure.hardChoices.map((c) => c.choice),
			}),
			result = evaluateLocalStoryFlowClosure({
				state,
				seeds: [event(0), event(1), event(2)],
			});
		const rows = [0, 1].map((i) => ({
			origin: { ownerNodeId: "n0", index: i },
			prerequisite: event(i),
			dependent: event(2),
			prerequisiteBeatId: `b${i}`,
			dependentBeatId: "b2",
			ancestorBeatIds: ["b0", "b1"],
		}));
		expect(e.alternatives).toEqual([
			{
				index: 0,
				choices,
				closureResultHash: result.resultHash,
				dependencyCheckHash: hash({
					version: "local-story-flow-alternative-dependencies-v1",
					choices,
					closureResultHash: result.resultHash,
					rows,
				}),
			},
		]);
		expect(e.alternativeChecksHash).toBe(hash(e.alternatives));
		expect(e.fullGraphHash).toBe(hash(trace.tree.graph));
		const missing = makeTrace(f, {
			...b,
			beats: [
				first(b.beats),
				first(b.beats.slice(1)),
				{ ...first(b.beats.slice(2)), requires: ["b0"] },
			],
		});
		expect(() => buildLocalStoryFlowScope(inputs(missing))).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID",
		);
	});
	it("rejects a skipped pending step and all old unresolved records rather than trusting a complete final row", () => {
		const f = fixture({
				...minimal,
				selected: [1],
				leaf(o) {
					o.claims.push({
						id: "c1",
						text: "前提。",
						supports: [event(0)],
						witnesses: [{ id: "w0", allOf: [event(0)] }],
					});
					o.relations.push({
						kind: "REQUIRES",
						from: event(1),
						target: { kind: "OWN_CLAIM", claimId: "c1" },
					});
				},
			}),
			trace = makeTrace(f, blueprint([beat(0, ["l0_e0"]), beat(1, ["l1_e0"])]));
		expect(() =>
			buildLocalStoryFlowScope({
				...inputs(trace),
				steps: trace.steps.filter(
					(s) => localStoryFlowRouteStepEvidence(s).phase !== "WITNESS",
				),
			}),
		).toThrow("LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
		const simple = makeTrace(fixture(minimal), blueprint([beat(0, ["l0_e0"])])),
			firstStep = localStoryFlowRouteStepEvidence(first(simple.steps)),
			root = buildLocalStoryFlowRouteStep({
				expectation: buildLocalStoryFlowRouteExpectation({
					phase: "ROOT",
					...simple.f,
				}),
				output: {
					...firstStep.rawOutput,
					unresolved: [
						{
							ref: { kind: "CONTEXT_NODE", nodeId: firstStep.rawOutput.nodeId },
							reason: "SOURCE_CONTEXT_UNCLEAR",
						},
					],
				},
			});
		expect(() =>
			buildLocalStoryFlowScope({
				...inputs(simple),
				steps: [root, ...simple.steps.slice(1)],
			}),
		).toThrow("LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
	});
	it("rejects source/clock substitution and a fully valid different cached scope instead of treating its hashes as expected", () => {
		const trace = makeTrace(fixture(minimal), blueprint([beat(0, ["l0_e0"])])),
			scope = buildLocalStoryFlowScope(inputs(trace));
		const f = fixture({
			...minimal,
			mutate(input) {
				input.timeMap.id = "55555555-5555-4555-8555-555555555555";
				input.timeMapHash = hash(input.timeMap);
			},
		});
		expect(() =>
			buildLocalStoryFlowScope({
				...inputs(trace),
				source: f.source,
				tree: f.tree,
			}),
		).toThrow("LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
		const otherTrace = makeTrace(
				fixture({ ...minimal, profile: "amd" }),
				blueprint([beat(0, ["l0_e0"])]),
			),
			other = localStoryFlowScopeEvidence(
				buildLocalStoryFlowScope(inputs(otherTrace)),
			);
		expect(() => validateLocalStoryFlowScope(other, inputs(trace))).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_INVALID",
		);
		expect(localStoryFlowScopeEvidence(scope).sourceBindingHash).not.toBe(
			other.sourceBindingHash,
		);
	});
	it("rejects sparse arrays, hidden fields and accessors before reading their properties", () => {
		const trace = makeTrace(fixture(minimal), blueprint([beat(0, ["l0_e0"])])),
			options = inputs(trace);
		let reads = 0;
		const steps = [...trace.steps];
		Object.defineProperty(steps, "0", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("SYNTHETIC_PRIVATE_VALUE");
			},
		});
		expect(() => buildLocalStoryFlowScope({ ...options, steps })).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID",
		);
		const sparse = [...trace.steps];
		delete sparse[1];
		expect(() =>
			buildLocalStoryFlowScope({ ...options, steps: sparse }),
		).toThrow("LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
		const hidden = { ...options };
		Object.defineProperty(hidden, "source", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("SYNTHETIC_PRIVATE_VALUE");
			},
		});
		expect(() => buildLocalStoryFlowScope(hidden)).toThrow(
			"LOCAL_STORY_FLOW_SCOPE_INVALID",
		);
		expect(reads).toBe(0);
	});
	it("uses a fixed policy, code-only errors and immutable bounded detail", () => {
		expect(LOCAL_STORY_FLOW_SCOPE_POLICY).toMatchObject({
			maxAcceptedSteps: 64,
			candidateEventLimit: 32,
			maxAlternatives: 1024,
			scopeClockStatus: "PENDING",
			planClockStatus: "LEGACY_FORWARD_COVERAGE_VALIDATED",
			strictEventMomentOrder: "NOT_PROVEN",
		});
		expect(Object.isFrozen(LOCAL_STORY_FLOW_SCOPE_POLICY)).toBe(true);
		const origin = { ownerNodeId: "n0", index: 0 },
			e = new LocalStoryFlowScopeError(
				"LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID",
				{ alternativeIndex: 1, origin },
			);
		origin.index = 5;
		expect(e.message).toBe(e.code);
		expect(e.name).toBe("LocalStoryFlowScopeError");
		expect(e.detail).toEqual({
			alternativeIndex: 1,
			origin: { ownerNodeId: "n0", index: 0 },
		});
		expect(Object.isFrozen(e.detail.origin)).toBe(true);
		expect(e.cause).toBeUndefined();
	});
});
