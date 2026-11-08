import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
} from "./local-semantic-protocol";
import {
	localStoryIdentityForModelPin,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import type { LocalStoryInput } from "./local-story-contracts";
import { LOCAL_STORY_FLOW_CLOSURE_POLICY } from "./local-story-flow-closure";
import {
	type BoundLocalStoryFlowContextNode,
	buildLocalStoryFlowContextNode,
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	localStoryFlowContextInputForNode,
	localStoryFlowContextNodeEvidence,
	localStoryFlowContextSourceEvidence,
	prepareLocalStoryFlowContextSourceFromPin,
} from "./local-story-flow-context";
import { buildLocalStoryFlowContextTree } from "./local-story-flow-context-tree";
import {
	LOCAL_STORY_FLOW_H1_POLICY,
	type LocalStoryFlowContextOutput,
} from "./local-story-flow-contracts";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import * as native from "./local-story-flow-native";
import {
	buildLocalStoryFlowRouteExpectation,
	buildLocalStoryFlowRouteStep,
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	localStoryFlowRouteExpectationEvidence,
	localStoryFlowRouteStepEvidence,
} from "./local-story-flow-route";
import {
	localStoryFlowIdentityForModelPin,
	localStoryFlowStageRegistry,
} from "./local-story-flow-stages";
import { buildLocalStoryChunks } from "./local-story-input";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

const modelPin = {
	profile: "nvidia" as const,
	configId: "44444444-4444-4444-8444-444444444444",
};
const organizationId = "00000000-0000-4000-8000-000000000001";
const originTaskId = "00000000-0000-4000-8000-000000000002";
// Future engine/scope/delivery owners are deliberately synthetic contracts, never production READY.
function pin(
	selected: { profile: "amd" | "nvidia"; configId: string } = modelPin,
) {
	return {
		modelPin: selected,
		policies: {
			version: "local-story-flow-task-policies-v1",
			workflowPolicyHash: hash(LOCAL_STORY_FLOW_H1_POLICY),
			contextPolicyHash: hash(LOCAL_STORY_FLOW_CONTEXT_POLICY),
			closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
			routePolicyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
			promptPolicyHash: hash(native.LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
			engineValidationPolicyHash: hash({
				fixtureOnly: "UNIMPLEMENTED_H2_ENGINE_POLICY",
			}),
			scopePolicyHash: hash({ fixtureOnly: "SCOPE" }),
			deliveryPolicyHash: hash({
				fixtureOnly: "UNIMPLEMENTED_H3B_DELIVERY_POLICY",
			}),
		},
	};
}
function fixture(
	count = 1,
	rootRequires = false,
	profile: "amd" | "nvidia" = "nvidia",
) {
	const selectedModelPin = { ...modelPin, profile };
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
		title: "合成の鍵",
		description: "合成の鍵を返す。",
		timeMap,
		timeMapHash: hash(timeMap),
		segments: [],
		scenes: [{ sceneId: "scene", text: "合成の場面", fields: [] }],
		shots: Array.from({ length: count }, (_, i) => ({
			ref: "s" + i,
			sceneId: "scene",
			shotIndex: i,
			fromFrame: i * 90,
			toFrame: (i + 1) * 90,
			text: "人物は鍵を見つける。" + "あ".repeat(900),
			fields: [
				{
					kind: "AISA" as const,
					pointer: "/shots/" + i,
					text: "人物は鍵を見つける。",
				},
			],
		})),
		coverage: Array.from({ length: count }, (_, i) => ({
			ref: "s" + i,
			status: "ELIGIBLE" as const,
		})),
	};
	const chunks = buildLocalStoryChunks(input),
		model = localStoryIdentityForModelPin(selectedModelPin);
	const ledgers = chunks.map((chunk) => {
		const ref = chunk.refs[0];
		if (!ref) throw new Error("Missing synthetic source ref");
		return {
			summary: "合成の鍵を見つける。",
			events: [
				{
					id: "e0",
					label: "鍵を見つける",
					role: "ACTION" as const,
					refs: [ref],
					quotes: [{ ref, quote: "鍵を見つける。" }],
					subjects: ["人物"],
					uncertainty: "合成",
				},
			],
		};
	});
	const transcriptFingerprint = hash("synthetic transcript");
	const schemaHash =
		localStoryStageRegistry().stages.LOCAL_LEDGER_V1.schemaHash;
	const ledgerRefs = chunks.map((chunk, chunkIndex) => {
		const stageInputHash = hash({ chunk, transcriptFingerprint }),
			promptHash = hash("synthetic accepted prompt");
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
	const source = prepareLocalStoryFlowContextSourceFromPin({
		h0,
		manifest,
		pages,
		workflow: localStoryFlowIdentityForModelPin(selectedModelPin, "FLOW"),
		pin: selectedModelPin,
		mode: "FLOW",
	});
	const sourceValue = localStoryFlowContextSourceEvidence(source);
	const nodes: BoundLocalStoryFlowContextNode[] = [];
	const byId = new Map<string, BoundLocalStoryFlowContextNode>();
	const rawById = new Map<string, LocalStoryFlowContextOutput>();
	for (const plan of sourceValue.layout.nodes) {
		let output: LocalStoryFlowContextOutput;
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const child = byId.get(id);
						if (!child) throw new Error("Missing synthetic child");
						return child;
					});
		if (plan.phase === "LEAF") {
			const page = pages.find((p) => p.pageId === plan.pageId);
			if (!page) throw new Error("Missing synthetic page");
			const accountedItems = page.data.items.map((item) =>
				item.kind === "DERIVED_CHUNK_SUMMARY"
					? { kind: "SUMMARY" as const, summaryId: item.id }
					: { kind: "EVENT" as const, eventId: item.id },
			);
			const event = accountedItems.find((item) => item.kind === "EVENT");
			if (!event) throw new Error("Missing synthetic event");
			output = {
				version: "local-story-flow-context-output-v1",
				mode: "FLOW",
				phase: "LEAF",
				nodeId: plan.nodeId,
				pageId: plan.pageId,
				accountedItems,
				claims: [
					{
						id: "c0",
						text: "鍵を返す。",
						supports: [event],
						witnesses: [{ id: "w0", allOf: [event] }],
					},
				],
				relations: [],
				unresolved: [],
			};
		} else {
			const childEvidence = children.map(localStoryFlowContextNodeEvidence);
			const claims = childEvidence.map((child) => {
				const claim = child.claimRefs[0];
				if (!claim) throw new Error("Missing synthetic claim");
				return claim;
			});
			const witness = childEvidence[0]?.witnessProofs[0]?.ref;
			if (!witness) throw new Error("Missing synthetic witness");
			const target = claims[1];
			if (!target) throw new Error("Missing synthetic target");
			output = {
				version: "local-story-flow-context-output-v1",
				mode: "FLOW",
				phase: "MERGE",
				nodeId: plan.nodeId,
				accountedChildren: plan.children.map((nodeId) => ({
					kind: "CHILD_NODE",
					nodeId,
				})),
				claims: [
					{
						id: "c0",
						text: "鍵を返す。",
						supports: claims,
						witnesses: [{ id: "w0", allOf: [witness] }],
					},
				],
				relations:
					rootRequires && plan.nodeId === sourceValue.layout.rootNodeId
						? [
								{
									kind: "REQUIRES",
									from: { kind: "OWN_CLAIM", claimId: "c0" },
									target,
								},
							]
						: [],
				unresolved: [],
			};
		}
		const node = buildLocalStoryFlowContextNode({
			source,
			nodeId: plan.nodeId,
			children,
			output,
		});
		nodes.push(node);
		byId.set(plan.nodeId, node);
		rawById.set(plan.nodeId, output);
	}
	const node = byId.get("n0"),
		raw = rawById.get("n0");
	if (!node || !raw) throw new Error("Missing synthetic first leaf");
	const tree = buildLocalStoryFlowContextTree({ source, nodes });
	return { source, node, nodes, tree, raw };
}

describe("H2 pure native formatter and request identity", () => {
	it("returns fresh fixed errors when a hostile descriptor trap throws a modified native error", () => {
		const failure = new native.LocalStoryFlowNativeError(
			"LOCAL_STORY_FLOW_NATIVE_INVALID",
		);
		failure.message = "PRIVATE_EXCEPTION_MESSAGE";
		const input = new Proxy(
			{ organizationId, originTaskId, nativeKeyHash: "0".repeat(64) },
			{
				ownKeys: () => {
					throw failure;
				},
			},
		);
		expect(() => native.localStoryFlowNativeRequestIds(input)).toThrow(
			"LOCAL_STORY_FLOW_NATIVE_INVALID",
		);
	});
	it("uses the approved exact URL namespace vector without a dependency or runtime config", () => {
		expect(
			native.localStoryFlowNativeRequestIds({
				organizationId,
				originTaskId,
				nativeKeyHash: "0".repeat(64),
			}),
		).toEqual({
			requestKey: "8f9613d3-2dff-5fb3-a384-d3f08853431b",
			jobId: "556276c4-4e88-5c5a-8643-05783ab9a621",
		});
	});
	it("formats complete owned context DATA with exact markers, separate byte caps and the core inputHash", () => {
		const f = fixture();
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: pin(),
		});
		const e = native.localStoryFlowNativeExpectationEvidence(expected);
		const input = localStoryFlowContextInputForNode({
			source: f.source,
			nodeId: "n0",
			children: [],
		});
		expect(e.input).toEqual(input);
		expect(e.prompt).toBe(
			native.LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY.contextInstruction +
				"\nCONTROL\n" +
				canonicalEditingJson(e.control) +
				"\nDATA\n" +
				canonicalEditingJson(input.data),
		);
		expect(e.promptHash).toBe(e.nativeKey.promptHash);
		expect(e.nativeKey.coreInputHash).toBe(input.inputHash);
		expect(e.nativeKey.binding).toEqual({
			kind: "CONTEXT",
			manifestHash: input.sourceBinding.manifestHash,
			layoutHash: input.sourceBinding.layoutHash,
			orderedInputProofs: input.orderedInputProofs,
		});
		expect(e.promptUtf8Bytes).toBe(
			new TextEncoder().encode(e.prompt).byteLength,
		);
		expect(e.instructionUtf8Bytes).toBe(774);
		expect(e.prefixUtf8Bytes).toBe(
			e.instructionUtf8Bytes + 9 + e.controlUtf8Bytes + 6,
		);
		expect(e.dataUtf8Bytes).toBe(input.dataUtf8Bytes);
		expect(e.promptUtf8Bytes).toBeLessThanOrEqual(5632);
		const request = native.nativeRequestForOrigin(expected, {
			organizationId,
			originTaskId,
		});
		expect(request.body).toMatchObject({
			version: "bitovp-semantic-job-v1",
			organizationId,
			profile: "nvidia",
			stage: "LOCAL_FLOW_CONTEXT_V1",
			inputHash: input.inputHash,
			prompt: e.prompt,
			promptVersion: "local-story-flow-context-v1",
			schemaHash:
				localStoryFlowStageRegistry().stages.LOCAL_FLOW_CONTEXT_V1.schemaHash,
		});
		expect(request.requestHash).toBe(hash(request.body));
		expect(e.nativeKeyHash).toBe(hash(e.nativeKey));
		expect(
			native.nativeRequestForOrigin(expected, {
				organizationId,
				originTaskId: "00000000-0000-4000-8000-000000000003",
			}).body.requestKey,
		).not.toBe(request.body.requestKey);
		expect(
			native.localStoryFlowNativeExpectationEvidence(expected).nativeKeyHash,
		).toBe(e.nativeKeyHash);
	});
	it("constructs ROOT before any choice, future receipt or native root proof exists", () => {
		const f = fixture();
		const routeExpectation = buildLocalStoryFlowRouteExpectation({
			phase: "ROOT",
			source: f.source,
			tree: f.tree,
			targetFrames: 900,
		});
		const handle = native.routeNativeExpectation({
			routeExpectation,
			pin: pin(),
		});
		const e = native.localStoryFlowNativeExpectationEvidence(handle);
		if (e.input.version !== "local-story-flow-route-input-v1")
			throw new Error("Synthetic ROOT expected");
		expect(e.input).toEqual(
			localStoryFlowRouteExpectationEvidence(routeExpectation).input,
		);
		expect(e.nativeKey.stage).toBe("LOCAL_FLOW_ROUTE_V1");
		expect(e.nativeKey.binding).toEqual({
			kind: "ROOT",
			treeHash: e.input.treeHash,
			targetFrames: 900,
			rootSelectionPolicy: "source-grounded-flow-goal-v1",
		});
		expect(JSON.stringify(e.nativeKey)).not.toContain("nativeRootProof");
		expect(e.instructionUtf8Bytes).toBe(779);
		expect(() =>
			Reflect.apply(native.routeNativeExpectation, null, [
				{ routeExpectation, pin: pin(), nativeRootProof: "a".repeat(64) },
			]),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
	});
	it("rejects forged handles, wrong compiled relevant policies and caller aliases", () => {
		const f = fixture(),
			p = pin();
		for (const name of [
			"workflowPolicyHash",
			"contextPolicyHash",
			"promptPolicyHash",
		] as const) {
			expect(() =>
				native.contextNativeExpectation({
					source: f.source,
					nodeId: "n0",
					children: [],
					pin: { ...p, policies: { ...p.policies, [name]: "f".repeat(64) } },
				}),
			).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		}
		expect(() =>
			native.contextNativeExpectation({
				source: structuredClone(f.source),
				nodeId: "n0",
				children: [],
				pin: p,
			}),
		).toThrow();
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: p,
		});
		const saved = native.localStoryFlowNativeExpectationEvidence(expected);
		saved.prompt = "alias mutation";
		saved.nativeKey.workflowIdentity.baseModel.profile = "amd";
		expect(
			native.localStoryFlowNativeExpectationEvidence(expected).prompt,
		).not.toBe("alias mutation");
		expect(() =>
			native.localStoryFlowNativeExpectationEvidence(structuredClone(expected)),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		expect(() =>
			Reflect.apply(native.nativeRequestForOrigin, null, [
				expected,
				{ organizationId, originTaskId, slot: 2 },
			]),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		expect(
			localStoryFlowContextSourceEvidence(f.source).workflow.baseModel.profile,
		).toBe("nvidia");
	});
});

