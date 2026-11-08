import { describe, expect, it } from "vitest";
import {
	LOCAL_STORY_FLOW_H1_POLICY,
	localStoryFlowClaimRefSchema,
	localStoryFlowContextOutputSchema,
	localStoryFlowEventRefSchema,
	localStoryFlowNodeIdSchema,
	localStoryFlowPageIdSchema,
	localStoryFlowRouteOutputSchema,
	localStoryFlowSummaryRefSchema,
	localStoryFlowWitnessRefSchema,
} from "./local-story-flow-contracts";
import { LOCAL_STORY_FLOW_LEAF_PAGE_LIMITS } from "./local-story-flow-manifest";

describe("flow scalar and typed-reference contracts", () => {
	it("keeps frozen policy limits equal to H0 without mutable aliases", () => {
		expect(LOCAL_STORY_FLOW_H1_POLICY.leafPageLimits).toEqual(
			LOCAL_STORY_FLOW_LEAF_PAGE_LIMITS,
		);
		for (const value of [
			LOCAL_STORY_FLOW_H1_POLICY,
			LOCAL_STORY_FLOW_H1_POLICY.leafPageLimits,
			LOCAL_STORY_FLOW_H1_POLICY.formatting,
			LOCAL_STORY_FLOW_H1_POLICY.output,
			LOCAL_STORY_FLOW_H1_POLICY.tree,
			LOCAL_STORY_FLOW_H1_POLICY.invocations,
		])
			expect(Object.isFrozen(value)).toBe(true);
		expect(
			Reflect.set(LOCAL_STORY_FLOW_H1_POLICY.invocations, "total", 128),
		).toBe(false);
		expect(LOCAL_STORY_FLOW_H1_POLICY.invocations.total).toBe(127);
	});
	it.each([
		[
			localStoryFlowPageIdSchema,
			["flow-page0", "flow-page31"],
			["flow-page32", "flow-page00", "flow-page0\n"],
		],
		[localStoryFlowNodeIdSchema, ["n0", "n62"], ["n63", "n00", " n0", "n0\n"]],
	])("requires complete ASCII scalar matches without coercion or trimming", (schema, valid, invalid) => {
		for (const value of valid)
			expect(schema.safeParse(value).success).toBe(true);
		for (const value of [...invalid, 0, null])
			expect(schema.safeParse(value).success).toBe(false);
	});
	it("preserves the summary/event distinction and exact global event ID bounds", () => {
		expect(
			localStoryFlowSummaryRefSchema.parse({
				kind: "SUMMARY",
				summaryId: "u127",
			}),
		).toEqual({ kind: "SUMMARY", summaryId: "u127" });
		expect(
			localStoryFlowEventRefSchema.parse({ kind: "EVENT", eventId: "l127_e5" }),
		).toEqual({ kind: "EVENT", eventId: "l127_e5" });
		for (const eventId of ["u0", "l128_e0", "l0_e6", "l00_e0", "l0_e0\n"])
			expect(
				localStoryFlowEventRefSchema.safeParse({ kind: "EVENT", eventId })
					.success,
			).toBe(false);
		expect(
			localStoryFlowSummaryRefSchema.safeParse({
				kind: "SUMMARY",
				summaryId: "u128",
			}).success,
		).toBe(false);
		expect(
			localStoryFlowEventRefSchema.safeParse({
				kind: "SUMMARY",
				eventId: "l0_e0",
			}).success,
		).toBe(false);
	});
	it("uses explicit claim/witness owners and rejects unknown fields", () => {
		const claim = { kind: "CLAIM", nodeId: "n62", claimId: "c3" },
			witness = {
				kind: "WITNESS",
				nodeId: "n62",
				claimId: "c3",
				witnessId: "w2",
			};
		expect(localStoryFlowClaimRefSchema.parse(claim)).toEqual(claim);
		expect(localStoryFlowWitnessRefSchema.parse(witness)).toEqual(witness);
		for (const value of [
			{ ...claim, claimId: "c4" },
			{ ...claim, text: "An extra field" },
			{ ...claim, kind: "OWN_CLAIM" },
		])
			expect(localStoryFlowClaimRefSchema.safeParse(value).success).toBe(false);
		expect(
			localStoryFlowWitnessRefSchema.safeParse({ ...witness, witnessId: "w3" })
				.success,
		).toBe(false);
	});
});

