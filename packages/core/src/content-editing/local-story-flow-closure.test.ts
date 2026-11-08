import { describe, expect, it } from "vitest";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import {
	localStoryIdentityForConfiguration,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import type { LocalStoryInput } from "./local-story-contracts";
import * as closureModule from "./local-story-flow-closure";
import {
	evaluateLocalStoryFlowClosure,
	extendLocalStoryFlowHardChoice,
	LOCAL_STORY_FLOW_CLOSURE_POLICY,
	LocalStoryFlowClosureError,
	localStoryFlowClosureStateEvidence,
	prepareLocalStoryFlowClosure,
} from "./local-story-flow-closure";
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
import { localStoryFlowIdentityForConfiguration } from "./local-story-flow-stages";
import { buildLocalStoryChunks } from "./local-story-input";
import { cfrTimeMapSchema, MAX_EDIT_DURATION_FRAMES } from "./schema";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

const config: LocalSemanticConfiguration = {
	url: "https://fixture.invalid/",
	token: "synthetic-test-token-".repeat(3),
	caFile: "/never-read/fixture.pem",
	profile: "nvidia",
	configId: "44444444-4444-4444-8444-444444444444",
};
function fixture(
	count = 2,
	zeroEvents = false,
	longSummary = false,
	mutate?: (input: LocalStoryInput) => void,
) {
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
	mutate?.(input);
	const chunks = buildLocalStoryChunks(input),
		model = localStoryIdentityForConfiguration(config);
	const ledgers = chunks.map((chunk) => ({
		summary: longSummary ? "あ".repeat(320) : "人物が鍵を見つける。",
		events: zeroEvents
			? []
			: [
					{
						id: "e0",
						label: "鍵を見つける",
						role: "ACTION" as const,
						refs: [chunk.refs[0] ?? "missing"],
						quotes: [
							{
								ref: chunk.refs[0] ?? "missing",
								quote: "人物は鍵を見つける。",
							},
						],
						subjects: ["人物", "鍵"],
						uncertainty: "文脈は未確認",
					},
				],
	}));
	const transcriptFingerprint = "a".repeat(64),
		schemaHash = localStoryStageRegistry().stages.LOCAL_LEDGER_V1.schemaHash;
	const ledgerRefs = chunks.map((chunk, chunkIndex) => {
		const stageInputHash = hash({ chunk, transcriptFingerprint }),
			promptHash = "b".repeat(64);
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
	const options = {
		h0,
		manifest,
		pages,
		workflow: localStoryFlowIdentityForConfiguration(config, "FLOW"),
		config,
		mode: "FLOW" as const,
	};
	return { options, source: () => prepareLocalStoryFlowContextSource(options) };
}

type Leaf = Extract<LocalStoryFlowContextOutput, { phase: "LEAF" }>;
type Merge = Extract<LocalStoryFlowContextOutput, { phase: "MERGE" }>;
const event = (n: number) => ({ kind: "EVENT" as const, eventId: `l${n}_e0` });
const claim = (nodeId = "n0", claimId = "c0") => ({
	kind: "CLAIM" as const,
	nodeId,
	claimId,
});
const witness = (nodeId = "n0", claimId = "c0", witnessId = "w0") => ({
	kind: "WITNESS" as const,
	nodeId,
	claimId,
	witnessId,
});
const own = (claimId = "c0") => ({ kind: "OWN_CLAIM" as const, claimId });
const hard = (nodeId = "n0", claimId = "c0", witnessId = "w0") => ({
	kind: "HARD_REQUIREMENT" as const,
	claim: claim(nodeId, claimId),
	witness: witness(nodeId, claimId, witnessId),
});
function first<T extends readonly unknown[]>(items: T): T[number] {
	const value = items[0];
	if (value === undefined) throw new Error("Missing authored synthetic data");
	return value;
}
function scenario(
	options: {
		count?: number;
		longSummary?: boolean;
		summaryChars?: number;
		selected?: number[];
		mutate?: (input: LocalStoryInput) => void;
		leaf?: (output: Leaf) => void;
		merge?: (
			output: Merge,
			children: ReturnType<typeof localStoryFlowContextNodeEvidence>[],
		) => void;
	} = {},
) {
	const f = fixture(
		options.count ?? 3,
		false,
		options.longSummary ?? false,
		options.mutate,
	);
	if (options.summaryChars !== undefined) {
		for (const ledger of f.options.h0.ledgers)
			ledger.summary = "あ".repeat(options.summaryChars);
		for (const [i, ref] of f.options.h0.ledgerRefs.entries())
			ref.ledgerHash = hash(f.options.h0.ledgers[i]);
		f.options.manifest = buildLocalStoryFlowManifest(f.options.h0);
		f.options.pages = buildLocalStoryFlowLeafPages(f.options.manifest);
	}
	const source = prepareLocalStoryFlowContextSource(f.options),
		e = localStoryFlowContextSourceEvidence(source);
	const selected = new Set(
		(options.selected ?? [0]).map((n) => event(n).eventId),
	);
	const nodes: BoundLocalStoryFlowContextNode[] = [],
		byId = new Map<string, BoundLocalStoryFlowContextNode>();
	for (const plan of e.layout.nodes) {
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const c = byId.get(id);
						if (!c) throw new Error("Missing fake child");
						return c;
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
			);
			const chosen = events.filter((r) => selected.has(r.eventId));
			output = {
				version: "local-story-flow-context-output-v1",
				phase: "LEAF",
				mode: "FLOW",
				nodeId: plan.nodeId,
				pageId: plan.pageId,
				accountedItems,
				claims: events.length
					? [
							{
								id: "c0",
								text: '合成の目的　鍵を"返す"。',
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
			const values = children.map(localStoryFlowContextNodeEvidence);
			const available = values.filter((v) => v.witnessProofs.length > 0);
			const chosen = available.filter((v) =>
				first(v.witnessProofs).events.some((e) => selected.has(e.ref.eventId)),
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
				claims: available.length
					? [
							{
								id: "c0",
								text: '合成の目的　鍵を"返す"。',
								supports: values.flatMap((v) => v.claimRefs.slice(0, 1)),
								witnesses: [
									{
										id: "w0",
										allOf: (chosen.length ? chosen : available.slice(0, 1)).map(
											(v) => first(v.witnessProofs).ref,
										),
									},
								],
							},
						]
					: [],
				relations: [],
				unresolved: [],
			};
			options.merge?.(output, values);
		}
		const node = buildLocalStoryFlowContextNode({
			source,
			nodeId: plan.nodeId,
			children,
			output,
		});
		nodes.push(node);
		byId.set(plan.nodeId, node);
	}
	const tree = buildLocalStoryFlowContextTree({ source, nodes }),
		value = localStoryFlowContextTreeEvidence(tree, source);
	const rootChoice = {
		kind: "ROOT_GOAL" as const,
		claim: claim(value.rootNodeId),
		witness: witness(value.rootNodeId),
	};
	return { source, tree, rootChoice, targetFrames: 300 };
}
function prepared(options: Parameters<typeof scenario>[0] = {}) {
	return prepareLocalStoryFlowClosure(scenario(options));
}
describe("H1c-1 immutable structural choices", () => {
	it("fixes policy, bounds and code-only errors", () => {
		expect(LOCAL_STORY_FLOW_CLOSURE_POLICY.eventLimit).toBe(32);
		expect(LOCAL_STORY_FLOW_CLOSURE_POLICY.targetMaxFrames).toBe(
			MAX_EDIT_DURATION_FRAMES,
		);
		expect(Object.isFrozen(LOCAL_STORY_FLOW_CLOSURE_POLICY)).toBe(true);
		const error = new LocalStoryFlowClosureError(
			"LOCAL_STORY_FLOW_CLOSURE_INVALID",
		);
		expect(error.message).toBe(error.code);
		expect(error.name).toBe("LocalStoryFlowClosureError");
	});
	it("keeps full ROOT B and exact goal text without granting native provenance", () => {
		const f = scenario({ selected: [0, 1] }),
			state = prepareLocalStoryFlowClosure(f),
			e = localStoryFlowClosureStateEvidence(state);
		expect(e.rootEvents.map((e) => e.ref)).toEqual([event(0), event(1)]);
		expect(e.rootGoalText).toBe('合成の目的　鍵を"返す"。');
		const { structuralStateHash, ...body } = e;
		expect(structuralStateHash).toBe(hash(body));
		expect(e).not.toHaveProperty("receiptHash");
	});
	it("extends immutable hard choices, preserving ROOT and cutting all caller/DTO aliases", () => {
		const f = scenario({
			leaf: (o) =>
				first(o.claims).witnesses.push({ id: "w1", allOf: [event(1)] }),
		});
		const state = prepareLocalStoryFlowClosure(f),
			choice = hard("n0", "c0", "w1");
		const next = extendLocalStoryFlowHardChoice({
			state,
			requestedClaim: claim(),
			choice,
		});
		const value = localStoryFlowClosureStateEvidence(next);
		expect(value.rootChoice.witness.witnessId).toBe("w0");
		expect(first(value.hardChoices).events.map((e) => e.ref)).toEqual([
			event(1),
		]);
		expect(localStoryFlowClosureStateEvidence(state).hardChoices).toEqual([]);
		const repeated = extendLocalStoryFlowHardChoice({
			state: next,
			requestedClaim: claim(),
			choice,
		});
		expect(localStoryFlowClosureStateEvidence(repeated)).toEqual(value);
		expect(() =>
			extendLocalStoryFlowHardChoice({
				state: next,
				requestedClaim: claim(),
				choice: hard(),
			}),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_IMMUTABLE");
		choice.witness.witnessId = "w2";
		value.rootEvents.pop();
		expect(localStoryFlowClosureStateEvidence(next).rootEvents).toHaveLength(1);
		expect(() =>
			localStoryFlowClosureStateEvidence(structuredClone(next)),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
	});
	it("rejects duplicate/unknown/wrong-owner/partial choices and unknown option fields", () => {
		const f = scenario();
		for (const rootChoice of [
			null,
			{},
			{ ...f.rootChoice, goalText: "caller" },
			{ ...f.rootChoice, witness: witness("n0", "c1") },
			{ kind: "ROOT_GOAL", claim: claim(), events: [event(0)] },
		])
			expect(() =>
				prepareLocalStoryFlowClosure({ ...f, rootChoice }),
			).toThrow();
		expect(() =>
			prepareLocalStoryFlowClosure({ ...f, hardChoices: [hard(), hard()] }),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID");
		expect(() =>
			Reflect.apply(prepareLocalStoryFlowClosure, null, [
				{ ...f, inputKey: undefined },
			]),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
		expect(() =>
			Reflect.apply(prepareLocalStoryFlowClosure, null, [
				{ ...f, hardChoices: undefined },
			]),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
		const multi = scenario({ count: 9, longSummary: true });
		expect(() =>
			prepareLocalStoryFlowClosure({
				...multi,
				rootChoice: { kind: "ROOT_GOAL", claim: claim(), witness: witness() },
			}),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID");
	});
	it("validates runtime target limits without coercion and rejects unavailable choices", () => {
		const f = scenario();
		for (const targetFrames of [0, 5401, 0.5, NaN, Infinity, "300"])
			expect(() =>
				Reflect.apply(prepareLocalStoryFlowClosure, null, [
					{ ...f, targetFrames },
				]),
			).toThrow("LOCAL_STORY_FLOW_CLOSURE_DURATION_INVALID");
		const tiny = scenario({
			mutate: (input) =>
				input.shots.forEach((s, i) => {
					s.fromFrame = i;
					s.toFrame = i + 1;
				}),
		});
		for (const targetFrames of [1, 5400])
			expect(
				localStoryFlowClosureStateEvidence(
					prepareLocalStoryFlowClosure({ ...tiny, targetFrames }),
				).targetFrames,
			).toBe(targetFrames);
		expect(() =>
			prepareLocalStoryFlowClosure({ ...f, targetFrames: 1 }),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE");
		expect(() => prepared({ count: 6, selected: [0, 1, 2, 3, 4, 5] })).toThrow(
			"LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE",
		);
	});
});

it("rejects nested ref accessors before parsing without executing or leaking them", () => {
	const f = scenario(),
		state = prepareLocalStoryFlowClosure(f);
	let invoked = 0;
	const throwing = () => {
		invoked++;
		throw new Error("SYNTHETIC_PRIVATE_GETTER");
	};
	const rootChoice = structuredClone(f.rootChoice);
	Object.defineProperty(rootChoice.claim, "nodeId", {
		get: throwing,
		enumerable: true,
	});
	expect(() => prepareLocalStoryFlowClosure({ ...f, rootChoice })).toThrow(
		"LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID",
	);
	const requested = claim();
	Object.defineProperty(requested, "claimId", {
		get: throwing,
		enumerable: true,
	});
	expect(() =>
		extendLocalStoryFlowHardChoice({
			state,
			requestedClaim: requested,
			choice: hard(),
		}),
	).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
	const choice = hard();
	Object.defineProperty(choice.witness, "witnessId", {
		get: throwing,
		enumerable: true,
	});
	expect(() =>
		extendLocalStoryFlowHardChoice({ state, requestedClaim: claim(), choice }),
	).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID");
	expect(invoked).toBe(0);
});

describe("H1c-1 finite known closure", () => {
	it("keeps all ROOT events, never seeds unused hard choices and adds exact event targets", () => {
		const f = scenario({
			selected: [0, 1],
			leaf: (o) => {
				o.claims.push({
					id: "c1",
					text: "別の要件",
					supports: [event(2)],
					witnesses: [{ id: "w0", allOf: [event(2)] }],
				});
			},
		});
		const state = prepareLocalStoryFlowClosure({
			...f,
			hardChoices: [hard("n0", "c1")],
		});
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [event(0)] });
		expect(result.status).toBe("COMPLETE");
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
		]);
		expect(result.unusedHardClaims).toEqual([claim("n0", "c1")]);
		expect(result.usedHardClaims).toEqual([]);
		const direct = prepared({
			leaf: (o) =>
				o.relations.push({
					kind: "REQUIRES",
					from: event(0),
					target: event(1),
				}),
		});
		const exact = evaluateLocalStoryFlowClosure({ state: direct, seeds: [] });
		expect(exact.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
		]);
		expect(exact.usedHardClaims).toEqual([]);
		expect(exact.resolvedRequires).toEqual([
			{ origin: { ownerNodeId: "n0", index: 0 }, events: [event(1)] },
		]);
	});
	it("returns first pending after all known targets, resolves an entire selected OR, and keeps old state", () => {
		const f = scenario({
			leaf: (o) => {
				o.claims.push({
					id: "c1",
					text: "必須",
					supports: [event(0), event(1), event(2)],
					witnesses: [
						{ id: "w0", allOf: [event(0), event(1)] },
						{ id: "w1", allOf: [event(2)] },
					],
				});
				o.relations.push(
					{ kind: "REQUIRES", from: event(0), target: own("c1") },
					{ kind: "REQUIRES", from: event(0), target: event(2) },
				);
			},
		});
		const state = prepareLocalStoryFlowClosure(f);
		const pending = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(pending.status).toBe("PENDING_HARD_CHOICE");
		if (pending.status !== "PENDING_HARD_CHOICE")
			throw new Error("Expected synthetic pending");
		expect(pending.pending).toEqual({
			origin: { ownerNodeId: "n0", index: 0 },
			requestedClaim: claim("n0", "c1"),
		});
		expect(pending.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(2),
		]);
		const extended = extendLocalStoryFlowHardChoice({
			state,
			requestedClaim: claim("n0", "c1"),
			choice: hard("n0", "c1"),
		});
		const resolved = evaluateLocalStoryFlowClosure({
			state: extended,
			seeds: [],
		});
		expect(resolved.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
			event(2),
		]);
		expect(resolved.usedHardClaims).toEqual([claim("n0", "c1")]);
		expect(evaluateLocalStoryFlowClosure({ state, seeds: [] })).toEqual(
			pending,
		);
	});
});

function failureReason(
	result: ReturnType<typeof evaluateLocalStoryFlowClosure>,
) {
	expect(result.status).toBe("UNREACHED");
	if (result.status !== "UNREACHED")
		throw new Error("Expected synthetic domain failure");
	return result.failure;
}
describe("H1c-1 known domain limits", () => {
	it("does not replace summary-only or wholly unavailable hard targets with nearby events", () => {
		const noWitness = prepared({
			leaf: (o) => {
				o.claims.push({
					id: "c1",
					text: "要約のみ",
					supports: [{ kind: "SUMMARY", summaryId: "u0" }],
					witnesses: [],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: event(0),
					target: own("c1"),
				});
			},
		});
		expect(
			failureReason(
				evaluateLocalStoryFlowClosure({ state: noWitness, seeds: [] }),
			),
		).toEqual({
			reason: "HARD_TARGET_NO_WITNESS",
			origin: { ownerNodeId: "n0", index: 0 },
			ref: claim("n0", "c1"),
			cycle: null,
		});
		const unavailable = prepared({
			count: 6,
			leaf: (o) => {
				o.claims.push({
					id: "c1",
					text: "六件",
					supports: [0, 1, 2, 3, 4, 5].map(event),
					witnesses: [{ id: "w0", allOf: [0, 1, 2, 3, 4, 5].map(event) }],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: event(0),
					target: own("c1"),
				});
			},
		});
		expect(
			failureReason(
				evaluateLocalStoryFlowClosure({ state: unavailable, seeds: [] }),
			).reason,
		).toBe("HARD_TARGET_UNAVAILABLE");
	});
	it("retains all 33 known events, permits 32, and reports an initial or edge crossing", () => {
		const state = prepared({ count: 33 });
		const result = evaluateLocalStoryFlowClosure({
			state,
			seeds: Array.from({ length: 32 }, (_, i) => event(i + 1)),
		});
		expect(result.requiredEvents).toHaveLength(33);
		expect(failureReason(result)).toEqual({
			reason: "EVENT_LIMIT",
			origin: null,
			ref: null,
			cycle: null,
		});
		expect(
			evaluateLocalStoryFlowClosure({
				state,
				seeds: Array.from({ length: 32 }, (_, i) => event(i)),
			}).status,
		).toBe("COMPLETE");
		const triggered = prepared({
			count: 33,
			leaf: (o) => {
				if (
					o.accountedItems.some(
						(r) => r.kind === "EVENT" && r.eventId === event(32).eventId,
					)
				)
					o.relations.push({
						kind: "REQUIRES",
						from: own(),
						target: event(32),
					});
			},
		});
		const edge = evaluateLocalStoryFlowClosure({
			state: triggered,
			seeds: Array.from({ length: 31 }, (_, i) => event(i + 1)),
		});
		expect(edge.requiredEvents).toHaveLength(33);
		expect(failureReason(edge).reason).toBe("EVENT_LIMIT");
		expect(failureReason(edge).origin).not.toBeNull();
	});
	it("checks individual event minima without summing and keeps event failure above missing choices", () => {
		const f = scenario({
			mutate: (input) => {
				first(input.shots).toFrame = 1;
			},
			leaf: (o) => {
				o.claims.push({
					id: "c1",
					text: "未選択",
					supports: [event(2)],
					witnesses: [{ id: "w0", allOf: [event(2)] }],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: event(0),
					target: own("c1"),
				});
			},
		});
		const state = prepareLocalStoryFlowClosure({ ...f, targetFrames: 1 });
		expect(
			failureReason(
				evaluateLocalStoryFlowClosure({ state, seeds: [event(1)] }),
			),
		).toEqual({
			reason: "REQUIRED_EVENT_UNAVAILABLE",
			origin: null,
			ref: event(1),
			cycle: null,
		});
		expect(() =>
			prepared({
				leaf: (o) =>
					o.relations.push({
						kind: "REQUIRES",
						from: event(0),
						target: event(0),
					}),
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_INVALID");
		const beta = prepared({
			leaf: (o) => {
				o.claims.push({
					id: "c1",
					text: "全bundle",
					supports: [event(0), event(1)],
					witnesses: [{ id: "w0", allOf: [event(0), event(1)] }],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: event(0),
					target: own("c1"),
				});
			},
		});
		const extended = extendLocalStoryFlowHardChoice({
			state: beta,
			requestedClaim: claim("n0", "c1"),
			choice: hard("n0", "c1"),
		});
		expect(
			failureReason(
				evaluateLocalStoryFlowClosure({ state: extended, seeds: [] }),
			).reason,
		).toBe("DIRECT_SELF_DEPENDENCY");
	});
});

describe("H1c-1 active typed proof", () => {
	it("hashes exact original proof atoms and source bindings, never an unselected OR", () => {
		const state = prepared({
			leaf: (o) =>
				first(o.claims).witnesses.push({ id: "w1", allOf: [event(1)] }),
		});
		const e = localStoryFlowClosureStateEvidence(state),
			result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(result.typedGraphHash).toBe(
			hash({
				version: "local-story-flow-closure-typed-graph-v1",
				sourceBindingHash: e.sourceBindingHash,
				treeHash: e.treeHash,
				policyHash: e.policyHash,
				structuralStateHash: e.structuralStateHash,
				seeds: [],
				requires: [],
				proofRoots: { root: witness(), hard: [], firedWitnesses: [] },
				realizations: [{ claim: claim(), witness: witness() }],
				atoms: [{ witness: witness(), atomIndex: 0, atom: event(0) }],
			}),
		);
	});
	it("rejects known event/claim cycles before a missing choice and returns a stable original-edge cycle", () => {
		const f = scenario({
			leaf: (o) => {
				o.claims.push(
					{
						id: "c1",
						text: "A",
						supports: [event(0)],
						witnesses: [{ id: "w0", allOf: [event(0)] }],
					},
					{
						id: "c2",
						text: "B",
						supports: [event(1)],
						witnesses: [{ id: "w0", allOf: [event(1)] }],
					},
					{
						id: "c3",
						text: "未決",
						supports: [event(2)],
						witnesses: [{ id: "w0", allOf: [event(2)] }],
					},
				);
				o.relations.push(
					{ kind: "REQUIRES", from: event(0), target: own("c2") },
					{ kind: "REQUIRES", from: event(1), target: own("c1") },
					{ kind: "REQUIRES", from: event(0), target: own("c3") },
				);
			},
		});
		const state = prepareLocalStoryFlowClosure({
			...f,
			hardChoices: [hard("n0", "c2"), hard("n0", "c1")],
		});
		const bad = failureReason(
			evaluateLocalStoryFlowClosure({ state, seeds: [] }),
		);
		expect(bad).toEqual({
			reason: "TYPED_REQUIREMENT_CYCLE",
			origin: { ownerNodeId: "n0", index: 0 },
			ref: null,
			cycle: [
				event(0),
				claim("n0", "c2"),
				witness("n0", "c2"),
				event(1),
				claim("n0", "c1"),
				witness("n0", "c1"),
				event(0),
			],
		});
	});
	it("does not let an empty temporal projection hide typed cycles between overlapping whole bundles", () => {
		const f = scenario({
			selected: [0, 1],
			leaf: (o) => {
				for (const id of ["c1", "c2"])
					o.claims.push({
						id,
						text: id,
						supports: [event(0), event(1)],
						witnesses: [{ id: "w0", allOf: [event(0), event(1)] }],
					});
				o.relations.push(
					{ kind: "REQUIRES", from: own("c1"), target: own("c2") },
					{ kind: "REQUIRES", from: own("c2"), target: own("c1") },
				);
			},
		});
		const state = prepareLocalStoryFlowClosure({
			...f,
			hardChoices: [hard("n0", "c1"), hard("n0", "c2")],
		});
		expect(
			failureReason(evaluateLocalStoryFlowClosure({ state, seeds: [] })).reason,
		).toBe("TYPED_REQUIREMENT_CYCLE");
	});
	it("follows complete child-owner proof paths back to an ancestor", () => {
		const f = scenario({
			count: 9,
			longSummary: true,
			merge: (o, children) => {
				o.relations.push({
					kind: "REQUIRES",
					from: first(first(children).claimRefs),
					target: own(),
				});
			},
		});
		const graph = localStoryFlowContextTreeEvidence(f.tree, f.source);
		const hardChoices = graph.nodes
			.filter((n) => n.phase === "MERGE")
			.map((n) => hard(n.nodeId));
		const state = prepareLocalStoryFlowClosure({ ...f, hardChoices });
		const bad = failureReason(
			evaluateLocalStoryFlowClosure({ state, seeds: [] }),
		);
		expect(bad.reason).toBe("TYPED_REQUIREMENT_CYCLE");
		expect(bad.cycle?.some((r) => r.kind === "WITNESS")).toBe(true);
		expect(
			bad.cycle?.some(
				(r) => r.kind === "CLAIM" && r.nodeId !== graph.rootNodeId,
			),
		).toBe(true);
	});
	it("traces a fired Witness anchor for cycles without promoting its unrendered atoms or refs into M", () => {
		const state = prepared({
			leaf: (o) => {
				first(o.claims).witnesses.push({
					id: "w1",
					allOf: [event(0), event(1)],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: { kind: "OWN_WITNESS", claimId: "c0", witnessId: "w1" },
					target: event(2),
				});
			},
		});
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(2),
		]);
		expect(result.committedRefs).toEqual([claim(), witness()]);
		const e = localStoryFlowClosureStateEvidence(state);
		expect(result.typedGraphHash).toBe(
			hash({
				version: "local-story-flow-closure-typed-graph-v1",
				sourceBindingHash: e.sourceBindingHash,
				treeHash: e.treeHash,
				policyHash: e.policyHash,
				structuralStateHash: e.structuralStateHash,
				seeds: [],
				requires: [
					{
						origin: { ownerNodeId: "n0", index: 0 },
						from: witness("n0", "c0", "w1"),
						target: event(2),
					},
				],
				proofRoots: {
					root: witness(),
					hard: [],
					firedWitnesses: [
						{
							origin: { ownerNodeId: "n0", index: 0 },
							witness: witness("n0", "c0", "w1"),
						},
					],
				},
				realizations: [
					{ claim: claim(), witness: witness() },
					{ claim: claim(), witness: witness("n0", "c0", "w1") },
				],
				atoms: [
					{ witness: witness(), atomIndex: 0, atom: event(0) },
					{ witness: witness("n0", "c0", "w1"), atomIndex: 0, atom: event(0) },
					{ witness: witness("n0", "c0", "w1"), atomIndex: 1, atom: event(1) },
				],
			}),
		);
	});
});

describe("H1c-1 temporal projection", () => {
	it("keeps a complete composite bundle but subtracts all same-anchor prerequisites before projecting time", () => {
		const state = prepared({
			selected: [0, 1, 2],
			leaf: (o) => {
				o.relations.push(
					{ kind: "REQUIRES", from: own(), target: event(0) },
					{ kind: "REQUIRES", from: own(), target: event(1) },
				);
			},
		});
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(result.status).toBe("COMPLETE");
		expect(result.temporalRequirements).toEqual([
			{
				origin: { ownerNodeId: "n0", index: 0 },
				prerequisites: [event(0)],
				dependents: [event(2)],
			},
			{
				origin: { ownerNodeId: "n0", index: 1 },
				prerequisites: [event(1)],
				dependents: [event(2)],
			},
		]);
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
			event(2),
		]);
		const noResult = prepared({
			selected: [0, 1],
			leaf: (o) =>
				o.relations.push(
					{ kind: "REQUIRES", from: own(), target: event(0) },
					{ kind: "REQUIRES", from: own(), target: event(1) },
				),
		});
		const empty = evaluateLocalStoryFlowClosure({ state: noResult, seeds: [] });
		expect(failureReason(empty).reason).toBe("NO_DISTINCT_DEPENDENT");
		expect(
			empty.temporalRequirements?.every((t) => t.dependents.length === 0),
		).toBe(true);
	});
	it("projects an individual composite prerequisite without self edges and never decides empty T before missing β", () => {
		const state = prepared({
			selected: [0, 1],
			leaf: (o) =>
				o.relations.push({ kind: "REQUIRES", from: own(), target: event(0) }),
		});
		const complete = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(complete.status).toBe("COMPLETE");
		expect(complete.temporalRequirements).toEqual([
			{
				origin: { ownerNodeId: "n0", index: 0 },
				prerequisites: [event(0)],
				dependents: [event(1)],
			},
		]);
		const f = scenario({
			selected: [0, 2],
			leaf: (o) => {
				o.claims.push(
					{
						id: "c1",
						text: "返却",
						supports: [event(0), event(1)],
						witnesses: [{ id: "w0", allOf: [event(0), event(1)] }],
					},
					{
						id: "c2",
						text: "B",
						supports: [event(1)],
						witnesses: [{ id: "w0", allOf: [event(1)] }],
					},
				);
				o.relations.push(
					{ kind: "REQUIRES", from: own("c1"), target: event(0) },
					{ kind: "REQUIRES", from: event(2), target: own("c2") },
				);
			},
		});
		const pendingState = prepareLocalStoryFlowClosure(f);
		const pending = evaluateLocalStoryFlowClosure({
			state: pendingState,
			seeds: [],
		});
		expect(pending.status).toBe("PENDING_HARD_CHOICE");
		expect(pending.temporalRequirements).toBeNull();
		const next = extendLocalStoryFlowHardChoice({
			state: pendingState,
			requestedClaim: claim("n0", "c2"),
			choice: hard("n0", "c2"),
		});
		const nextResult = evaluateLocalStoryFlowClosure({
			state: next,
			seeds: [],
		});
		expect(nextResult.status).toBe("COMPLETE");
		expect(nextResult.temporalRequirements).toEqual([
			{
				origin: { ownerNodeId: "n0", index: 0 },
				prerequisites: [event(0)],
				dependents: [event(1)],
			},
			{
				origin: { ownerNodeId: "n0", index: 1 },
				prerequisites: [event(1)],
				dependents: [event(2)],
			},
		]);
	});
	it("rejects temporal cycles separately, keeping the first original origin and all P/T rows", () => {
		const state = prepared({
			selected: [0, 1, 2],
			leaf: (o) => {
				o.claims.push(
					{
						id: "c1",
						text: "AB",
						supports: [event(0), event(1)],
						witnesses: [{ id: "w0", allOf: [event(0), event(1)] }],
					},
					{
						id: "c2",
						text: "BC",
						supports: [event(1), event(2)],
						witnesses: [{ id: "w0", allOf: [event(1), event(2)] }],
					},
				);
				o.relations.push(
					{ kind: "REQUIRES", from: own("c1"), target: event(2) },
					{ kind: "REQUIRES", from: own("c2"), target: event(0) },
				);
			},
		});
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(failureReason(result)).toEqual({
			reason: "TEMPORAL_DEPENDENCY_CYCLE",
			origin: { ownerNodeId: "n0", index: 0 },
			ref: null,
			cycle: [event(0), event(2), event(0)],
		});
		expect(result.temporalRequirements).toHaveLength(2);
	});
});

describe("H1c-1 complete-origin diagnostics", () => {
	it("follows all 52 transitive supports for diagnostics without expanding a three-event render obligation", () => {
		const f = scenario({ count: 52, selected: [0, 1, 2] });
		const result = evaluateLocalStoryFlowClosure({
			state: prepareLocalStoryFlowClosure(f),
			seeds: [],
		});
		expect(result.status).toBe("COMPLETE");
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
			event(2),
		]);
		expect(
			result.diagnostics.relevantRefs.filter((r) => r.kind === "EVENT"),
		).toHaveLength(52);
		expect(result.diagnostics.fullGraphHash).toBe(
			hash(localStoryFlowContextTreeEvidence(f.tree, f.source).graph),
		);
	});
	it("blocks either end of a contradiction, even when the other claim and its witness are outside render/diagnostic membership", () => {
		const state = prepared({
			leaf: (o) => {
				o.claims.push(
					{
						id: "c1",
						text: "関連",
						supports: [event(0)],
						witnesses: [{ id: "w0", allOf: [event(0)] }],
					},
					{
						id: "c2",
						text: "外側",
						supports: [event(2)],
						witnesses: [{ id: "w0", allOf: [event(2)] }],
					},
					{
						id: "c3",
						text: "未決",
						supports: [event(1)],
						witnesses: [{ id: "w0", allOf: [event(1)] }],
					},
				);
				o.relations.push(
					{ kind: "REQUIRES", from: event(0), target: own("c3") },
					{ kind: "CONTRADICTS", from: own("c2"), target: own("c1") },
				);
			},
		});
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(failureReason(result).reason).toBe("RELEVANT_CONTRADICTION");
		expect(result.temporalRequirements).toBeNull();
		expect(result.diagnostics.blockingRelations).toEqual([
			{ ownerNodeId: "n0", index: 1 },
		]);
		expect(result.diagnostics.relevantRefs).not.toContainEqual(
			claim("n0", "c2"),
		);
		expect(result.diagnostics.relationCount).toBe(2);
	});
	it("finds child Issues omitted by parent views and does not make every child relevant just because root is relevant", () => {
		const hidden = scenario({
			count: 9,
			longSummary: true,
			leaf: (o) => {
				if (o.nodeId === "n0")
					o.unresolved.push({ ref: own(), reason: "SOURCE_CONTEXT_UNCLEAR" });
			},
		});
		const hiddenResult = evaluateLocalStoryFlowClosure({
			state: prepareLocalStoryFlowClosure(hidden),
			seeds: [],
		});
		expect(failureReason(hiddenResult).reason).toBe("RELEVANT_ISSUE");
		expect(hiddenResult.diagnostics.blockingIssues).toEqual([
			{ ownerNodeId: "n0", index: 0 },
		]);
		expect(
			first(
				localStoryFlowContextTreeEvidence(
					hidden.tree,
					hidden.source,
				).nodes.filter((n) => n.nodeId === hidden.rootChoice.claim.nodeId),
			).publicView.unresolved,
		).toEqual([]);
		const unrelated = scenario({
			count: 9,
			longSummary: true,
			leaf: (o) => {
				if (o.nodeId !== "n0")
					o.unresolved.push({ ref: own(), reason: "RELATION_UNCLEAR" });
			},
			merge: (o, children) => {
				first(o.claims).supports = [first(first(children).claimRefs)];
			},
		});
		const result = evaluateLocalStoryFlowClosure({
			state: prepareLocalStoryFlowClosure(unrelated),
			seeds: [],
		});
		expect(result.status).toBe("COMPLETE");
		expect(result.diagnostics.issueCount).toBeGreaterThan(0);
		expect(result.diagnostics.blockingIssues).toEqual([]);
		expect(result.diagnostics.relevantNodeIds).toContain(
			unrelated.rootChoice.claim.nodeId,
		);
		expect(result.diagnostics.relevantNodeIds).not.toContain("n1");
	});
	it("uses the H0 item chunk mapping to include a same-chunk summary on another page", () => {
		const base = { count: 8, summaryChars: 260 },
			probe = scenario(base),
			source = localStoryFlowContextSourceEvidence(probe.source);
		const pageOf = (id: string) =>
			source.pages.find((p) => p.data.items.some((i) => i.id === id))?.pageId;
		const split = source.manifest.items.find(
			(i) =>
				i.kind === "GROUNDED_LEAF_EVENT_CARD" &&
				pageOf(i.id) !== pageOf(`u${i.chunkIndex}`),
		);
		if (!split)
			throw new Error("Authored fixture must split a summary/event pair");
		const summary = {
			kind: "SUMMARY" as const,
			summaryId: `u${split.chunkIndex}`,
		};
		const f = scenario({
			...base,
			selected: [split.chunkIndex],
			leaf: (o) => {
				if (
					o.accountedItems.some(
						(i) => i.kind === "SUMMARY" && i.summaryId === summary.summaryId,
					)
				)
					o.unresolved.push({ ref: summary, reason: "SOURCE_CONTEXT_UNCLEAR" });
			},
		});
		const result = evaluateLocalStoryFlowClosure({
			state: prepareLocalStoryFlowClosure(f),
			seeds: [],
		});
		expect(failureReason(result).reason).toBe("RELEVANT_ISSUE");
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(split.chunkIndex),
		]);
		expect(result.diagnostics.relevantRefs).toContainEqual(summary);
		const summaryNode = source.layout.nodes.find(
			(n) => n.phase === "LEAF" && n.pageId === pageOf(summary.summaryId),
		);
		expect(result.diagnostics.relevantNodeIds).toContain(summaryNode?.nodeId);
	});
});

