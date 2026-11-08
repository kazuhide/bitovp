import { describe, expect, it } from "vitest";
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
import { buildLocalStoryFlowContextTree } from "./local-story-flow-context-tree";
import type { LocalStoryFlowContextOutput } from "./local-story-flow-contracts";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import {
	type BoundLocalStoryFlowRouteStep,
	buildLocalStoryFlowRouteExpectation,
	buildLocalStoryFlowRouteStep,
	localStoryFlowRouteExpectationEvidence,
	localStoryFlowRouteStepEvidence,
} from "./local-story-flow-route";
import {
	localStoryFlowRouteProgressHash,
	nextLocalStoryFlowRoute,
} from "./local-story-flow-scheduler";
import { localStoryFlowIdentityForConfiguration } from "./local-story-flow-stages";
import { buildLocalStoryChunks } from "./local-story-input";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

// Pure synthetic corpus construction; no transport or configuration IO.
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

type Steps = BoundLocalStoryFlowRouteStep[];
function next(f: ReturnType<typeof fixture>, steps: Steps) {
	const n = nextLocalStoryFlowRoute({ ...f, steps });
	if (n.status !== "NEXT") throw new Error("Expected synthetic next operation");
	return n.expectation;
}
function append(f: ReturnType<typeof fixture>, steps: Steps, output: unknown) {
	const step = buildLocalStoryFlowRouteStep({
		expectation: next(f, steps),
		output,
	});
	steps.push(step);
	return step;
}
describe("bounded source-grounded route scheduling", () => {
	it("makes one ROOT, exposes its whole leaf and finalizes without adding a new choice", () => {
		const f = fixture(),
			steps: Steps = [];
		const rootInput = localStoryFlowRouteExpectationEvidence(
			next(f, steps),
		).input;
		expect(rootInput.phase).toBe("ROOT");
		append(f, steps, rootOutput(rootInput.nodeId));
		expect(
			localStoryFlowRouteExpectationEvidence(next(f, steps)).input.phase,
		).toBe("LEAF");
		append(f, steps, leafOutput(f));
		expect(
			localStoryFlowRouteExpectationEvidence(next(f, steps)).input.phase,
		).toBe("FINALIZE");
		append(f, steps, finalOutput([event(0)]));
		expect(nextLocalStoryFlowRoute({ ...f, steps })).toEqual({
			status: "COMPLETE",
			terminal: steps[2],
		});
	});
	it("forces mandatory paths through retained CONTEXT_ONLY observations and observes each branch once", () => {
		const f = fixture({ count: 9, summaryChars: 320, selected: [6] }),
			steps: Steps = [],
			branches: string[] = [];
		const source = localStoryFlowContextSourceEvidence(f.source),
			root = source.layout.rootNodeId;
		append(f, steps, rootOutput(root));
		for (let i = 0; i < 20; i++) {
			const e = localStoryFlowRouteExpectationEvidence(next(f, steps)).input;
			if (e.phase === "FINALIZE") break;
			if (e.phase === "BRANCH") {
				branches.push(e.nodeId);
				append(f, steps, branchOutput(f, e.nodeId));
			} else {
				expect(e.phase).toBe("LEAF");
				append(f, steps, leafOutput(f, [], e.nodeId));
			}
		}
		const exposed = localStoryFlowRouteStepEvidence(first(steps.slice(-1)))
			.after.navigation.exposedPages;
		const page = source.pages.find((p) =>
			p.data.items.some(
				(i) =>
					i.kind === "GROUNDED_LEAF_EVENT_CARD" && i.id === event(6).eventId,
			),
		);
		expect(exposed.map((p) => p.pageId)).toEqual([page?.pageId]);
		expect(new Set(branches).size).toBe(branches.length);
		expect(
			localStoryFlowRouteStepEvidence(steps[1] as BoundLocalStoryFlowRouteStep)
				.rawOutput,
		).toEqual(branchOutput(f, root));
		expect(
			localStoryFlowRouteExpectationEvidence(next(f, steps)).input.phase,
		).toBe("FINALIZE");
	});
	it("visits mandatory descendants before earlier optional frontier, then accounts all DESCEND pages", () => {
		const f = fixture({ count: 9, summaryChars: 320, selected: [6] }),
			steps: Steps = [],
			source = localStoryFlowContextSourceEvidence(f.source);
		append(f, steps, rootOutput(source.layout.rootNodeId));
		append(f, steps, branchOutput(f, source.layout.rootNodeId, "DESCEND"));
		const e = localStoryFlowRouteExpectationEvidence(next(f, steps)).input;
		expect(e.phase).toBe("LEAF");
		const node = source.layout.nodes.find((n) => n.nodeId === e.nodeId);
		expect(
			node?.phase === "LEAF" &&
				source.pages
					.find((p) => p.pageId === node.pageId)
					?.data.items.some(
						(i) =>
							i.kind === "GROUNDED_LEAF_EVENT_CARD" &&
							i.id === event(6).eventId,
					),
		).toBe(true);
		for (let i = 0; i < 30; i++) {
			const input = localStoryFlowRouteExpectationEvidence(
				next(f, steps),
			).input;
			if (input.phase === "FINALIZE") break;
			if (input.phase === "BRANCH")
				append(f, steps, branchOutput(f, input.nodeId, "DESCEND"));
			else {
				expect(input.phase).toBe("LEAF");
				append(f, steps, leafOutput(f, [], input.nodeId));
			}
		}
		expect(
			localStoryFlowRouteStepEvidence(
				first(steps.slice(-1)),
			).after.navigation.exposedPages.map((p) => p.pageId),
		).toEqual(source.pages.map((p) => p.pageId));
		expect(
			steps
				.map(localStoryFlowRouteStepEvidence)
				.map((step) => `${step.phase}:${step.expectation.input.nodeId}`),
		).toEqual([
			"ROOT:n4",
			"BRANCH:n4",
			"LEAF:n2",
			"BRANCH:n3",
			"LEAF:n0",
			"LEAF:n1",
		]);
	});
	it("counts semantic navigation progress and rejects a repeated BRANCH despite changed observation IDs", () => {
		const f = fixture({ count: 9, summaryChars: 320, selected: [6] }),
			source = localStoryFlowContextSourceEvidence(f.source),
			steps: Steps = [];
		append(f, steps, rootOutput(source.layout.rootNodeId));
		const branch = append(f, steps, branchOutput(f, source.layout.rootNodeId));
		const repeated = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "BRANCH",
				previousStep: branch,
				nodeId: source.layout.rootNodeId,
			}),
			output: branchOutput(f, source.layout.rootNodeId),
		});
		expect(localStoryFlowRouteStepEvidence(repeated).observationHash).not.toBe(
			localStoryFlowRouteStepEvidence(branch).observationHash,
		);
		expect(localStoryFlowRouteProgressHash(f.source, repeated)).toBe(
			localStoryFlowRouteProgressHash(f.source, branch),
		);
		expect(() =>
			nextLocalStoryFlowRoute({ ...f, steps: [...steps, repeated] }),
		).toThrow("LOCAL_STORY_FLOW_NO_PROGRESS");
	});
	it("rejects a copied handle, omitted ROOT, reordered history and a changed source/target", () => {
		const f = fixture(),
			steps: Steps = [],
			root = append(f, steps, rootOutput()),
			leaf = append(f, steps, leafOutput(f));
		for (const list of [[structuredClone(root)], [leaf], [leaf, root]])
			expect(() => nextLocalStoryFlowRoute({ ...f, steps: list })).toThrow(
				"LOCAL_STORY_ARTIFACT_UNVERIFIED",
			);
		expect(() =>
			nextLocalStoryFlowRoute({ ...f, targetFrames: 301, steps }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		expect(() =>
			nextLocalStoryFlowRoute({ ...fixture({ count: 3 }), steps }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("rejects sparse, accessor and unknown-key options without reading getters", () => {
		const f = fixture();
		let reads = 0;
		const options = { ...f, steps: [] } as Record<string, unknown>;
		Object.defineProperty(options, "steps", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE");
			},
		});
		expect(() =>
			Reflect.apply(nextLocalStoryFlowRoute, null, [options]),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		const values: Steps = [];
		values.length = 1;
		Object.defineProperty(values, "0", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE");
			},
		});
		expect(() => nextLocalStoryFlowRoute({ ...f, steps: values })).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
		expect(() =>
			Reflect.apply(nextLocalStoryFlowRoute, null, [
				{ ...f, steps: [], extra: 1 },
			]),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		expect(() =>
			nextLocalStoryFlowRoute({ ...f, steps: new Array(1) }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		expect(reads).toBe(0);
	});
});

describe("new mandatory paths without another BRANCH inference", () => {
	it("prioritizes WITNESS and reopens an old CONTEXT_ONLY path using its original observation", () => {
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
		const steps: Steps = [];
		append(f, steps, rootOutput("n4"));
		const branch = append(f, steps, branchOutput(f, "n4"));
		const before = localStoryFlowRouteStepEvidence(branch);
		append(f, steps, leafOutput(f, [event(7)], "n2"));
		expect(
			localStoryFlowRouteExpectationEvidence(next(f, steps)).input.phase,
		).toBe("WITNESS");
		const output = rootOutput("n3");
		append(f, steps, {
			...output,
			phase: "WITNESS",
			choice: { ...output.choice, kind: "HARD_REQUIREMENT" },
		});
		const candidate = localStoryFlowRouteExpectationEvidence(next(f, steps));
		expect(candidate.input.phase).toBe("BRANCH");
		expect(candidate.input.nodeId).toBe("n3");
		expect(candidate.continuation).toMatchObject({
			traversal: [
				{
					parentNodeId: "n4",
					childNodeId: "n3",
					branchObservationHash: before.observationHash,
					rawDisposition: "CONTEXT_ONLY",
					effectiveDisposition: "DESCEND",
				},
			],
		});
		expect(localStoryFlowRouteStepEvidence(branch)).toEqual(before);
		expect(
			steps
				.map(localStoryFlowRouteStepEvidence)
				.filter(
					(e) => e.phase === "BRANCH" && e.expectation.input.nodeId === "n4",
				),
		).toHaveLength(1);
	});
});
