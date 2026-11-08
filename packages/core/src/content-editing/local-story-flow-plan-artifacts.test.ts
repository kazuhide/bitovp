import { beforeEach, vi } from "vitest";
import { localStoryFlowAcceptedContextEvidence } from "./local-story-flow-artifact-reader";
import {
	buildLocalStoryFlowPlanArtifact,
	hydrateLocalStoryFlowPlanArtifact,
	LocalStoryFlowPlanArtifactError,
	localStoryFlowPlanArtifactEvidence,
} from "./local-story-flow-plan-artifacts";
import {
	localStoryFlowRuntimeHistoryEvidence,
	localStoryFlowRuntimeIdentityEvidence,
	localStoryFlowRuntimeKey,
	localStoryFlowRuntimeStartRecord,
	prepareLocalStoryFlowRuntimeIdentity,
	readLocalStoryFlowRuntimeHistory,
} from "./local-story-flow-runtime-history";
import {
	type BoundLocalStoryFlowSealedRecord,
	localStoryFlowSealedRecordEvidence,
	readLocalStoryFlowSealedRecord,
} from "./local-story-flow-seals";

const calls = vi.hoisted(() => ({
	build: vi.fn(),
	select: vi.fn(),
	validateScope: vi.fn(),
	validatePlan: vi.fn(),
	legacy: vi.fn(),
}));
vi.mock("./local-story-flow-scope", async (original) => {
	const actual = await original<typeof import("./local-story-flow-scope")>();
	calls.build.mockImplementation(actual.buildLocalStoryFlowScope);
	calls.select.mockImplementation(actual.selectLocalStoryFlowPlan);
	calls.validateScope.mockImplementation(actual.validateLocalStoryFlowScope);
	calls.validatePlan.mockImplementation(actual.validateLocalStoryFlowPlan);
	return {
		...actual,
		buildLocalStoryFlowScope: calls.build,
		selectLocalStoryFlowPlan: calls.select,
		validateLocalStoryFlowScope: calls.validateScope,
		validateLocalStoryFlowPlan: calls.validatePlan,
	};
});
vi.mock("./local-story-planner", async (original) => {
	const actual = await original<typeof import("./local-story-planner")>();
	calls.legacy.mockImplementation(actual.selectLocalStoryClips);
	return { ...actual, selectLocalStoryClips: calls.legacy };
});
beforeEach(() => {
	for (const call of Object.values(calls)) call.mockClear();
});

