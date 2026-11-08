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
	buildLocalStoryFlowAcceptedContext,
	localStoryFlowAcceptedContextNodePublication,
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
	type BoundLocalStoryFlowNativeExpectation,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	localStoryFlowNativeExpectationEvidence,
	localStoryFlowNativeRootEvidence,
	nativeRequestForOrigin,
} from "./local-story-flow-native";
import {
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	localStoryFlowRouteStepEvidence,
} from "./local-story-flow-route";
import {
	type AcceptedLocalStoryFlowRouteStep,
	acceptLocalStoryFlowRouteWork,
	localStoryFlowAcceptedRouteCoreStep,
	localStoryFlowAcceptedRouteNativeRoot,
	localStoryFlowAcceptedRoutePublication,
	localStoryFlowRouteWorkExpectation,
	nextLocalStoryFlowRouteWork,
} from "./local-story-flow-route-artifacts";
import {
	buildLocalStoryFlowScope,
	LOCAL_STORY_FLOW_SCOPE_POLICY,
	localStoryFlowPlanEvidence,
	selectLocalStoryFlowPlan,
} from "./local-story-flow-scope";
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
describe("owned native route creator", () => {
	it.each([
		"nvidia",
		"amd",
	] as const)("creates ROOT through FINALIZE and a selectable C3 plan on %s", (profile) => {
		const f = routeFixture(4, profile);
		const phases: string[] = [];
		while (f.next().status === "NEXT") {
			const a = f.append(),
				p = localStoryFlowAcceptedRoutePublication(a.step);
			phases.push(p.step.payload.stepEvidence.phase);
			expect(p.native).toBe(a.native);
			expect(p.expectation).toBe(a.expected);
			expect(p.archive).toBe(f.archive);
			expect(p.context).toBe(f.c.context);
			expect(p.step.payload.stepEvidence.rawOutput).toEqual(a.raw);
			expect(p.cache.payload.observationRef).toEqual(p.observation.ref);
			expect(p.step.payload.observationRef).toEqual(p.observation.ref);
			expect(p.step.ref).toEqual(
				flowRef(p.step.sourceTuple, p.step.kind, p.step.key, p.step.payload),
			);
		}
		expect(phases).toEqual(["ROOT", "LEAF", "FINALIZE"]);
		expect(f.next()).toEqual({ status: "COMPLETE", terminal: f.steps.at(-1) });
		const root = localStoryFlowAcceptedRouteNativeRoot(first(f.steps));
		expect(localStoryFlowNativeRootEvidence(root).rootObservationRef).toEqual(
			localStoryFlowAcceptedRoutePublication(first(f.steps)).observation.ref,
		);
		for (const step of f.steps)
			expect(localStoryFlowAcceptedRouteNativeRoot(step)).toBe(root);
		const scope = buildLocalStoryFlowScope({
			source: localStoryFlowSourceArchiveContext(f.archive),
			tree: localStoryFlowAcceptedContextTree(f.c.context),
			steps: f.steps.map(localStoryFlowAcceptedRouteCoreStep),
		});
		const plan = localStoryFlowPlanEvidence(
			selectLocalStoryFlowPlan({ scope }),
		);
		expect(plan.targetFrames).toBe(f.f.input.parameters.targetDurationFrames);
		expect(plan.selection.localStorySelection.selectedEventIds).toEqual([
			"l0_e0",
		]);
	});
	it("schedules required branches from complete multi-page context before exposing the mandatory leaf", () => {
		const f = routeFixture(64);
		expect(f.c.source.layout.nodes.length).toBeGreaterThan(1);
		const phases: string[] = [];
		while (f.next().status === "NEXT") {
			const { step } = f.append();
			phases.push(
				localStoryFlowAcceptedRoutePublication(step).step.payload.stepEvidence
					.phase,
			);
		}
		expect(phases[0]).toBe("ROOT");
		expect(phases).toContain("BRANCH");
		expect(phases).toContain("LEAF");
		expect(phases.at(-1)).toBe("FINALIZE");
		expect(phases.length).toBeLessThanOrEqual(64);
	});
	it("resolves mandatory witness choices using the original native ROOT proof", () => {
		const f = routeFixture(64, "nvidia", true);
		const phases: string[] = [];
		while (f.next().status === "NEXT") {
			const { step } = f.append();
			phases.push(
				localStoryFlowAcceptedRoutePublication(step).step.payload.stepEvidence
					.phase,
			);
			if (f.steps.length > 64)
				throw Error("Authored traversal failed to complete");
		}
		expect(phases.slice(0, 2)).toEqual(["ROOT", "WITNESS"]);
		expect(phases.at(-1)).toBe("FINALIZE");
		const root = localStoryFlowAcceptedRouteNativeRoot(first(f.steps));
		for (const step of f.steps)
			expect(localStoryFlowAcceptedRouteNativeRoot(step)).toBe(root);
	});
	it("preserves owned references while all public save bodies are detached", () => {
		const f = routeFixture();
		const { step, work, native, expected } = f.append();
		const before = localStoryFlowAcceptedRoutePublication(step),
			changed = localStoryFlowAcceptedRoutePublication(step);
		changed.step.payload.stepEvidence.rawOutput.nodeId = "AUTHORED_MUTATION";
		changed.cache.payload.observationHash = "0".repeat(64);
		const result = changed.observation.payload.terminalJob.result;
		if (!result) throw Error("Missing authored result");
		result.content = "mutated";
		expect(localStoryFlowAcceptedRoutePublication(step)).toEqual(before);
		expect(before.work).toBe(work);
		expect(before.native).toBe(native);
		expect(before.expectation).toBe(expected);
	});
	it("rejects unrelated or copied archive, context and work handles", () => {
		const f = routeFixture(),
			other = routeFixture();
		const n = f.next();
		if (n.status !== "NEXT") throw Error("Missing next");
		for (const options of [
			{ archive: other.archive, context: f.c.context, steps: [] },
			{ archive: f.archive, context: other.c.context, steps: [] },
			{ archive: { ...f.archive }, context: f.c.context, steps: [] },
		]) {
			expect(() => nextLocalStoryFlowRouteWork(options)).toThrow(
				"LOCAL_STORY_ARTIFACT_UNVERIFIED",
			);
		}
		expect(() => localStoryFlowRouteWorkExpectation({ ...n.work })).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
		expect(() => localStoryFlowAcceptedRoutePublication({})).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
	});
	it("never invokes top-level getters and rejects array additions and sparse histories", () => {
		const f = routeFixture();
		let getters = 0;
		expect(() =>
			nextLocalStoryFlowRouteWork({
				get archive() {
					getters++;
					return f.archive;
				},
				context: f.c.context,
				steps: [],
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		const sparse = new Array<AcceptedLocalStoryFlowRouteStep>(1);
		expect(() =>
			nextLocalStoryFlowRouteWork({
				archive: f.archive,
				context: f.c.context,
				steps: sparse,
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		const extra: AcceptedLocalStoryFlowRouteStep[] = [];
		Object.defineProperty(extra, "hidden", { value: "extra" });
		expect(() =>
			nextLocalStoryFlowRouteWork({
				archive: f.archive,
				context: f.c.context,
				steps: extra,
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		expect(getters).toBe(0);
	});
	it("rejects foreign history, skipped ROOT, reordered and duplicated steps", () => {
		const f = routeFixture();
		f.append();
		f.append();
		const a = routeFixture();
		a.append();
		for (const steps of [
			[first(a.steps)],
			[first(f.steps.slice(1))],
			[first(f.steps), first(f.steps)],
			[first(f.steps.slice(1)), first(f.steps)],
		]) {
			expect(() =>
				nextLocalStoryFlowRouteWork({
					archive: f.archive,
					context: f.c.context,
					steps,
				}),
			).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		}
	});
	it("rejects substituting an equal-looking ROOT handle under an already accepted child", () => {
		const f = routeFixture(),
			root = f.append(),
			leaf = f.append();
		const fork = acceptLocalStoryFlowRouteWork({
			work: root.work,
			native: root.native,
		});
		expect(
			localStoryFlowRouteStepEvidence(
				localStoryFlowAcceptedRouteCoreStep(fork),
			),
		).toEqual(
			localStoryFlowRouteStepEvidence(
				localStoryFlowAcceptedRouteCoreStep(root.step),
			),
		);
		expect(() =>
			nextLocalStoryFlowRouteWork({
				archive: f.archive,
				context: f.c.context,
				steps: [fork, leaf.step],
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("admits a separately prepared equal native key, then requires the actual accepted chain", () => {
		const f = routeFixture();
		const firstNext = f.next(),
			secondNext = f.next();
		if (firstNext.status !== "NEXT" || secondNext.status !== "NEXT")
			throw Error("No next");
		expect(firstNext.work).not.toBe(secondNext.work);
		const native = capture(
			localStoryFlowRouteWorkExpectation(firstNext.work),
			f.archive,
			routeOutput(firstNext.work),
			f.c.nodes.length + 1,
		);
		const step = acceptLocalStoryFlowRouteWork({
			work: secondNext.work,
			native,
		});
		expect(localStoryFlowAcceptedRoutePublication(step).native).toBe(native);
		expect(
			nextLocalStoryFlowRouteWork({
				archive: f.archive,
				context: f.c.context,
				steps: [step],
			}).status,
		).toBe("NEXT");
	});
	it("rejects a native from a different duration even when all source metadata is identical", () => {
		const f = routeFixture();
		const n = f.next();
		if (n.status !== "NEXT") throw Error("No next");
		f.f.input.parameters.targetDurationFrames = 180;
		f.f.refresh();
		const sibling = buildLocalStoryFlowSourceArchive({
			transcript: transcriptFixture(f.f).handle,
			ledgers: f.ledgers.pairs,
		});
		expect(() =>
			nextLocalStoryFlowRouteWork({
				archive: sibling,
				context: f.c.context,
				steps: [],
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		const c = acceptedContext(sibling, f.c.natives),
			other = nextLocalStoryFlowRouteWork({
				archive: sibling,
				context: c.context,
				steps: [],
			});
		if (other.status !== "NEXT") throw Error("No next");
		const native = capture(
			localStoryFlowRouteWorkExpectation(other.work),
			sibling,
			routeOutput(other.work),
			f.c.nodes.length + 1,
		);
		expect(() =>
			acceptLocalStoryFlowRouteWork({ work: n.work, native }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		const otherRoot = acceptLocalStoryFlowRouteWork({
			work: other.work,
			native,
		});
		f.append();
		const currentLeaf = f.next(),
			otherLeaf = nextLocalStoryFlowRouteWork({
				archive: sibling,
				context: c.context,
				steps: [otherRoot],
			});
		if (currentLeaf.status !== "NEXT" || otherLeaf.status !== "NEXT")
			throw Error("Missing authored leaf work");
		const foreign = capture(
			localStoryFlowRouteWorkExpectation(otherLeaf.work),
			sibling,
			routeOutput(otherLeaf.work),
			f.c.nodes.length + 2,
		);
		expect(routeOutput(currentLeaf.work)).toEqual(routeOutput(otherLeaf.work));
		expect(() =>
			acceptLocalStoryFlowRouteWork({
				work: currentLeaf.work,
				native: foreign,
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("rejects the old context wrapper when non-key probe facts changed under the same source tuple", () => {
		const f = routeFixture();
		Object.assign(f.f.media.probe, { authoredExtraFact: "changed" });
		const sibling = buildLocalStoryFlowSourceArchive({
			transcript: transcriptFixture(f.f).handle,
			ledgers: f.ledgers.pairs,
		});
		expect(
			localStoryFlowSourceArchiveEvidence(sibling).payload.sourceTuple,
		).toEqual(
			localStoryFlowSourceArchiveEvidence(f.archive).payload.sourceTuple,
		);
		expect(() =>
			nextLocalStoryFlowRouteWork({
				archive: sibling,
				context: f.c.context,
				steps: [],
			}),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("rejects native output that was resealed with an extra field instead of dropping it", () => {
		const f = routeFixture();
		const n = f.next();
		if (n.status !== "NEXT") throw Error("No next");
		const raw = { ...routeOutput(n.work), unexpected: "must not be discarded" };
		const native = capture(
			localStoryFlowRouteWorkExpectation(n.work),
			f.archive,
			raw,
			f.c.nodes.length + 1,
		);
		expect(() =>
			acceptLocalStoryFlowRouteWork({ work: n.work, native }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it("rejects phase replacement in a fully admitted native observation", () => {
		const f = routeFixture();
		const n = f.next();
		if (n.status !== "NEXT") throw Error("No next");
		const native = capture(
			localStoryFlowRouteWorkExpectation(n.work),
			f.archive,
			{ ...routeOutput(n.work), phase: "FINALIZE" },
			f.c.nodes.length + 1,
		);
		expect(() =>
			acceptLocalStoryFlowRouteWork({ work: n.work, native }),
		).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
});
