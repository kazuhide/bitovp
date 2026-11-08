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
import { LOCAL_STORY_FLOW_CLOSURE_POLICY } from "./local-story-flow-closure";
import {
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	localStoryFlowContextSourceEvidence,
} from "./local-story-flow-context";
import { LOCAL_STORY_FLOW_H1_POLICY } from "./local-story-flow-contracts";
import { parseLegacyWhisperTranscript } from "./local-story-flow-legacy-asr";
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
import {
	createLocalStoryLegacyTranscriptRecipe,
	type LocalStoryLegacyTranscriptStoredValue,
} from "./local-story-flow-legacy-transcript";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import {
	contextNativeExpectation,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	localStoryFlowNativeExpectationEvidence,
} from "./local-story-flow-native";
import { LOCAL_STORY_FLOW_ROUTE_POLICY } from "./local-story-flow-route";
import { LOCAL_STORY_FLOW_SCOPE_POLICY } from "./local-story-flow-scope";
import {
	admitLocalStoryFlowArchiveTranscript,
	buildLocalStoryFlowSourceArchive,
	type LocalStoryFlowArchiveLedgerPair,
	type LocalStoryFlowArchiveSourceSnapshots,
	type LocalStoryFlowLegacyRecordPair,
	LocalStoryFlowSourceArchiveError,
	localStoryFlowArchiveLedgerRequests,
	localStoryFlowArchiveLedgerStageRequest,
	localStoryFlowArchivePreparationEvidence,
	localStoryFlowArchiveTranscriptEvidence,
	localStoryFlowSourceArchiveContext,
	localStoryFlowSourceArchiveEvidence,
	prepareLocalStoryFlowArchiveSource,
	validateLocalStoryFlowSourceArchive,
} from "./local-story-flow-source-archive";
import { localStoryFlowIdentityForModelPin } from "./local-story-flow-stages";
import {
	buildLocalStoryChunks,
	buildLocalStoryInput,
	mergeLocalStoryLedgers,
} from "./local-story-input";
import {
	buildPreparedShotPartition,
	verifyPreparedNormalizationReceipt,
} from "./prepared-shot-partition";
import { hashEditingEvidence as H } from "./verify-automatic-binding";