import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
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
import { LOCAL_STORY_FLOW_SCOPE_POLICY } from "./local-story-flow-scope";
import {
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordKind,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
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
	},
) {
	const expected = work,
		e = localStoryFlowNativeExpectationEvidence(expected);
	const a = localStoryFlowSourceArchiveEvidence(archive);
	const sourceTuple = a.payload.sourceTuple as LocalStoryFlowSourceTuple;
	const originTaskId = String(a.payload.taskId);
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
function routeFixture(
	count = 4,
	profile: "amd" | "nvidia" = "nvidia",
	hardChoice = false,
) {
	const f = archiveFixture(count, profile);
	const c = acceptedContext(f.archive, undefined, hardChoice);
	const steps: AcceptedLocalStoryFlowRouteStep[] = [];
	const next = () =>
		nextLocalStoryFlowRouteWork({
			archive: f.archive,
			context: c.context,
			steps,
		});
	const append = (output?: unknown) => {
		const n = next();
		if (n.status !== "NEXT") throw Error("No authored next work");
		const expected = localStoryFlowRouteWorkExpectation(n.work);
		const raw = output ?? routeOutput(n.work);
		const native = capture(
			expected,
			f.archive,
			raw,
			c.nodes.length + steps.length + 1,
		);
		const step = acceptLocalStoryFlowRouteWork({ work: n.work, native });
		steps.push(step);
		return { step, work: n.work, native, raw, expected };
	};
	return { ...f, c, steps, next, append };
}

function storedFlow(
	t: LocalStoryFlowSourceTuple,
	key: LocalStoryFlowRecordKey,
	payload: Record<string, unknown>,
): BoundLocalStoryFlowSealedRecord {
	const kind = "LOCAL_FLOW_PLAN_V1";
	const identity = localStoryFlowRecordIdentity({ sourceTuple: t, kind, key });
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: canonicalEditingJson(payload),
	};
	return readLocalStoryFlowSealedRecord({
		sourceTuple: t,
		kind,
		key,
		ref: { kind, ...identity, proofHash: H(proof) },
		row: {
			id: identity.receiptId,
			organizationId: t.organizationId,
			sourceId: t.sourceId,
			mediaVersionId: t.mediaVersionId,
			analysisRevisionId: t.analysisRevisionId,
			kind,
			proof,
			proofHash: H(proof),
		},
	});
}
function planFixture(count = 4, profile: "nvidia" | "amd" = "nvidia") {
	// Real pure source/context/native/route builders. Task B admits task A's
	// exact semantic observations; B's history therefore has no new reservations.
	const a = routeFixture(count, profile);
	while (a.next().status === "NEXT") a.append();
	a.f.snapshots.task.id = randomUUID();
	a.f.input.requestKey = randomUUID();
	a.f.refresh();
	const transcript = transcriptFixture(a.f);
	const archive = buildLocalStoryFlowSourceArchive({
		transcript: transcript.handle,
		ledgers: a.ledgers.pairs,
	});
	const context = acceptedContext(archive, a.c.natives).context;
	const steps: AcceptedLocalStoryFlowRouteStep[] = [];
	for (const old of a.steps) {
		const next = nextLocalStoryFlowRouteWork({ archive, context, steps });
		if (next.status !== "NEXT")
			throw Error("Expected complete synthetic route");
		steps.push(
			acceptLocalStoryFlowRouteWork({
				work: next.work,
				native: localStoryFlowAcceptedRoutePublication(old).native,
			}),
		);
	}
	const source = localStoryFlowSourceArchiveEvidence(archive),
		contextValue = localStoryFlowAcceptedContextEvidence(context);
	const tuple = source.payload.sourceTuple as LocalStoryFlowSourceTuple;
	const identity = prepareLocalStoryFlowRuntimeIdentity({
		taskId: a.f.snapshots.task.id,
		organizationId: a.f.media.organizationId,
		taskParameters: a.f.snapshots.task.parameters,
		startedAtMs: 1_000_000,
		sourceTuple: tuple,
		policies: a.f.policies,
	});
	const facts = localStoryFlowRuntimeIdentityEvidence(identity);
	const startValue = localStoryFlowRuntimeStartRecord(
		identity,
		H("SYNTHETIC_ORIGINAL_CONNECTION"),
	);
	const start = storedFlow(tuple, startValue.key, startValue.payload);
	const startRef = localStoryFlowSealedRecordEvidence(start).ref;
	const records = [start];
	for (const node of contextValue.nodes) {
		records.push(
			storedFlow(
				tuple,
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
	}
	let previousPrefixRef: LocalStoryFlowRecordRef | null = null;
	for (const [index, step] of steps.entries()) {
		const p = localStoryFlowAcceptedRoutePublication(step);
		const body = {
			version: "local-story-flow-runtime-prefix-v1",
			purpose: "ROUTE_PREFIX",
			taskId: facts.taskId,
			startRef,
			sourceArchiveRef: contextValue.sourceArchive.ref,
			treeRef: contextValue.tree.ref,
			ordinal: index + 1,
			previousPrefixRef,
			stepRef: p.step.ref,
			stepHash: p.step.payload.stepHash,
			expectationHash: p.step.payload.stepEvidence.expectation.expectationHash,
			observationRef: p.observation.ref,
			nativeRootProof: localStoryFlowNativeRootEvidence(p.nativeRoot)
				.nativeRootProof,
			progressHash: p.progressHash,
		};
		const prefix = storedFlow(
			tuple,
			localStoryFlowRuntimeKey(identity, {
				purpose: "ROUTE_PREFIX",
				ordinal: index + 1,
			}),
			{ ...body, prefixHash: H(body) },
		);
		records.push(prefix);
		previousPrefixRef = localStoryFlowSealedRecordEvidence(prefix).ref;
	}
	const makeHistory = (rows = records) =>
		readLocalStoryFlowRuntimeHistory({
			identity,
			records: rows,
			pins: rows.map((r) => ({
				organizationId: facts.organizationId,
				taskId: facts.taskId,
				receiptId: localStoryFlowSealedRecordEvidence(r).ref.receiptId,
			})),
		});
	return {
		archive,
		context,
		identity,
		history: makeHistory(),
		steps,
		records,
		makeHistory,
		tuple,
		facts,
		fixture: a,
	};
}
function sealedPlan(
	value: ReturnType<typeof localStoryFlowPlanArtifactEvidence>,
) {
	return readLocalStoryFlowSealedRecord({
		sourceTuple: value.sourceTuple,
		kind: value.kind,
		key: value.key,
		ref: value.ref,
		row: {
			id: value.ref.receiptId,
			organizationId: value.sourceTuple.organizationId,
			sourceId: value.sourceTuple.sourceId,
			mediaVersionId: value.sourceTuple.mediaVersionId,
			analysisRevisionId: value.sourceTuple.analysisRevisionId,
			kind: value.kind,
			proof: {
				version: "local-story-cache-v2",
				cacheHash: value.ref.cacheHash,
				valueJson: canonicalEditingJson(value.payload),
			},
			proofHash: value.ref.proofHash,
		},
	});
}
it("creates the full PLAN with one actual C3 scope and one actual legacy selector", () => {
	const f = planFixture();
	const plan = buildLocalStoryFlowPlanArtifact({
		archive: f.archive,
		context: f.context,
		identity: f.identity,
		history: f.history,
		steps: f.steps,
	});
	const p = localStoryFlowPlanArtifactEvidence(plan);
	expect(p.key.purpose).toBe("PLAN");
	expect(p.payload.originalSelection).toEqual(p.payload.planEvidence.selection);
	expect(p.payload.originalSelectedEventIds).toEqual(
		p.payload.planEvidence.selection.localStorySelection.selectedEventIds,
	);
	expect(p.payload.clock.strictEventMomentOrder).toBe("NOT_PROVEN");
	expect(p.payload.orderedPrefixRefs).toHaveLength(f.steps.length);
	expect(calls.build).toHaveBeenCalledTimes(1);
	expect(calls.select).toHaveBeenCalledTimes(1);
	expect(calls.validateScope).not.toHaveBeenCalled();
	expect(calls.validatePlan).not.toHaveBeenCalled();
	expect(calls.legacy).toHaveBeenCalledTimes(1);
});
it("terminal hydrates full PLAN through validators exactly once without creator preselection", () => {
	const f = planFixture();
	const options = {
		archive: f.archive,
		context: f.context,
		identity: f.identity,
		history: f.history,
		steps: f.steps,
	};
	const value = localStoryFlowPlanArtifactEvidence(
		buildLocalStoryFlowPlanArtifact(options),
	);
	for (const call of Object.values(calls)) call.mockClear();
	const hydrated = hydrateLocalStoryFlowPlanArtifact({
		...options,
		plan: sealedPlan(value),
	});
	expect(localStoryFlowPlanArtifactEvidence(hydrated)).toEqual(value);
	expect(calls.validateScope).toHaveBeenCalledTimes(1);
	expect(calls.validatePlan).toHaveBeenCalledTimes(1);
	expect(calls.build).not.toHaveBeenCalled();
	expect(calls.select).not.toHaveBeenCalled();
	expect(calls.legacy).toHaveBeenCalledTimes(1);
});

function optionsFor(f: ReturnType<typeof planFixture>) {
	return {
		archive: f.archive,
		context: f.context,
		identity: f.identity,
		history: f.history,
		steps: f.steps,
	};
}
function withHistoryRows(
	f: ReturnType<typeof planFixture>,
	rows: BoundLocalStoryFlowSealedRecord[],
) {
	return { ...optionsFor(f), history: f.makeHistory(rows) };
}
function alterPrefixes(
	f: ReturnType<typeof planFixture>,
	edit: (payload: Record<string, unknown>, last: boolean) => void,
) {
	let previous: LocalStoryFlowRecordRef | null = null;
	const rows = f.records.map((record) => {
		const e = localStoryFlowSealedRecordEvidence(record);
		if (e.key.purpose !== "ROUTE_PREFIX") return record;
		const body = { ...e.payload };
		delete body.prefixHash;
		body.previousPrefixRef = previous;
		edit(body, body.ordinal === f.steps.length);
		const changed = storedFlow(f.tuple, e.key, {
			...body,
			prefixHash: H(body),
		});
		previous = localStoryFlowSealedRecordEvidence(changed).ref;
		return changed;
	});
	return withHistoryRows(f, rows);
}
it("retains every formal PLAN field, full original selection and independently computed native trace", () => {
	const f = planFixture(),
		p = localStoryFlowPlanArtifactEvidence(
			buildLocalStoryFlowPlanArtifact(optionsFor(f)),
		);
	const h = localStoryFlowRuntimeHistoryEvidence(f.history);
	expect(p.payload.nativeTraceHash).toBe(
		H({
			version: "local-story-flow-native-trace-v1",
			taskId: f.facts.taskId,
			startRef: h.start.ref,
			sourceArchiveRef: p.payload.sourceArchiveRef,
			treeRef: p.payload.treeRef,
			prefixes: h.prefixes.map((prefix, index) => ({
				ordinal: index + 1,
				prefixRef: prefix.ref,
				prefixHash: prefix.payload.prefixHash,
				stepHash: prefix.payload.stepHash,
				expectationHash: prefix.payload.expectationHash,
				observationRef: prefix.payload.observationRef,
			})),
			structuralTraceHash: p.payload.scopeEvidence.trace.traceHash,
		}),
	);
	const { artifactHash, ...body } = p.payload;
	expect(artifactHash).toBe(H(body));
	expect(p.payload.originalSelection).toHaveProperty("clips");
	expect(p.payload.originalSelection).toHaveProperty("localStorySelection");
	expect(p.payload.structuralTraceHash).toBe(
		p.payload.scopeEvidence.trace.traceHash,
	);
	expect(Object.keys(p.payload).sort()).toEqual(
		[
			"version",
			"purpose",
			"taskId",
			"startRef",
			"taskPinHash",
			"sourceTuple",
			"sourceArchiveRef",
			"workflow",
			"baseModel",
			"sourceBindingHash",
			"inputHash",
			"transcriptFingerprint",
			"corpusHash",
			"manifestHash",
			"treeRef",
			"treeHash",
			"orderedContextBindings",
			"orderedPrefixRefs",
			"nativeTraceHash",
			"structuralTraceHash",
			"nativeRootProof",
			"scopeEvidence",
			"scopeHash",
			"planEvidence",
			"planHash",
			"originalBlueprint",
			"originalSelection",
			"originalSelectedEventIds",
			"clock",
			"generationPolicyFingerprint",
			"compiledPolicyParts",
			"artifactHash",
		].sort(),
	);
});
it.each([
	"STEP_HASH",
	"EXPECTATION",
	"OBSERVATION",
	"PROGRESS",
	"ROOT_PROOF",
] as const)("rejects coherent re-sealed whole history with an actual-step mirror mismatch: %s", (mode) => {
	const f = planFixture();
	const options = alterPrefixes(f, (p, last) => {
		if (mode === "ROOT_PROOF") p.nativeRootProof = H("SYNTHETIC_WRONG_ROOT");
		if (!last) return;
		if (mode === "STEP_HASH") p.stepHash = H("SYNTHETIC_WRONG_STEP");
		if (mode === "EXPECTATION")
			p.expectationHash = H("SYNTHETIC_WRONG_EXPECTATION");
		if (mode === "OBSERVATION")
			p.observationRef = localStoryFlowAcceptedRoutePublication(
				first(f.steps),
			).observation.ref;
		if (mode === "PROGRESS") p.progressHash = H("SYNTHETIC_WRONG_PROGRESS");
	});
	expect(() => buildLocalStoryFlowPlanArtifact(options)).toThrow(
		LocalStoryFlowPlanArtifactError,
	);
	expect(calls.legacy).not.toHaveBeenCalled();
});
it.each([
	"MISSING",
	"EXTRA",
	"NODE_HASH",
] as const)("requires exactly all layout bindings: %s", (mode) => {
	const f = planFixture();
	const binding = first(
		f.records.filter(
			(r) =>
				localStoryFlowSealedRecordEvidence(r).key.purpose === "CONTEXT_BINDING",
		),
	);
	const b = localStoryFlowSealedRecordEvidence(binding);
	let rows = [...f.records];
	if (mode === "MISSING") rows = rows.filter((r) => r !== binding);
	if (mode === "EXTRA")
		rows.push(
			storedFlow(
				f.tuple,
				localStoryFlowRuntimeKey(f.identity, {
					purpose: "CONTEXT_BINDING",
					nodeId: "n62",
				}),
				b.payload,
			),
		);
	if (mode === "NODE_HASH")
		rows = rows.map((r) =>
			r === binding
				? storedFlow(f.tuple, b.key, {
						...b.payload,
						nodeHash: H("SYNTHETIC_BAD_NODE"),
					})
				: r,
		);
	expect(() =>
		buildLocalStoryFlowPlanArtifact(withHistoryRows(f, rows)),
	).toThrow(LocalStoryFlowPlanArtifactError);
	expect(calls.legacy).not.toHaveBeenCalled();
});
it.each([
	"MISSING",
	"REVERSED",
	"DUPLICATE",
	"FOREIGN",
] as const)("rejects incomplete or forked accepted route arrays: %s", (mode) => {
	const f = planFixture();
	let steps = [...f.steps];
	if (mode === "MISSING") steps = steps.slice(1);
	if (mode === "REVERSED") steps.reverse();
	if (mode === "DUPLICATE") steps[1] = first(steps);
	if (mode === "FOREIGN") steps = planFixture().steps;
	expect(() =>
		buildLocalStoryFlowPlanArtifact({ ...optionsFor(f), steps }),
	).toThrow(LocalStoryFlowPlanArtifactError);
	expect(calls.legacy).not.toHaveBeenCalled();
});
it.each([
	"EXTRA",
	"MISSING",
	"SELECTION_INNER",
	"BLUEPRINT",
	"CONTEXT_BINDINGS",
	"PREFIX_REFS",
	"NATIVE_TRACE",
	"STRUCTURAL_TRACE",
	"ROOT_PROOF",
	"POLICY",
	"MODEL",
	"CLOCK",
	"TASK_PIN",
] as const)("rejects a self-consistently re-sealed PLAN mirror corruption: %s", (mode) => {
	const f = planFixture(),
		options = optionsFor(f);
	const p = localStoryFlowPlanArtifactEvidence(
		buildLocalStoryFlowPlanArtifact(options),
	);
	const payload: Record<string, unknown> = structuredClone(p.payload);
	if (mode === "EXTRA") payload.extra = "SYNTHETIC";
	if (mode === "MISSING") delete payload.corpusHash;
	if (mode === "SELECTION_INNER")
		payload.originalSelection = p.payload.originalSelection.localStorySelection;
	if (mode === "BLUEPRINT")
		payload.originalBlueprint = {
			...p.payload.originalBlueprint,
			message: "Changed",
		};
	if (mode === "CONTEXT_BINDINGS") payload.orderedContextBindings = [];
	if (mode === "PREFIX_REFS")
		payload.orderedPrefixRefs = p.payload.orderedPrefixRefs.slice(1);
	if (mode === "NATIVE_TRACE")
		payload.nativeTraceHash = p.payload.structuralTraceHash;
	if (mode === "STRUCTURAL_TRACE")
		payload.structuralTraceHash = p.payload.nativeTraceHash;
	if (mode === "ROOT_PROOF")
		payload.nativeRootProof = H("SYNTHETIC_WRONG_ROOT");
	if (mode === "POLICY")
		payload.compiledPolicyParts = {
			...p.payload.compiledPolicyParts,
			deliveryPolicyHash: H("OTHER"),
		};
	if (mode === "MODEL")
		payload.baseModel = { ...p.payload.baseModel, profile: "amd" };
	if (mode === "CLOCK")
		payload.clock = { ...p.payload.clock, strictEventMomentOrder: "PROVEN" };
	if (mode === "TASK_PIN") payload.taskPinHash = H("OTHER");
	delete payload.artifactHash;
	payload.artifactHash = H(payload);
	const plan = storedFlow(f.tuple, p.key, payload);
	for (const call of Object.values(calls)) call.mockClear();
	expect(() => hydrateLocalStoryFlowPlanArtifact({ ...options, plan })).toThrow(
		LocalStoryFlowPlanArtifactError,
	);
	expect(calls.legacy).toHaveBeenCalledTimes(1);
});
function stoppedHistory(
	f: ReturnType<typeof planFixture>,
	code: string | null,
	cleanupStatus = "CONFIRMED",
) {
	const expectation = localStoryFlowAcceptedRoutePublication(
		first(f.steps),
	).expectation;
	const e = localStoryFlowNativeExpectationEvidence(expectation);
	const request = nativeRequestForOrigin(expectation, {
		organizationId: f.facts.organizationId,
		originTaskId: f.facts.taskId,
	});
	const start = localStoryFlowSealedRecordEvidence(first(f.records));
	const body = {
		version: "local-story-flow-runtime-attempt-v1",
		purpose: "ATTEMPT",
		taskId: f.facts.taskId,
		startRef: start.ref,
		slot: 1,
		category: "ROUTE",
		nativeKeyHash: e.nativeKeyHash,
		requestKey: request.body.requestKey,
		jobId: request.jobId,
		requestHash: request.requestHash,
		coreInputHash: e.nativeKey.coreInputHash,
		promptHash: e.promptHash,
		expectedTailPrefixRef: null,
		reservedAtMs: f.facts.startedAtMs + 1,
		nativeKey: e.nativeKey,
		requestBody: request.body,
	};
	const attempt = storedFlow(
		f.tuple,
		localStoryFlowRuntimeKey(f.identity, { purpose: "ATTEMPT", slot: 1 }),
		{ ...body, attemptHash: H(body) },
	);
	const rows = [...f.records, attempt];
	if (code !== null)
		rows.push(
			storedFlow(
				f.tuple,
				localStoryFlowRuntimeKey(f.identity, { purpose: "OUTCOME", slot: 1 }),
				{
					version: "local-story-flow-runtime-outcome-v1",
					purpose: "OUTCOME",
					taskId: f.facts.taskId,
					startRef: start.ref,
					attemptRef: localStoryFlowSealedRecordEvidence(attempt).ref,
					slot: 1,
					completedAtMs: f.facts.startedAtMs + 2,
					status: "FAILED",
					failureCode: code,
					cleanupStatus,
					observationRef: null,
				},
			),
		);
	return f.makeHistory(rows);
}
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
])("preserves the owned history's exact known stop code before invalid source: %s", (code) => {
	const f = planFixture(),
		history = stoppedHistory(f, code);
	const options = {
		...optionsFor(f),
		archive: {} as BoundLocalStoryFlowSourceArchive,
		history,
	};
	for (const operation of [
		() => buildLocalStoryFlowPlanArtifact(options),
		() => hydrateLocalStoryFlowPlanArtifact({ ...options, plan: {} }),
	]) {
		let error: unknown;
		try {
			operation();
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(LocalStoryFlowPlanArtifactError);
		expect(error).toMatchObject({ code, message: code });
		expect(error).not.toHaveProperty("cause");
	}
	expect(calls.legacy).not.toHaveBeenCalled();
});
it("keeps S0 cleanup priority and refuses a remaining unconfirmed slot", () => {
	const f = planFixture();
	for (const [history, code] of [
		[
			stoppedHistory(f, "SOURCE_CHANGED", "UNCONFIRMED"),
			"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		],
		[stoppedHistory(f, null), "LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED"],
	] as const) {
		expect(() =>
			buildLocalStoryFlowPlanArtifact({ ...optionsFor(f), history }),
		).toThrow(code);
	}
	expect(calls.legacy).not.toHaveBeenCalled();
});
it("rejects another original identity/start/policy and a same-T different full source", () => {
	const f = planFixture();
	for (const change of ["TIME", "TASK", "POLICY"] as const) {
		const parameters = structuredClone(f.fixture.f.snapshots.task.parameters);
		const policies = { ...f.facts.taskPin.policies };
		if (change === "POLICY") {
			policies.deliveryPolicyHash = H("DIFFERENT_DELIVERY");
			(
				parameters as { identity: { generationPolicyFingerprint: string } }
			).identity.generationPolicyFingerprint =
				localStoryFlowGenerationPolicyFingerprint(policies);
		}
		const identity = prepareLocalStoryFlowRuntimeIdentity({
			taskId: change === "TASK" ? randomUUID() : f.facts.taskId,
			organizationId: f.facts.organizationId,
			taskParameters: parameters,
			startedAtMs: f.facts.startedAtMs + (change === "TIME" ? 1 : 0),
			sourceTuple: f.tuple,
			policies,
		});
		expect(() =>
			buildLocalStoryFlowPlanArtifact({ ...optionsFor(f), identity }),
		).toThrow(LocalStoryFlowPlanArtifactError);
	}
	f.fixture.f.media.storage = { changed: "SYNTHETIC_STORAGE" };
	const t = transcriptFixture(f.fixture.f);
	const archive = buildLocalStoryFlowSourceArchive({
		transcript: t.handle,
		ledgers: f.fixture.ledgers.pairs,
	});
	expect(
		localStoryFlowSourceArchiveEvidence(archive).payload.sourceTuple,
	).toEqual(f.tuple);
	expect(() =>
		buildLocalStoryFlowPlanArtifact({ ...optionsFor(f), archive }),
	).toThrow(LocalStoryFlowPlanArtifactError);
});
it("rejects unknown/getter/extra/holes without exposing raw errors and returns detached full evidence", () => {
	const f = planFixture(),
		options = optionsFor(f);
	let getters = 0;
	const hostile = Object.defineProperty({ ...options }, "history", {
		enumerable: true,
		get() {
			getters++;
			throw Error("PRIVATE");
		},
	});
	expect(() => buildLocalStoryFlowPlanArtifact(hostile)).toThrow(
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	);
	const sparse = new Array(f.steps.length);
	expect(() =>
		buildLocalStoryFlowPlanArtifact({ ...options, steps: sparse }),
	).toThrow(LocalStoryFlowPlanArtifactError);
	expect(() =>
		buildLocalStoryFlowPlanArtifact({ ...options, extra: true } as never),
	).toThrow(LocalStoryFlowPlanArtifactError);
	expect(() => localStoryFlowPlanArtifactEvidence({})).toThrow(
		LocalStoryFlowPlanArtifactError,
	);
	expect(getters).toBe(0);
	const handle = buildLocalStoryFlowPlanArtifact(options),
		before = localStoryFlowPlanArtifactEvidence(handle);
	const originalJson = canonicalEditingJson(before);
	const copy = localStoryFlowPlanArtifactEvidence(handle);
	copy.payload.originalSelectedEventIds.length = 0;
	copy.payload.originalBlueprint.message = "PRIVATE_MUTATION";
	copy.ref.proofHash = H("PRIVATE_MUTATION");
	expect(canonicalEditingJson(localStoryFlowPlanArtifactEvidence(handle))).toBe(
		originalJson,
	);
	expect(() => localStoryFlowPlanArtifactEvidence({ ...handle })).toThrow(
		LocalStoryFlowPlanArtifactError,
	);
});

it("does not promote another task's owned stop code before original identity binding", () => {
	const expected = planFixture(),
		other = planFixture();
	const history = stoppedHistory(other, "SOURCE_CHANGED", "UNCONFIRMED");
	let error: unknown;
	try {
		buildLocalStoryFlowPlanArtifact({ ...optionsFor(expected), history });
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
});
it.each([
	"nvidia",
	"amd",
] as const)("keeps all multi-page context bindings in layout order for %s", (profile) => {
	const f = planFixture(64, profile);
	const value = localStoryFlowPlanArtifactEvidence(
		buildLocalStoryFlowPlanArtifact(optionsFor(f)),
	);
	const context = localStoryFlowAcceptedContextEvidence(f.context);
	expect(context.nodes.length).toBeGreaterThan(1);
	expect(value.payload.orderedContextBindings.map((b) => b.nodeId)).toEqual(
		context.nodes.map((n) => n.payload.nodeId),
	);
	expect(value.payload.baseModel.profile).toBe(profile);
	expect(value.payload.orderedPrefixRefs).toHaveLength(f.steps.length);
});