const event = (eventId = "l0_e0") => ({ kind: "EVENT", eventId });
const summary = () => ({ kind: "SUMMARY", summaryId: "u0" });
const claim = (nodeId = "n0") => ({ kind: "CLAIM", nodeId, claimId: "c0" });
const witness = (nodeId = "n0") => ({
	kind: "WITNESS",
	nodeId,
	claimId: "c0",
	witnessId: "w0",
});
const child = (nodeId: string) => ({ kind: "CHILD_NODE", nodeId });
function first<T>(values: T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("Missing authored fixture");
	return value;
}
function leaf() {
	return {
		version: "local-story-flow-context-output-v1",
		phase: "LEAF",
		mode: "FLOW",
		nodeId: "n0",
		pageId: "flow-page0",
		accountedItems: [summary(), event()],
		claims: [
			{
				id: "c0",
				text: "A key is returned.",
				supports: [summary(), event()],
				witnesses: [{ id: "w0", allOf: [event()] }],
			},
		],
		relations: [],
		unresolved: [],
	};
}
function merge() {
	return {
		version: "local-story-flow-context-output-v1",
		phase: "MERGE",
		mode: "FLOW",
		nodeId: "n2",
		accountedChildren: [child("n0"), child("n1")],
		claims: [
			{
				id: "c0",
				text: "A key is returned.",
				supports: [claim()],
				witnesses: [{ id: "w0", allOf: [witness()] }],
			},
		],
		relations: [],
		unresolved: [],
	};
}
function routes() {
	const common = {
		version: "local-story-flow-route-output-v1",
		mode: "FLOW",
		nodeId: "n2",
		unresolved: [],
	};
	return [
		{
			...common,
			phase: "ROOT",
			choice: { kind: "ROOT_GOAL", claim: claim("n2"), witness: witness("n2") },
		},
		{
			...common,
			phase: "WITNESS",
			choice: {
				kind: "HARD_REQUIREMENT",
				claim: claim("n2"),
				witness: witness("n2"),
			},
		},
		{
			...common,
			phase: "BRANCH",
			accountedChildren: [child("n0"), child("n1")],
			dispositions: [
				{ child: child("n0"), disposition: "DESCEND" },
				{ child: child("n1"), disposition: "CONTEXT_ONLY" },
			],
		},
		{
			...common,
			phase: "LEAF",
			nodeId: "n0",
			pageId: "flow-page0",
			accountedItems: [summary(), event()],
			candidates: [event()],
		},
		{
			...common,
			phase: "FINALIZE",
			accountedRoot: { kind: "CONTEXT_NODE", nodeId: "n2" },
			accountedEvents: [event(), event("l1_e0")],
			blueprint: {
				mode: "FLOW",
				message: "鍵が持ち主へ戻る。",
				beats: [
					{ id: "b0", role: "CONTEXT", eventIds: ["l0_e0"], requires: [] },
					{ id: "b1", role: "OUTCOME", eventIds: ["l1_e0"], requires: ["b0"] },
				],
				uncertainty: "",
			},
		},
	];
}