// Synthetic snapshots only. Future policy hashes below are explicit unit contracts,
// not compiled delivery readiness, provider evidence or a native execution result.
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
function normalization(f: Fixture) {
	const durationUs = f.map.sourceEndUs,
		count = f.map.editingEndFrame;
	const source = {
		width: 640,
		height: 360,
		codec: "h264" as const,
		fps: { num: 24, den: 1 },
		timeBase: { num: 1, den: 12288 },
		frameCount: (durationUs / 1_000_000) * 24,
		durationUs,
		videoPtsHash: "b".repeat(64),
		colorProfile: "BT709_8BIT_LIMITED" as const,
		audio: null,
	};
	const sourceFrameIndex = Array.from({ length: count }, (_, i) =>
		Math.floor((i * 24) / 30),
	);
	const proof = {
		schemaVersion: 1,
		profile: "SDR_CFR30_INDEXED_V1",
		mode: "NORMALIZE",
		originalSha256: "c".repeat(64),
		preparedSha256: f.media.sha256,
		originalBytes: 100,
		preparedBytes: 120,
		source,
		output: {
			width: 640,
			height: 360,
			frameCount: count,
			durationUs,
			fps: { num: 30, den: 1 },
			hasAudio: false,
		},
		sourceStartUs: 0,
		sourceEndUs: durationUs,
		sourceFrameIndex,
		indexMapHash: H(sourceFrameIndex),
		recipeHash: H({
			profile: "SDR_CFR30_INDEXED_V1",
			mode: "NORMALIZE",
			source,
			videoFilter:
				"fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=" +
				count +
				",setpts=N/(30*TB),setsar=1/1",
			audioFilter: null,
		}),
		organizationId: f.media.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		timeMapId: f.map.id,
	};
	const refresh = () => {
		const proofHash = H(proof);
		f.snapshots.normalizationSnapshot = { proof, proofHash };
		Reflect.set(f.identity, "preparedShotClock", {
			version: "aisa-prepared-clock-v3",
			normalizationReceiptHash: proofHash,
		});
		f.refresh();
	};
	refresh();
	return { proof, refresh };
}
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
function storedTranscript(
	f: Fixture,
	zero = false,
): LocalStoryLegacyTranscriptStoredValue {
	const observed = parseLegacyWhisperTranscript(
		{
			result: { language: "en" },
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: zero ? [] : [{ offsets: { from: 100, to: 500 } }],
			},
			transcription: zero
				? []
				: [
						{
							text: "Hello.",
							offsets: { from: 100, to: 500 },
							no_speech_probability: 0.1,
							tokens: [
								{ text: "Hello", p: 0.9, offsets: { from: 100, to: 450 } },
								{ text: ".", p: 0.9, offsets: { from: 450, to: 500 } },
							],
						},
					],
		},
		f.map.sourceEndUs - f.map.sourceStartUs,
		f.map.sourceStartUs,
		{ requireQuality: true },
	);
	return {
		version: "local-story-transcript-v3",
		retryPolicyVersion: "strict-invalid-30s-10s-v1",
		engineVersion: "1.9.5",
		mediaSha256: f.media.sha256,
		modelSha256: f.identity.modelSha256,
		timeMapHash: H(f.map),
		language: "en",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		segments: observed.segments,
		rawSegments: observed.rawSegments ?? [],
		speechIntervals: observed.speechIntervals ?? [],
		warnings: observed.warnings,
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		mediaWindows: [
			{
				fromUs: 0,
				toUs: f.map.sourceEndUs - f.map.sourceStartUs,
				language: "en",
			},
		],
	};
}
function transcriptFixture(
	f: Fixture,
	options: { zero?: boolean; sealVersion?: 1 | 2 } = {},
) {
	const prep = f.prep();
	const recipe = createLocalStoryLegacyTranscriptRecipe({
		mediaSha256: f.media.sha256,
		timeMap: f.map,
		configuredModel: { sha256: f.identity.modelSha256 },
		language: "en",
	});
	const value = storedTranscript(f, options.zero);
	const pair = f.media.probe.streams.some((s) => s.codec_type === "audio")
		? sealed(f, recipe.kind, recipe.key, value, options.sealVersion)
		: null;
	const prepared = pair
		? recipe.ready({
				value: recipe.parse(value),
				valueHash: H(value),
				cached: false,
			})
		: recipe.absent({ status: "NO_AUDIO", warning: "SOURCE_HAS_NO_AUDIO" }, []);
	const handle = admitLocalStoryFlowArchiveTranscript(prep, pair);
	const n = f.snapshots.normalizationSnapshot;
	const preparedPartition = n
		? buildPreparedShotPartition({
				analysis: f.analysis.document,
				timeMap: f.map,
				normalization: verifyPreparedNormalizationReceipt({
					...n,
					organizationId: f.media.organizationId,
					sourceId: f.media.sourceId,
					mediaVersionId: f.media.id,
					preparedSha256: f.media.sha256,
					timeMap: f.map,
					width: f.media.width,
					height: f.media.height,
				}),
			})
		: undefined;
	const input = buildLocalStoryInput({
		analysis: f.analysis.document,
		timeMap: f.map,
		preparedPartition,
		segments: prepared.segments,
	});
	const chunks = buildLocalStoryChunks(input);
	expect(localStoryFlowArchiveTranscriptEvidence(handle).fullInput).toEqual(
		input,
	);
	expect(localStoryFlowArchiveTranscriptEvidence(handle).chunks).toEqual(
		chunks,
	);
	return { prep, recipe, value, pair, prepared, handle, input, chunks };
}
type TranscriptFixture = ReturnType<typeof transcriptFixture>;
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
function decoded(
	pair: LocalStoryFlowLegacyRecordPair,
): Record<string, unknown> {
	const proof = pair.row.proof as Record<string, unknown>;
	return (
		proof.version === "local-story-cache-v2"
			? JSON.parse(String(proof.valueJson))
			: structuredClone(proof.value)
	) as Record<string, unknown>;
}
function reseal(pair: LocalStoryFlowLegacyRecordPair, value: unknown) {
	const proof = pair.row.proof as Record<string, unknown>;
	pair.row.proof = JSON.parse(
		JSON.stringify(
			proof.version === "local-story-cache-v2"
				? { ...proof, valueJson: canonicalEditingJson(value) }
				: { ...proof, value },
		),
	);
	pair.row.proofHash = H(pair.row.proof);
	pair.ref.proofHash = pair.row.proofHash;
}