describe("H1c-1 exact result and input boundary", () => {
	it("returns the exact status-dependent body and self-excluded hashes without a native/clock/render proof", () => {
		const f = scenario({
			leaf: (o) =>
				o.relations.push({
					kind: "REQUIRES",
					from: event(1),
					target: event(2),
				}),
		});
		const state = prepareLocalStoryFlowClosure(f),
			e = localStoryFlowClosureStateEvidence(state);
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [] }),
			{ resultHash, ...body } = result;
		expect(resultHash).toBe(hash(body));
		expect(result.version).toBe("local-story-flow-closure-result-v1");
		expect(result.sourceBindingHash).toBe(e.sourceBindingHash);
		expect(result.treeHash).toBe(e.treeHash);
		expect(result.policyHash).toBe(hash(LOCAL_STORY_FLOW_CLOSURE_POLICY));
		expect(result.structuralStateHash).toBe(e.structuralStateHash);
		expect(result.targetFrames).toBe(300);
		expect(result.seeds).toEqual([]);
		expect(result.clockStatus).toBe("NOT_EVALUATED");
		expect(result.firedRequires).toEqual([]);
		expect(result.temporalRequirements).toEqual([]);
		expect(Object.keys(result).sort()).toEqual(
			[
				"version",
				"sourceBindingHash",
				"treeHash",
				"policyHash",
				"structuralStateHash",
				"targetFrames",
				"seeds",
				"requiredEvents",
				"usedHardClaims",
				"unusedHardClaims",
				"committedRefs",
				"firedRequires",
				"resolvedRequires",
				"typedGraphHash",
				"diagnostics",
				"temporalRequirements",
				"clockStatus",
				"status",
				"resultHash",
			].sort(),
		);
		const graph = localStoryFlowContextTreeEvidence(f.tree, f.source).graph;
		expect(result.diagnostics.scanHash).toBe(
			hash({
				version: "local-story-flow-closure-diagnostic-scan-v1",
				fullGraphHash: hash(graph),
				structuralStateHash: e.structuralStateHash,
				requiredEventRefs: result.requiredEvents.map((e) => e.ref),
				committedRefs: result.committedRefs,
				relevantRefs: result.diagnostics.relevantRefs,
				relevantNodeIds: result.diagnostics.relevantNodeIds,
				relations: [
					{ origin: { ownerNodeId: "n0", index: 0 }, applies: false },
				],
				issues: [],
			}),
		);
		expect(result).not.toHaveProperty("pending");
		expect(result).not.toHaveProperty("failure");
	});
	it("canonicalizes derived seed/β order, preserves same-label event IDs, and returns mutable copies without aliases", () => {
		const f = scenario({
			leaf: (o) => {
				o.claims.push(
					{
						id: "c1",
						text: "同じ",
						supports: [event(1)],
						witnesses: [{ id: "w0", allOf: [event(1)] }],
					},
					{
						id: "c2",
						text: "同じ",
						supports: [event(2)],
						witnesses: [{ id: "w0", allOf: [event(2)] }],
					},
				);
			},
		});
		const state = prepareLocalStoryFlowClosure({
			...f,
			hardChoices: [hard("n0", "c2"), hard("n0", "c1")],
		});
		const other = prepareLocalStoryFlowClosure({
			...f,
			hardChoices: [hard("n0", "c1"), hard("n0", "c2")],
		});
		const result = evaluateLocalStoryFlowClosure({
			state,
			seeds: [event(2), event(1)],
		});
		expect(result).toEqual(
			evaluateLocalStoryFlowClosure({
				state: other,
				seeds: [event(1), event(2)],
			}),
		);
		expect(result.seeds).toEqual([event(1), event(2)]);
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
			event(2),
		]);
		expect(Object.isFrozen(first(result.diagnostics.relevantRefs))).toBe(false);
		const copy = structuredClone(result);
		Reflect.set(
			first(result.diagnostics.relevantRefs),
			"kind",
			"SYNTHETIC_CORRUPTION",
		);
		result.requiredEvents.pop();
		result.unusedHardClaims.pop();
		expect(
			evaluateLocalStoryFlowClosure({ state, seeds: [event(1), event(2)] }),
		).toEqual(copy);
		expect(() =>
			evaluateLocalStoryFlowClosure({ state: copy, seeds: [] }),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
	});
	it("rejects every seed before closure, including accessors, dense-array violations, Own refs and unknown extra fields", () => {
		const state = prepared(),
			hole = new Array(1),
			symbol = event(0);
		Object.defineProperty(symbol, Symbol("synthetic"), { value: true });
		const nullProto = Object.assign(Object.create(null), event(0));
		let invoked = 0;
		const accessor = event(0),
			array: unknown[] = [event(0)];
		const fail = () => {
			invoked++;
			throw new Error("SYNTHETIC_PRIVATE_GETTER");
		};
		Object.defineProperty(accessor, "eventId", { get: fail, enumerable: true });
		Object.defineProperty(array, "0", { get: fail, enumerable: true });
		for (const seeds of [
			[event(0), event(0)],
			hole,
			[own()],
			[{ ...event(0), extra: undefined }],
			[{ kind: "EVENT", eventId: "l127_e5" }],
			[symbol],
			[nullProto],
			[accessor],
			array,
			Array.from({ length: 33 }, () => event(0)),
		])
			expect(() => evaluateLocalStoryFlowClosure({ state, seeds })).toThrow(
				"LOCAL_STORY_FLOW_CLOSURE_INVALID",
			);
		expect(invoked).toBe(0);
		const proxy = Proxy.revocable([], {});
		proxy.revoke();
		expect(() =>
			evaluateLocalStoryFlowClosure({ state, seeds: proxy.proxy }),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
		for (const value of [
			{ state, seeds: [], inputKey: undefined },
			{ state, seeds: undefined },
			{ state, seeds: [], targetFrames: 1 },
		])
			expect(() =>
				Reflect.apply(evaluateLocalStoryFlowClosure, null, [value]),
			).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
	});
	it("preserves provider source/ownership errors and treats literal ref membership as structural only", () => {
		const f = scenario(),
			other = scenario({
				mutate: (input) => {
					input.title = "別の合成入力";
				},
			});
		expect(() =>
			prepareLocalStoryFlowClosure({ ...f, source: other.source }),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH");
		expect(() =>
			prepareLocalStoryFlowClosure({ ...f, source: structuredClone(f.source) }),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_INVALID");
		expect(() =>
			prepareLocalStoryFlowClosure({ ...f, tree: structuredClone(f.tree) }),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID");
		expect(() =>
			prepareLocalStoryFlowClosure({
				...f,
				rootChoice: { ...f.rootChoice, sourceBindingHash: "a".repeat(64) },
			}),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID");
		expect(
			localStoryFlowClosureStateEvidence(
				prepareLocalStoryFlowClosure({
					...other,
					rootChoice: structuredClone(f.rootChoice),
				}),
			).treeHash,
		).toBe(
			localStoryFlowContextTreeEvidence(other.tree, other.source).treeHash,
		);
	});
});

it("rejects explicit null optional choices and unknown requested claims instead of coalescing either input", () => {
	const f = scenario(),
		state = prepareLocalStoryFlowClosure(f);
	expect(() =>
		Reflect.apply(prepareLocalStoryFlowClosure, null, [
			{ ...f, hardChoices: null },
		]),
	).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID");
	expect(() =>
		extendLocalStoryFlowHardChoice({
			state,
			requestedClaim: claim("n0", "c3"),
			choice: hard(),
		}),
	).toThrow("LOCAL_STORY_FLOW_CLOSURE_INVALID");
});

describe("H1c-1 remaining full-bundle and finite guards", () => {
	it("uses all OR alternatives only as guards and revisits earlier origins after a later edge grows M", () => {
		const state = prepared({
			selected: [2],
			leaf: (o) => {
				o.claims.push({
					id: "c1",
					text: "OR guard",
					supports: [event(0), event(2)],
					witnesses: [
						{ id: "w0", allOf: [event(0)] },
						{ id: "w1", allOf: [event(2)] },
					],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: own("c1"),
					target: event(1),
				});
			},
		});
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(result.status).toBe("COMPLETE");
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(1),
			event(2),
		]);
		expect(result.committedRefs).not.toContainEqual(claim("n0", "c1"));
		const revisit = prepared({
			leaf: (o) => {
				o.claims.push(
					{
						id: "c1",
						text: "先",
						supports: [event(2)],
						witnesses: [{ id: "w0", allOf: [event(2)] }],
					},
					{
						id: "c2",
						text: "後",
						supports: [event(2)],
						witnesses: [{ id: "w0", allOf: [event(2)] }],
					},
				);
				o.relations.push(
					{ kind: "REQUIRES", from: event(1), target: own("c1") },
					{ kind: "REQUIRES", from: event(0), target: event(1) },
					{ kind: "REQUIRES", from: event(0), target: own("c2") },
				);
			},
		});
		const pending = evaluateLocalStoryFlowClosure({
			state: revisit,
			seeds: [],
		});
		expect(pending.status).toBe("PENDING_HARD_CHOICE");
		if (pending.status !== "PENDING_HARD_CHOICE")
			throw new Error("Expected synthetic pending");
		expect(pending.pending).toEqual({
			origin: { ownerNodeId: "n0", index: 0 },
			requestedClaim: claim("n0", "c1"),
		});
		expect(pending.firedRequires).toEqual(
			[0, 1, 2].map((index) => ({ ownerNodeId: "n0", index })),
		);
	});
	it("rejects a null individual minimum from seeds or an exact prerequisite while retaining all source evidence", () => {
		const options = {
			count: 4,
			mutate: (input: LocalStoryInput) => {
				input.shots.splice(1, 1);
				first(input.coverage.filter((c) => c.ref === "s1")).status = "EXCLUDED";
				input.segments = [
					{ startUs: 4_000_000, endUs: 8_000_000, text: "途切れない合成発話" },
				];
			},
		};
		const f = scenario(options),
			source = localStoryFlowContextSourceEvidence(f.source);
		expect(
			first(
				source.manifest.items.filter(
					(i) =>
						i.kind === "GROUNDED_LEAF_EVENT_CARD" && i.id === event(1).eventId,
				),
			),
		).toHaveProperty("minimumFrames", null);
		const state = prepareLocalStoryFlowClosure(f),
			seeded = evaluateLocalStoryFlowClosure({ state, seeds: [event(1)] });
		expect(failureReason(seeded)).toEqual({
			reason: "REQUIRED_EVENT_UNAVAILABLE",
			origin: null,
			ref: event(1),
			cycle: null,
		});
		const direct = prepared({
			...options,
			leaf: (o) =>
				o.relations.push({
					kind: "REQUIRES",
					from: event(0),
					target: event(1),
				}),
		});
		const result = evaluateLocalStoryFlowClosure({ state: direct, seeds: [] });
		expect(failureReason(result)).toEqual({
			reason: "REQUIRED_EVENT_UNAVAILABLE",
			origin: { ownerNodeId: "n0", index: 0 },
			ref: event(1),
			cycle: null,
		});
		expect(result.temporalRequirements).toBeNull();
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
		]);
	});
	it("keeps both exact child-witness paths and every original atom when their flattened event is the same", () => {
		const f = scenario({
			count: 9,
			longSummary: true,
			leaf: (o) => {
				if (o.nodeId === "n0")
					first(o.claims).witnesses.push({ id: "w1", allOf: [event(0)] });
			},
			merge: (o, children) => {
				const second = children
					.flatMap((c) => c.witnessProofs)
					.find((w) => w.ref.witnessId === "w1");
				if (second) first(first(o.claims).witnesses).allOf.push(second.ref);
			},
		});
		const state = prepareLocalStoryFlowClosure(f),
			e = localStoryFlowClosureStateEvidence(state),
			result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(result.status).toBe("COMPLETE");
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([event(0)]);
		expect(result.committedRefs).toContainEqual(witness());
		expect(result.committedRefs).toContainEqual(witness("n0", "c0", "w1"));
		const graph = localStoryFlowContextTreeEvidence(f.tree, f.source).graph;
		const proofs = graph.witnesses.filter((w) =>
			result.committedRefs.some(
				(r) =>
					r.kind === "WITNESS" &&
					r.nodeId === w.ref.nodeId &&
					r.claimId === w.ref.claimId &&
					r.witnessId === w.ref.witnessId,
			),
		);
		const atoms = proofs.flatMap((w) =>
			w.allOf.map((atom, atomIndex) => ({ witness: w.ref, atomIndex, atom })),
		);
		expect(
			atoms.filter(
				(a) => a.atom.kind === "EVENT" && a.atom.eventId === event(0).eventId,
			),
		).toHaveLength(2);
		expect(result.typedGraphHash).toBe(
			hash({
				version: "local-story-flow-closure-typed-graph-v1",
				sourceBindingHash: e.sourceBindingHash,
				treeHash: e.treeHash,
				policyHash: e.policyHash,
				structuralStateHash: e.structuralStateHash,
				seeds: [],
				requires: [],
				proofRoots: {
					root: e.rootChoice.witness,
					hard: [],
					firedWitnesses: [],
				},
				realizations: proofs.map((w) => ({
					claim: claim(w.ref.nodeId, w.ref.claimId),
					witness: w.ref,
				})),
				atoms,
			}),
		);
	});
	it("retains fixed ROOT while β selects another witness of that same claim, and validates unused choices", () => {
		const f = scenario({
			leaf: (o) => {
				first(o.claims).witnesses.push({ id: "w1", allOf: [event(1)] });
				o.relations.push({ kind: "REQUIRES", from: event(0), target: own() });
			},
		});
		const state = prepareLocalStoryFlowClosure({
			...f,
			hardChoices: [hard("n0", "c0", "w1")],
		});
		expect(
			localStoryFlowClosureStateEvidence(state).rootEvents.map((e) => e.ref),
		).toEqual([event(0)]);
		const result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
		expect(result.requiredEvents.map((e) => e.ref)).toEqual([
			event(0),
			event(1),
		]);
		expect(result.usedHardClaims).toEqual([claim()]);
		const unavailable = scenario({
			count: 6,
			leaf: (o) =>
				o.claims.push({
					id: "c1",
					text: "未使用でも不適格",
					supports: [0, 1, 2, 3, 4, 5].map(event),
					witnesses: [{ id: "w0", allOf: [0, 1, 2, 3, 4, 5].map(event) }],
				}),
		});
		expect(() =>
			prepareLocalStoryFlowClosure({
				...unavailable,
				hardChoices: [hard("n0", "c1")],
			}),
		).toThrow("LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE");
	});
});