// Independent origin facts stand in for future trusted DB/RPC admission; no row/lease/RLS is executed.
function captured(
	expected: native.BoundLocalStoryFlowNativeExpectation,
	output: unknown,
	sealed = false,
) {
	const e = native.localStoryFlowNativeExpectationEvidence(expected);
	const request = native.nativeRequestForOrigin(expected, {
		organizationId,
		originTaskId,
	});
	const ref = (
		receiptId: string,
		purpose: "START" | "ATTEMPT" | "OUTCOME",
	) => ({
		kind: "LOCAL_FLOW_PLAN_V1" as const,
		receiptId,
		cacheHash: "a".repeat(64),
		inputKeyHash: hash({
			version: "local-story-flow-record-key-v1",
			purpose,
			keyBody:
				purpose === "START"
					? { taskId: originTaskId }
					: { taskId: originTaskId, slot: 1 },
		}),
		proofHash: "a".repeat(64),
	});
	const origin = {
		organizationId,
		originTaskId,
		slot: 1,
		startRef: ref("288fe5ff-910c-5097-9d7a-726dbcc788c7", "START"),
		attemptRef: ref("56862565-6b84-586a-95e6-1a8489f21d47", "ATTEMPT"),
	};
	const receipt = {
		version: "bitovp-semantic-receipt-v1" as const,
		profile: request.body.profile,
		model: LOCAL_SEMANTIC_MODEL,
		modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
		runtimeVersion: LOCAL_SEMANTIC_RUNTIME_VERSION,
		inputHash: request.body.inputHash,
		promptHash: e.promptHash,
		schemaHash: request.body.schemaHash,
		promptVersion: request.body.promptVersion,
		context: 8192 as const,
		maxOutputTokens: 1536 as const,
		thinking: false as const,
		requestHash: request.requestHash,
		elapsedMs: 1.25,
		apiStats: {
			promptEvalCount: 12,
			evalCount: 14,
			doneReason: "stop" as const,
			loadDurationNs: 0,
			promptEvalDurationNs: 10,
			evalDurationNs: 20,
		},
		placement: [
			{
				name: "synthetic-model",
				size: 1,
				sizeVram: 1,
				contextLength: 8192 as const,
			},
		],
		cleanupConfirmed: true as const,
		schemaVerified: false as const,
	};
	const body = {
		version: "local-story-flow-native-observation-v1" as const,
		purpose: "NATIVE_OBSERVATION" as const,
		nativeKey: e.nativeKey,
		origin,
		requestBody: request.body,
		requestHash: request.requestHash,
		requestKey: request.body.requestKey,
		jobId: request.jobId,
		terminalJob: {
			id: request.jobId,
			stage: request.body.stage,
			state: "SUCCEEDED" as const,
			requestHash: request.requestHash,
			cleanupConfirmed: true,
			result: { content: " \n" + JSON.stringify(output) + "\n", receipt },
		},
	};
	const observation = { ...body, observationHash: hash(body) };
	const observationRef = {
		kind:
			request.body.stage === "LOCAL_FLOW_CONTEXT_V1"
				? ("LOCAL_FLOW_CONTEXT_V1" as const)
				: ("LOCAL_FLOW_ROUTE_V1" as const),
		receiptId: "70594e37-0546-52bf-b31c-0c085e9da212",
		cacheHash: "b".repeat(64),
		inputKeyHash: hash({
			version: "local-story-flow-record-key-v1",
			purpose: "NATIVE_OBSERVATION",
			keyBody: { nativeKeyHash: e.nativeKeyHash, originTaskId, slot: 1 },
		}),
		proofHash: hash({
			version: "local-story-cache-v2",
			cacheHash: "b".repeat(64),
			valueJson: canonicalEditingJson(observation),
		}),
	};
	const common = {
		version: "local-story-flow-native-origin-contract-v1" as const,
		origin,
		sourceBindingHash: e.nativeKey.sourceBindingHash,
		workflowIdentityHash: hash(e.nativeKey.workflowIdentity),
		nativeKeyHash: e.nativeKeyHash,
		coreInputHash: request.body.inputHash,
		requestHash: request.requestHash,
	};
	const resolvedOrigin = sealed
		? {
				...common,
				kind: "SEALED_ACCEPTED" as const,
				accepted: {
					status: "ACCEPTED" as const,
					outcomeRef: ref("b51f8911-9ece-5712-ba5d-9313591fbd1c", "OUTCOME"),
					observationRef,
					observationHash: observation.observationHash,
				},
			}
		: {
				...common,
				kind: "CURRENT_CAPTURE" as const,
				capture: {
					taskId: originTaskId,
					leaseToken: "55555555-5555-4555-8555-555555555555",
					connectionHash: hash("synthetic owned connection"),
				},
			};
	return { expected, observation, observationRef, resolvedOrigin };
}
function resealObservation(o: ReturnType<typeof captured>["observation"]) {
	const { observationHash: _hash, ...body } = o;
	o.observationHash = hash(body);
	return o;
}