describe("independent source archive preparation", () => {
	it("accepts only stored model/workflow/policy pins, with no current runtime configuration", () => {
		const f = fixture(),
			prep = f.prep(),
			evidence = localStoryFlowArchivePreparationEvidence(prep);
		expect(evidence.sourceTuple).toMatchObject({
			organizationId: f.media.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
			mediaSha256: f.media.sha256,
			timeMapHash: H(f.map),
			bindingHash: H(f.binding),
		});
		expect(evidence.hasAudio).toBe(false);
		expect(evidence.transcript.kind).toBe("LOCAL_STORY_TRANSCRIPT_V1");
		expect(evidence.taskPinHash).toBe(H(evidence.taskPin));
		expect(evidence.taskPayloadHash).toBe(H(f.snapshots.task.parameters));
	});
	it.each([
		null,
		{},
		{ streams: null },
		{ streams: [] },
		{ streams: [{}] },
	])("rejects unknown/incomplete probe %j instead of manufacturing NO_AUDIO", (probe) => {
		const f = fixture();
		f.snapshots.mediaSnapshot.probe = probe;
		expect(() => f.prep()).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it("keeps a real probe's NO_AUDIO admission and excludes cached from semantic history", () => {
		const f = fixture(),
			prep = f.prep(),
			transcript = admitLocalStoryFlowArchiveTranscript(prep, null),
			evidence = localStoryFlowArchiveTranscriptEvidence(transcript);
		expect(evidence.transcriptAdmission).toMatchObject({
			status: "NO_AUDIO",
			warning: "SOURCE_HAS_NO_AUDIO",
			transcript: { status: "NO_AUDIO", segments: [], modelSha256: null },
		});
		expect(evidence.transcriptAdmission.transcript).not.toHaveProperty(
			"cached",
		);
		expect(evidence.chunks.length).toBeGreaterThan(1);
		expect(
			localStoryFlowArchiveLedgerRequests(transcript, 0).map((r) => r.version),
		).toEqual(["V4", "V3", "V2", "V1"]);
	});
});

describe("source archive with complete original transcript and ledger seals", () => {
	it.each([
		"V4",
		"V3",
		"V2",
		"V1",
	] as const)("retains all %s pointers and original receipt bodies through H0/H1b", (version) => {
		const f = fixture(),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t, version);
		const archive = buildLocalStoryFlowSourceArchive({
			transcript: t.handle,
			ledgers: ledgers.pairs,
		});
		const e = localStoryFlowSourceArchiveEvidence(archive);
		const source = localStoryFlowContextSourceEvidence(
			localStoryFlowSourceArchiveContext(archive),
		);
		const corpus = mergeLocalStoryLedgers({
			input: t.input,
			chunks: t.chunks,
			ledgers: ledgers.values,
		});
		expect(e.payload.fullCorpus).toEqual(corpus);
		expect(e.payload.fullInput).toEqual(t.input);
		expect(e.payload.chunks).toEqual(t.chunks);
		const admissions = e.payload.orderedLedgerAdmissions as Array<
			Record<string, unknown>
		>;
		expect(admissions).toHaveLength(t.chunks.length);
		expect(admissions.map((a) => a.chunkIndex)).toEqual(
			t.chunks.map((_, i) => i),
		);
		const h0 = {
			input: t.input,
			chunks: t.chunks,
			ledgers: ledgers.values,
			model: f.model,
			transcriptFingerprint: t.prepared.fingerprint,
			ledgerRefs: ledgers.ledgerRefs,
		};
		const manifest = buildLocalStoryFlowManifest(h0);
		expect(e.payload.manifest).toEqual(manifest);
		expect(e.payload.pages).toEqual(buildLocalStoryFlowLeafPages(manifest));
		expect(source.input).toEqual(t.input);
		expect(source.manifest.corpus).toEqual(corpus);
		expect(source.manifest.ledgerRefs).toEqual(h0.ledgerRefs);
		expect(e.requiredLegacyRefs).toHaveLength(2 * t.chunks.length);
		expect(
			localStoryFlowSourceArchiveEvidence(
				validateLocalStoryFlowSourceArchive(e.payload, {
					transcript: t.handle,
					ledgers: ledgers.pairs,
				}),
			),
		).toEqual(e);
	});
	it.each([
		false,
		true,
	])("admits complete READY speech-zero=%s without inventing historical cache metrics", (zero) => {
		const f = fixture({ audio: true }),
			t = transcriptFixture(f, { zero }),
			ledgers = ledgerFixtures(f, t);
		const archive = buildLocalStoryFlowSourceArchive({
			transcript: t.handle,
			ledgers: ledgers.pairs,
		});
		const e = localStoryFlowSourceArchiveEvidence(archive),
			admission = e.payload.transcriptAdmission as Record<string, unknown>;
		expect(admission).toMatchObject({
			status: "READY",
			transcript: {
				status: "READY",
				segments: t.value.segments,
				fingerprint: H(t.value),
				modelSha256: f.identity.modelSha256,
			},
		});
		expect(admission.transcript).not.toHaveProperty("cached");
		expect(e.requiredLegacyRefs).toEqual([
			t.pair?.ref,
			...ledgers.pairs.flatMap((p) => [p.pointer.ref, p.stage.ref]),
		]);
	});
	it.each([
		"V3",
		"V4",
	] as const)("keeps %s's original structured repair prompt, stage input and request key", (version) => {
		const f = fixture(),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t, version, 2, true);
		const e = localStoryFlowSourceArchiveEvidence(
			buildLocalStoryFlowSourceArchive({
				transcript: t.handle,
				ledgers: ledgers.pairs,
			}),
		);
		const admissions = e.payload.orderedLedgerAdmissions as Array<
			Record<string, unknown>
		>;
		for (const [i, pair] of ledgers.pairs.entries()) {
			expect(admissions[i]?.acceptedPrompt).toBe(decoded(pair.pointer).prompt);
			expect(admissions[i]?.stageBody).toEqual(decoded(pair.stage));
			expect(admissions[i]?.stageBody).toHaveProperty(
				"requestKey",
				decoded(pair.stage).requestKey,
			);
			expect(admissions[i]?.acceptedPrompt).toContain("QUOTE_REPAIR:");
		}
	});
	it("recovers only a v1 derived mean when the entire original transcript proof hash matches", () => {
		const f = fixture({ audio: true }),
			prep = f.prep(),
			recipe = createLocalStoryLegacyTranscriptRecipe({
				mediaSha256: f.media.sha256,
				timeMap: f.map,
				configuredModel: { sha256: f.identity.modelSha256 },
				language: "en",
			}),
			value = storedTranscript(f),
			pair = sealed(f, recipe.kind, recipe.key, value, 1);
		const proof = pair.row.proof as {
			value: LocalStoryLegacyTranscriptStoredValue;
		};
		first(proof.value.rawSegments).quality.meanTokenLogProbability =
			-0.10536051565783;
		const retained = structuredClone(pair);
		const admitted = admitLocalStoryFlowArchiveTranscript(prep, pair),
			evidence = localStoryFlowArchiveTranscriptEvidence(admitted);
		expect(evidence.transcriptFingerprint).toBe(H(value));
		expect(pair).toEqual(retained);
		const corrupted = structuredClone(pair);
		const changed = corrupted.row.proof as {
			value: LocalStoryLegacyTranscriptStoredValue;
		};
		first(first(changed.value.rawSegments).tokens ?? []).p = 0.8;
		expect(() =>
			admitLocalStoryFlowArchiveTranscript(prep, corrupted),
		).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it("keeps all old v1 ledger full bodies and never invents native origin/wire fields", () => {
		const f = fixture(),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t, "V1", 1),
			original = structuredClone(ledgers.pairs),
			e = localStoryFlowSourceArchiveEvidence(
				buildLocalStoryFlowSourceArchive({
					transcript: t.handle,
					ledgers: ledgers.pairs,
				}),
			);
		const admissions = e.payload.orderedLedgerAdmissions as Array<
			Record<string, unknown>
		>;
		for (const a of admissions) {
			expect(a.stageBody).not.toHaveProperty("originTaskId");
			expect(a.stageBody).not.toHaveProperty("terminalJob");
			expect(a.stageBody).not.toHaveProperty("rawOutput");
			expect(a.validationPolicyVersion).toBe(
				"exact-source-ledger-validation-v4",
			);
			expect(a.pointerBody).toMatchObject({
				validationPolicyVersion: "exact-source-ledger-validation-v1",
			});
		}
		expect(ledgers.pairs).toEqual(original);
	});
	it("separates two task wrappers while retaining original stages and identical context native keys", () => {
		const f = fixture(),
			a = transcriptFixture(f),
			ledgers = ledgerFixtures(f, a);
		const archiveA = buildLocalStoryFlowSourceArchive({
			transcript: a.handle,
			ledgers: ledgers.pairs,
		});
		const snapshotsB = structuredClone(f.snapshots),
			inputB = structuredClone(f.input);
		inputB.requestKey = randomUUID();
		inputB.parameters.targetDurationFrames = 120;
		snapshotsB.task.id = randomUUID();
		snapshotsB.task.requestKey = inputB.requestKey;
		snapshotsB.task.parameters = {
			schemaVersion: 1,
			input: inputB,
			identity: f.identity,
		};
		snapshotsB.task.requestHash = mediaTaskIntentHash(
			inputB,
			snapshotsB.task.parentTaskId,
		);
		snapshotsB.task.cacheKey = mediaTaskCacheKey(inputB, f.identity);
		const prepB = prepareLocalStoryFlowArchiveSource(snapshotsB, f.policies),
			b = admitLocalStoryFlowArchiveTranscript(prepB, null),
			archiveB = buildLocalStoryFlowSourceArchive({
				transcript: b,
				ledgers: ledgers.pairs,
			}),
			ea = localStoryFlowSourceArchiveEvidence(archiveA),
			eb = localStoryFlowSourceArchiveEvidence(archiveB);
		expect(ea.key).not.toEqual(eb.key);
		expect(ea.payload.taskId).toBe(f.snapshots.task.id);
		expect(eb.payload.taskId).toBe(snapshotsB.task.id);
		expect(ea.payload.taskPayloadHash).not.toBe(eb.payload.taskPayloadHash);
		expect(ea.payload.fullCorpus).toEqual(eb.payload.fullCorpus);
		expect(ea.payload.manifest).toEqual(eb.payload.manifest);
		const sourceA = localStoryFlowSourceArchiveContext(archiveA),
			sourceB = localStoryFlowSourceArchiveContext(archiveB);
		expect(localStoryFlowContextSourceEvidence(sourceA)).toEqual(
			localStoryFlowContextSourceEvidence(sourceB),
		);
		const key = (source: typeof sourceA) =>
			localStoryFlowNativeExpectationEvidence(
				contextNativeExpectation({
					source,
					nodeId: "n0",
					children: [],
					pin: { modelPin: f.modelPin, policies: f.policies },
				}),
			).nativeKeyHash;
		expect(key(sourceA)).toBe(key(sourceB));
		expect(
			localStoryFlowSourceArchiveEvidence(
				validateLocalStoryFlowSourceArchive(eb.payload, {
					transcript: b,
					ledgers: ledgers.pairs,
				}),
			),
		).toEqual(eb);
		expect(ea.requiredLegacyRefs).toEqual(eb.requiredLegacyRefs);
	});
});

describe("source archive full sealed transcript boundaries", () => {
	it("refuses audible source without its sealed READY transcript and refuses fake NO_AUDIO records", () => {
		const f = fixture({ audio: true }),
			prep = f.prep();
		expect(() => admitLocalStoryFlowArchiveTranscript(prep, null)).toThrowError(
			LocalStoryFlowSourceArchiveError,
		);
		const silent = fixture(),
			silentPrep = silent.prep(),
			t = transcriptFixture(f);
		expect(() =>
			admitLocalStoryFlowArchiveTranscript(silentPrep, t.pair),
		).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it.each([
		"windows",
		"word",
		"mean",
		"model",
		"quality",
		"cached",
		"public",
	] as const)("rejects a fully resealed transcript with %s corruption instead of trusting its outer hash", (change) => {
		const f = fixture({ audio: true }),
			prep = f.prep(),
			value = storedTranscript(f);
		const recipe = createLocalStoryLegacyTranscriptRecipe({
			mediaSha256: f.media.sha256,
			timeMap: f.map,
			configuredModel: { sha256: f.identity.modelSha256 },
			language: "en",
		});
		let body: unknown = value;
		if (change === "windows")
			value.mediaWindows = [
				{ fromUs: 0, toUs: 1_000_000, language: "en" },
				{ fromUs: 1_000_001, toUs: f.map.sourceEndUs, language: "en" },
			];
		if (change === "word") first(first(value.segments).words ?? []).startUs++;
		if (change === "mean")
			first(value.rawSegments).quality.meanTokenLogProbability = 0;
		if (change === "model") value.modelSha256 = "f".repeat(64);
		if (change === "quality") value.qualityPolicyFingerprint = "f".repeat(64);
		if (change === "cached") body = { ...value, cached: true };
		if (change === "public")
			body = recipe.ready({ value, valueHash: H(value), cached: false });
		const pair = sealed(f, recipe.kind, recipe.key, body);
		expect(() => admitLocalStoryFlowArchiveTranscript(prep, pair)).toThrowError(
			LocalStoryFlowSourceArchiveError,
		);
	});
	it("rejects a transcript ref or complete proof mismatch and never reads nested accessors", () => {
		const f = fixture({ audio: true }),
			t = transcriptFixture(f);
		if (!t.pair) throw new Error("Missing synthetic ASR row");
		for (const field of [
			"receiptId",
			"proofHash",
			"cacheHash",
			"inputKeyHash",
		] as const) {
			const pair = structuredClone(t.pair);
			pair.ref[field] = field === "receiptId" ? randomUUID() : "f".repeat(64);
			expect(() =>
				admitLocalStoryFlowArchiveTranscript(t.prep, pair),
			).toThrowError(LocalStoryFlowSourceArchiveError);
		}
		const pair = structuredClone(t.pair);
		let reads = 0;
		Object.defineProperty(pair.row.proof, "valueJson", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_TRANSCRIPT_GETTER");
			},
		});
		expect(() =>
			admitLocalStoryFlowArchiveTranscript(t.prep, pair),
		).toThrowError(LocalStoryFlowSourceArchiveError);
		expect(reads).toBe(0);
	});
});

describe("source archive normalization and prepared clock", () => {
	it("retains the exact normalization receipt and original-frame partition through every full-source chunk", () => {
		const f = fixture(),
			n = normalization(f),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t),
			archive = buildLocalStoryFlowSourceArchive({
				transcript: t.handle,
				ledgers: ledgers.pairs,
			}),
			evidence = localStoryFlowSourceArchiveEvidence(archive),
			p = localStoryFlowArchivePreparationEvidence(t.prep);
		expect(p.sourceTuple).toMatchObject({
			normalizationReceiptHash: H(n.proof),
			preparedShotClockHash: H({
				version: "aisa-prepared-clock-v3",
				normalizationReceiptHash: H(n.proof),
			}),
		});
		expect(evidence.payload.normalizationSnapshot).toEqual({
			proof: n.proof,
			proofHash: H(n.proof),
		});
		expect(evidence.payload.fullInput).toEqual(t.input);
		expect(evidence.payload.chunks).toEqual(t.chunks);
		expect(evidence.payload.fullCorpus).toEqual(
			mergeLocalStoryLedgers({
				input: t.input,
				chunks: t.chunks,
				ledgers: ledgers.values,
			}),
		);
		expect(
			localStoryFlowSourceArchiveEvidence(
				validateLocalStoryFlowSourceArchive(evidence.payload, {
					transcript: t.handle,
					ledgers: ledgers.pairs,
				}),
			),
		).toEqual(evidence);
	});
	it.each([
		"outerHash",
		"preparedSha",
		"source",
		"map",
		"index",
		"recipe",
		"clockHash",
		"missingClock",
	] as const)("rejects %s normalized source substitution even when its task envelope is refreshed", (change) => {
		const f = fixture(),
			n = normalization(f);
		if (change === "preparedSha") n.proof.preparedSha256 = "f".repeat(64);
		if (change === "source") n.proof.sourceId = randomUUID();
		if (change === "map") n.proof.timeMapId = randomUUID();
		if (change === "index") {
			n.proof.sourceFrameIndex[0] = 1;
			n.proof.indexMapHash = H(n.proof.sourceFrameIndex);
		}
		if (change === "recipe") n.proof.recipeHash = "f".repeat(64);
		n.refresh();
		if (change === "outerHash" && f.snapshots.normalizationSnapshot)
			f.snapshots.normalizationSnapshot.proofHash = "f".repeat(64);
		if (change === "clockHash")
			Reflect.set(f.identity, "preparedShotClock", {
				version: "aisa-prepared-clock-v3",
				normalizationReceiptHash: "f".repeat(64),
			});
		if (change === "missingClock")
			Reflect.deleteProperty(f.identity, "preparedShotClock");
		f.refresh();
		expect(() => f.prep()).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it("does not read a normalization proof getter or classify unsupported streams as NO_AUDIO", () => {
		const f = fixture(),
			n = normalization(f);
		let reads = 0;
		Object.defineProperty(n.proof, "sourceFrameIndex", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_NORMALIZATION_GETTER");
			},
		});
		expect(() => f.prep()).toThrowError(LocalStoryFlowSourceArchiveError);
		expect(reads).toBe(0);
		for (const streams of [
			[{ codec_type: "audio" }],
			[{ codec_type: "video" }, { codec_type: "unknown" }],
			Array.from({ length: 65 }, () => ({ codec_type: "video" })),
		]) {
			const g = fixture();
			g.snapshots.mediaSnapshot.probe = { streams };
			expect(() => g.prep()).toThrowError(LocalStoryFlowSourceArchiveError);
		}
	});
});

