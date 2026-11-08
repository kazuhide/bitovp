import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import {
	localStoryIdentityForConfiguration,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import type { LocalStoryInput } from "./local-story-contracts";
import {
	buildLocalStoryFlowContextNode,
	localStoryFlowContextInputForNode,
	localStoryFlowContextNodeEvidence,
	localStoryFlowContextSourceEvidence,
	prepareLocalStoryFlowContextSource,
	prepareLocalStoryFlowContextSourceFromPin,
	validateLocalStoryFlowContextNode,
} from "./local-story-flow-context";
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
describe("H1b prepared full source and layout", () => {
	it("refuses non-data or unknown FromPin options before executing an accessor", () => {
		const f = fixture();
		const { config: _config, ...sourceOptions } = f.options;
		const options = {
			...sourceOptions,
			pin: { profile: config.profile, configId: config.configId },
		};
		let reads = 0;
		const getter = Object.defineProperty({ ...options }, "mode", {
			enumerable: true,
			get: () => {
				reads++;
				throw new Error("PRIVATE_SOURCE_OPTION");
			},
		});
		expect(() => prepareLocalStoryFlowContextSourceFromPin(getter)).toThrow(
			"LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH",
		);
		expect(() =>
			Reflect.apply(prepareLocalStoryFlowContextSourceFromPin, null, [
				{ ...options, config },
			]),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH");
		expect(reads).toBe(0);
	});
	it("rebuilds the same owned source from a stored model pin without a runtime configuration", () => {
		const f = fixture();
		const { config: _config, ...options } = f.options;
		const pin = { profile: config.profile, configId: config.configId };
		const source = prepareLocalStoryFlowContextSourceFromPin({
			...options,
			pin,
		});
		expect(localStoryFlowContextSourceEvidence(source)).toEqual(
			localStoryFlowContextSourceEvidence(f.source()),
		);
		expect(
			localStoryFlowContextInputForNode({ source, nodeId: "n0", children: [] }),
		).toEqual(
			localStoryFlowContextInputForNode({
				source: f.source(),
				nodeId: "n0",
				children: [],
			}),
		);
		for (const wrongPin of [
			{ ...pin, profile: "amd" },
			{ ...pin, configId: "33333333-3333-4333-8333-333333333333" },
			{ ...pin, token: "synthetic-forbidden-field" },
		])
			expect(() =>
				prepareLocalStoryFlowContextSourceFromPin({
					...options,
					pin: wrongPin,
				}),
			).toThrow("LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH");
	});
	it("binds all source fields and independent workflow, retaining full input", () => {
		const f = fixture(),
			source = f.source(),
			evidence = localStoryFlowContextSourceEvidence(source);
		expect(evidence.input).toEqual(f.options.h0.input);
		expect(evidence.manifest).toEqual(f.options.manifest);
		expect(evidence.sourceBinding.inputHash).toBe(hash(f.options.h0.input));
		expect(evidence.sourceBindingHash).toBe(hash(evidence.sourceBinding));
		evidence.input.shots[0]?.fields.push({
			kind: "AISA",
			pointer: "/fake",
			text: "変更",
		});
		expect(localStoryFlowContextSourceEvidence(source).input).toEqual(
			f.options.h0.input,
		);
		expect(() =>
			localStoryFlowContextSourceEvidence(structuredClone(source)),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_INVALID");
	});
	it("rejects altered source/pages/workflow and unsupported mode", () => {
		const f = fixture();
		const badPages = structuredClone(f.options.pages);
		badPages.pop();
		expect(() =>
			prepareLocalStoryFlowContextSource({ ...f.options, pages: badPages }),
		).toThrow();
		expect(() =>
			prepareLocalStoryFlowContextSource({
				...f.options,
				workflow: { ...f.options.workflow, policyHash: "c".repeat(64) },
			}),
		).toThrow();
		expect(() =>
			Reflect.apply(prepareLocalStoryFlowContextSource, null, [
				{ ...f.options, mode: "AUTO" },
			]),
		).toThrow();
	});
	it("constructs source-ordered odd carries without unary wrappers", () => {
		const f = fixture(9, true, true),
			evidence = localStoryFlowContextSourceEvidence(f.source());
		expect(evidence.pages).toHaveLength(3);
		expect(evidence.layout.nodes.map((n) => n.nodeId)).toEqual([
			"n0",
			"n1",
			"n2",
			"n3",
			"n4",
		]);
		expect(evidence.layout.nodes.at(-1)).toMatchObject({
			children: ["n3", "n2"],
			edgeDepth: 2,
			pageFrom: 0,
			pageToExclusive: 3,
		});
		expect(evidence.layout.rootNodeId).toBe("n4");
	});
});

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
function makeNode(
	source: Source,
	nodeId = "n0",
	output = leafOutput(source, nodeId),
) {
	return buildLocalStoryFlowContextNode({
		source,
		nodeId,
		children: [],
		output,
	});
}
function resealNode(
	value: ReturnType<typeof localStoryFlowContextNodeEvidence>,
) {
	const { nodeHash: _hash, ...body } = value;
	value.nodeHash = hash(body);
	return value;
}
describe("H1b bound node evidence", () => {
	it("retains exact raw/local output and separately maps Own refs to global proof", () => {
		const source = fixture().source(),
			output = leafOutput(source);
		output.relations = [
			{
				kind: "REQUIRES",
				from: { kind: "OWN_WITNESS", claimId: "c0", witnessId: "w0" },
				target: first(output.claims).supports[0] as {
					kind: "EVENT";
					eventId: string;
				},
			},
		];
		output.unresolved = [
			{ ref: { kind: "OWN_CLAIM", claimId: "c0" }, reason: "RELATION_UNCLEAR" },
		];
		const before = structuredClone(output),
			node = makeNode(source, "n0", output),
			value = localStoryFlowContextNodeEvidence(node);
		expect(value.rawOutput).toEqual(before);
		expect(output).toEqual(before);
		expect(value.ownRelations[0]?.relation.from).toEqual({
			kind: "WITNESS",
			nodeId: "n0",
			claimId: "c0",
			witnessId: "w0",
		});
		expect(value.publicView.unresolved[0]?.ref).toEqual({
			kind: "CLAIM",
			nodeId: "n0",
			claimId: "c0",
		});
		expect(value.witnessProofs[0]?.events.map((e) => e.ref.eventId)).toEqual([
			"l0_e0",
			"l1_e0",
		]);
		expect(value.witnessProofs[0]?.eligibility).toEqual({
			availability: "JOINT_UNVERIFIED",
			eventCount: 2,
			minimumFramesLowerBound: 90,
		});
		expect(value.publicViewUtf8Bytes).toBe(
			new TextEncoder().encode(canonicalEditingJson(value.publicView))
				.byteLength,
		);
	});
	it("requires leaf witness events to be that claim's EVENT supports", () => {
		const source = fixture().source(),
			output = leafOutput(source);
		first(output.claims).supports = [{ kind: "SUMMARY", summaryId: "u0" }];
		expect(() => makeNode(source, "n0", output)).toThrow(
			"LOCAL_STORY_FLOW_CONTEXT_INVALID",
		);
	});
	it("rejects account/phase/node mismatches instead of dropping unknown source refs", () => {
		const source = fixture().source(),
			output = leafOutput(source);
		const cases = [
			{ ...output, accountedItems: output.accountedItems.slice(1) },
			{ ...output, accountedItems: [...output.accountedItems].reverse() },
			{ ...output, nodeId: "n1" },
			{ ...output, extra: undefined },
		];
		for (const bad of cases)
			expect(() =>
				buildLocalStoryFlowContextNode({
					source,
					nodeId: "n0",
					children: [],
					output: bad,
				}),
			).toThrow();
	});
	it("strictly rebuilds cached evidence from independent expected output", () => {
		const source = fixture().source(),
			output = leafOutput(source),
			node = makeNode(source, "n0", output),
			good = localStoryFlowContextNodeEvidence(node);
		expect(
			localStoryFlowContextNodeEvidence(
				validateLocalStoryFlowContextNode(good, {
					source,
					nodeId: "n0",
					children: [],
					expectedOutput: output,
				}),
			),
		).toEqual(good);
		const bad = structuredClone(good);
		first(bad.witnessProofs).events.pop();
		resealNode(bad);
		expect(() =>
			validateLocalStoryFlowContextNode(bad, {
				source,
				nodeId: "n0",
				children: [],
				expectedOutput: output,
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_INVALID");
		const changed = structuredClone(output);
		first(changed.claims).text = "別の有効なmodel返答";
		const replacement = localStoryFlowContextNodeEvidence(
			makeNode(source, "n0", changed),
		);
		expect(() =>
			validateLocalStoryFlowContextNode(replacement, {
				source,
				nodeId: "n0",
				children: [],
				expectedOutput: output,
			}),
		).toThrow();
		expect(() =>
			validateLocalStoryFlowContextNode(
				{ ...good, extra: undefined },
				{ source, nodeId: "n0", children: [], expectedOutput: output },
			),
		).toThrow();
	});
	it("does not share mutable aliases across source, raw output, view, proof or readers", () => {
		const source = fixture().source(),
			output = leafOutput(source),
			node = makeNode(source, "n0", output),
			copy = localStoryFlowContextNodeEvidence(node);
		first(output.claims).text = "caller mutation";
		first(copy.publicView.claims).text = "view mutation";
		first(copy.witnessProofs).events.pop();
		expect(first(copy.rawOutput.claims).text).toBe('鍵を"返す"。');
		const fresh = localStoryFlowContextNodeEvidence(node);
		expect(first(fresh.publicView.claims).text).toBe('鍵を"返す"。');
		expect(first(fresh.witnessProofs).events).toHaveLength(2);
		expect(() =>
			localStoryFlowContextNodeEvidence(structuredClone(node)),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_INVALID");
	});
	it("keeps ineligible six-event context and advertises its legacy representability limit", () => {
		const source = fixture(6).source(),
			node = makeNode(source),
			value = localStoryFlowContextNodeEvidence(node);
		expect(first(value.witnessProofs).events).toHaveLength(6);
		expect(first(value.publicView.claims).witnesses[0]?.eligibility).toEqual({
			availability: "UNAVAILABLE",
			eventCount: 6,
			minimumFramesLowerBound: 90,
		});
		expect(first(value.witnessProofs).unavailableReasons).toEqual([
			"EVENT_COUNT_EXCEEDS_LEGACY_BEATS",
		]);
	});
	it("fails closed on complete public views exceeding the actual canonical byte cap", () => {
		const source = fixture(6).source(),
			output = leafOutput(source);
		const template = first(output.claims);
		output.claims = Array.from({ length: 4 }, (_, i) => ({
			...structuredClone(template),
			id: "c" + i,
			text: "あ".repeat(50),
		}));
		expect(() => makeNode(source, "n0", output)).toThrow(
			"LOCAL_STORY_FLOW_CONTEXT_PUBLIC_VIEW_LIMIT",
		);
	});
	it("binds leaf input to exact DATA without future result/receipt fields", () => {
		const source = fixture().source(),
			input = localStoryFlowContextInputForNode({
				source,
				nodeId: "n0",
				children: [],
			});
		expect(input.data).toEqual(
			localStoryFlowContextSourceEvidence(source).pages[0]?.data,
		);
		expect(input.dataUtf8Bytes).toBe(
			new TextEncoder().encode(canonicalEditingJson(input.data)).byteLength,
		);
		expect(input).not.toHaveProperty("nodeHash");
		expect(input).not.toHaveProperty("rawOutputHash");
		const { inputHash, ...body } = input;
		expect(inputHash).toBe(hash(body));
	});
	it("flattens whole child bundles and retains all child input seals", () => {
		const source = fixture(12, false, true).source(),
			e = localStoryFlowContextSourceEvidence(source);
		const plan = first(e.layout.nodes.filter((n) => n.phase === "MERGE"));
		if (plan.phase !== "MERGE") throw new Error("Fixture merge missing");
		const children = plan.children.map((id) => makeNode(source, id));
		const refs = children.map((n) =>
			first(localStoryFlowContextNodeEvidence(n).claimRefs),
		);
		const atoms = children.map(
			(n) => first(localStoryFlowContextNodeEvidence(n).witnessProofs).ref,
		);
		const output: LocalStoryFlowContextOutput = {
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
					text: "鍵の経緯",
					supports: refs,
					witnesses: [{ id: "w0", allOf: atoms }],
				},
			],
			relations: [],
			unresolved: [],
		};
		const node = buildLocalStoryFlowContextNode({
				source,
				nodeId: plan.nodeId,
				children,
				output,
			}),
			value = localStoryFlowContextNodeEvidence(node);
		const expected = children.flatMap((n) =>
			first(localStoryFlowContextNodeEvidence(n).witnessProofs).events.map(
				(e) => e.ref.eventId,
			),
		);
		expect(first(value.witnessProofs).events.map((e) => e.ref.eventId)).toEqual(
			expected,
		);
		expect(first(value.witnessProofs).allOf).toEqual(atoms);
		expect(() =>
			buildLocalStoryFlowContextNode({
				source,
				nodeId: plan.nodeId,
				children: [...children].reverse(),
				output,
			}),
		).toThrow();
		const bad = structuredClone(output);
		first(bad.claims).supports = refs.slice(1);
		expect(() =>
			buildLocalStoryFlowContextNode({
				source,
				nodeId: plan.nodeId,
				children,
				output: bad,
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_INVALID");
	});
});

describe("H1b bounded proof edge cases", () => {
	it("retains unavailable events rather than dropping context with a speech coverage gap", () => {
		const f = fixture(3, false, false, (input) => {
			input.shots.splice(1, 1);
			const excluded = input.coverage[1];
			if (!excluded) throw new Error("Missing synthetic shot");
			excluded.status = "EXCLUDED";
			input.segments = [
				{ startUs: 1_000_000, endUs: 8_000_000, text: "合成の長い発話" },
			];
		});
		const source = f.source(),
			value = localStoryFlowContextNodeEvidence(makeNode(source));
		expect(first(value.witnessProofs).events).toHaveLength(2);
		expect(
			first(value.witnessProofs).events.every((e) => e.minimumFrames === null),
		).toBe(true);
		expect(first(value.publicView.claims).witnesses[0]?.eligibility).toEqual({
			availability: "UNAVAILABLE",
			eventCount: 2,
			minimumFramesLowerBound: null,
		});
		expect(first(value.witnessProofs).unavailableReasons).toEqual([
			"EVENT_MINIMUM_UNAVAILABLE",
		]);
	});
	it("keeps overlapping individual minima as a max lower bound, never a duration sum", () => {
		const source = fixture(2, false, false, (input) => {
			const second = input.shots[1];
			if (!second) throw new Error("Missing synthetic overlap");
			second.fromFrame = 0;
			second.toFrame = 90;
		}).source();
		const proof = first(
			localStoryFlowContextNodeEvidence(makeNode(source)).witnessProofs,
		);
		expect(proof.events.map((e) => e.minimumFrames)).toEqual([90, 90]);
		expect(proof.eligibility.minimumFramesLowerBound).toBe(90);
		expect(proof.eligibility.availability).toBe("JOINT_UNVERIFIED");
	});
	it("never unions unselected OR alternatives and keeps allOf provenance when paths overlap", () => {
		const source = fixture(12, false, true).source(),
			sourceValue = localStoryFlowContextSourceEvidence(source);
		const plan = first(
			sourceValue.layout.nodes.filter((n) => n.phase === "MERGE"),
		);
		if (plan.phase !== "MERGE") throw new Error("Synthetic pair missing");
		const output = leafOutput(source, plan.children[0]),
			c = first(output.claims);
		const a = first(c.witnesses).allOf[0],
			b = first(c.witnesses).allOf[1];
		if (!a || !b) throw new Error("Synthetic events missing");
		c.witnesses = [
			{ id: "w0", allOf: [a] },
			{ id: "w1", allOf: [a, b] },
		];
		const left = makeNode(source, plan.children[0], output),
			rightOutput = leafOutput(source, plan.children[1]);
		rightOutput.claims = [];
		const right = makeNode(source, plan.children[1], rightOutput);
		const leftValue = localStoryFlowContextNodeEvidence(left),
			ref = first(leftValue.claimRefs),
			atoms = leftValue.witnessProofs.map((w) => w.ref);
		const merge: Extract<LocalStoryFlowContextOutput, { phase: "MERGE" }> = {
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
					text: "鍵を返す",
					supports: [ref],
					witnesses: [{ id: "w0", allOf: [first(atoms)] }],
				},
			],
			relations: [],
			unresolved: [],
		};
		const selected = localStoryFlowContextNodeEvidence(
			buildLocalStoryFlowContextNode({
				source,
				nodeId: plan.nodeId,
				children: [left, right],
				output: merge,
			}),
		);
		expect(
			first(selected.witnessProofs).events.map((e) => e.ref.eventId),
		).toEqual([a.eventId]);
		first(first(merge.claims).witnesses).allOf = atoms;
		const both = localStoryFlowContextNodeEvidence(
			buildLocalStoryFlowContextNode({
				source,
				nodeId: plan.nodeId,
				children: [left, right],
				output: merge,
			}),
		);
		expect(first(both.witnessProofs).events.map((e) => e.ref.eventId)).toEqual([
			a.eventId,
			b.eventId,
		]);
		expect(first(both.witnessProofs).allOf).toHaveLength(2);
	});
	it("rejects a foreign source child and a missing actual child witness", () => {
		const source = fixture(12, false, true).source(),
			plan = first(
				localStoryFlowContextSourceEvidence(source).layout.nodes.filter(
					(n) => n.phase === "MERGE",
				),
			);
		if (plan.phase !== "MERGE") throw new Error("Missing synthetic merge");
		const children = plan.children.map((id) => makeNode(source, id)),
			left = localStoryFlowContextNodeEvidence(first(children));
		const ref = first(left.claimRefs),
			atom = first(left.witnessProofs).ref;
		const output: LocalStoryFlowContextOutput = {
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
					text: "根拠",
					supports: [ref],
					witnesses: [{ id: "w0", allOf: [{ ...atom, witnessId: "w2" }] }],
				},
			],
			relations: [],
			unresolved: [],
		};
		expect(() =>
			buildLocalStoryFlowContextNode({
				source,
				nodeId: plan.nodeId,
				children,
				output,
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_INVALID");
		expect(() =>
			localStoryFlowContextInputForNode({
				source,
				nodeId: plan.nodeId,
				children: [makeNode(fixture().source()), ...children.slice(1)],
			}),
		).toThrow("LOCAL_STORY_FLOW_CONTEXT_SOURCE_MISMATCH");
	});
	it("accepts exactly 1800 canonical UTF-8 bytes and rejects the complete view at 1801", () => {
		const source = fixture(6).source(),
			output = leafOutput(source),
			original = first(output.claims);
		output.claims = Array.from({ length: 3 }, (_, i) => ({
			...structuredClone(original),
			id: "c" + i,
			text: 'あ"\\\n',
			witnesses: [
				{ id: "w0", allOf: [first(first(original.witnesses).allOf)] },
			],
		}));
		let last = localStoryFlowContextNodeEvidence(
			makeNode(source, "n0", output),
		);
		for (let step = 0; step < 500; step++) {
			const claim = output.claims.find(
				(c) =>
					new TextEncoder().encode(JSON.stringify(c.text)).byteLength < 160,
			);
			if (!claim) throw new Error("Synthetic boundary did not reach 1801");
			claim.text += "x";
			try {
				last = localStoryFlowContextNodeEvidence(
					makeNode(source, "n0", output),
				);
			} catch (error) {
				expect(error).toMatchObject({
					code: "LOCAL_STORY_FLOW_CONTEXT_PUBLIC_VIEW_LIMIT",
				});
				expect(last.publicViewUtf8Bytes).toBe(1800);
				return;
			}
		}
		throw new Error("Synthetic view never reached byte cap");
	});
	it("cuts caller mutations after preparation and keeps fixed error text", () => {
		const f = fixture(),
			source = f.source(),
			before = localStoryFlowContextSourceEvidence(source);
		first(f.options.h0.input.shots).fields.push({
			kind: "AISA",
			pointer: "/caller",
			text: "変更",
		});
		expect(localStoryFlowContextSourceEvidence(source)).toEqual(before);
		try {
			buildLocalStoryFlowContextNode({
				source,
				nodeId: "n0",
				children: [],
				output: { message: "SYNTHETIC_PRIVATE_TEXT" },
			});
		} catch (error) {
			expect((error as Error).message).toBe("LOCAL_STORY_FLOW_CONTEXT_INVALID");
			return;
		}
		throw new Error("Expected fixed rejection");
	});
});
