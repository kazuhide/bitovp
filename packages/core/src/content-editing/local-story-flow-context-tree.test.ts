import { describe, expect, it } from "vitest";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import {
	localSemanticStageRegistry,
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
	validateLocalStoryFlowContextTree,
} from "./local-story-flow-context-tree";
import type { LocalStoryFlowContextOutput } from "./local-story-flow-contracts";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
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
			ref: "s" + i,
			sceneId: "scene",
			shotIndex: i,
			fromFrame: i * 90,
			toFrame: (i + 1) * 90,
			text: "人物は鍵を見つける。" + "あ".repeat(900),
			fields: [
				{ kind: "AISA", pointer: "/shots/" + i, text: "人物は鍵を見つける。" },
			],
		})),
		coverage: Array.from({ length: count }, (_, i) => ({
			ref: "s" + i,
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
type Source = ReturnType<typeof prepareLocalStoryFlowContextSource>;
type LeafOutput = Extract<LocalStoryFlowContextOutput, { phase: "LEAF" }>;
function first<T extends readonly unknown[]>(values: T): T[number] {
	const value = values[0];
	if (value === undefined) throw new Error("Missing synthetic fixture");
	return value;
}
function leafOutput(source: Source, nodeId = "n0"): LeafOutput {
	const e = localStoryFlowContextSourceEvidence(source),
		plan = first(e.layout.nodes.filter((n) => n.nodeId === nodeId));
	if (plan.phase !== "LEAF") throw new Error("Expected synthetic leaf");
	const page = first(e.pages.filter((p) => p.pageId === plan.pageId));
	const accountedItems = page.data.items.map((item) =>
		item.kind === "DERIVED_CHUNK_SUMMARY"
			? { kind: "SUMMARY" as const, summaryId: item.id }
			: { kind: "EVENT" as const, eventId: item.id },
	);
	const events = accountedItems.filter(
		(ref): ref is { kind: "EVENT"; eventId: string } => ref.kind === "EVENT",
	);
	return {
		version: "local-story-flow-context-output-v1",
		phase: "LEAF",
		mode: "FLOW",
		nodeId,
		pageId: page.pageId,
		accountedItems,
		claims: events.length
			? [
					{
						id: "c0",
						text: '鍵を"返す"。',
						supports: [...events],
						witnesses: [{ id: "w0", allOf: [...events].slice(0, 8) }],
					},
				]
			: [],
		relations: [],
		unresolved: [],
	};
}

function observations(
	f = fixture(6, false, true),
	decorate?: (output: LeafOutput) => void,
) {
	const source = f.source(),
		e = localStoryFlowContextSourceEvidence(source);
	const nodes: BoundLocalStoryFlowContextNode[] = [],
		byId = new Map<string, BoundLocalStoryFlowContextNode>();
	const outputs: { nodeId: string; output: LocalStoryFlowContextOutput }[] = [];
	for (const plan of e.layout.nodes) {
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const node = byId.get(id);
						if (!node) throw new Error("Missing synthetic child");
						return node;
					});
		let output: LocalStoryFlowContextOutput;
		if (plan.phase === "LEAF") {
			output = leafOutput(source, plan.nodeId);
			if (plan.nodeId === "n0") decorate?.(output);
		} else
			output = {
				version: "local-story-flow-context-output-v1",
				phase: "MERGE",
				mode: "FLOW",
				nodeId: plan.nodeId,
				accountedChildren: plan.children.map((nodeId) => ({
					kind: "CHILD_NODE",
					nodeId,
				})),
				claims: [],
				relations: [],
				unresolved: [],
			};
		const node = buildLocalStoryFlowContextNode({
			source,
			nodeId: plan.nodeId,
			children,
			output,
		});
		nodes.push(node);
		byId.set(plan.nodeId, node);
		outputs.push({ nodeId: plan.nodeId, output });
	}
	return { source, nodes, outputs };
}
function annotated() {
	return observations(fixture(6, false, true), (output) => {
		const c = first(output.claims),
			event = first(c.witnesses).allOf[0];
		if (!event) throw new Error("Missing synthetic event");
		output.claims.push({ ...structuredClone(c), id: "c1" });
		output.relations = [
			{
				kind: "REQUIRES",
				from: { kind: "OWN_CLAIM", claimId: "c0" },
				target: event,
			},
			{
				kind: "CONTRADICTS",
				from: { kind: "OWN_CLAIM", claimId: "c0" },
				target: { kind: "OWN_CLAIM", claimId: "c1" },
			},
		];
		output.unresolved = [
			{
				ref: { kind: "OWN_WITNESS", claimId: "c0", witnessId: "w0" },
				reason: "CONTRADICTORY_INPUT",
			},
		];
	});
}
describe("H1b complete tree and retained context graph", () => {
	it.each([
		1, 3, 5, 32,
	])("reconstructs all %s pages with the exact balanced layout", (p) => {
		const f = observations(fixture(p === 1 ? 1 : p * 3, true, true));
		const value = localStoryFlowContextTreeEvidence(
			buildLocalStoryFlowContextTree(f),
			f.source,
		);
		expect(value.coverage).toMatchObject({
			pages: p,
			leafNodes: p,
			internalNodes: p - 1,
			nodes: 2 * p - 1,
			complete: true,
		});
		expect(value.coverage.maxEdgeDepth).toBeLessThanOrEqual(5);
		expect(value.nodes).toHaveLength(2 * p - 1);
		const { treeHash, ...body } = value;
		expect(treeHash).toBe(hash(body));
		expect(value.rootNodeId).toBe("n" + (2 * p - 2));
	});
	it("retains every child origin when its parent has no claims or relations", () => {
		const f = annotated(),
			value = localStoryFlowContextTreeEvidence(
				buildLocalStoryFlowContextTree(f),
				f.source,
			);
		const root = first(
			value.nodes.filter((n) => n.nodeId === value.rootNodeId),
		);
		expect(root.rawOutput.claims).toEqual([]);
		expect(root.ownRelations).toEqual([]);
		expect(
			value.graph.relations.map((r) => [
				r.ownerNodeId,
				r.index,
				r.relation.kind,
			]),
		).toEqual([
			["n0", 0, "REQUIRES"],
			["n0", 1, "CONTRADICTS"],
		]);
		expect(value.graph.relations[0]?.relation.target.kind).toBe("EVENT");
		expect(value.graph.unresolved[0]).toMatchObject({
			ownerNodeId: "n0",
			index: 0,
			issue: {
				ref: { kind: "WITNESS", nodeId: "n0" },
				reason: "CONTRADICTORY_INPUT",
			},
		});
		expect(value.graph.claims.some((c) => c.ref.nodeId === "n0")).toBe(true);
	});
	it("rejects missing, duplicate, reordered or incompatible child seals", () => {
		const f = observations();
		for (const nodes of [
			f.nodes.slice(1),
			[...f.nodes].reverse(),
			[first(f.nodes), ...f.nodes.slice(1), first(f.nodes)],
		])
			expect(() => buildLocalStoryFlowContextTree({ ...f, nodes })).toThrow(
				"LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID",
			);
		const output = structuredClone(first(f.outputs).output);
		first(output.claims).text = "別の返答";
		const alternative = buildLocalStoryFlowContextNode({
			source: f.source,
			nodeId: "n0",
			children: [],
			output,
		});
		expect(() =>
			buildLocalStoryFlowContextTree({
				...f,
				nodes: [alternative, ...f.nodes.slice(1)],
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID");
	});
	it("strictly rebuilds unknown tree values from independent complete observations", () => {
		const f = annotated(),
			tree = buildLocalStoryFlowContextTree(f),
			good = localStoryFlowContextTreeEvidence(tree, f.source);
		const reader = () => ({ source: f.source, expectedOutputs: f.outputs });
		expect(
			localStoryFlowContextTreeEvidence(
				validateLocalStoryFlowContextTree(good, reader()),
				f.source,
			),
		).toEqual(good);
		const damaged = structuredClone(good);
		damaged.graph.unresolved.pop();
		const { treeHash: _hash, ...body } = damaged;
		damaged.treeHash = hash(body);
		for (const value of [
			damaged,
			{ ...good, extra: undefined },
			{ ...good, nodes: good.nodes.slice(1) },
			{ ...good, rootNodeId: "n0" },
		])
			expect(() => validateLocalStoryFlowContextTree(value, reader())).toThrow(
				"LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID",
			);
		expect(() =>
			validateLocalStoryFlowContextTree(good, {
				source: f.source,
				expectedOutputs: f.outputs.slice(1),
			}),
		).toThrow();
		expect(() =>
			validateLocalStoryFlowContextTree(good, {
				source: f.source,
				expectedOutputs: [...f.outputs].reverse(),
			}),
		).toThrow();
	});
	it("keeps graph DTOs separate from all node proof and raw output copies", () => {
		const f = annotated(),
			tree = buildLocalStoryFlowContextTree(f),
			value = localStoryFlowContextTreeEvidence(tree, f.source);
		const originalCount = first(first(value.nodes).witnessProofs).events.length;
		first(value.graph.witnesses).events.pop();
		first(value.graph.claims).supports.pop();
		expect(first(first(value.nodes).witnessProofs).events).toHaveLength(
			originalCount,
		);
		expect(
			first(first(value.nodes).rawOutput.claims).supports.length,
		).toBeGreaterThan(0);
		expect(
			first(localStoryFlowContextTreeEvidence(tree, f.source).graph.witnesses)
				.events,
		).toHaveLength(originalCount);
		expect(() =>
			localStoryFlowContextTreeEvidence(structuredClone(tree), f.source),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID");
		expect(() =>
			localStoryFlowContextTreeEvidence(tree, fixture(3).source()),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH");
	});
	it("does not alter legacy registries or model identities through the new factories", () => {
		annotated();
		expect(hash(localStoryStageRegistry())).toBe(
			"c6e24f37dddb8dbf8ff046f91d82142f130463f3fa6ddecb66a74eadad5c0189",
		);
		expect(hash(localSemanticStageRegistry())).toBe(
			"cca2b05de7299f0a87569dd225d8646d2f78aab398a8c5479957a2135de4b50e",
		);
		const fixed = {
			...config,
			configId: "33333333-3333-4333-8333-333333333333",
		};
		expect(hash(localStoryIdentityForConfiguration(fixed))).toBe(
			"651e61b705049e70a07adda5bff85a9e9d71bc02e5f1858e8f9aedbfebf953d0",
		);
		expect(
			hash(localStoryIdentityForConfiguration({ ...fixed, profile: "amd" })),
		).toBe("bece8496cda72749433ebe022004a3ea8cc59746070294eb629d5b83fc305257");
	});
});

describe("H1b origin and observation identity", () => {
	it("retains the same logical contradiction from separate nodes exactly once per origin", () => {
		const f = annotated(),
			sourceValue = localStoryFlowContextSourceEvidence(f.source),
			plan = first(sourceValue.layout.nodes.filter((n) => n.phase === "MERGE"));
		if (plan.phase !== "MERGE") throw new Error("Missing synthetic pair");
		const byId = new Map(
			f.nodes.map((n) => [localStoryFlowContextNodeEvidence(n).nodeId, n]),
		);
		const children = plan.children.map((id) => {
			const child = byId.get(id);
			if (!child) throw new Error("Missing fixture");
			return child;
		});
		const prior = localStoryFlowContextNodeEvidence(first(children)),
			output: Extract<LocalStoryFlowContextOutput, { phase: "MERGE" }> = {
				version: "local-story-flow-context-output-v1",
				phase: "MERGE",
				mode: "FLOW",
				nodeId: plan.nodeId,
				accountedChildren: plan.children.map((nodeId) => ({
					kind: "CHILD_NODE",
					nodeId,
				})),
				claims: [],
				relations: [
					{
						kind: "CONTRADICTS",
						from: first(prior.claimRefs),
						target: first(prior.claimRefs.slice(1)),
					},
				],
				unresolved: [],
			};
		const parent = buildLocalStoryFlowContextNode({
			source: f.source,
			nodeId: plan.nodeId,
			children,
			output,
		});
		const nodes = f.nodes.map((n) =>
			localStoryFlowContextNodeEvidence(n).nodeId === plan.nodeId ? parent : n,
		);
		const graph = localStoryFlowContextTreeEvidence(
			buildLocalStoryFlowContextTree({ source: f.source, nodes }),
			f.source,
		).graph;
		expect(
			graph.relations
				.filter((r) => r.relation.kind === "CONTRADICTS")
				.map((r) => r.ownerNodeId),
		).toEqual(["n0", plan.nodeId]);
	});
	it("rejects an entirely self-consistent replacement tree under the original output observations", () => {
		const a = observations(),
			good = localStoryFlowContextTreeEvidence(
				buildLocalStoryFlowContextTree(a),
				a.source,
			);
		const replacement = observations(fixture(6, false, true), (out) => {
			first(out.claims).text = "別の構文上有効な結果";
		});
		const value = localStoryFlowContextTreeEvidence(
			buildLocalStoryFlowContextTree(replacement),
			replacement.source,
		);
		expect(value.treeHash).not.toBe(good.treeHash);
		expect(() =>
			validateLocalStoryFlowContextTree(value, {
				source: a.source,
				expectedOutputs: a.outputs,
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_TREE_INVALID");
	});
});