describe("source archive full pointer/stage boundaries", () => {
	it.each([
		"transcript",
		"pointer",
		"stage",
	] as const)("rejects an own __proto__ key in the original %s proof without losing it during schema parsing", (kind) => {
		const f = fixture({ audio: true }),
			t = transcriptFixture(f);
		if (!t.pair) throw new Error("Missing synthetic ASR row");
		const ledgers = ledgerFixtures(f, t),
			pairs = structuredClone(ledgers.pairs);
		const pair =
			kind === "transcript" ? structuredClone(t.pair) : first(pairs)[kind];
		const originalRef = structuredClone(pair.ref),
			originalRowHash = pair.row.proofHash;
		Object.defineProperty(pair.row.proof, "__proto__", {
			value: { x: 1 },
			enumerable: true,
			configurable: true,
			writable: true,
		});
		expect(pair.ref).toEqual(originalRef);
		expect(pair.row.proofHash).toBe(originalRowHash);
		expect(H(pair.row.proof)).not.toBe(originalRowHash);
		if (kind === "transcript")
			expect(() =>
				admitLocalStoryFlowArchiveTranscript(t.prep, pair),
			).toThrowError(LocalStoryFlowSourceArchiveError);
		else {
			if (kind === "pointer")
				expect(() =>
					localStoryFlowArchiveLedgerStageRequest(t.handle, 0, pair),
				).toThrowError(LocalStoryFlowSourceArchiveError);
			expect(() =>
				buildLocalStoryFlowSourceArchive({
					transcript: t.handle,
					ledgers: pairs,
				}),
			).toThrowError(LocalStoryFlowSourceArchiveError);
		}
	});
	it.each([
		"missing",
		"reversed",
		"hole",
		"pointerPrompt",
		"receipt",
		"quote",
		"requestKey",
		"pointerRef",
		"stageRef",
		"rowTenant",
		"fullSeal",
		"stageExtra",
	] as const)("rejects %s ledger corruption without dropping a chunk or inventing another key", (change) => {
		const f = fixture(),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t),
			pairs = structuredClone(ledgers.pairs),
			pair = first(pairs);
		if (change === "missing") pairs.pop();
		if (change === "reversed") pairs.reverse();
		if (change === "hole") delete pairs[0];
		if (change === "pointerPrompt") {
			const value = decoded(pair.pointer);
			value.prompt = `${String(value.prompt)} `;
			reseal(pair.pointer, value);
		}
		if (
			change === "receipt" ||
			change === "quote" ||
			change === "requestKey" ||
			change === "stageExtra"
		) {
			const value = decoded(pair.stage);
			if (change === "receipt")
				Reflect.set(value.receipt as object, "inputHash", "f".repeat(64));
			if (change === "quote")
				first(first((value.output as LocalStoryLedger).events).quotes).quote =
					"Invented quote outside every source field.";
			if (change === "requestKey") value.requestKey = randomUUID();
			if (change === "stageExtra") value.extra = true;
			reseal(pair.stage, value);
		}
		if (change === "pointerRef") pair.pointer.ref.inputKeyHash = "f".repeat(64);
		if (change === "stageRef") pair.stage.ref.cacheHash = "f".repeat(64);
		if (change === "rowTenant") pair.stage.row.organizationId = randomUUID();
		if (change === "fullSeal") pair.stage.row.proofHash = "f".repeat(64);
		expect(() =>
			buildLocalStoryFlowSourceArchive({
				transcript: t.handle,
				ledgers: pairs,
			}),
		).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it("admits the entire original pointer before returning a stage key and keeps lookup bounds fixed", () => {
		const f = fixture(),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t);
		const pair = structuredClone(first(ledgers.pairs).pointer);
		pair.ref.proofHash = "f".repeat(64);
		expect(() =>
			localStoryFlowArchiveLedgerStageRequest(t.handle, 0, pair),
		).toThrowError(LocalStoryFlowSourceArchiveError);
		const altered = structuredClone(first(ledgers.pairs).pointer);
		Reflect.set(altered.ref, "kind", "LOCAL_FLOW_CONTEXT_V1");
		expect(() =>
			localStoryFlowArchiveLedgerStageRequest(t.handle, 0, altered),
		).toThrowError(LocalStoryFlowSourceArchiveError);
		for (const index of [-1, 0.5, NaN, t.chunks.length, 1_000_000])
			expect(() =>
				localStoryFlowArchiveLedgerRequests(t.handle, index),
			).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it("rejects options prototype/nonenumerable and getter-based arrays before field reads", () => {
		const f = fixture(),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t);
		for (const change of ["prototype", "hidden"] as const) {
			const options = { transcript: t.handle, ledgers: ledgers.pairs };
			if (change === "prototype")
				Object.setPrototypeOf(options, { extra: true });
			else
				Object.defineProperty(options, "ledgers", {
					value: ledgers.pairs,
					enumerable: false,
				});
			expect(() => buildLocalStoryFlowSourceArchive(options)).toThrowError(
				LocalStoryFlowSourceArchiveError,
			);
		}
		let reads = 0;
		const pairs = [...ledgers.pairs];
		Object.defineProperty(pairs, "0", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_LEDGER_GETTER");
			},
		});
		expect(() =>
			buildLocalStoryFlowSourceArchive({
				transcript: t.handle,
				ledgers: pairs,
			}),
		).toThrowError(LocalStoryFlowSourceArchiveError);
		expect(reads).toBe(0);
	});
	it("rejects self-rehashed cached archive changes against independently retained transcript and all stage rows", () => {
		const f = fixture(),
			t = transcriptFixture(f),
			ledgers = ledgerFixtures(f, t),
			archive = buildLocalStoryFlowSourceArchive({
				transcript: t.handle,
				ledgers: ledgers.pairs,
			}),
			e = localStoryFlowSourceArchiveEvidence(archive);
		for (const field of [
			"fullInput",
			"chunks",
			"fullCorpus",
			"manifest",
			"pages",
			"sourceEvidence",
			"taskId",
		]) {
			const changed = structuredClone(e.payload);
			changed[field] = field === "taskId" ? randomUUID() : [];
			const { archiveHash: _old, ...body } = changed;
			changed.archiveHash = H(body);
			expect(() =>
				validateLocalStoryFlowSourceArchive(changed, {
					transcript: t.handle,
					ledgers: ledgers.pairs,
				}),
			).toThrowError(LocalStoryFlowSourceArchiveError);
		}
		const changed = structuredClone(e.payload);
		let reads = 0;
		Object.defineProperty(changed, "fullCorpus", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_ARCHIVE_GETTER");
			},
		});
		expect(() =>
			validateLocalStoryFlowSourceArchive(changed, {
				transcript: t.handle,
				ledgers: ledgers.pairs,
			}),
		).toThrowError(LocalStoryFlowSourceArchiveError);
		expect(reads).toBe(0);
		const outside = localStoryFlowSourceArchiveEvidence(archive);
		outside.payload.fullCorpus = [];
		outside.requiredLegacyRefs.reverse();
		expect(localStoryFlowSourceArchiveEvidence(archive)).toEqual(e);
		expect(() =>
			localStoryFlowSourceArchiveEvidence({ ...archive }),
		).toThrowError(LocalStoryFlowSourceArchiveError);
	});
});