it("checks child-node Issues against relevant nodes while hashing all original issue records", () => {
	const base = { count: 9, longSummary: true },
		probe = scenario(base),
		rootId = probe.rootChoice.claim.nodeId;
	const f = scenario({
		...base,
		merge: (o, children) => {
			if (o.nodeId !== rootId) return;
			first(o.claims).supports = [first(first(children).claimRefs)];
			for (const child of children)
				o.unresolved.push({
					ref: { kind: "CHILD_NODE", nodeId: child.nodeId },
					reason: "RELATION_UNCLEAR",
				});
		},
	});
	const state = prepareLocalStoryFlowClosure(f),
		result = evaluateLocalStoryFlowClosure({ state, seeds: [] });
	expect(failureReason(result).reason).toBe("RELEVANT_ISSUE");
	expect(result.diagnostics.blockingIssues).toEqual([
		{ ownerNodeId: rootId, index: 0 },
	]);
	expect(result.diagnostics.issueCount).toBe(2);
	const tree = localStoryFlowContextTreeEvidence(f.tree, f.source),
		e = localStoryFlowClosureStateEvidence(state);
	expect(result.diagnostics.scanHash).toBe(
		hash({
			version: "local-story-flow-closure-diagnostic-scan-v1",
			fullGraphHash: hash(tree.graph),
			structuralStateHash: e.structuralStateHash,
			requiredEventRefs: result.requiredEvents.map((e) => e.ref),
			committedRefs: result.committedRefs,
			relevantRefs: result.diagnostics.relevantRefs,
			relevantNodeIds: result.diagnostics.relevantNodeIds,
			relations: [],
			issues: [
				{ origin: { ownerNodeId: rootId, index: 0 }, applies: true },
				{ origin: { ownerNodeId: rootId, index: 1 }, applies: false },
			],
		}),
	);
});
it("keeps EVENT_LIMIT ahead of a missing choice and emits exact negative-status hashes", () => {
	const state = prepared({
		count: 33,
		leaf: (o) => {
			if (o.nodeId === "n0") {
				o.claims.push({
					id: "c1",
					text: "未決",
					supports: [event(1)],
					witnesses: [{ id: "w0", allOf: [event(1)] }],
				});
				o.relations.push({
					kind: "REQUIRES",
					from: event(0),
					target: own("c1"),
				});
			}
		},
	});
	const result = evaluateLocalStoryFlowClosure({
		state,
		seeds: Array.from({ length: 32 }, (_, i) => event(i + 1)),
	});
	expect(failureReason(result).reason).toBe("EVENT_LIMIT");
	expect(result.requiredEvents).toHaveLength(33);
	expect(result).not.toHaveProperty("pending");
	expect(result.temporalRequirements).toBeNull();
	const { resultHash, ...body } = result;
	expect(resultHash).toBe(hash(body));
	const pending = prepared({
		leaf: (o) => {
			o.claims.push({
				id: "c1",
				text: "未決",
				supports: [event(1)],
				witnesses: [{ id: "w0", allOf: [event(1)] }],
			});
			o.relations.push({ kind: "REQUIRES", from: event(0), target: own("c1") });
		},
	});
	const p = evaluateLocalStoryFlowClosure({ state: pending, seeds: [] }),
		{ resultHash: pHash, ...pBody } = p;
	expect(p.status).toBe("PENDING_HARD_CHOICE");
	expect(p).not.toHaveProperty("failure");
	expect(pHash).toBe(hash(pBody));
});

