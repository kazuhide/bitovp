import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	mediaTaskCacheKey,
	mediaTaskIntentHash,
} from "../content-production/identity";
import { localStoryFlowGenerationPolicyFingerprint } from "../content-production/local-story-workflow";
import { mediaTaskCreateSchema } from "../content-production/schema";
import { TRANSCRIPTION_POLICY_FINGERPRINT } from "../content-production/transcription-quality";
import {
	canonicalEditingJson,
	editingAnalysisBindingSchema,
} from "./automatic-binding";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
	type LocalSemanticReceipt,
} from "./local-semantic-protocol";
import {
	localStoryIdentityForModelPin,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import type { LocalStoryLedger } from "./local-story-contracts";
import {
	type AcceptedLocalStoryFlowContextNode,
	acceptLocalStoryFlowContextWork,
	buildLocalStoryFlowAcceptedContext,
	type LocalStoryFlowArtifactProposal,
	localStoryFlowAcceptedContextEvidence,
	localStoryFlowAcceptedContextNodePublication,
	localStoryFlowContextWorkExpectation,
	prepareLocalStoryFlowContextWork,
} from "./local-story-flow-artifact-reader";
import { LOCAL_STORY_FLOW_CLOSURE_POLICY } from "./local-story-flow-closure";
import {
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	type LocalStoryFlowContextNodeEvidence,
	localStoryFlowContextSourceEvidence,
} from "./local-story-flow-context";
import {
	LOCAL_STORY_FLOW_H1_POLICY,
	type LocalStoryFlowContextOutput,
} from "./local-story-flow-contracts";
import {
	createLocalStoryLegacyLedgerCacheRecipe,
	createLocalStoryLegacyLedgerStageRecipe,
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
	localStoryLegacyLedgerPrompt,
} from "./local-story-flow-legacy-ledger";
import {
	type LocalStoryLegacyArtifactKind,
	localStoryArtifactCacheHashes,
} from "./local-story-flow-legacy-seals";
import type { buildLocalStoryFlowManifest } from "./local-story-flow-manifest";
import {
	admitFlowNativeObservation,
	type BoundLocalStoryFlowNativeExpectation,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	type LocalStoryFlowNativeObservation,
	localStoryFlowNativeExpectationEvidence,
	localStoryFlowNativeRootEvidence,
	nativeRequestForOrigin,
} from "./local-story-flow-native";
import { LOCAL_STORY_FLOW_ROUTE_POLICY } from "./local-story-flow-route";
import {
	type AcceptedLocalStoryFlowRouteStep,
	acceptLocalStoryFlowRouteWork,
	localStoryFlowAcceptedRoutePublication,
	localStoryFlowRouteWorkExpectation,
	nextLocalStoryFlowRouteWork,
} from "./local-story-flow-route-artifacts";
import {
	hydrateLocalStoryFlowRouteArtifacts,
	type LocalStoryFlowRouteHydrationSnapshot,
} from "./local-story-flow-route-reader";
import {
	admitLocalStoryFlowAcceptedOrigin,
	localStoryFlowAcceptedOriginEvidence,
	localStoryFlowRuntimeHistoryEvidence,
	localStoryFlowRuntimeIdentityEvidence,
	localStoryFlowRuntimeKey,
	localStoryFlowRuntimeStartRecord,
	prepareLocalStoryFlowRuntimeIdentity,
	readLocalStoryFlowRuntimeHistory,
} from "./local-story-flow-runtime-history";
import { LOCAL_STORY_FLOW_SCOPE_POLICY } from "./local-story-flow-scope";
import {
	type BoundLocalStoryFlowSealedRecord,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordKind,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
	readLocalStoryFlowSealedRecord,
} from "./local-story-flow-seals";
import {
	admitLocalStoryFlowArchiveTranscript,
	type BoundLocalStoryFlowSourceArchive,
	buildLocalStoryFlowSourceArchive,
	type LocalStoryFlowArchiveLedgerPair,
	type LocalStoryFlowArchiveSourceSnapshots,
	type LocalStoryFlowLegacyRecordPair,
	localStoryFlowArchiveLedgerRequests,
	localStoryFlowArchiveLedgerStageRequest,
	localStoryFlowArchiveTranscriptEvidence,
	localStoryFlowSourceArchiveContext,
	localStoryFlowSourceArchiveEvidence,
	prepareLocalStoryFlowArchiveSource,
} from "./local-story-flow-source-archive";
import { localStoryFlowIdentityForModelPin } from "./local-story-flow-stages";
import { hashEditingEvidence as H } from "./verify-automatic-binding";

const stageCalls = vi.hoisted(() => ({
	build: vi.fn(),
	scope: vi.fn(),
	plan: vi.fn(),
	select: vi.fn(),
	legacy: vi.fn(),
}));
vi.mock("./local-story-flow-scope", async (original) => {
	const actual = await original<typeof import("./local-story-flow-scope")>();
	stageCalls.build.mockImplementation(actual.buildLocalStoryFlowScope);
	stageCalls.scope.mockImplementation(actual.validateLocalStoryFlowScope);
	stageCalls.plan.mockImplementation(actual.validateLocalStoryFlowPlan);
	stageCalls.select.mockImplementation(actual.selectLocalStoryFlowPlan);
	return {
		...actual,
		buildLocalStoryFlowScope: stageCalls.build,
		validateLocalStoryFlowScope: stageCalls.scope,
		validateLocalStoryFlowPlan: stageCalls.plan,
		selectLocalStoryFlowPlan: stageCalls.select,
	};
});
vi.mock("./local-story-planner", async (original) => {
	const actual = await original<typeof import("./local-story-planner")>();
	stageCalls.legacy.mockImplementation(actual.selectLocalStoryClips);
	return { ...actual, selectLocalStoryClips: stageCalls.legacy };
});
beforeEach(() => {
	for (const call of Object.values(stageCalls)) call.mockClear();
});
afterEach(() => {
	for (const call of Object.values(stageCalls))
		expect(call).not.toHaveBeenCalled();
});

// Synthetic source/native contracts only; no media, DB, RPC or model execution.
function fixture(
	options: { audio?: boolean; count?: number; profile?: "nvidia" | "amd" } = {},
) {
	const count = options.count ?? 4,
		durationUs = count * 3_000_000;
	const organizationId = randomUUID(),
		sourceId = randomUUID(),
		mediaId = randomUUID(),
		analysisId = randomUUID(),
		taskId = randomUUID();
	const modelPin = {
		profile: options.profile ?? "nvidia",
		configId: randomUUID(),
	};
	const model = localStoryIdentityForModelPin(modelPin),
		workflow = localStoryFlowIdentityForModelPin(modelPin, "FLOW");
	const policies = {
		version: "local-story-flow-task-policies-v1" as const,
		workflowPolicyHash: H(LOCAL_STORY_FLOW_H1_POLICY),
		contextPolicyHash: H(LOCAL_STORY_FLOW_CONTEXT_POLICY),
		closurePolicyHash: H(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		routePolicyHash: H(LOCAL_STORY_FLOW_ROUTE_POLICY),
		scopePolicyHash: H(LOCAL_STORY_FLOW_SCOPE_POLICY),
		promptPolicyHash: H(LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
		engineValidationPolicyHash: H("SYNTHETIC_ENGINE_CONTRACT_NOT_READY"),
		deliveryPolicyHash: H("SYNTHETIC_DELIVERY_CONTRACT_NOT_READY"),
	};
	const map = {
		id: randomUUID(),
		mediaVersionId: mediaId,
		kind: "CFR" as const,
		sourceStartUs: 0,
		sourceEndUs: durationUs,
		editingStartFrame: 0,
		editingEndFrame: count * 90,
		fps: { num: 30 as const, den: 1 as const },
	};
	const raw = {
		metadata: { version: "synthetic-source-archive" },
		title: "A key is returned",
		description: "Synthetic complete metadata.",
		duration: durationUs / 1_000_000,
		scenes: [
			{
				id: randomUUID(),
				type: "MAIN_CONTENT",
				title: "The key",
				startInSeconds: 0,
				endInSeconds: durationUs / 1_000_000,
				shots: Array.from({ length: count }, (_, i) => ({
					startInSeconds: i * 3,
					endInSeconds: (i + 1) * 3,
					detailedDescription:
						"A person holds key " +
						i +
						"." +
						" Authored background.".repeat(80),
				})),
			},
		],
	};
	const analysis = {
		id: analysisId,
		organizationId,
		sourceId,
		rawHash: H(raw),
		locale: "en",
		providerVersion: "synthetic-test-only",
		raw,
		document: normalizeSceneAnalysis(raw),
	};
	const media = {
		id: mediaId,
		organizationId,
		sourceId,
		state: "READY" as const,
		sha256: "a".repeat(64),
		durationUs: String(durationUs),
		width: 640,
		height: 360,
		fpsNum: 30,
		fpsDen: 1,
		timeMap: map,
		probe: {
			streams: [
				{ codec_type: "video" },
				...(options.audio ? [{ codec_type: "audio" }] : []),
			],
		},
		storage: {},
	};
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId,
		locale: "en",
		analysisRevisionId: analysisId,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: H(analysis.document),
		mediaVersionId: mediaId,
		mediaSha256: media.sha256,
		timeMapId: map.id,
		timeMapHash: H(map),
		sourceStartUs: map.sourceStartUs,
		sourceEndUs: map.sourceEndUs,
		width: media.width,
		height: media.height,
	});
	const input = mediaTaskCreateSchema.parse({
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: randomUUID(),
		parameters: {
			contentId: randomUUID(),
			targetDurationFrames: 90,
			policy: "LOCAL_STORY",
			storyMode: "FLOW",
			renderMode: "DRAFT",
			storyWorkflowVersion: "hierarchical-flow-v1",
			captions: "OFF",
			tracking: false,
			language: "en",
		},
	});
	if (input.kind !== "GENERATE")
		throw new Error("Missing synthetic GENERATE input");
	const identity = {
		organizationId,
		mediaSha256: media.sha256,
		modelSha256: "b".repeat(64),
		analysisDocumentHash: binding.analysisDocumentHash,
		analysisRawHash: analysis.rawHash,
		timeMapHash: binding.timeMapHash,
		bindingHash: H(binding),
		bindingSnapshot: binding,
		localStoryModel: model,
		localStoryWorkflow: workflow,
		transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		generationPolicyFingerprint:
			localStoryFlowGenerationPolicyFingerprint(policies),
	};
	const snapshots: LocalStoryFlowArchiveSourceSnapshots = {
		task: {
			id: taskId,
			organizationId,
			kind: "GENERATE",
			mediaVersionId: mediaId,
			analysisRevisionId: analysisId,
			requestKey: input.requestKey,
			parentTaskId: null,
			requestHash: mediaTaskIntentHash(input),
			cacheKey: mediaTaskCacheKey(input, identity),
			parameters: { schemaVersion: 1, input, identity },
		},
		mediaSnapshot: media,
		analysisSnapshot: analysis,
		bindingSnapshot: binding,
		normalizationSnapshot: null,
	};
	const refresh = () => {
		snapshots.task.parameters = { schemaVersion: 1, input, identity };
		snapshots.task.requestKey = input.requestKey;
		snapshots.task.requestHash = mediaTaskIntentHash(
			input,
			snapshots.task.parentTaskId,
		);
		snapshots.task.cacheKey = mediaTaskCacheKey(input, identity);
	};
	const prep = () => prepareLocalStoryFlowArchiveSource(snapshots, policies);
	return {
		snapshots,
		policies,
		modelPin,
		model,
		workflow,
		map,
		analysis,
		media,
		binding,
		input,
		identity,
		prep,
		refresh,
	};
}

type Fixture = ReturnType<typeof fixture>;
const first = <T>(values: readonly T[]): T => {
	const value = values[0];
	if (value === undefined) throw new Error("Missing synthetic fixture item");
	return value;
};
function receiptId(org: string, cacheHash: string) {
	const bytes = createHash("sha1")
		.update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
		.update(`bitovp-semantic:${org}:artifact:${cacheHash}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 15) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
	const h = bytes.toString("hex");
	return [
		h.slice(0, 8),
		h.slice(8, 12),
		h.slice(12, 16),
		h.slice(16, 20),
		h.slice(20),
	].join("-");
}
function sealed(
	f: Fixture,
	kind: LocalStoryLegacyArtifactKind,
	key: unknown,
	value: unknown,
	version: 1 | 2 = 2,
): LocalStoryFlowLegacyRecordPair {
	const scope = {
		task: { organizationId: f.snapshots.task.organizationId },
		media: f.media,
		taskIdentity: f.identity,
		analysisRevisionId:
			kind === "LOCAL_STORY_TRANSCRIPT_V1" ? null : f.analysis.id,
	};
	const hashes = localStoryArtifactCacheHashes({
		...scope,
		input: { kind, key },
	});
	const proof =
		version === 1
			? {
					version: "local-story-cache-v1",
					cacheHash: hashes.cacheHash,
					value: JSON.parse(JSON.stringify(value)),
				}
			: {
					version: "local-story-cache-v2",
					cacheHash: hashes.cacheHash,
					valueJson: canonicalEditingJson(value),
				};
	const proofHash = H(proof),
		id = receiptId(f.snapshots.task.organizationId, hashes.cacheHash);
	return {
		ref: { kind, receiptId: id, ...hashes, proofHash },
		row: {
			id,
			organizationId: f.snapshots.task.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId: scope.analysisRevisionId,
			kind,
			proof: JSON.parse(JSON.stringify(proof)),
			proofHash,
		},
	};
}

function ledgerFixtures(
	f: Fixture,
	t: TranscriptFixture,
	version: "V1" | "V2" | "V3" | "V4" = "V4",
	sealVersion: 1 | 2 = 2,
	structuredQuote = false,
) {
	const definition = localStoryStageRegistry().stages.LOCAL_LEDGER_V1;
	const values: LocalStoryLedger[] = [];
	const ledgerRefs: Parameters<
		typeof buildLocalStoryFlowManifest
	>[0]["ledgerRefs"][number][] = [];
	const pairs = t.chunks.map(
		(chunk, index): LocalStoryFlowArchiveLedgerPair => {
			const common = {
				identity: f.model,
				input: t.input,
				chunk,
				transcriptFingerprint: t.prepared.fingerprint,
				definition,
			};
			const cache = createLocalStoryLegacyLedgerCacheRecipe(
				version === "V4"
					? {
							...common,
							version,
							validationPolicyVersion:
								LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions
									.V4,
						}
					: { ...common, version },
			);
			const prompt = structuredQuote
				? localStoryLegacyLedgerPrompt({
						kind: "STRUCTURED",
						version: version === "V3" ? "V3" : "V4",
						family: "QUOTE",
						input: t.input,
						chunk,
					})
				: localStoryLegacyLedgerPrompt({ kind: "BASE", chunk });
			if (!prompt)
				throw new Error("Missing complete synthetic accepted prompt");
			const pointer = cache.pointer(prompt),
				ref = first(chunk.refs);
			const quote = `A person holds key ${Number(ref.slice(1))}.`;
			const output: LocalStoryLedger = {
				summary: "A key is observed.",
				events: [
					{
						id: "e0",
						label: quote,
						role: "ACTION",
						refs: [ref],
						quotes: [{ ref, quote }],
						subjects: ["person", "key"],
						uncertainty: "",
					},
				],
			};
			const stage = createLocalStoryLegacyLedgerStageRecipe({
				...common,
				organizationId: f.media.organizationId,
				prompt,
			});
			const requestKey = randomUUID(),
				body = stage.bodyFor(requestKey);
			const receipt: LocalSemanticReceipt = {
				version: "bitovp-semantic-receipt-v1",
				profile: body.profile,
				model: LOCAL_SEMANTIC_MODEL,
				modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
				runtimeVersion: LOCAL_SEMANTIC_RUNTIME_VERSION,
				inputHash: body.inputHash,
				promptHash: createHash("sha256").update(prompt).digest("hex"),
				schemaHash: body.schemaHash,
				promptVersion: body.promptVersion,
				requestHash: H(body),
				context: 8192,
				maxOutputTokens: 1024,
				thinking: false,
				elapsedMs: 1,
				apiStats: {
					promptEvalCount: 10,
					evalCount: 5,
					doneReason: "stop",
					loadDurationNs: 1,
					promptEvalDurationNs: 1,
					evalDurationNs: 1,
				},
				placement: [
					{
						name: LOCAL_SEMANTIC_MODEL,
						size: 29_000_000_000,
						sizeVram: 14_000_000_000,
						contextLength: 8192,
					},
				],
				cleanupConfirmed: true,
				schemaVerified: false,
			};
			const stored = stage.parse({
				version: "local-semantic-stage-result-v1",
				requestKey,
				output,
				receipt,
			});
			values.push(stored.output);
			ledgerRefs.push({
				chunkIndex: index,
				stageInputHash: stage.key.inputHash,
				promptHash: stage.key.promptHash,
				schemaHash: stage.key.schemaHash,
				stageKeyHash: H(stage.key),
				ledgerHash: H(stored.output),
			});
			const pair = {
				pointer: sealed(
					f,
					"LOCAL_STORY_LEDGER_V1",
					cache.key,
					pointer,
					sealVersion,
				),
				stage: sealed(
					f,
					"LOCAL_STORY_LEDGER_V1",
					stage.key,
					stored,
					sealVersion,
				),
			};
			const requests = localStoryFlowArchiveLedgerRequests(t.handle, index);
			expect(
				first(requests.filter((r) => r.version === version)),
			).toMatchObject({
				key: cache.key,
				receiptId: pair.pointer.ref.receiptId,
				cacheHash: pair.pointer.ref.cacheHash,
				inputKeyHash: pair.pointer.ref.inputKeyHash,
			});
			expect(
				localStoryFlowArchiveLedgerStageRequest(t.handle, index, pair.pointer),
			).toMatchObject({
				key: stage.key,
				receiptId: pair.stage.ref.receiptId,
				cacheHash: pair.stage.ref.cacheHash,
				inputKeyHash: pair.stage.ref.inputKeyHash,
				pointerBody: pointer,
			});
			return pair;
		},
	);
	return { pairs, values, ledgerRefs };
}

function transcriptFixture(f: Fixture) {
	const handle = admitLocalStoryFlowArchiveTranscript(f.prep(), null);
	const e = localStoryFlowArchiveTranscriptEvidence(handle);
	return {
		handle,
		input: e.fullInput,
		chunks: e.chunks,
		prepared: { fingerprint: e.transcriptFingerprint },
	};
}
type TranscriptFixture = ReturnType<typeof transcriptFixture>;
function archiveFixture(count = 64, profile: "amd" | "nvidia" = "nvidia") {
	const f = fixture({ count, profile });
	const t = transcriptFixture(f);
	const ledgers = ledgerFixtures(f, t);
	const archive = buildLocalStoryFlowSourceArchive({
		transcript: t.handle,
		ledgers: ledgers.pairs,
	});
	return { f, t, ledgers, archive };
}
function flowRef(
	sourceTuple: LocalStoryFlowSourceTuple,
	kind: LocalStoryFlowRecordKind,
	key: LocalStoryFlowRecordKey,
	payload: Record<string, unknown>,
) {
	const identity = localStoryFlowRecordIdentity({ sourceTuple, kind, key });
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: canonicalEditingJson(payload),
	};
	return { kind, ...identity, proofHash: H(proof) };
}
function capture(
	work: BoundLocalStoryFlowNativeExpectation,
	archive: BoundLocalStoryFlowSourceArchive,
	output: unknown,
	slot: number,
	refs?: {
		startRef: LocalStoryFlowRecordRef;
		attemptRef: LocalStoryFlowRecordRef;
		originTaskId?: string;
	},
) {
	const expected = work,
		e = localStoryFlowNativeExpectationEvidence(expected);
	const a = localStoryFlowSourceArchiveEvidence(archive);
	const sourceTuple = a.payload.sourceTuple as LocalStoryFlowSourceTuple;
	const originTaskId = refs?.originTaskId ?? String(a.payload.taskId);
	const request = nativeRequestForOrigin(expected, {
		organizationId: sourceTuple.organizationId,
		originTaskId,
	});
	const runtimeRef = (purpose: "START" | "ATTEMPT") =>
		flowRef(
			sourceTuple,
			"LOCAL_FLOW_PLAN_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose,
				keyBody:
					purpose === "START"
						? { taskId: originTaskId }
						: { taskId: originTaskId, slot },
			},
			{
				version:
					purpose === "START"
						? "local-story-flow-runtime-start-v1"
						: "local-story-flow-runtime-attempt-v1",
				purpose,
			},
		);
	const origin = {
		organizationId: sourceTuple.organizationId,
		originTaskId,
		startRef: refs?.startRef ?? runtimeRef("START"),
		attemptRef: refs?.attemptRef ?? runtimeRef("ATTEMPT"),
		slot,
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
		requestHash: request.requestHash,
		context: 8192 as const,
		maxOutputTokens: 1536 as const,
		thinking: false as const,
		elapsedMs: 1,
		apiStats: {
			promptEvalCount: 8,
			evalCount: 8,
			doneReason: "stop" as const,
			loadDurationNs: 1,
			promptEvalDurationNs: 1,
			evalDurationNs: 1,
		},
		placement: [
			{
				name: "synthetic-only-not-performance",
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
			result: { content: ` \n${JSON.stringify(output)}\n`, receipt },
		},
	};
	const observation = { ...body, observationHash: H(body) };
	return admitFlowNativeObservation(expected, {
		resolvedOrigin: {
			version: "local-story-flow-native-origin-contract-v1",
			kind: "CURRENT_CAPTURE",
			origin,
			sourceBindingHash: e.nativeKey.sourceBindingHash,
			workflowIdentityHash: H(e.nativeKey.workflowIdentity),
			nativeKeyHash: e.nativeKeyHash,
			coreInputHash: request.body.inputHash,
			requestHash: request.requestHash,
			capture: {
				taskId: originTaskId,
				leaseToken: randomUUID(),
				connectionHash: H("SYNTHETIC_CAPTURE_NOT_LIVE_OR_DB_PROOF"),
			},
		},
		observation,
	});
}
function outputFor(
	archive: BoundLocalStoryFlowSourceArchive,
	nodeId: string,
	children: readonly AcceptedLocalStoryFlowContextNode[],
): LocalStoryFlowContextOutput {
	const source = localStoryFlowContextSourceEvidence(
		localStoryFlowSourceArchiveContext(archive),
	);
	const plan = source.layout.nodes.find((p) => p.nodeId === nodeId);
	if (!plan) throw Error("Synthetic plan missing");
	if (plan.phase === "LEAF") {
		const page = source.pages.find((p) => p.pageId === plan.pageId);
		if (!page) throw Error("Synthetic page missing");
		const accountedItems = page.data.items.map((item) =>
			item.kind === "DERIVED_CHUNK_SUMMARY"
				? { kind: "SUMMARY" as const, summaryId: item.id }
				: { kind: "EVENT" as const, eventId: item.id },
		);
		const event = accountedItems.find((item) => item.kind === "EVENT");
		if (!event) throw Error("Synthetic event missing");
		return {
			version: "local-story-flow-context-output-v1",
			mode: "FLOW",
			phase: "LEAF",
			nodeId,
			pageId: page.pageId,
			accountedItems,
			claims: [
				{
					id: "c0",
					text: "The key is observed.",
					supports: [event],
					witnesses: [{ id: "w0", allOf: [event] }],
				},
			],
			relations: [],
			unresolved: [],
		};
	}
	const evidence = children.map(
		(child) =>
			localStoryFlowAcceptedContextNodePublication(child).node.payload
				.nodeEvidence as LocalStoryFlowContextNodeEvidence,
	);
	const supports = evidence.map((child) => first(child.claimRefs));
	const witness = first(first(evidence).witnessProofs).ref;
	return {
		version: "local-story-flow-context-output-v1",
		mode: "FLOW",
		phase: "MERGE",
		nodeId,
		accountedChildren: plan.children.map((child) => ({
			kind: "CHILD_NODE" as const,
			nodeId: child,
		})),
		claims: [
			{
				id: "c0",
				text: "The full sequence is retained.",
				supports,
				witnesses: [{ id: "w0", allOf: [witness] }],
			},
		],
		relations: [],
		unresolved: [],
	};
}
function acceptedContext(
	archive: BoundLocalStoryFlowSourceArchive,
	cached?: Map<string, ReturnType<typeof capture>>,
	hardChoice = false,
) {
	const source = localStoryFlowContextSourceEvidence(
		localStoryFlowSourceArchiveContext(archive),
	);
	const nodes: AcceptedLocalStoryFlowContextNode[] = [],
		byId = new Map<string, AcceptedLocalStoryFlowContextNode>();
	const natives = new Map<string, ReturnType<typeof capture>>();
	for (const [index, plan] of source.layout.nodes.entries()) {
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const child = byId.get(id);
						if (!child) throw Error("Synthetic child missing");
						return child;
					});
		const work = prepareLocalStoryFlowContextWork({
			archive,
			nodeId: plan.nodeId,
			children,
		});
		const output = outputFor(archive, plan.nodeId, children);
		if (hardChoice && output.phase === "MERGE") {
			const claim = first(output.claims);
			const later = localStoryFlowAcceptedContextNodePublication(
				first(children.slice(-1)),
			).node.payload.nodeEvidence as LocalStoryFlowContextNodeEvidence;
			first(claim.witnesses).allOf = [first(later.witnessProofs).ref];
			output.relations.push({
				kind: "REQUIRES",
				from: { kind: "OWN_CLAIM", claimId: claim.id },
				target: first(claim.supports),
			});
		}
		const native =
			cached?.get(plan.nodeId) ??
			capture(
				localStoryFlowContextWorkExpectation(work),
				archive,
				output,
				index + 1,
			);
		const node = acceptLocalStoryFlowContextWork({ work, native });
		nodes.push(node);
		byId.set(plan.nodeId, node);
		natives.set(plan.nodeId, native);
	}
	return {
		nodes,
		natives,
		context: buildLocalStoryFlowAcceptedContext({ archive, nodes }),
		source,
	};
}

type RouteWork = Parameters<typeof localStoryFlowRouteWorkExpectation>[0];
function routeOutput(work: RouteWork) {
	const native = localStoryFlowNativeExpectationEvidence(
		localStoryFlowRouteWorkExpectation(work),
	);
	const input = native.input;
	if (input.version !== "local-story-flow-route-input-v1")
		throw Error("Missing authored route");
	const { phase, nodeId } = input;
	const common = {
		version: "local-story-flow-route-output-v1" as const,
		mode: "FLOW" as const,
		phase,
		nodeId,
		unresolved: [],
	};
	if (phase === "ROOT")
		return {
			...common,
			choice: {
				kind: "ROOT_GOAL",
				claim: { kind: "CLAIM", nodeId, claimId: "c0" },
				witness: { kind: "WITNESS", nodeId, claimId: "c0", witnessId: "w0" },
			},
		};
	if (phase === "WITNESS" && input.control.phase === "WITNESS")
		return {
			...common,
			choice: {
				kind: "HARD_REQUIREMENT",
				claim: input.control.requestedClaim,
				witness: {
					...input.control.requestedClaim,
					kind: "WITNESS",
					witnessId: "w0",
				},
			},
		};
	if (phase === "BRANCH" && "children" in input.data) {
		const accountedChildren = input.data.children.map((child) => ({
			kind: "CHILD_NODE" as const,
			nodeId: child.nodeId,
		}));
		return {
			...common,
			accountedChildren,
			dispositions: accountedChildren.map((child) => ({
				child,
				disposition: "CONTEXT_ONLY",
			})),
		};
	}
	if (phase === "LEAF" && "items" in input.data)
		return {
			...common,
			pageId: input.orderedInputProofs.find((p) => p.kind === "LEAF_PAGE")
				?.pageId,
			accountedItems: input.data.items.map((i) =>
				i.kind === "DERIVED_CHUNK_SUMMARY"
					? { kind: "SUMMARY", summaryId: i.id }
					: { kind: "EVENT", eventId: i.id },
			),
			candidates: input.data.items
				.filter((i) => i.kind === "GROUNDED_LEAF_EVENT_CARD")
				.slice(0, 1)
				.map((i) => ({ kind: "EVENT", eventId: i.id })),
		};
	if (phase === "FINALIZE" && "events" in input.data) {
		const events = input.data.events.map((i) => ({
			kind: "EVENT",
			eventId: i.id,
		}));
		return {
			...common,
			accountedRoot: { kind: "CONTEXT_NODE", nodeId },
			accountedEvents: events,
			blueprint: {
				mode: "FLOW",
				message: "The key is observed.",
				beats: events.map((event, index) => ({
					id: `b${index}`,
					role: "ACTION",
					eventIds: [event.eventId],
					requires: [],
				})),
				uncertainty: "Synthetic structural test only",
			},
		};
	}
	throw Error("Unsupported authored route");
}

function storedProposal<P extends object>(
	p: LocalStoryFlowArtifactProposal<P>,
): BoundLocalStoryFlowSealedRecord {
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: p.ref.cacheHash,
		valueJson: canonicalEditingJson(p.payload),
	};
	return readLocalStoryFlowSealedRecord({
		sourceTuple: p.sourceTuple,
		kind: p.kind,
		key: p.key,
		ref: p.ref,
		row: {
			id: p.ref.receiptId,
			organizationId: p.sourceTuple.organizationId,
			sourceId: p.sourceTuple.sourceId,
			mediaVersionId: p.sourceTuple.mediaVersionId,
			analysisRevisionId: p.sourceTuple.analysisRevisionId,
			kind: p.kind,
			proof,
			proofHash: H(proof),
		},
	});
}
function storedFlow(
	t: LocalStoryFlowSourceTuple,
	kind: LocalStoryFlowRecordKind,
	key: LocalStoryFlowRecordKey,
	payload: Record<string, unknown>,
) {
	return storedProposal({
		sourceTuple: t,
		kind,
		key,
		payload,
		ref: flowRef(t, kind, key, payload),
	});
}
type RuntimeIdentity = ReturnType<typeof prepareLocalStoryFlowRuntimeIdentity>;
function prefixFor(
	identity: RuntimeIdentity,
	context: ReturnType<typeof localStoryFlowAcceptedContextEvidence>,
	start: BoundLocalStoryFlowSealedRecord,
	step: AcceptedLocalStoryFlowRouteStep,
	ordinal: number,
	previousPrefixRef: LocalStoryFlowRecordRef | null,
) {
	const facts = localStoryFlowRuntimeIdentityEvidence(identity);
	const p = localStoryFlowAcceptedRoutePublication(step);
	const body = {
		version: "local-story-flow-runtime-prefix-v1",
		purpose: "ROUTE_PREFIX",
		taskId: facts.taskId,
		startRef: localStoryFlowSealedRecordEvidence(start).ref,
		sourceArchiveRef: context.sourceArchive.ref,
		treeRef: context.tree.ref,
		ordinal,
		previousPrefixRef,
		stepRef: p.step.ref,
		stepHash: p.step.payload.stepHash,
		expectationHash: p.step.payload.stepEvidence.expectation.expectationHash,
		observationRef: p.observation.ref,
		nativeRootProof: localStoryFlowNativeRootEvidence(p.nativeRoot)
			.nativeRootProof,
		progressHash: p.progressHash,
	};
	return storedFlow(
		facts.sourceTuple,
		"LOCAL_FLOW_PLAN_V1",
		localStoryFlowRuntimeKey(identity, { purpose: "ROUTE_PREFIX", ordinal }),
		{ ...body, prefixHash: H(body) },
	);
}
function routeFixture(
	count = 4,
	profile: "amd" | "nvidia" = "nvidia",
	hardChoice = false,
) {
	const f = archiveFixture(count, profile);
	const c = acceptedContext(f.archive, undefined, hardChoice);
	const tuple = localStoryFlowSourceArchiveEvidence(f.archive).payload
		.sourceTuple as LocalStoryFlowSourceTuple;
	const identityInput = {
		taskId: f.f.snapshots.task.id,
		organizationId: f.f.media.organizationId,
		taskParameters: structuredClone(f.f.snapshots.task.parameters),
		startedAtMs: 1_000_000,
		sourceTuple: tuple,
		policies: f.f.policies,
	};
	const identity = prepareLocalStoryFlowRuntimeIdentity(identityInput);
	const facts = localStoryFlowRuntimeIdentityEvidence(identity);
	const startValue = localStoryFlowRuntimeStartRecord(
		identity,
		H("SYNTHETIC_ORIGINAL_CONNECTION"),
	);
	const start = storedFlow(
		tuple,
		startValue.kind,
		startValue.key,
		startValue.payload,
	);
	const startRef = localStoryFlowSealedRecordEvidence(start).ref;
	const contextEvidence = localStoryFlowAcceptedContextEvidence(c.context);
	const steps: AcceptedLocalStoryFlowRouteStep[] = [];
	const originals: LocalStoryFlowRouteHydrationSnapshot["origins"][number][] =
		[];
	const originalPrefixes: BoundLocalStoryFlowSealedRecord[] = [];
	const next = () =>
		nextLocalStoryFlowRouteWork({
			archive: f.archive,
			context: c.context,
			steps,
		});
	const append = () => {
		const n = next();
		if (n.status !== "NEXT") throw Error("No authored next work");
		const expected = localStoryFlowRouteWorkExpectation(n.work);
		const e = localStoryFlowNativeExpectationEvidence(expected),
			slot = steps.length + 1;
		const request = nativeRequestForOrigin(expected, {
			organizationId: facts.organizationId,
			originTaskId: facts.taskId,
		});
		const previous = originalPrefixes.at(-1);
		const previousRef = previous
			? localStoryFlowSealedRecordEvidence(previous).ref
			: null;
		const attemptBody = {
			version: "local-story-flow-runtime-attempt-v1",
			purpose: "ATTEMPT",
			taskId: facts.taskId,
			startRef,
			slot,
			category: "ROUTE",
			nativeKeyHash: e.nativeKeyHash,
			requestKey: request.body.requestKey,
			jobId: request.jobId,
			requestHash: request.requestHash,
			coreInputHash: e.nativeKey.coreInputHash,
			promptHash: e.promptHash,
			expectedTailPrefixRef: previousRef,
			reservedAtMs: facts.startedAtMs + slot,
			nativeKey: e.nativeKey,
			requestBody: request.body,
		};
		const attempt = storedFlow(
			tuple,
			"LOCAL_FLOW_PLAN_V1",
			localStoryFlowRuntimeKey(identity, { purpose: "ATTEMPT", slot }),
			{ ...attemptBody, attemptHash: H(attemptBody) },
		);
		const raw = routeOutput(n.work);
		const native = capture(expected, f.archive, raw, slot, {
			startRef,
			attemptRef: localStoryFlowSealedRecordEvidence(attempt).ref,
			originTaskId: facts.taskId,
		});
		const step = acceptLocalStoryFlowRouteWork({ work: n.work, native });
		const p = localStoryFlowAcceptedRoutePublication(step);
		const outcome = storedFlow(
			tuple,
			"LOCAL_FLOW_PLAN_V1",
			localStoryFlowRuntimeKey(identity, { purpose: "OUTCOME", slot }),
			{
				version: "local-story-flow-runtime-outcome-v1",
				purpose: "OUTCOME",
				taskId: facts.taskId,
				startRef,
				attemptRef: localStoryFlowSealedRecordEvidence(attempt).ref,
				slot,
				completedAtMs: facts.startedAtMs + 1000 + slot,
				status: "ACCEPTED",
				observationRef: p.observation.ref,
				acceptedArtifactRef: p.step.ref,
				acceptedArtifactHash: p.step.payload.stepHash,
				acceptedOrdinal: slot,
			},
		);
		steps.push(step);
		originals.push({ identity, start, attempt, outcome });
		originalPrefixes.push(
			prefixFor(identity, contextEvidence, start, step, slot, previousRef),
		);
		return step;
	};
	return {
		...f,
		c,
		steps,
		next,
		append,
		originals,
		originalPrefixes,
		identityInput,
		identity,
		start,
		facts,
	};
}
function terminalRouteFixture(
	count = 4,
	profile: "amd" | "nvidia" = "nvidia",
	hardChoice = false,
) {
	const original = routeFixture(count, profile, hardChoice);
	while (original.next().status === "NEXT") original.append();
	original.f.snapshots.task.id = randomUUID();
	original.f.input.requestKey = randomUUID();
	original.f.refresh();
	const transcript = transcriptFixture(original.f);
	const archive = buildLocalStoryFlowSourceArchive({
		transcript: transcript.handle,
		ledgers: original.ledgers.pairs,
	});
	const c = acceptedContext(archive, original.c.natives, hardChoice);
	const context = c.context,
		contextEvidence = localStoryFlowAcceptedContextEvidence(context);
	const steps: AcceptedLocalStoryFlowRouteStep[] = [];
	for (const old of original.steps) {
		const next = nextLocalStoryFlowRouteWork({ archive, context, steps });
		if (next.status !== "NEXT")
			throw Error("Expected next cached semantic input");
		steps.push(
			acceptLocalStoryFlowRouteWork({
				work: next.work,
				native: localStoryFlowAcceptedRoutePublication(old).native,
			}),
		);
	}
	const tuple = localStoryFlowSourceArchiveEvidence(archive).payload
		.sourceTuple as LocalStoryFlowSourceTuple;
	const identityInput = {
		taskId: original.f.snapshots.task.id,
		organizationId: original.f.media.organizationId,
		taskParameters: structuredClone(original.f.snapshots.task.parameters),
		startedAtMs: 1_000_000,
		sourceTuple: tuple,
		policies: original.f.policies,
	};
	const identity = prepareLocalStoryFlowRuntimeIdentity(identityInput);
	const facts = localStoryFlowRuntimeIdentityEvidence(identity);
	const sv = localStoryFlowRuntimeStartRecord(
		identity,
		H("SYNTHETIC_CURRENT_CONNECTION"),
	);
	const start = storedFlow(tuple, sv.kind, sv.key, sv.payload);
	const startRef = localStoryFlowSealedRecordEvidence(start).ref;
	const records = [start];
	for (const node of contextEvidence.nodes)
		records.push(
			storedFlow(
				tuple,
				"LOCAL_FLOW_PLAN_V1",
				localStoryFlowRuntimeKey(identity, {
					purpose: "CONTEXT_BINDING",
					nodeId: node.payload.nodeId,
				}),
				{
					version: "local-story-flow-runtime-context-binding-v1",
					purpose: "CONTEXT_BINDING",
					startRef,
					nodeRef: node.ref,
					nodeHash: node.payload.nodeHash,
					observationRef: node.payload.observationRef,
				},
			),
		);
	let tail: LocalStoryFlowRecordRef | null = null;
	for (const [index, step] of steps.entries()) {
		const prefix = prefixFor(
			identity,
			contextEvidence,
			start,
			step,
			index + 1,
			tail,
		);
		records.push(prefix);
		tail = localStoryFlowSealedRecordEvidence(prefix).ref;
	}
	const makeHistory = (rows = records, owner = identity) => {
		const f = localStoryFlowRuntimeIdentityEvidence(owner);
		return readLocalStoryFlowRuntimeHistory({
			identity: owner,
			records: rows,
			pins: rows.map((r) => ({
				organizationId: f.organizationId,
				taskId: f.taskId,
				receiptId: localStoryFlowSealedRecordEvidence(r).ref.receiptId,
			})),
		});
	};
	const snapshot: LocalStoryFlowRouteHydrationSnapshot = {
		steps: steps.map((s) =>
			storedProposal(localStoryFlowAcceptedRoutePublication(s).step),
		),
		observations: steps.map((s) =>
			storedProposal(localStoryFlowAcceptedRoutePublication(s).observation),
		),
		nativeCaches: steps.map((s) =>
			storedProposal(localStoryFlowAcceptedRoutePublication(s).cache),
		),
		origins: original.originals,
	};
	return {
		archive,
		context,
		identity,
		identityInput,
		history: makeHistory(),
		snapshot,
		steps,
		records,
		makeHistory,
		tuple,
		facts,
		original,
		contextEvidence,
	};
}

function inputFor(f: ReturnType<typeof terminalRouteFixture>) {
	return {
		archive: f.archive,
		context: f.context,
		identity: f.identity,
		history: f.history,
		snapshot: f.snapshot,
	};
}
function failedHistoryFor(
	f: ReturnType<typeof terminalRouteFixture>,
	identity = f.identity,
	start = first(f.records),
	failureCode = "SOURCE_CHANGED",
	cleanupStatus: "CONFIRMED" | "UNCONFIRMED" = "UNCONFIRMED",
) {
	const facts = localStoryFlowRuntimeIdentityEvidence(identity);
	const expected = localStoryFlowAcceptedRoutePublication(
		first(f.steps),
	).expectation;
	const e = localStoryFlowNativeExpectationEvidence(expected);
	const request = nativeRequestForOrigin(expected, {
		organizationId: facts.organizationId,
		originTaskId: facts.taskId,
	});
	const startRef = localStoryFlowSealedRecordEvidence(start).ref;
	const body = {
		version: "local-story-flow-runtime-attempt-v1",
		purpose: "ATTEMPT",
		taskId: facts.taskId,
		startRef,
		slot: 1,
		category: "ROUTE",
		nativeKeyHash: e.nativeKeyHash,
		requestKey: request.body.requestKey,
		jobId: request.jobId,
		requestHash: request.requestHash,
		coreInputHash: e.nativeKey.coreInputHash,
		promptHash: e.promptHash,
		expectedTailPrefixRef: null,
		reservedAtMs: facts.startedAtMs + 1,
		nativeKey: e.nativeKey,
		requestBody: request.body,
	};
	const attempt = storedFlow(
		f.tuple,
		"LOCAL_FLOW_PLAN_V1",
		localStoryFlowRuntimeKey(identity, { purpose: "ATTEMPT", slot: 1 }),
		{ ...body, attemptHash: H(body) },
	);
	const failed = storedFlow(
		f.tuple,
		"LOCAL_FLOW_PLAN_V1",
		localStoryFlowRuntimeKey(identity, { purpose: "OUTCOME", slot: 1 }),
		{
			version: "local-story-flow-runtime-outcome-v1",
			purpose: "OUTCOME",
			taskId: facts.taskId,
			startRef,
			attemptRef: localStoryFlowSealedRecordEvidence(attempt).ref,
			slot: 1,
			completedAtMs: facts.startedAtMs + 1000,
			status: "FAILED",
			failureCode,
			cleanupStatus,
			observationRef: null,
		},
	);
	return f.makeHistory([start, attempt, failed], identity);
}
function resealedLastObservation(
	f: ReturnType<typeof terminalRouteFixture>,
	edit: (value: LocalStoryFlowNativeObservation) => void,
) {
	const index = f.snapshot.observations.length - 1;
	const old = localStoryFlowSealedRecordEvidence(
		first(f.snapshot.observations.slice(index)),
	);
	const native = structuredClone(
		old.payload,
	) as unknown as LocalStoryFlowNativeObservation;
	edit(native);
	const body: Record<string, unknown> = { ...native };
	delete body.observationHash;
	const observation = storedFlow(old.sourceTuple, old.kind, old.key, {
		...body,
		observationHash: H(body),
	});
	const obs = localStoryFlowSealedRecordEvidence(observation);
	const step = localStoryFlowSealedRecordEvidence(
		first(f.snapshot.steps.slice(index)),
	);
	const newStep = storedFlow(
		step.sourceTuple,
		step.kind,
		{
			...step.key,
			keyBody: {
				...step.key.keyBody,
				observationHash: obs.payload.observationHash,
			},
		},
		{ ...step.payload, observationRef: obs.ref },
	);
	const actualStep = localStoryFlowSealedRecordEvidence(newStep);
	const cache = localStoryFlowSealedRecordEvidence(
		first(f.snapshot.nativeCaches.slice(index)),
	);
	const newCache = storedFlow(cache.sourceTuple, cache.kind, cache.key, {
		...cache.payload,
		observationRef: obs.ref,
		observationHash: obs.payload.observationHash,
	});
	const origin = first(f.snapshot.origins.slice(index));
	const outcome = localStoryFlowSealedRecordEvidence(origin.outcome);
	const newOutcome = storedFlow(
		outcome.sourceTuple,
		outcome.kind,
		outcome.key,
		{
			...outcome.payload,
			observationRef: obs.ref,
			acceptedArtifactRef: actualStep.ref,
		},
	);
	const rows = f.records.map((r) => {
		const e = localStoryFlowSealedRecordEvidence(r);
		if (e.key.purpose !== "ROUTE_PREFIX" || e.payload.ordinal !== index + 1)
			return r;
		const payload = {
			...e.payload,
			stepRef: actualStep.ref,
			observationRef: obs.ref,
		};
		Reflect.deleteProperty(payload, "prefixHash");
		return storedFlow(e.sourceTuple, e.kind, e.key, {
			...payload,
			prefixHash: H(payload),
		});
	});
	const replace = <T>(items: readonly T[], value: T): T[] =>
		items.map((old, i) => (i === index ? value : old));
	const snapshot: LocalStoryFlowRouteHydrationSnapshot = {
		steps: replace(f.snapshot.steps, newStep),
		observations: replace(f.snapshot.observations, observation),
		nativeCaches: replace(f.snapshot.nativeCaches, newCache),
		origins: replace(f.snapshot.origins, { ...origin, outcome: newOutcome }),
	};
	return { ...inputFor(f), history: f.makeHistory(rows), snapshot };
}
function changedPrefixHistory(
	f: ReturnType<typeof terminalRouteFixture>,
	edit: (payload: Record<string, unknown>, index: number) => void,
) {
	let previous: LocalStoryFlowRecordRef | null = null;
	const rows = f.records.map((record) => {
		const e = localStoryFlowSealedRecordEvidence(record);
		if (e.key.purpose !== "ROUTE_PREFIX") return record;
		const payload: Record<string, unknown> = {
			...e.payload,
			previousPrefixRef: previous,
		};
		Reflect.deleteProperty(payload, "prefixHash");
		edit(payload, Number(payload.ordinal) - 1);
		const updated = storedFlow(e.sourceTuple, e.kind, e.key, {
			...payload,
			prefixHash: H(payload),
		});
		previous = localStoryFlowSealedRecordEvidence(updated).ref;
		return updated;
	});
	return f.makeHistory(rows);
}
describe("terminal native route artifacts", () => {
	it("rejects a same-key cache winner resealed to point at another actual native observation", () => {
		const f = terminalRouteFixture();
		const original = localStoryFlowSealedRecordEvidence(
			first(f.snapshot.nativeCaches),
		);
		const other = localStoryFlowSealedRecordEvidence(
			first(f.snapshot.observations.slice(-1)),
		);
		const cache = storedFlow(
			original.sourceTuple,
			original.kind,
			original.key,
			{
				...original.payload,
				observationRef: other.ref,
				observationHash: other.payload.observationHash,
			},
		);
		const replaced = localStoryFlowSealedRecordEvidence(cache);
		expect(replaced.ref.receiptId).toBe(original.ref.receiptId);
		expect(replaced.ref.cacheHash).toBe(original.ref.cacheHash);
		expect(replaced.ref.proofHash).not.toBe(original.ref.proofHash);
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				snapshot: {
					...f.snapshot,
					nativeCaches: [cache, ...f.snapshot.nativeCaches.slice(1)],
				},
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("rejects a different valid C2 output resealed as STEP while the original native wire stays unchanged", () => {
		const f = terminalRouteFixture(),
			index = f.steps.length - 1;
		const p = localStoryFlowAcceptedRoutePublication(
			first(f.steps.slice(index)),
		);
		const raw = structuredClone(p.step.payload.stepEvidence.rawOutput);
		if (raw.phase !== "FINALIZE") throw Error("Expected authored final output");
		raw.blueprint.message =
			"A replacement narrative from a different valid response.";
		const origin = first(f.snapshot.origins.slice(index));
		const originFacts = localStoryFlowRuntimeIdentityEvidence(origin.identity);
		const fakeNative = capture(p.expectation, f.archive, raw, index + 1, {
			startRef: localStoryFlowSealedRecordEvidence(origin.start).ref,
			attemptRef: localStoryFlowSealedRecordEvidence(origin.attempt).ref,
			originTaskId: originFacts.taskId,
		});
		const forged = localStoryFlowAcceptedRoutePublication(
			acceptLocalStoryFlowRouteWork({ work: p.work, native: fakeNative }),
		);
		const old = localStoryFlowSealedRecordEvidence(
			first(f.snapshot.steps.slice(index)),
		);
		const step = storedFlow(old.sourceTuple, old.kind, old.key, {
			...forged.step.payload,
			observationRef: p.observation.ref,
		});
		const e = localStoryFlowSealedRecordEvidence(step);
		const outcome = localStoryFlowSealedRecordEvidence(origin.outcome);
		const changedOutcome = storedFlow(
			outcome.sourceTuple,
			outcome.kind,
			outcome.key,
			{
				...outcome.payload,
				acceptedArtifactRef: e.ref,
				acceptedArtifactHash: e.payload.stepHash,
			},
		);
		const history = changedPrefixHistory(f, (v, i) => {
			if (i === index) {
				v.stepRef = e.ref;
				v.stepHash = e.payload.stepHash;
			}
		});
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				history,
				snapshot: {
					...f.snapshot,
					steps: f.snapshot.steps.map((v, i) => (i === index ? step : v)),
					origins: f.snapshot.origins.map((v, i) =>
						i === index ? { ...v, outcome: changedOutcome } : v,
					),
				},
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it.each([
		"steps",
		"observations",
		"nativeCaches",
		"origins",
	] as const)("rejects a unique unconsumed extra %s", (field) => {
		const f = terminalRouteFixture();
		let extra: unknown;
		if (field === "origins") {
			const origin = first(f.snapshot.origins);
			const a = localStoryFlowSealedRecordEvidence(origin.attempt);
			const ab = { ...a.payload, slot: 127 };
			Reflect.deleteProperty(ab, "attemptHash");
			const attempt = storedFlow(
				a.sourceTuple,
				a.kind,
				{ ...a.key, keyBody: { ...a.key.keyBody, slot: 127 } },
				{ ...ab, attemptHash: H(ab) },
			);
			const o = localStoryFlowSealedRecordEvidence(origin.outcome);
			const outcome = storedFlow(
				o.sourceTuple,
				o.kind,
				{ ...o.key, keyBody: { ...o.key.keyBody, slot: 127 } },
				{
					...o.payload,
					slot: 127,
					attemptRef: localStoryFlowSealedRecordEvidence(attempt).ref,
				},
			);
			extra = { ...origin, attempt, outcome };
		} else {
			const e = localStoryFlowSealedRecordEvidence(first(f.snapshot[field]));
			const keyBody = { ...e.key.keyBody };
			if (field === "steps") keyBody.expectationHash = H("unrequested step");
			if (field === "observations") keyBody.slot = 127;
			if (field === "nativeCaches")
				keyBody.nativeKeyHash = H("unrequested cache");
			extra = storedFlow(
				e.sourceTuple,
				e.kind,
				{ ...e.key, keyBody },
				e.payload,
			);
		}
		const values: readonly unknown[] = f.snapshot[field];
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				snapshot: {
					...f.snapshot,
					[field]: [...values, extra],
				} as never,
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it.each([
		"progressHash",
		"expectationHash",
		"stepHash",
		"nativeRootProof",
		"sourceArchiveRef",
		"treeRef",
	])("rejects a structurally resealed prefix chain with changed %s", (field) => {
		const f = terminalRouteFixture();
		const history = changedPrefixHistory(f, (p, i) => {
			if (["nativeRootProof", "sourceArchiveRef", "treeRef"].includes(field)) {
				p[field] = field.endsWith("Ref")
					? {
							...(p[field] as LocalStoryFlowRecordRef),
							proofHash: H("forged prefix association"),
						}
					: H("forged native root proof");
			} else if (i === f.steps.length - 1) p[field] = H("changed final mirror");
		});
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({ ...inputFor(f), history }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("rejects a genuine sealed record from another source", () => {
		const f = terminalRouteFixture(),
			other = terminalRouteFixture();
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				snapshot: {
					...f.snapshot,
					observations: [
						first(other.snapshot.observations),
						...f.snapshot.observations.slice(1),
					],
				},
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("rejects an origin bundle accessor without executing it", () => {
		const f = terminalRouteFixture(),
			getter = vi.fn();
		const origin = Object.defineProperty(
			{ ...first(f.snapshot.origins) },
			"identity",
			{ get: getter, enumerable: true },
		);
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				snapshot: {
					...f.snapshot,
					origins: [origin, ...f.snapshot.origins.slice(1)],
				},
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		expect(getter).not.toHaveBeenCalled();
	});
	it.each([
		"CLEANUP",
		"STATS",
		"JSON",
	] as const)("rejects consistently resealed native %s with all STEP/cache/outcome/prefix mirrors updated", (mode) => {
		const f = terminalRouteFixture();
		const input = resealedLastObservation(f, (o) => {
			if (mode === "CLEANUP") o.terminalJob.cleanupConfirmed = false;
			const result = o.terminalJob.result;
			if (!result) throw Error("Missing authored result");
			if (mode === "STATS") result.receipt.apiStats.evalCount = -1;
			if (mode === "JSON") result.content = "{";
		});
		const i = input.snapshot.observations.length - 1;
		const original = first(input.snapshot.origins.slice(i));
		const observation = first(input.snapshot.observations.slice(i));
		const expected = localStoryFlowAcceptedRoutePublication(
			first(f.steps.slice(i)),
		).expectation;
		// The independent origin/full seals still pass; original native wire admission must reject.
		const origin = admitLocalStoryFlowAcceptedOrigin({
			...original,
			expectation: expected,
			observation,
		});
		expect(() =>
			admitFlowNativeObservation(expected, {
				resolvedOrigin: localStoryFlowAcceptedOriginEvidence(origin),
				observation: localStoryFlowSealedRecordEvidence(observation).payload,
			}),
		).toThrow("LOCAL_STORY_FLOW_NATIVE_INVALID");
		expect(() => hydrateLocalStoryFlowRouteArtifacts(input)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
	});
	it("hydrates a multipage route with a pending hard witness and forced branch traversal", () => {
		const f = terminalRouteFixture(64, "nvidia", true);
		const actual = hydrateLocalStoryFlowRouteArtifacts(inputFor(f));
		const phases = actual.map(
			(s) =>
				localStoryFlowAcceptedRoutePublication(s).step.payload.stepEvidence
					.phase,
		);
		expect(phases).toContain("WITNESS");
		expect(phases).toContain("BRANCH");
		expect(phases.filter((p) => p === "LEAF").length).toBeGreaterThan(1);
		expect(phases.at(-1)).toBe("FINALIZE");
		for (const call of Object.values(stageCalls))
			expect(call).not.toHaveBeenCalled();
	});
	it.each([
		"steps",
		"observations",
		"nativeCaches",
		"origins",
	] as const)("rejects missing and duplicate %s instead of returning a partial route", (field) => {
		const f = terminalRouteFixture();
		const items: readonly unknown[] = f.snapshot[field];
		for (const bad of [items.slice(1), [...items, first(items)]])
			expect(() =>
				hydrateLocalStoryFlowRouteArtifacts({
					...inputFor(f),
					snapshot: { ...f.snapshot, [field]: bad } as never,
				}),
			).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it.each([
		"sparse",
		"getter",
		"symbol",
		"hidden",
		"over64",
	] as const)("rejects %s snapshot arrays without executing element accessors", (kind) => {
		const f = terminalRouteFixture(),
			getter = vi.fn();
		const steps = [...f.snapshot.steps];
		if (kind === "sparse") Reflect.deleteProperty(steps, "1");
		if (kind === "getter")
			Object.defineProperty(steps, "0", { get: getter, enumerable: true });
		if (kind === "symbol")
			Object.defineProperty(steps, Symbol("extra"), { value: true });
		if (kind === "hidden")
			Object.defineProperty(steps, "extra", { value: true });
		if (kind === "over64")
			steps.push(
				...Array.from({ length: 65 - steps.length }, () =>
					first(f.snapshot.steps),
				),
			);
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				snapshot: { ...f.snapshot, steps },
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		expect(getter).not.toHaveBeenCalled();
	});
	it("rejects current and original identity times that do not match their START records", () => {
		const f = terminalRouteFixture();
		const current = prepareLocalStoryFlowRuntimeIdentity({
			...f.identityInput,
			startedAtMs: f.facts.startedAtMs + 1,
		});
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				identity: current,
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		const original = prepareLocalStoryFlowRuntimeIdentity({
			...f.original.identityInput,
			startedAtMs: f.original.facts.startedAtMs + 1,
		});
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				snapshot: {
					...f.snapshot,
					origins: f.snapshot.origins.map((o, i) =>
						i === 0 ? { ...o, identity: original } : o,
					),
				},
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it.each([
		"LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
		"LOCAL_STORY_FLOW_NO_PROGRESS",
		"LOCAL_STORY_FLOW_BUDGET_EXHAUSTED",
		"LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		"LOCAL_SEMANTIC_JOB_FAILED",
		"CANCELED",
		"SOURCE_CHANGED",
	])("preserves same-task fixed failure %s before heavy source work", (code) => {
		const f = terminalRouteFixture();
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				archive: {},
				context: {},
				history: failedHistoryFor(
					f,
					f.identity,
					first(f.records),
					code,
					"CONFIRMED",
				),
			}),
		).toThrow(code);
	});
	it("does not execute error code or message getters when normalizing a hostile failure", () => {
		const code = vi.fn(),
			message = vi.fn();
		const failure = Object.defineProperties(
			{},
			{ code: { get: code }, message: { get: message } },
		);
		const input = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw failure;
				},
			},
		);
		expect(() => hydrateLocalStoryFlowRouteArtifacts(input as never)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
		expect(code).not.toHaveBeenCalled();
		expect(message).not.toHaveBeenCalled();
	});
	it("rejects a foreign-task owned S0 history before honoring its stop code", () => {
		const f = terminalRouteFixture();
		const foreign = failedHistoryFor(f, f.original.identity, f.original.start);
		expect(localStoryFlowRuntimeHistoryEvidence(foreign).stopCode).toBe(
			"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		);
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({ ...inputFor(f), history: foreign }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("preserves same-task S0 before looking at an invalid heavy source", () => {
		const f = terminalRouteFixture();
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				...inputFor(f),
				archive: {},
				context: {},
				history: failedHistoryFor(f),
			}),
		).toThrow("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
	});
	it.each([
		"nvidia",
		"amd",
	] as const)("hydrates cached ROOT/LEAF/FINALIZE with original fixed origins on %s", (profile) => {
		const f = terminalRouteFixture(4, profile);
		const actual = hydrateLocalStoryFlowRouteArtifacts(inputFor(f));
		expect(
			actual.map(
				(s) =>
					localStoryFlowAcceptedRoutePublication(s).step.payload.stepEvidence
						.phase,
			),
		).toEqual(["ROOT", "LEAF", "FINALIZE"]);
		expect(
			actual.map((s) => localStoryFlowAcceptedRoutePublication(s).step),
		).toEqual(
			f.steps.map((s) => localStoryFlowAcceptedRoutePublication(s).step),
		);
		const history = localStoryFlowRuntimeHistoryEvidence(f.history);
		expect(history.counts.total).toBe(0);
		expect(history.attempts).toEqual([]);
		expect(f.snapshot.origins).toHaveLength(3);
		expect(f.original.originalPrefixes).toHaveLength(3);
		expect(f.facts.taskId).not.toBe(f.original.facts.taskId);
		const originalContext = localStoryFlowAcceptedContextEvidence(
			f.original.c.context,
		);
		expect(originalContext.tree.ref).not.toEqual(f.contextEvidence.tree.ref);
		expect(originalContext.tree.payload.treeHash).toBe(
			f.contextEvidence.tree.payload.treeHash,
		);
		for (const call of Object.values(stageCalls))
			expect(call).not.toHaveBeenCalled();
		actual.pop();
		expect(hydrateLocalStoryFlowRouteArtifacts(inputFor(f))).toHaveLength(3);
	});

	it("rejects unknown handles and input accessors without invoking them", () => {
		expect(() =>
			hydrateLocalStoryFlowRouteArtifacts({
				archive: {},
				context: {},
				identity: {},
				history: {},
				snapshot: {
					steps: [],
					observations: [],
					nativeCaches: [],
					origins: [],
				},
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		const getter = vi.fn();
		const input = Object.defineProperty({}, "archive", {
			enumerable: true,
			get: getter,
		});
		expect(() => hydrateLocalStoryFlowRouteArtifacts(input as never)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
		expect(getter).not.toHaveBeenCalled();
	});
});