describe("source archive rejects independent-source and unknown-data substitutions", () => {
	it.each([
		"taskHash",
		"taskCache",
		"tenant",
		"analysisSource",
		"media",
		"clock",
		"model",
		"workflow",
		"policy",
		"binding",
		"normalization",
		"legacyMarker",
		"snapshotExtra",
		"policyExtra",
	] as const)("rejects %s instead of rebuilding an archive from self-declared metadata", (change) => {
		const f = fixture();
		if (change === "taskHash") f.snapshots.task.requestHash = "f".repeat(64);
		if (change === "taskCache") f.snapshots.task.cacheKey = "f".repeat(64);
		if (change === "tenant") f.snapshots.task.organizationId = randomUUID();
		if (change === "analysisSource") f.analysis.sourceId = randomUUID();
		if (change === "media") f.media.sha256 = "f".repeat(64);
		if (change === "clock") f.map.id = randomUUID();
		if (change === "model") {
			f.identity.localStoryModel.modelDigest = "f".repeat(64);
			f.refresh();
		}
		if (change === "workflow") {
			f.identity.localStoryWorkflow.baseModel.configId = randomUUID();
			f.refresh();
		}
		if (change === "policy") {
			f.policies.contextPolicyHash = H("WRONG_COMPILED_CONTEXT_POLICY");
			f.identity.generationPolicyFingerprint =
				localStoryFlowGenerationPolicyFingerprint(f.policies);
			f.refresh();
		}
		if (change === "binding")
			f.snapshots.bindingSnapshot = {
				...f.binding,
				mediaSha256: "f".repeat(64),
			};
		if (change === "normalization")
			f.snapshots.normalizationSnapshot = {
				proof: {},
				proofHash: "f".repeat(64),
			};
		if (change === "legacyMarker")
			Reflect.deleteProperty(f.input.parameters, "storyWorkflowVersion");
		if (change === "snapshotExtra") Reflect.set(f.snapshots, "extra", true);
		if (change === "policyExtra") Reflect.set(f.policies, "extra", true);
		expect(() => f.prep()).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it("rejects getters before reading snapshots or policy values and never leaks proxy exceptions", () => {
		for (const field of ["snapshot", "clock", "policy"] as const) {
			const f = fixture();
			let reads = 0;
			const object =
				field === "snapshot"
					? f.snapshots
					: field === "clock"
						? f.map
						: f.policies;
			Object.defineProperty(
				object,
				field === "snapshot"
					? "mediaSnapshot"
					: field === "clock"
						? "id"
						: "contextPolicyHash",
				{
					enumerable: true,
					get() {
						reads++;
						throw new Error("PRIVATE_GETTER_SENTINEL");
					},
				},
			);
			expect(() => f.prep()).toThrowError(LocalStoryFlowSourceArchiveError);
			expect(reads).toBe(0);
		}
		const f = fixture();
		const proxy = new Proxy(f.snapshots, {
			getPrototypeOf() {
				throw new Error("PRIVATE_PROXY_SENTINEL");
			},
		});
		let caught: unknown;
		try {
			prepareLocalStoryFlowArchiveSource(proxy, f.policies);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect(caught).not.toHaveProperty("cause");
	});
	it.each([
		"hidden",
		"symbol",
		"prototype",
		"hole",
		"cycle",
	] as const)("rejects %s unknown snapshots", (change) => {
		const f = fixture();
		if (change === "hidden")
			Object.defineProperty(f.snapshots, "extra", { value: true });
		if (change === "symbol")
			Reflect.set(f.snapshots, Symbol("PRIVATE_SYMBOL"), true);
		if (change === "prototype")
			Object.setPrototypeOf(f.snapshots, { extra: true });
		if (change === "hole") delete f.analysis.raw.scenes[0];
		if (change === "cycle")
			Reflect.set(f.media.storage, "self", f.media.storage);
		expect(() => f.prep()).toThrowError(LocalStoryFlowSourceArchiveError);
	});
	it("keeps owned preparation/evidence independent from input and getter aliases", () => {
		const f = fixture(),
			prep = f.prep(),
			expected = localStoryFlowArchivePreparationEvidence(prep),
			outside = localStoryFlowArchivePreparationEvidence(prep);
		f.media.sha256 = "f".repeat(64);
		f.identity.localStoryModel.configId = randomUUID();
		outside.sourceTuple.mediaSha256 = "e".repeat(64);
		expect(localStoryFlowArchivePreparationEvidence(prep)).toEqual(expected);
		expect(() =>
			localStoryFlowArchivePreparationEvidence({ ...prep }),
		).toThrowError(LocalStoryFlowSourceArchiveError);
	});
});