describe("all structural route phases keep exact native inputs", () => {
	it("formats MERGE context plus ROOT/WITNESS/BRANCH/LEAF/FINALIZE without inventing a native history", () => {
		const f = fixture(20, true),
			source = localStoryFlowContextSourceEvidence(f.source);
		const rootPlan = source.layout.nodes.find(
			(p) => p.nodeId === source.layout.rootNodeId,
		);
		if (rootPlan?.phase !== "MERGE")
			throw new Error("Synthetic source must have two or more pages");
		const byId = new Map(
			f.nodes.map((n) => {
				const e = localStoryFlowContextNodeEvidence(n);
				return [e.nodeId, n] as const;
			}),
		);
		const rootChildren = rootPlan.children.map((id) => {
			const n = byId.get(id);
			if (!n) throw new Error("Missing synthetic context child");
			return n;
		});
		const merge = native.contextNativeExpectation({
			source: f.source,
			nodeId: rootPlan.nodeId,
			children: rootChildren,
			pin: pin(),
		});
		expect(native.localStoryFlowNativeExpectationEvidence(merge).input).toEqual(
			localStoryFlowContextInputForNode({
				source: f.source,
				nodeId: rootPlan.nodeId,
				children: rootChildren,
			}),
		);
		const rootExpectation = buildLocalStoryFlowRouteExpectation({
			phase: "ROOT",
			source: f.source,
			tree: f.tree,
			targetFrames: 900,
		});
		const rootNative = native.routeNativeExpectation({
			routeExpectation: rootExpectation,
			pin: pin(),
		});
		const rootRaw = {
			version: "local-story-flow-route-output-v1",
			mode: "FLOW",
			phase: "ROOT",
			nodeId: rootPlan.nodeId,
			choice: {
				kind: "ROOT_GOAL",
				claim: { kind: "CLAIM", nodeId: rootPlan.nodeId, claimId: "c0" },
				witness: {
					kind: "WITNESS",
					nodeId: rootPlan.nodeId,
					claimId: "c0",
					witnessId: "w0",
				},
			},
			unresolved: [],
		};
		const c = captured(rootNative, rootRaw);
		const admitted = native.admitFlowNativeObservation(rootNative, {
			resolvedOrigin: c.resolvedOrigin,
			observation: c.observation,
		});
		let previous = buildLocalStoryFlowRouteStep({
			expectation: rootExpectation,
			output: native.admittedFlowNativeOutput(admitted),
		});
		const nativeRootProof = native.bindLocalStoryFlowNativeRoot({
			native: admitted,
			rootStep: previous,
			observationRef: c.observationRef,
		});
		const phases = new Set(["ROOT"]);
		const check = (
			routeExpectation: ReturnType<typeof buildLocalStoryFlowRouteExpectation>,
		) => {
			const handle = native.routeNativeExpectation({
				routeExpectation,
				pin: pin(),
				nativeRootProof,
			});
			const e = native.localStoryFlowNativeExpectationEvidence(handle),
				actual = localStoryFlowRouteExpectationEvidence(routeExpectation).input;
			expect(e.input).toEqual(actual);
			expect(e.nativeKey.coreInputHash).toBe(actual.inputHash);
			expect(e.nativeKey.binding.nativeRootProof).toBe(
				native.localStoryFlowNativeRootEvidence(nativeRootProof)
					.nativeRootProof,
			);
			expect(e.prompt).toBe(
				native.LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY.routeInstruction +
					"\nCONTROL\n" +
					canonicalEditingJson(actual.control) +
					"\nDATA\n" +
					canonicalEditingJson(actual.data),
			);
			expect(e.dataUtf8Bytes).toBeLessThanOrEqual(4096);
			expect(e.controlUtf8Bytes).toBeLessThanOrEqual(480);
			phases.add(actual.phase);
		};
		const witness = buildLocalStoryFlowRouteExpectation({
			phase: "WITNESS",
			previousStep: previous,
		});
		check(witness);
		const wi = localStoryFlowRouteExpectationEvidence(witness).input;
		if (wi.control.phase !== "WITNESS")
			throw new Error("Expected synthetic pending owner");
		const claim = wi.control.requestedClaim;
		previous = buildLocalStoryFlowRouteStep({
			expectation: witness,
			output: {
				version: "local-story-flow-route-output-v1",
				mode: "FLOW",
				phase: "WITNESS",
				nodeId: wi.nodeId,
				choice: {
					kind: "HARD_REQUIREMENT",
					claim,
					witness: {
						kind: "WITNESS",
						nodeId: claim.nodeId,
						claimId: claim.claimId,
						witnessId: "w0",
					},
				},
				unresolved: [],
			},
		});
		function walk(nodeId: string) {
			const plan = source.layout.nodes.find((p) => p.nodeId === nodeId);
			if (!plan) throw new Error("Missing synthetic route plan");
			if (plan.phase === "MERGE") {
				const e = buildLocalStoryFlowRouteExpectation({
					phase: "BRANCH",
					previousStep: previous,
					nodeId,
				});
				check(e);
				previous = buildLocalStoryFlowRouteStep({
					expectation: e,
					output: {
						version: "local-story-flow-route-output-v1",
						mode: "FLOW",
						phase: "BRANCH",
						nodeId,
						accountedChildren: plan.children.map((nodeId) => ({
							kind: "CHILD_NODE",
							nodeId,
						})),
						dispositions: plan.children.map((nodeId) => ({
							child: { kind: "CHILD_NODE", nodeId },
							disposition: "DESCEND",
						})),
						unresolved: [],
					},
				});
				for (const child of plan.children) walk(child);
			} else {
				const page = source.pages.find((p) => p.pageId === plan.pageId);
				if (!page) throw new Error("Missing synthetic route page");
				const e = buildLocalStoryFlowRouteExpectation({
					phase: "LEAF",
					previousStep: previous,
					nodeId,
				});
				check(e);
				const accountedItems = page.data.items.map((item) =>
					item.kind === "DERIVED_CHUNK_SUMMARY"
						? { kind: "SUMMARY", summaryId: item.id }
						: { kind: "EVENT", eventId: item.id },
				);
				const candidate = accountedItems.find((i) => i.kind === "EVENT");
				if (!candidate) throw new Error("Missing synthetic candidate");
				previous = buildLocalStoryFlowRouteStep({
					expectation: e,
					output: {
						version: "local-story-flow-route-output-v1",
						mode: "FLOW",
						phase: "LEAF",
						nodeId,
						pageId: page.pageId,
						accountedItems,
						candidates: [candidate],
						unresolved: [],
					},
				});
			}
		}
		walk(rootPlan.nodeId);
		check(
			buildLocalStoryFlowRouteExpectation({
				phase: "FINALIZE",
				previousStep: previous,
			}),
		);
		expect([...phases].sort()).toEqual([
			"BRANCH",
			"FINALIZE",
			"LEAF",
			"ROOT",
			"WITNESS",
		]);
	});
});