describe("flow output contracts", () => {
	it("accepts lossless leaf/merge outputs and all five route phases without mutating them", () => {
		for (const output of [leaf(), merge()]) {
			const before = structuredClone(output);
			expect(localStoryFlowContextOutputSchema.parse(output)).toEqual(before);
			expect(output).toEqual(before);
		}
		for (const output of routes()) {
			const before = structuredClone(output);
			expect(localStoryFlowRouteOutputSchema.parse(output)).toEqual(before);
			expect(output).toEqual(before);
		}
	});
	it.each([
		"ASCII",
		"Unicode",
		"JSON escapes",
	])("measures %s claim text as exactly 160 serialized UTF-8 bytes", (kind) => {
		const f = leaf(),
			prefix =
				kind === "Unicode"
					? "あ".repeat(50)
					: kind === "JSON escapes"
						? ' \t\\ "あ'
						: "";
		const size = (text: string) =>
			new TextEncoder().encode(JSON.stringify(text)).byteLength;
		first(f.claims).text = prefix + "x".repeat(160 - size(prefix));
		expect(size(first(f.claims).text)).toBe(160);
		expect(localStoryFlowContextOutputSchema.parse(f).claims[0]?.text).toBe(
			first(f.claims).text,
		);
		first(f.claims).text += "x";
		expect(localStoryFlowContextOutputSchema.safeParse(f).success).toBe(false);
	});
	it.each([
		[
			"duplicate account",
			(f: ReturnType<typeof leaf>) => f.accountedItems.push(event()),
		],
		[
			"duplicate support",
			(f: ReturnType<typeof leaf>) => first(f.claims).supports.push(event()),
		],
		[
			"duplicate atom",
			(f: ReturnType<typeof leaf>) =>
				first(first(f.claims).witnesses).allOf.push(event()),
		],
		[
			"sparse claim",
			(f: ReturnType<typeof leaf>) => {
				first(f.claims).id = "c1";
			},
		],
		[
			"sparse witness",
			(f: ReturnType<typeof leaf>) => {
				first(first(f.claims).witnesses).id = "w1";
			},
		],
		[
			"blank text",
			(f: ReturnType<typeof leaf>) => {
				first(f.claims).text = " \n ";
			},
		],
		[
			"unaccounted support",
			(f: ReturnType<typeof leaf>) =>
				first(f.claims).supports.push(event("l1_e0")),
		],
		[
			"dangling own witness",
			(f: ReturnType<typeof leaf>) =>
				Reflect.set(f, "unresolved", [
					{
						ref: { kind: "OWN_WITNESS", claimId: "c0", witnessId: "w2" },
						reason: "RELATION_UNCLEAR",
					},
				]),
		],
		[
			"self relation",
			(f: ReturnType<typeof leaf>) =>
				Reflect.set(f, "relations", [
					{ kind: "REQUIRES", from: event(), target: event() },
				]),
		],
		[
			"wrong-phase atom",
			(f: ReturnType<typeof leaf>) =>
				Reflect.set(first(first(f.claims).witnesses), "allOf", [witness()]),
		],
	])("rejects %s instead of normalizing or dropping it", (_name, change) => {
		const f = leaf();
		change(f);
		expect(localStoryFlowContextOutputSchema.safeParse(f).success).toBe(false);
	});
	it("preserves direct event prerequisites and rejects reversed duplicate contradictions", () => {
		const f = leaf();
		Reflect.set(f, "relations", [
			{
				kind: "REQUIRES",
				from: { kind: "OWN_CLAIM", claimId: "c0" },
				target: event(),
			},
		]);
		expect(localStoryFlowContextOutputSchema.parse(f).relations).toEqual(
			f.relations,
		);
		f.claims.push({ ...structuredClone(first(f.claims)), id: "c1" });
		Reflect.set(f, "relations", [
			{
				kind: "CONTRADICTS",
				from: { kind: "OWN_CLAIM", claimId: "c0" },
				target: { kind: "OWN_CLAIM", claimId: "c1" },
			},
			{
				kind: "CONTRADICTS",
				from: { kind: "OWN_CLAIM", claimId: "c1" },
				target: { kind: "OWN_CLAIM", claimId: "c0" },
			},
		]);
		expect(localStoryFlowContextOutputSchema.safeParse(f).success).toBe(false);
	});
	it("rejects references to an unaccounted or current node in merge output", () => {
		for (const nodeId of ["n2", "n3"]) {
			const f = merge();
			first(f.claims).supports = [claim(nodeId)];
			expect(localStoryFlowContextOutputSchema.safeParse(f).success).toBe(
				false,
			);
		}
	});
	it("accepts exact collection bounds and rejects a ninth atom or seventeenth relation", () => {
		const f = leaf(),
			items = Array.from({ length: 32 }, (_, i) =>
				event(`l${Math.floor(i / 6)}_e${i % 6}`),
			);
		Reflect.set(f, "accountedItems", items);
		first(f.claims).supports = items;
		first(first(f.claims).witnesses).allOf = items.slice(0, 8);
		Reflect.set(
			f,
			"relations",
			items.slice(0, 16).map((target) => ({
				kind: "REQUIRES",
				from: { kind: "OWN_CLAIM", claimId: "c0" },
				target,
			})),
		);
		expect(localStoryFlowContextOutputSchema.safeParse(f).success).toBe(true);
		const ninth = structuredClone(f);
		first(first(ninth.claims).witnesses).allOf.push(first(items.slice(8)));
		expect(localStoryFlowContextOutputSchema.safeParse(ninth).success).toBe(
			false,
		);
		const seventeenth = structuredClone(f);
		Reflect.set(
			seventeenth,
			"relations",
			items.slice(0, 17).map((target) => ({
				kind: "REQUIRES",
				from: { kind: "OWN_CLAIM", claimId: "c0" },
				target,
			})),
		);
		expect(
			localStoryFlowContextOutputSchema.safeParse(seventeenth).success,
		).toBe(false);
	});
	it("keeps ROOT_GOAL and hard choice distinct and requires the exact witness owner", () => {
		for (const phase of ["ROOT", "WITNESS"]) {
			const output = first(routes().filter((value) => value.phase === phase));
			for (const bad of [
				{ ...output, choice: null },
				{ ...output, choice: {} },
				{
					...output,
					choice: {
						kind: phase === "ROOT" ? "HARD_REQUIREMENT" : "ROOT_GOAL",
						claim: claim("n2"),
						witness: witness("n2"),
					},
				},
				{
					...output,
					choice: {
						kind: phase === "ROOT" ? "ROOT_GOAL" : "HARD_REQUIREMENT",
						claim: claim("n2"),
						witness: { ...witness("n2"), claimId: "c1" },
					},
				},
				{
					...output,
					choice: {
						kind: phase === "ROOT" ? "ROOT_GOAL" : "HARD_REQUIREMENT",
						claim: claim("n1"),
						witness: witness("n1"),
					},
				},
				{ ...output, goalText: "A caller-forged goal" },
			])
				expect(localStoryFlowRouteOutputSchema.safeParse(bad).success).toBe(
					false,
				);
		}
	});
	it("retains old blueprint refinements and confines all alternatives to accounted events", () => {
		const f = first(routes().filter((value) => value.phase === "FINALIZE"));
		for (const beats of [
			[{ id: "b0", role: "ACTION", eventIds: ["l0_e0"], requires: ["b1"] }],
			[
				{
					id: "b0",
					role: "ACTION",
					eventIds: ["l0_e0", "l0_e0"],
					requires: [],
				},
			],
			[{ id: "b0", role: "ACTION", eventIds: ["l2_e0"], requires: [] }],
		])
			expect(
				localStoryFlowRouteOutputSchema.safeParse({
					...f,
					blueprint: {
						mode: "FLOW",
						message: "観測された出来事。",
						beats,
						uncertainty: "",
					},
				}).success,
			).toBe(false);
	});
	it("rejects unsupported modes, versions, extra fields and branch reorderings", () => {
		for (const output of routes())
			for (const bad of [
				{ ...output, mode: "AUTO" },
				{ ...output, mode: "THEME" },
				{ ...output, version: "other" },
				{ ...output, extra: true },
			])
				expect(localStoryFlowRouteOutputSchema.safeParse(bad).success).toBe(
					false,
				);
		const branch = first(routes().filter((value) => value.phase === "BRANCH"));
		expect(
			localStoryFlowRouteOutputSchema.safeParse({
				...branch,
				dispositions: [
					{ child: child("n1"), disposition: "DESCEND" },
					{ child: child("n0"), disposition: "CONTEXT_ONLY" },
				],
			}).success,
		).toBe(false);
	});
	it("uses the exact Issue.ref union for every phase", () => {
		const refs = [
			summary(),
			event(),
			child("n0"),
			{ kind: "CONTEXT_NODE", nodeId: "n2" },
			claim(),
			witness(),
			{ kind: "OWN_CLAIM", claimId: "c0" },
			{ kind: "OWN_WITNESS", claimId: "c0", witnessId: "w0" },
		];
		const expected = {
			ROOT: ["CONTEXT_NODE", "CLAIM", "WITNESS"],
			WITNESS: ["CONTEXT_NODE", "CLAIM", "WITNESS"],
			BRANCH: ["CHILD_NODE", "CLAIM", "WITNESS"],
			LEAF: ["SUMMARY", "EVENT"],
			FINALIZE: ["CONTEXT_NODE", "EVENT", "CLAIM", "WITNESS"],
		};
		for (const output of routes()) {
			const allowed = Reflect.get(expected, output.phase);
			for (const ref of refs)
				expect(
					localStoryFlowRouteOutputSchema.safeParse({
						...output,
						unresolved: [{ ref, reason: "RELATION_UNCLEAR" }],
					}).success,
				).toBe(allowed.includes(ref.kind));
		}
		for (const output of [leaf(), merge()]) {
			const allowed =
				output.phase === "LEAF"
					? ["SUMMARY", "EVENT", "OWN_CLAIM", "OWN_WITNESS"]
					: ["CHILD_NODE", "CLAIM", "WITNESS", "OWN_CLAIM", "OWN_WITNESS"];
			for (const ref of refs)
				expect(
					localStoryFlowContextOutputSchema.safeParse({
						...output,
						unresolved: [{ ref, reason: "RELATION_UNCLEAR" }],
					}).success,
				).toBe(allowed.includes(ref.kind));
		}
	});
});
