import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
	type BoundLocalStoryFlowContextWork,
	buildLocalStoryFlowAcceptedContext,
	hydrateLocalStoryFlowContextArtifacts,
	type LocalStoryFlowArtifactProposal,
	LocalStoryFlowArtifactReadError,
	type LocalStoryFlowContextHydrationSnapshot,
	localStoryFlowAcceptedContextEvidence,
	localStoryFlowAcceptedContextNodePublication,
	localStoryFlowAcceptedContextPublication,
	localStoryFlowAcceptedContextTree,
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
	admittedFlowNativeEvidence,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	type LocalStoryFlowNativeObservation,
	localStoryFlowNativeExpectationEvidence,
	nativeRequestForOrigin,
} from "./local-story-flow-native";
import { LOCAL_STORY_FLOW_ROUTE_POLICY } from "./local-story-flow-route";
import {
	localStoryFlowRuntimeIdentityEvidence,
	localStoryFlowRuntimeKey,
	localStoryFlowRuntimeStartRecord,
	prepareLocalStoryFlowRuntimeIdentity,
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
	work: BoundLocalStoryFlowContextWork,
	archive: BoundLocalStoryFlowSourceArchive,
	output: unknown,
	slot: number,
	refs?: {
		startRef: LocalStoryFlowRecordRef;
		attemptRef: LocalStoryFlowRecordRef;
	},
) {
	const expected = localStoryFlowContextWorkExpectation(work),
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
		const native =
			cached?.get(plan.nodeId) ??
			capture(
				work,
				archive,
				outputFor(archive, plan.nodeId, children),
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
function assertOuterProposal<P extends object>(
	p: LocalStoryFlowArtifactProposal<P>,
) {
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: p.ref.cacheHash,
		valueJson: canonicalEditingJson(p.payload),
	};
	const sealed = readLocalStoryFlowSealedRecord({
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
	expect(localStoryFlowSealedRecordEvidence(sealed).payload).toEqual(p.payload);
}
describe("context artifacts bind full source and actual owned native output", () => {
	it.each([
		"SAME",
		"DELIVERY_ONLY",
		"ENGINE_CHANGED",
	] as const)("checks direct foreign-task nodes and children against current relevant policies: %s", (change) => {
		const a = archiveFixture(),
			built = acceptedContext(a.archive);
		a.f.snapshots.task.id = randomUUID();
		a.f.input.requestKey = randomUUID();
		if (change === "DELIVERY_ONLY")
			a.f.policies.deliveryPolicyHash = H("SYNTHETIC_DIFFERENT_DELIVERY_RULE");
		if (change === "ENGINE_CHANGED")
			a.f.policies.engineValidationPolicyHash = H(
				"SYNTHETIC_DIFFERENT_ENGINE_RULE",
			);
		a.f.identity.generationPolicyFingerprint =
			localStoryFlowGenerationPolicyFingerprint(a.f.policies);
		a.f.refresh();
		const t = transcriptFixture(a.f);
		const archiveB = buildLocalStoryFlowSourceArchive({
			transcript: t.handle,
			ledgers: a.ledgers.pairs,
		});
		const merge = built.source.layout.nodes.find((p) => p.phase === "MERGE");
		if (merge?.phase !== "MERGE") throw Error("Synthetic merge needed");
		const children = merge.children.map((id) =>
			first(
				built.nodes.filter(
					(n) =>
						localStoryFlowAcceptedContextNodePublication(n).node.payload
							.nodeId === id,
				),
			),
		);
		const directTree = () =>
			buildLocalStoryFlowAcceptedContext({
				archive: archiveB,
				nodes: built.nodes,
			});
		const parentWork = () =>
			prepareLocalStoryFlowContextWork({
				archive: archiveB,
				nodeId: merge.nodeId,
				children,
			});
		if (change === "ENGINE_CHANGED") {
			expect(directTree).toThrow(LocalStoryFlowArtifactReadError);
			expect(parentWork).toThrow(LocalStoryFlowArtifactReadError);
		} else {
			const contextB = directTree();
			expect(
				localStoryFlowAcceptedContextEvidence(contextB).tree.payload.treeHash,
			).toBe(
				localStoryFlowAcceptedContextEvidence(built.context).tree.payload
					.treeHash,
			);
			expect(localStoryFlowContextWorkExpectation(parentWork())).toBeDefined();
		}
	});
	it.each([
		"nvidia",
		"amd",
	] as const)("keeps every leaf/child and native wire result for %s", (profile) => {
		const f = archiveFixture(64, profile),
			built = acceptedContext(f.archive),
			e = localStoryFlowAcceptedContextEvidence(built.context);
		expect(built.source.layout.nodes.length).toBeGreaterThan(1);
		expect(e.nodes).toHaveLength(built.source.layout.nodes.length);
		expect(e.tree.payload.treeEvidence.coverage.accountedItems).toBe(
			built.source.manifest.items.length,
		);
		expect(e.tree.payload.treeEvidence.coverage.complete).toBe(true);
		expect(e.tree.payload.orderedNodeRefs).toEqual(
			e.nodes.map((node) => node.ref),
		);
		expect(e.tree.key.keyBody.orderedNodeHashes).toEqual(
			e.nodes.map((node) => node.payload.nodeHash),
		);
		expect(e.tree.key.keyBody.sourceArchiveRef).toEqual(e.sourceArchive.ref);
		expect(e.requiredLegacyRefs).toEqual(
			localStoryFlowSourceArchiveEvidence(f.archive).requiredLegacyRefs,
		);
		for (const node of built.nodes) {
			const p = localStoryFlowAcceptedContextNodePublication(node);
			expect(p.expectation).toBe(localStoryFlowContextWorkExpectation(p.work));
			expect(p.native).toBe(built.natives.get(String(p.node.payload.nodeId)));
			const result = p.observation.payload.terminalJob.result;
			if (!result) throw Error("Synthetic accepted native result required");
			expect(result.content).toBe(
				admittedFlowNativeEvidence(p.native).terminalJob.result?.content,
			);
			expect(p.cache.payload.observationRef).toEqual(p.observation.ref);
			expect(p.node.key.keyBody.observationHash).toBe(
				p.observation.payload.observationHash,
			);
			assertOuterProposal(p.observation);
			assertOuterProposal(p.node);
			assertOuterProposal(p.cache);
		}
		assertOuterProposal(e.sourceArchive);
		assertOuterProposal(e.tree);
		expect(localStoryFlowAcceptedContextTree(built.context)).toBe(
			localStoryFlowAcceptedContextTree(built.context),
		);
	});
	it("reuses the same semantic native observations while separating task A/B archive and tree wrappers", () => {
		const a = archiveFixture(),
			builtA = acceptedContext(a.archive);
		const originalTask = a.f.snapshots.task.id;
		a.f.snapshots.task.id = randomUUID();
		a.f.input.requestKey = randomUUID();
		a.f.input.parameters.targetDurationFrames = 60;
		a.f.refresh();
		const tB = transcriptFixture(a.f),
			archiveB = buildLocalStoryFlowSourceArchive({
				transcript: tB.handle,
				ledgers: a.ledgers.pairs,
			});
		const builtB = acceptedContext(archiveB, builtA.natives),
			ea = localStoryFlowAcceptedContextEvidence(builtA.context),
			eb = localStoryFlowAcceptedContextEvidence(builtB.context);
		expect(eb.sourceArchive.ref).not.toEqual(ea.sourceArchive.ref);
		expect(eb.tree.ref).not.toEqual(ea.tree.ref);
		expect(eb.tree.payload.treeHash).toBe(ea.tree.payload.treeHash);
		expect(eb.nodes.map((node) => node.ref)).toEqual(
			ea.nodes.map((node) => node.ref),
		);
		for (const node of builtB.nodes) {
			const p = localStoryFlowAcceptedContextNodePublication(node);
			expect(p.observation.payload.origin.originTaskId).toBe(originalTask);
			expect(p.native).toBe(builtA.natives.get(String(p.node.payload.nodeId)));
		}
	});
	it("rejects missing, reordered and foreign-source nodes instead of accepting a selected subtree", () => {
		const a = archiveFixture(),
			b = acceptedContext(a.archive);
		expect(() =>
			buildLocalStoryFlowAcceptedContext({
				archive: a.archive,
				nodes: b.nodes.slice(1),
			}),
		).toThrow(LocalStoryFlowArtifactReadError);
		expect(() =>
			buildLocalStoryFlowAcceptedContext({
				archive: a.archive,
				nodes: [...b.nodes].reverse(),
			}),
		).toThrow(LocalStoryFlowArtifactReadError);
		const other = archiveFixture(),
			wrong = acceptedContext(other.archive);
		expect(() =>
			buildLocalStoryFlowAcceptedContext({
				archive: a.archive,
				nodes: wrong.nodes,
			}),
		).toThrow(LocalStoryFlowArtifactReadError);
		const merge = b.source.layout.nodes.find((p) => p.phase === "MERGE");
		if (merge?.phase !== "MERGE") throw Error("Synthetic merge needed");
		const children = merge.children.map((id) =>
			first(
				b.nodes.filter(
					(n) =>
						localStoryFlowAcceptedContextNodePublication(n).node.payload
							.nodeId === id,
				),
			),
		);
		expect(() =>
			prepareLocalStoryFlowContextWork({
				archive: a.archive,
				nodeId: merge.nodeId,
				children: children.slice(1),
			}),
		).toThrow(LocalStoryFlowArtifactReadError);
		expect(() =>
			prepareLocalStoryFlowContextWork({
				archive: a.archive,
				nodeId: merge.nodeId,
				children: [...children].reverse(),
			}),
		).toThrow(LocalStoryFlowArtifactReadError);
	});
	it("rejects a genuine admission for another input rather than using its stored output as expected", () => {
		const a = archiveFixture(),
			b = archiveFixture(),
			workA = prepareLocalStoryFlowContextWork({
				archive: a.archive,
				nodeId: "n0",
				children: [],
			});
		const workB = prepareLocalStoryFlowContextWork({
			archive: b.archive,
			nodeId: "n0",
			children: [],
		});
		const nativeB = capture(
			workB,
			b.archive,
			outputFor(b.archive, "n0", []),
			1,
		);
		expect(() =>
			acceptLocalStoryFlowContextWork({ work: workA, native: nativeB }),
		).toThrow(LocalStoryFlowArtifactReadError);
	});
	it("rejects native SUCCEEDED with missing coverage or an own __proto__ dropped by a schema", () => {
		const f = archiveFixture(),
			work = prepareLocalStoryFlowContextWork({
				archive: f.archive,
				nodeId: "n0",
				children: [],
			});
		const raw = outputFor(f.archive, "n0", []);
		if (raw.phase !== "LEAF") throw Error("Synthetic leaf needed");
		const missing = { ...raw, accountedItems: raw.accountedItems.slice(1) };
		const native = capture(work, f.archive, missing, 1);
		expect(() => acceptLocalStoryFlowContextWork({ work, native })).toThrow(
			LocalStoryFlowArtifactReadError,
		);
		const dropped = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
		Object.defineProperty(dropped, "__proto__", { value: 7, enumerable: true });
		expect(() =>
			acceptLocalStoryFlowContextWork({
				work,
				native: capture(work, f.archive, dropped, 1),
			}),
		).toThrow(LocalStoryFlowArtifactReadError);
	});
	it("returns detached proposal bodies without detaching the owned native/expectation handles", () => {
		const f = archiveFixture(),
			b = acceptedContext(f.archive),
			node = first(
				b.nodes.filter(
					(value) =>
						localStoryFlowAcceptedContextNodePublication(value).children
							.length > 0,
				),
			),
			before = localStoryFlowAcceptedContextNodePublication(node);
		const copy = localStoryFlowAcceptedContextNodePublication(node);
		expect(copy.children.length).toBeGreaterThan(0);
		copy.node.payload.nodeEvidence.nodeHash = "0".repeat(64);
		const result = copy.observation.payload.terminalJob.result;
		if (!result) throw Error("Synthetic accepted native result required");
		result.content = "PRIVATE_MUTATION";
		copy.children.length = 0;
		const after = localStoryFlowAcceptedContextNodePublication(node);
		expect(after.node).toEqual(before.node);
		expect(after.observation).toEqual(before.observation);
		expect(after.children).toEqual(before.children);
		expect(after.native).toBe(before.native);
		expect(after.expectation).toBe(before.expectation);
		const contextCopy = localStoryFlowAcceptedContextEvidence(b.context);
		contextCopy.tree.payload.orderedNodeRefs.reverse();
		expect(localStoryFlowAcceptedContextEvidence(b.context).tree).not.toEqual(
			contextCopy.tree,
		);
	});
	it("rejects unknown handles, extra options and hostile getters with a fresh fixed error", () => {
		const f = archiveFixture();
		let getters = 0;
		const hostile = Object.defineProperty(
			{ archive: f.archive, children: [] },
			"nodeId",
			{
				enumerable: true,
				get() {
					getters++;
					throw Error("PRIVATE");
				},
			},
		);
		expect(() => prepareLocalStoryFlowContextWork(hostile as never)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
		expect(getters).toBe(0);
		expect(() => localStoryFlowContextWorkExpectation({})).toThrow(
			LocalStoryFlowArtifactReadError,
		);
		expect(() => localStoryFlowAcceptedContextNodePublication({})).toThrow(
			LocalStoryFlowArtifactReadError,
		);
		expect(() => localStoryFlowAcceptedContextEvidence({})).toThrow(
			LocalStoryFlowArtifactReadError,
		);
		expect(() => localStoryFlowAcceptedContextTree({})).toThrow(
			LocalStoryFlowArtifactReadError,
		);
		expect(() =>
			prepareLocalStoryFlowContextWork({
				archive: f.archive,
				nodeId: "n0",
				children: [],
				trusted: true,
			} as never),
		).toThrow(LocalStoryFlowArtifactReadError);
		expect(() =>
			buildLocalStoryFlowAcceptedContext({ archive: f.archive, nodes: [{}] }),
		).toThrow(LocalStoryFlowArtifactReadError);
	});
});

describe("context publication keeps every originally accepted node", () => {
	it.each([
		"nvidia",
		"amd",
	] as const)("retains owned node/native handles in full layout order on %s", (profile) => {
		const f = archiveFixture(64, profile);
		const built = acceptedContext(f.archive);
		const before = localStoryFlowAcceptedContextEvidence(built.context);
		const publication = localStoryFlowAcceptedContextPublication(built.context);
		expect(Object.keys(publication).sort()).toEqual(["nodes", "tree"]);
		expect(publication.nodes.length).toBeGreaterThan(1);
		expect(publication.nodes).not.toBe(built.nodes);
		expect(publication.nodes).toHaveLength(built.source.layout.nodes.length);
		for (const [index, node] of publication.nodes.entries()) {
			expect(node).toBe(built.nodes[index]);
			const own = localStoryFlowAcceptedContextNodePublication(node);
			expect(own.native).toBe(
				built.natives.get(String(own.node.payload.nodeId)),
			);
			expect(own.node.ref).toEqual(before.nodes[index]?.ref);
		}
		expect(publication.tree).toEqual(before.tree);
		assertOuterProposal(publication.tree);
	});
	it("protects the stored node list and TREE while preserving actual node identity", () => {
		const f = archiveFixture();
		const built = acceptedContext(f.archive);
		const handles = [...built.nodes];
		const before = localStoryFlowAcceptedContextEvidence(built.context);
		const copy = localStoryFlowAcceptedContextPublication(built.context);
		copy.nodes.length = 0;
		copy.tree.payload.orderedNodeRefs.reverse();
		copy.tree.payload.treeHash = "0".repeat(64);
		built.nodes.length = 0;
		const after = localStoryFlowAcceptedContextPublication(built.context);
		expect(after.nodes).toHaveLength(handles.length);
		for (const [index, node] of after.nodes.entries())
			expect(node).toBe(handles[index]);
		expect(after.tree).toEqual(before.tree);
	});
	it("keeps the task-specific TREE and original native origins when nodes are reused", () => {
		const a = archiveFixture();
		const builtA = acceptedContext(a.archive);
		const taskA = a.f.snapshots.task.id;
		a.f.snapshots.task.id = randomUUID();
		a.f.input.requestKey = randomUUID();
		a.f.refresh();
		const tB = transcriptFixture(a.f);
		const archiveB = buildLocalStoryFlowSourceArchive({
			transcript: tB.handle,
			ledgers: a.ledgers.pairs,
		});
		const builtB = acceptedContext(archiveB, builtA.natives);
		const pubA = localStoryFlowAcceptedContextPublication(builtA.context);
		const pubB = localStoryFlowAcceptedContextPublication(builtB.context);
		expect(pubB.tree.ref).not.toEqual(pubA.tree.ref);
		for (const [index, node] of pubB.nodes.entries()) {
			expect(node).toBe(builtB.nodes[index]);
			const own = localStoryFlowAcceptedContextNodePublication(node);
			expect(own.observation.payload.origin.originTaskId).toBe(taskA);
			expect(own.native).toBe(
				builtA.natives.get(String(own.node.payload.nodeId)),
			);
		}
	});
	it("allows a separately owned archive with the same full bytes", () => {
		const f = archiveFixture();
		const built = acceptedContext(f.archive);
		const duplicate = buildLocalStoryFlowSourceArchive({
			transcript: f.t.handle,
			ledgers: f.ledgers.pairs,
		});
		expect(duplicate).not.toBe(f.archive);
		const context = buildLocalStoryFlowAcceptedContext({
			archive: duplicate,
			nodes: built.nodes,
		});
		const pub = localStoryFlowAcceptedContextPublication(context);
		expect(pub.tree).toEqual(
			localStoryFlowAcceptedContextPublication(built.context).tree,
		);
		for (const [index, node] of pub.nodes.entries())
			expect(node).toBe(built.nodes[index]);
	});
	it("does not register publication DTOs or read hostile unknown handles", () => {
		const f = archiveFixture();
		const built = acceptedContext(f.archive);
		const publication = localStoryFlowAcceptedContextPublication(built.context);
		let getters = 0;
		const hostile = Object.defineProperty({}, "nodes", {
			get() {
				getters++;
				throw Error("PRIVATE_GETTER");
			},
		});
		for (const input of [{}, { ...built.context }, publication, hostile]) {
			expect(() => localStoryFlowAcceptedContextPublication(input)).toThrow(
				LocalStoryFlowArtifactReadError,
			);
			expect(() => localStoryFlowAcceptedContextPublication(input)).toThrow(
				"LOCAL_STORY_ARTIFACT_UNVERIFIED",
			);
		}
		expect(getters).toBe(0);
	});
});

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
function terminalContextFixture() {
	const f = archiveFixture();
	const a = localStoryFlowSourceArchiveEvidence(f.archive),
		sourceTuple = a.payload.sourceTuple as LocalStoryFlowSourceTuple;
	const identityInput = {
		taskId: f.f.snapshots.task.id,
		organizationId: f.f.media.organizationId,
		taskParameters: f.f.snapshots.task.parameters,
		startedAtMs: 1_000_000,
		sourceTuple,
		policies: f.f.policies,
	};
	const identity = prepareLocalStoryFlowRuntimeIdentity(identityInput),
		facts = localStoryFlowRuntimeIdentityEvidence(identity);
	const startRecord = localStoryFlowRuntimeStartRecord(
		identity,
		H("SYNTHETIC_ORIGINAL_CONNECTION"),
	);
	const start = storedFlow(
		sourceTuple,
		startRecord.kind,
		startRecord.key,
		startRecord.payload,
	);
	const startRef = localStoryFlowSealedRecordEvidence(start).ref;
	const source = localStoryFlowContextSourceEvidence(
		localStoryFlowSourceArchiveContext(f.archive),
	);
	const nodes: AcceptedLocalStoryFlowContextNode[] = [],
		byId = new Map<string, AcceptedLocalStoryFlowContextNode>();
	const originals: LocalStoryFlowContextHydrationSnapshot["origins"][number][] =
		[];
	const observations: BoundLocalStoryFlowSealedRecord[] = [],
		caches: BoundLocalStoryFlowSealedRecord[] = [];
	for (const [index, plan] of source.layout.nodes.entries()) {
		const slot = index + 1;
		const children =
			plan.phase === "LEAF"
				? []
				: plan.children.map((id) => {
						const child = byId.get(id);
						if (!child) throw Error("Synthetic child needed");
						return child;
					});
		const work = prepareLocalStoryFlowContextWork({
			archive: f.archive,
			nodeId: plan.nodeId,
			children,
		});
		const expectation = localStoryFlowContextWorkExpectation(work),
			e = localStoryFlowNativeExpectationEvidence(expectation);
		const request = nativeRequestForOrigin(expectation, {
			organizationId: facts.organizationId,
			originTaskId: facts.taskId,
		});
		const body = {
			version: "local-story-flow-runtime-attempt-v1",
			purpose: "ATTEMPT",
			taskId: facts.taskId,
			startRef,
			slot,
			category: "CONTEXT",
			nativeKeyHash: e.nativeKeyHash,
			requestKey: request.body.requestKey,
			jobId: request.jobId,
			requestHash: request.requestHash,
			coreInputHash: e.nativeKey.coreInputHash,
			promptHash: e.promptHash,
			expectedTailPrefixRef: null,
			reservedAtMs: facts.startedAtMs + slot,
			nativeKey: e.nativeKey,
			requestBody: request.body,
		};
		const attempt = storedFlow(
			sourceTuple,
			"LOCAL_FLOW_PLAN_V1",
			localStoryFlowRuntimeKey(identity, { purpose: "ATTEMPT", slot }),
			{ ...body, attemptHash: H(body) },
		);
		const attemptRef = localStoryFlowSealedRecordEvidence(attempt).ref;
		const native = capture(
			work,
			f.archive,
			outputFor(f.archive, plan.nodeId, children),
			slot,
			{ startRef, attemptRef },
		);
		const node = acceptLocalStoryFlowContextWork({ work, native }),
			publication = localStoryFlowAcceptedContextNodePublication(node);
		const observation = storedProposal(publication.observation);
		const outcome = storedFlow(
			sourceTuple,
			"LOCAL_FLOW_PLAN_V1",
			localStoryFlowRuntimeKey(identity, { purpose: "OUTCOME", slot }),
			{
				version: "local-story-flow-runtime-outcome-v1",
				purpose: "OUTCOME",
				taskId: facts.taskId,
				startRef,
				attemptRef,
				slot,
				completedAtMs: facts.startedAtMs + 1000 + slot,
				status: "ACCEPTED",
				observationRef: publication.observation.ref,
				acceptedArtifactRef: publication.node.ref,
				acceptedArtifactHash: publication.node.payload.nodeHash,
			},
		);
		nodes.push(node);
		byId.set(plan.nodeId, node);
		observations.push(observation);
		caches.push(storedProposal(publication.cache));
		originals.push({ identity, start, attempt, outcome });
	}
	const context = buildLocalStoryFlowAcceptedContext({
		archive: f.archive,
		nodes,
	});
	const e = localStoryFlowAcceptedContextEvidence(context);
	const snapshot: LocalStoryFlowContextHydrationSnapshot = {
		sourceArchive: storedProposal(e.sourceArchive),
		tree: storedProposal(e.tree),
		nodes: e.nodes.map(storedProposal),
		nativeCaches: caches,
		observations,
		origins: originals,
	};
	return { ...f, context, nodes, snapshot, identityInput };
}
describe("terminal context reconstructs full native origin before accepting stored nodes", () => {
	it("hydrates every original full native result and full tree without a current connection or writer", () => {
		const f = terminalContextFixture();
		const hydrated = hydrateLocalStoryFlowContextArtifacts({
			archive: f.archive,
			snapshot: f.snapshot,
		});
		expect(localStoryFlowAcceptedContextEvidence(hydrated)).toEqual(
			localStoryFlowAcceptedContextEvidence(f.context),
		);
	});
	it("reuses original-task observations for a new task with another target while keeping its own archive/tree", () => {
		const f = terminalContextFixture();
		f.f.snapshots.task.id = randomUUID();
		f.f.input.requestKey = randomUUID();
		f.f.input.parameters.targetDurationFrames = 60;
		f.f.refresh();
		const t = transcriptFixture(f.f),
			archive = buildLocalStoryFlowSourceArchive({
				transcript: t.handle,
				ledgers: f.ledgers.pairs,
			});
		const contextB = buildLocalStoryFlowAcceptedContext({
				archive,
				nodes: f.nodes,
			}),
			eB = localStoryFlowAcceptedContextEvidence(contextB);
		const snapshot = {
			...f.snapshot,
			sourceArchive: storedProposal(eB.sourceArchive),
			tree: storedProposal(eB.tree),
		};
		const read = localStoryFlowAcceptedContextEvidence(
			hydrateLocalStoryFlowContextArtifacts({ archive, snapshot }),
		);
		expect(read.tree.ref).toEqual(eB.tree.ref);
		expect(read.tree.ref).not.toEqual(
			localStoryFlowAcceptedContextEvidence(f.context).tree.ref,
		);
		expect(read.nodes).toEqual(
			localStoryFlowAcceptedContextEvidence(f.context).nodes,
		);
	});
	it("rejects a self-resealed accepted outcome naming another node even with a genuine native result", () => {
		const f = terminalContextFixture(),
			original = first(f.snapshot.origins),
			row = localStoryFlowSealedRecordEvidence(original.outcome);
		const outcome = storedFlow(row.sourceTuple, row.kind, row.key, {
			...row.payload,
			acceptedArtifactHash: H("SYNTHETIC_WRONG_NODE"),
		});
		const snapshot = {
			...f.snapshot,
			origins: [{ ...original, outcome }, ...f.snapshot.origins.slice(1)],
		};
		expect(() =>
			hydrateLocalStoryFlowContextArtifacts({ archive: f.archive, snapshot }),
		).toThrow(LocalStoryFlowArtifactReadError);
	});
	it("rejects an independently different original start time and fake origin handles", () => {
		const f = terminalContextFixture(),
			firstOrigin = first(f.snapshot.origins);
		const identity = prepareLocalStoryFlowRuntimeIdentity({
			...f.identityInput,
			startedAtMs: f.identityInput.startedAtMs + 1,
		});
		for (const wrongIdentity of [identity, {}]) {
			const snapshot = {
				...f.snapshot,
				origins: [
					{ ...firstOrigin, identity: wrongIdentity },
					...f.snapshot.origins.slice(1),
				],
			};
			expect(() =>
				hydrateLocalStoryFlowContextArtifacts({ archive: f.archive, snapshot }),
			).toThrow(LocalStoryFlowArtifactReadError);
		}
	});
	it("rejects omissions, duplicate lookups, reversed nodes and foreign tree wrappers", () => {
		const f = terminalContextFixture();
		const variants = [
			{ ...f.snapshot, nodes: f.snapshot.nodes.slice(1) },
			{ ...f.snapshot, nodes: [...f.snapshot.nodes].reverse() },
			{
				...f.snapshot,
				nativeCaches: [
					first(f.snapshot.nativeCaches),
					...f.snapshot.nativeCaches,
				],
			},
			{ ...f.snapshot, observations: f.snapshot.observations.slice(1) },
			{ ...f.snapshot, origins: f.snapshot.origins.slice(1) },
			{ ...f.snapshot, tree: f.snapshot.sourceArchive },
		];
		for (const snapshot of variants)
			expect(() =>
				hydrateLocalStoryFlowContextArtifacts({ archive: f.archive, snapshot }),
			).toThrow(LocalStoryFlowArtifactReadError);
	});
	it("rejects hostile snapshot getters before reading them", () => {
		const f = terminalContextFixture();
		let reads = 0;
		const snapshot = Object.defineProperty({ ...f.snapshot }, "observations", {
			enumerable: true,
			get() {
				reads++;
				throw Error("PRIVATE");
			},
		});
		expect(() =>
			hydrateLocalStoryFlowContextArtifacts({ archive: f.archive, snapshot }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		expect(reads).toBe(0);
	});
});

function resealedObservationSnapshot(
	snapshot: LocalStoryFlowContextHydrationSnapshot,
	edit: (observation: LocalStoryFlowNativeObservation) => void,
): LocalStoryFlowContextHydrationSnapshot {
	const original = localStoryFlowSealedRecordEvidence(
		first(snapshot.observations),
	);
	const native = structuredClone(
		original.payload,
	) as unknown as LocalStoryFlowNativeObservation;
	edit(native);
	const body: Record<string, unknown> = { ...native };
	delete body.observationHash;
	const payload = { ...body, observationHash: H(body) };
	const observation = storedFlow(
		original.sourceTuple,
		original.kind,
		original.key,
		payload,
	);
	const obs = localStoryFlowSealedRecordEvidence(observation);
	const originalNode = localStoryFlowSealedRecordEvidence(
		first(snapshot.nodes),
	);
	const node = storedFlow(
		originalNode.sourceTuple,
		originalNode.kind,
		{
			...originalNode.key,
			keyBody: {
				...originalNode.key.keyBody,
				observationHash: payload.observationHash,
			},
		},
		{ ...originalNode.payload, observationRef: obs.ref },
	);
	const newNode = localStoryFlowSealedRecordEvidence(node);
	const originalCache = localStoryFlowSealedRecordEvidence(
		first(snapshot.nativeCaches),
	);
	const cache = storedFlow(
		originalCache.sourceTuple,
		originalCache.kind,
		originalCache.key,
		{
			...originalCache.payload,
			observationRef: obs.ref,
			observationHash: payload.observationHash,
		},
	);
	const originalOrigin = first(snapshot.origins);
	const originalOutcome = localStoryFlowSealedRecordEvidence(
		originalOrigin.outcome,
	);
	const outcome = storedFlow(
		originalOutcome.sourceTuple,
		originalOutcome.kind,
		originalOutcome.key,
		{
			...originalOutcome.payload,
			observationRef: obs.ref,
			acceptedArtifactRef: newNode.ref,
		},
	);
	const originalTree = localStoryFlowSealedRecordEvidence(snapshot.tree);
	const orderedNodeRefs = [
		newNode.ref,
		...(
			originalTree.payload.orderedNodeRefs as LocalStoryFlowRecordRef[]
		).slice(1),
	];
	const tree = storedFlow(
		originalTree.sourceTuple,
		originalTree.kind,
		{
			...originalTree.key,
			keyBody: { ...originalTree.key.keyBody, orderedNodeRefs },
		},
		{ ...originalTree.payload, orderedNodeRefs },
	);
	return {
		...snapshot,
		tree,
		nodes: [node, ...snapshot.nodes.slice(1)],
		observations: [observation, ...snapshot.observations.slice(1)],
		nativeCaches: [cache, ...snapshot.nativeCaches.slice(1)],
		origins: [{ ...originalOrigin, outcome }, ...snapshot.origins.slice(1)],
	};
}
describe("terminal context never trusts stored node output instead of native wire evidence", () => {
	it.each([
		"CLEANUP",
		"STATS",
		"JSON",
		"MEMBERSHIP",
	] as const)("rejects consistently resealed storage whose original native evidence fails %s", (mode) => {
		const f = terminalContextFixture();
		const snapshot = resealedObservationSnapshot(f.snapshot, (observation) => {
			const result = observation.terminalJob.result;
			if (!result) throw Error("Synthetic native result required");
			if (mode === "CLEANUP") observation.terminalJob.cleanupConfirmed = false;
			if (mode === "STATS") result.receipt.apiStats.evalCount = -1;
			if (mode === "JSON") result.content = "{not-native-json";
			if (mode === "MEMBERSHIP") {
				const output = JSON.parse(
					result.content,
				) as LocalStoryFlowContextOutput;
				if (output.phase !== "LEAF")
					throw Error("Synthetic first leaf required");
				output.accountedItems.pop();
				result.content = JSON.stringify(output);
			}
		});
		expect(() =>
			hydrateLocalStoryFlowContextArtifacts({ archive: f.archive, snapshot }),
		).toThrow(LocalStoryFlowArtifactReadError);
	});
});