describe("H2 pure native observation admission", () => {
	it("admits the separately pinned AMD profile without a configuration or credential", () => {
		const f = fixture(1, false, "amd");
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: pin({ ...modelPin, profile: "amd" }),
		});
		const c = captured(expected, f.raw, true);
		const admitted = native.admitFlowNativeObservation(expected, {
			observation: c.observation,
			resolvedOrigin: c.resolvedOrigin,
		});
		expect(
			native.admittedFlowNativeEvidence(admitted).terminalJob.result?.receipt
				.profile,
		).toBe("amd");
		expect(() =>
			native.contextNativeExpectation({
				source: f.source,
				nodeId: "n0",
				children: [],
				pin: pin(),
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
	});
	it("refuses corrupt or non-accepted sealed origins instead of treating them as cache misses", () => {
		const f = fixture();
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: pin(),
		});
		for (const corrupt of [
			"outcome",
			"status",
			"observationHash",
			"refHash",
			"refKind",
			"slot",
		] as const) {
			const c = captured(expected, f.raw, true);
			if (c.resolvedOrigin.kind !== "SEALED_ACCEPTED")
				throw new Error("Expected synthetic sealed origin");
			const accepted = c.resolvedOrigin.accepted;
			if (corrupt === "outcome") accepted.outcomeRef.receiptId = organizationId;
			else if (corrupt === "status") Reflect.set(accepted, "status", "FAILED");
			else if (corrupt === "observationHash")
				accepted.observationHash = "f".repeat(64);
			else if (corrupt === "refHash")
				accepted.observationRef.proofHash = "f".repeat(64);
			else if (corrupt === "refKind")
				Reflect.set(accepted.observationRef, "kind", "LOCAL_FLOW_MANIFEST_V1");
			else c.resolvedOrigin.origin.slot = 128;
			expect(() =>
				native.admitFlowNativeObservation(expected, {
					observation: c.observation,
					resolvedOrigin: c.resolvedOrigin,
				}),
			).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		}
	});
	it.each([
		false,
		true,
	])("retains the full terminal job and exact content for origin mode sealed=%s", (sealed) => {
		const f = fixture();
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: pin(),
		});
		const c = captured(expected, f.raw, sealed);
		const admitted = native.admitFlowNativeObservation(expected, {
			observation: c.observation,
			resolvedOrigin: c.resolvedOrigin,
		});
		const saved = native.admittedFlowNativeEvidence(admitted);
		expect(saved).toEqual(c.observation);
		expect(saved.terminalJob.result?.content).toBe(
			c.observation.terminalJob.result.content,
		);
		expect(native.admittedFlowNativeOutput(admitted)).toEqual(f.raw);
		Reflect.set(
			native.admittedFlowNativeOutput(admitted) as object,
			"nodeId",
			"n99",
		);
		saved.terminalJob.result?.receipt.placement.pop();
		expect(native.admittedFlowNativeOutput(admitted)).toEqual(f.raw);
		expect(native.admittedFlowNativeEvidence(admitted)).toEqual(c.observation);
		expect(() =>
			native.admittedFlowNativeOutput(structuredClone(admitted)),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
	});
	it("does not confuse a native-valid JSON value with core grounding success", () => {
		const f = fixture();
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: pin(),
		});
		const c = captured(expected, { ungrounded: "synthetic" });
		const admitted = native.admitFlowNativeObservation(expected, {
			observation: c.observation,
			resolvedOrigin: c.resolvedOrigin,
		});
		expect(() =>
			buildLocalStoryFlowContextNode({
				source: f.source,
				nodeId: "n0",
				children: [],
				output: native.admittedFlowNativeOutput(admitted),
			}),
		).toThrow();
	});
	it("checks every owned receipt binding even after a caller recomputes observationHash", () => {
		const f = fixture();
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: pin(),
		});
		for (const [field, value] of [
			["inputHash", "f".repeat(64)],
			["promptHash", "f".repeat(64)],
			["schemaHash", "f".repeat(64)],
			["requestHash", "f".repeat(64)],
			["promptVersion", "local-story-v1"],
			["maxOutputTokens", 1024],
			["profile", "amd"],
			["modelDigest", "f".repeat(64)],
			["runtimeVersion", "0.0.0"],
			["cleanupConfirmed", false],
			["schemaVerified", true],
			["thinking", true],
			["context", 4096],
			["elapsedMs", Number.NaN],
		] as const) {
			const c = captured(expected, f.raw);
			Reflect.set(c.observation.terminalJob.result.receipt, field, value);
			// Nonfinite JSON is rejected before hashing, other changed seals are not authority.
			if (field !== "elapsedMs") resealObservation(c.observation);
			expect(() =>
				native.admitFlowNativeObservation(expected, {
					observation: c.observation,
					resolvedOrigin: c.resolvedOrigin,
				}),
			).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		}
		for (const change of [
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(
					o.terminalJob.result.receipt.apiStats,
					"doneReason",
					"length",
				),
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(o.terminalJob.result.receipt.apiStats, "evalCount", -1),
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(
					o.terminalJob.result.receipt.placement[0] ?? {},
					"sizeVram",
					0,
				),
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(o.terminalJob, "cleanupConfirmed", false),
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(o.terminalJob, "errorCode", "PRIVATE_NATIVE_ERROR"),
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(o, "requestKey", organizationId),
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(o.terminalJob, "id", organizationId),
			(o: ReturnType<typeof captured>["observation"]) =>
				Reflect.set(o.terminalJob.result, "content", "{PRIVATE_INVALID_JSON"),
		]) {
			const c = captured(expected, f.raw);
			change(c.observation);
			resealObservation(c.observation);
			expect(() =>
				native.admitFlowNativeObservation(expected, {
					observation: c.observation,
					resolvedOrigin: c.resolvedOrigin,
				}),
			).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		}
	});
	it("requires independent origin facts, deterministic runtime references and descriptor-safe data", () => {
		const f = fixture();
		const expected = native.contextNativeExpectation({
			source: f.source,
			nodeId: "n0",
			children: [],
			pin: pin(),
		});
		for (const field of [
			"sourceBindingHash",
			"workflowIdentityHash",
			"nativeKeyHash",
			"coreInputHash",
			"requestHash",
		]) {
			const c = captured(expected, f.raw);
			Reflect.set(c.resolvedOrigin, field, "f".repeat(64));
			expect(() =>
				native.admitFlowNativeObservation(expected, {
					observation: c.observation,
					resolvedOrigin: c.resolvedOrigin,
				}),
			).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		}
		const wrongRef = captured(expected, f.raw);
		wrongRef.resolvedOrigin.origin.attemptRef.receiptId = organizationId;
		resealObservation(wrongRef.observation);
		expect(() =>
			native.admitFlowNativeObservation(expected, {
				observation: wrongRef.observation,
				resolvedOrigin: wrongRef.resolvedOrigin,
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		let reads = 0;
		const getter = captured(expected, f.raw);
		Object.defineProperty(
			getter.observation.terminalJob.result.receipt.apiStats,
			"evalCount",
			{
				enumerable: true,
				get: () => {
					reads++;
					throw new Error("PRIVATE_GETTER");
				},
			},
		);
		expect(() =>
			native.admitFlowNativeObservation(expected, {
				observation: getter.observation,
				resolvedOrigin: getter.resolvedOrigin,
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		expect(reads).toBe(0);
	});
});

describe("ROOT proof is derived after actual native and owned ROOT admission", () => {
	it("binds the original observation and owned structural root without changing any inputHash", () => {
		const f = fixture();
		const routeExpectation = buildLocalStoryFlowRouteExpectation({
			phase: "ROOT",
			source: f.source,
			tree: f.tree,
			targetFrames: 900,
		});
		const expected = native.routeNativeExpectation({
			routeExpectation,
			pin: pin(),
		});
		const raw = {
			version: "local-story-flow-route-output-v1",
			mode: "FLOW",
			phase: "ROOT",
			nodeId: "n0",
			choice: {
				kind: "ROOT_GOAL",
				claim: { kind: "CLAIM", nodeId: "n0", claimId: "c0" },
				witness: {
					kind: "WITNESS",
					nodeId: "n0",
					claimId: "c0",
					witnessId: "w0",
				},
			},
			unresolved: [],
		};
		const c = captured(expected, raw);
		const admitted = native.admitFlowNativeObservation(expected, {
			observation: c.observation,
			resolvedOrigin: c.resolvedOrigin,
		});
		const step = buildLocalStoryFlowRouteStep({
			expectation: routeExpectation,
			output: native.admittedFlowNativeOutput(admitted),
		});
		const root = native.bindLocalStoryFlowNativeRoot({
			native: admitted,
			rootStep: step,
			observationRef: c.observationRef,
		});
		const e = native.localStoryFlowNativeRootEvidence(root);
		const { nativeRootProof, ...body } = e;
		expect(nativeRootProof).toBe(hash(body));
		expect(e.rootCoreStepHash).toBe(
			localStoryFlowRouteStepEvidence(step).stepHash,
		);
		expect(e.rootCoreInputHash).toBe(c.observation.requestBody.inputHash);
		expect(e.rootObservationRef).toEqual(c.observationRef);
		const differentRoot = buildLocalStoryFlowRouteStep({
			expectation: buildLocalStoryFlowRouteExpectation({
				phase: "ROOT",
				source: f.source,
				tree: f.tree,
				targetFrames: 930,
			}),
			output: raw,
		});
		expect(() =>
			native.bindLocalStoryFlowNativeRoot({
				native: admitted,
				rootStep: differentRoot,
				observationRef: c.observationRef,
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		expect(() =>
			native.bindLocalStoryFlowNativeRoot({
				native: admitted,
				rootStep: step,
				observationRef: { ...c.observationRef, proofHash: "f".repeat(64) },
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		e.rootObservationRef.proofHash = "f".repeat(64);
		expect(
			native.localStoryFlowNativeRootEvidence(root).rootObservationRef,
		).toEqual(c.observationRef);
		const leafExpectation = buildLocalStoryFlowRouteExpectation({
			phase: "LEAF",
			previousStep: step,
			nodeId: "n0",
		});
		const next = native.routeNativeExpectation({
			routeExpectation: leafExpectation,
			pin: pin(),
			nativeRootProof: root,
		});
		const nextEvidence = native.localStoryFlowNativeExpectationEvidence(next);
		expect(nextEvidence.nativeKey.binding.nativeRootProof).toBe(
			nativeRootProof,
		);
		expect(nextEvidence.input).toEqual(
			localStoryFlowRouteExpectationEvidence(leafExpectation).input,
		);
		expect(c.observation.requestBody.inputHash).toBe(e.rootCoreInputHash);
		expect(() =>
			native.routeNativeExpectation({
				routeExpectation: leafExpectation,
				pin: pin(),
				nativeRootProof: structuredClone(root),
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		expect(() =>
			native.routeNativeExpectation({
				routeExpectation: leafExpectation,
				pin: {
					...pin(),
					policies: {
						...pin().policies,
						engineValidationPolicyHash: "f".repeat(64),
					},
				},
				nativeRootProof: root,
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
	});
});