it("keeps the exact policy and six-value public surface separate from any native permission", () => {
	expect(LOCAL_STORY_FLOW_CLOSURE_POLICY).toEqual({
		version: "local-story-flow-closure-policy-v1",
		eventLimit: 32,
		targetMaxFrames: MAX_EDIT_DURATION_FRAMES,
		guardRule: "exact-event-witness-all-claim-or-union-v1",
		seedRule: "root-all-plus-original-event-seeds-v1",
		hardChoiceRule: "immutable-claim-whole-witness-unused-not-seed-v1",
		pendingRule: "first-origin-after-known-fixed-point-v1",
		temporalRule: "direct-self-reject-same-anchor-union-prerequisites-v1",
		typedCycleRule: "fired-requires-and-exact-proof-realizations-v1",
		emptyCompositeRule: "no-distinct-dependent-after-all-targets-v1",
		diagnosticRule: "all-origins-downward-provenance-either-conflict-end-v1",
		clockRule: "not-evaluated-v1",
	});
	expect(Object.keys(closureModule).sort()).toEqual(
		[
			"LOCAL_STORY_FLOW_CLOSURE_POLICY",
			"LocalStoryFlowClosureError",
			"prepareLocalStoryFlowClosure",
			"extendLocalStoryFlowHardChoice",
			"localStoryFlowClosureStateEvidence",
			"evaluateLocalStoryFlowClosure",
		].sort(),
	);
	const state = prepared();
	expect(Object.keys(state)).toEqual([]);
	expect(Object.isFrozen(state)).toBe(true);
	const error = new LocalStoryFlowClosureError(
		"LOCAL_STORY_FLOW_CLOSURE_INVALID",
	);
	expect(error).not.toHaveProperty("cause");
});
