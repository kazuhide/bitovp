import { createHash } from "node:crypto";
import {
	canonicalEditingJson,
	editingAnalysisBindingSchema,
	hashEditingEvidence as H,
	LOCAL_STORY_FLOW_H1_POLICY,
	localStoryFlowGenerationPolicyFingerprint,
	localStoryStageRegistry,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import {
	admitLocalStoryFlowArchiveTranscript,
	buildLocalStoryFlowSourceArchive,
	LOCAL_STORY_FLOW_CLOSURE_POLICY,
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	LOCAL_STORY_FLOW_SCOPE_POLICY,
	localStoryFlowArchiveLedgerRequests,
	localStoryFlowArchiveLedgerStageRequest,
	localStoryFlowArchivePreparationEvidence,
	localStoryFlowArchiveTranscriptEvidence,
	localStoryFlowSourceArchiveEvidence,
	prepareLocalStoryFlowArchiveSource,
} from "@bitovp/core/local-story-flow-hierarchy";
import {
	createLocalStoryLegacyLedgerCacheRecipe,
	createLocalStoryLegacyLedgerStageRecipe,
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
	type LocalStoryArtifactCacheRow,
	localStoryFlowIdentityForModelPin,
	localStoryIdentityForModelPin,
	localStoryLegacyLedgerPrompt,
} from "@bitovp/core/local-story-flow-server";
import { describe, expect, it } from "vitest";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
} from "../../core/src/content-editing/local-semantic-protocol";

function firstSynthetic<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("Missing authored fixture item");
	return value;
}

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Synthetic policies only; no production supported catalog or native execution.
function sourceFixture(count = 1, audio = false) {
	const org = id(1),
		mediaId = id(2),
		sourceId = id(3),
		analysisId = id(4),
		duration = count * 3_000_000;
	const modelPin = { profile: "nvidia" as const, configId: id(5) };
	const policies = {
		version: "local-story-flow-task-policies-v1" as const,
		workflowPolicyHash: H(LOCAL_STORY_FLOW_H1_POLICY),
		contextPolicyHash: H(LOCAL_STORY_FLOW_CONTEXT_POLICY),
		closurePolicyHash: H(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		routePolicyHash: H(LOCAL_STORY_FLOW_ROUTE_POLICY),
		scopePolicyHash: H(LOCAL_STORY_FLOW_SCOPE_POLICY),
		promptPolicyHash: H(LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
		engineValidationPolicyHash: H("SYNTHETIC_ENGINE_NOT_READY"),
		deliveryPolicyHash: H("SYNTHETIC_DELIVERY_NOT_READY"),
	};
	const map = {
		id: id(6),
		mediaVersionId: mediaId,
		kind: "CFR" as const,
		sourceStartUs: 0,
		sourceEndUs: duration,
		editingStartFrame: 0,
		editingEndFrame: count * 90,
		fps: { num: 30, den: 1 },
	};
	const raw = {
		metadata: { version: "resolver synthetic" },
		title: "The key",
		duration: duration / 1_000_000,
		scenes: [
			{
				id: id(7),
				type: "MAIN_CONTENT",
				title: "The key",
				startInSeconds: 0,
				endInSeconds: duration / 1_000_000,
				shots: Array.from({ length: count }, (_, i) => ({
					startInSeconds: i * 3,
					endInSeconds: (i + 1) * 3,
					detailedDescription: `A person holds key ${i}.${" Authored background.".repeat(80)}`,
				})),
			},
		],
	};
	const analysis = {
		id: analysisId,
		organizationId: org,
		sourceId,
		rawHash: H(raw),
		locale: "en",
		providerVersion: "synthetic",
		raw,
		document: normalizeSceneAnalysis(raw),
	};
	const media = {
		id: mediaId,
		organizationId: org,
		sourceId,
		state: "READY" as const,
		sha256: "a".repeat(64),
		durationUs: String(duration),
		width: 640,
		height: 360,
		fpsNum: 30,
		fpsDen: 1,
		timeMap: map,
		storage: {},
		probe: {
			streams: [
				{ codec_type: "video" },
				...(audio ? [{ codec_type: "audio" }] : []),
			],
		},
	};
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId: org,
		sourceId,
		locale: "en",
		analysisRevisionId: analysisId,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: H(analysis.document),
		mediaVersionId: mediaId,
		mediaSha256: media.sha256,
		timeMapId: map.id,
		timeMapHash: H(map),
		sourceStartUs: 0,
		sourceEndUs: duration,
		width: 640,
		height: 360,
	});
	const input = mediaTaskCreateSchema.parse({
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: id(8),
		parameters: {
			contentId: id(9),
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
	if (input.kind !== "GENERATE") throw new Error("Expected authored GENERATE");
	const model = localStoryIdentityForModelPin(modelPin);
	const identity = {
		organizationId: org,
		mediaSha256: media.sha256,
		modelSha256: "b".repeat(64),
		analysisDocumentHash: binding.analysisDocumentHash,
		analysisRawHash: analysis.rawHash,
		timeMapHash: H(map),
		bindingHash: H(binding),
		bindingSnapshot: binding,
		localStoryModel: model,
		localStoryWorkflow: localStoryFlowIdentityForModelPin(modelPin, "FLOW"),
		transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		generationPolicyFingerprint:
			localStoryFlowGenerationPolicyFingerprint(policies),
	};
	const snapshots = {
		task: {
			id: id(10),
			organizationId: org,
			kind: "GENERATE" as const,
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
	const preparation = prepareLocalStoryFlowArchiveSource(snapshots, policies);
	return {
		preparation,
		snapshots,
		model,
		identity,
		policies,
		map,
		media,
		analysis,
	};
}
describe("legacy source resolution", () => {
	it("uses an independently prepared complete source and original transcript request", () => {
		const f = sourceFixture(),
			p = localStoryFlowArchivePreparationEvidence(f.preparation);
		expect(p.hasAudio).toBe(false);
		expect(p.transcript.kind).toBe("LOCAL_STORY_TRANSCRIPT_V1");
		const t = admitLocalStoryFlowArchiveTranscript(f.preparation, null);
		expect(localStoryFlowArchiveTranscriptEvidence(t).chunks).toHaveLength(1);
		expect(
			f.snapshots.task.parameters.identity.localStoryWorkflow,
		).toBeDefined();
	});
});

type Request = ReturnType<
	typeof localStoryFlowArchivePreparationEvidence
>["transcript"];
function legacyFixture(
	count = 1,
	version: "V1" | "V2" | "V3" | "V4" = "V4",
	seal: 1 | 2 = 2,
	audio = false,
) {
	const f = sourceFixture(count, audio);
	function pair(q: Request, value: unknown) {
		const proof =
			seal === 1
				? {
						version: "local-story-cache-v1",
						cacheHash: q.cacheHash,
						value: value as LocalStoryArtifactCacheRow["proof"],
					}
				: {
						version: "local-story-cache-v2",
						cacheHash: q.cacheHash,
						valueJson: canonicalEditingJson(value),
					};
		const row: LocalStoryArtifactCacheRow = {
			id: q.receiptId,
			organizationId: f.media.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			analysisRevisionId:
				q.kind === "LOCAL_STORY_TRANSCRIPT_V1" ? null : f.analysis.id,
			kind: q.kind,
			proof,
			proofHash: H(proof),
		};
		return {
			ref: {
				kind: q.kind,
				receiptId: q.receiptId,
				cacheHash: q.cacheHash,
				inputKeyHash: q.inputKeyHash,
				proofHash: row.proofHash,
			},
			row,
		};
	}
	const transcriptPair = audio
		? pair(localStoryFlowArchivePreparationEvidence(f.preparation).transcript, {
				version: "local-story-transcript-v3",
				retryPolicyVersion: "strict-invalid-30s-10s-v1",
				engineVersion: "1.9.5",
				mediaSha256: f.media.sha256,
				modelSha256: f.identity.modelSha256,
				timeMapHash: H(f.map),
				language: "en",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				segments: [],
				rawSegments: [],
				speechIntervals: [],
				warnings: [],
				qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
				mediaWindows: [{ fromUs: 0, toUs: f.map.sourceEndUs, language: "en" }],
			})
		: null;
	const t = admitLocalStoryFlowArchiveTranscript(f.preparation, transcriptPair);
	const e = localStoryFlowArchiveTranscriptEvidence(t);
	const pairs = e.chunks.map((chunk, index) => {
		const definition = localStoryStageRegistry().stages.LOCAL_LEDGER_V1;
		const common = {
			identity: f.model,
			input: e.fullInput,
			chunk,
			transcriptFingerprint: e.transcriptFingerprint,
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
		const prompt = localStoryLegacyLedgerPrompt({ kind: "BASE", chunk });
		if (!prompt) throw new Error("Expected full synthetic prompt");
		const q = localStoryFlowArchiveLedgerRequests(t, index).find(
			(q) => q.version === version,
		);
		if (!q) throw new Error("Expected registered family");
		const pointer = pair(q, cache.pointer(prompt));
		const stage = createLocalStoryLegacyLedgerStageRecipe({
			...common,
			organizationId: f.media.organizationId,
			prompt,
		});
		const requestKey = id(1000 + index),
			body = stage.bodyFor(requestKey),
			ref = chunk.refs[0];
		if (!ref) throw new Error("Expected source ref");
		const quote = `A person holds key ${Number(ref.slice(1))}.`;
		const stored = stage.parse({
			version: "local-semantic-stage-result-v1",
			requestKey,
			output: {
				summary: "The key is held.",
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
			},
			receipt: {
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
			},
		});
		const stageRequest = localStoryFlowArchiveLedgerStageRequest(
			t,
			index,
			pointer,
		);
		return { pointer, stage: pair(stageRequest, stored) };
	});
	const rows = new Map(
		[
			...pairs.flatMap((p) => [p.pointer.row, p.stage.row]),
			...(transcriptPair ? [transcriptPair.row] : []),
		].map((r) => [r.id, r]),
	);
	return { ...f, t, pairs, rows, pair, transcriptPair };
}
it("reconstructs complete legacy pairs through the real source archive validator", () => {
	const f = legacyFixture(2);
	const archive = buildLocalStoryFlowSourceArchive({
		transcript: f.t,
		ledgers: f.pairs,
	});
	expect(
		localStoryFlowSourceArchiveEvidence(archive).requiredLegacyRefs,
	).toHaveLength(f.pairs.length * 2);
});

it("resolves old complete rows in exactly two pointer/stage batches, no FLOW rows", async () => {
	const f = legacyFixture(3),
		calls: Request[][] = [];
	const { resolveLibraryFlowSourceArchive } = await import(
		"./library-flow-source-archive"
	);
	const archive = await resolveLibraryFlowSourceArchive(
		f.preparation,
		async (requests) => {
			calls.push(structuredClone([...requests]));
			return requests.flatMap((q) => {
				const row = f.rows.get(q.receiptId);
				return row ? [row] : [];
			});
		},
	);
	expect(calls.map((c) => c.length)).toEqual([
		f.pairs.length * 4,
		f.pairs.length,
	]);
	expect(localStoryFlowSourceArchiveEvidence(archive).payload).toEqual(
		localStoryFlowSourceArchiveEvidence(
			buildLocalStoryFlowSourceArchive({ transcript: f.t, ledgers: f.pairs }),
		).payload,
	);
});

async function resolveRows(
	f: ReturnType<typeof legacyFixture>,
	transform?: (
		rows: ReturnType<typeof legacyFixture>["pairs"][number]["pointer"]["row"][],
	) => ReturnType<typeof legacyFixture>["pairs"][number]["pointer"]["row"][],
) {
	const { resolveLibraryFlowSourceArchive } = await import(
		"./library-flow-source-archive"
	);
	return resolveLibraryFlowSourceArchive(f.preparation, async (requests) => {
		const rows = requests.flatMap((q) => {
			const row = f.rows.get(q.receiptId);
			return row ? [structuredClone(row)] : [];
		});
		return transform ? transform(rows) : rows.reverse();
	});
}
it.each([
	"V4",
	"V3",
	"V2",
	"V1",
] as const)("retains the exact registered %s family", async (version) => {
	const f = legacyFixture(2, version);
	const result = await resolveRows(f);
	expect(localStoryFlowSourceArchiveEvidence(result).payload).toEqual(
		localStoryFlowSourceArchiveEvidence(
			buildLocalStoryFlowSourceArchive({ transcript: f.t, ledgers: f.pairs }),
		).payload,
	);
});
it("ignores an unreached lower-family body when V4 is valid", async () => {
	const f = legacyFixture(),
		lower = legacyFixture(1, "V1");
	const row = structuredClone(firstSynthetic(lower.pairs).pointer.row);
	row.proof = { invalid: "unreached lower body" };
	f.rows.set(row.id, row);
	await expect(resolveRows(f)).resolves.toBeDefined();
});
it("does not turn a corrupt existing pointer into lower-family absence", async () => {
	const f = legacyFixture(),
		lower = legacyFixture(1, "V3");
	for (const [id, row] of lower.rows) f.rows.set(id, row);
	const pointer = firstSynthetic(f.pairs).pointer.row;
	pointer.proofHash = "0".repeat(64);
	await expect(resolveRows(f)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("skips missing V4 but stops at corrupt V3 even when V2 is valid", async () => {
	const f = legacyFixture(1, "V3"),
		lower = legacyFixture(1, "V2");
	for (const [id, row] of lower.rows) f.rows.set(id, row);
	firstSynthetic(f.pairs).pointer.row.proofHash = "0".repeat(64);
	await expect(resolveRows(f)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("rejects a missing referenced stage without repair", async () => {
	const f = legacyFixture();
	f.rows.delete(firstSynthetic(f.pairs).stage.row.id);
	await expect(resolveRows(f)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it.each([
	"duplicate",
	"extra",
	"organizationId",
	"sourceId",
	"mediaVersionId",
	"analysisRevisionId",
	"kind",
] as const)("rejects %s rows in a bounded batch", async (change) => {
	const f = legacyFixture();
	await expect(
		resolveRows(f, (rows) => {
			if (change === "duplicate")
				return [...rows, structuredClone(firstSynthetic(rows))];
			if (change === "extra")
				return [...rows, { ...firstSynthetic(rows), id: id(9000) }];
			const first = rows[0];
			if (first)
				Reflect.set(
					first,
					change,
					change === "kind" ? "LOCAL_STORY_TRANSCRIPT_V1" : id(9000),
				);
			return rows;
		}),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
});
it("rejects a getter without executing it", async () => {
	const f = legacyFixture();
	let accessed = 0;
	await expect(
		resolveRows(f, (rows) => {
			if (rows[0])
				Object.defineProperty(rows[0], "proofHash", {
					enumerable: true,
					get() {
						accessed++;
						return "x";
					},
				});
			return rows;
		}),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(accessed).toBe(0);
});

it.each([
	1, 2,
] as const)("accepts original full v%s seals including READY zero speech", async (seal) => {
	const f = legacyFixture(1, "V4", seal, true),
		calls: Request[][] = [];
	const { resolveLibraryFlowSourceArchive } = await import(
		"./library-flow-source-archive"
	);
	const a = await resolveLibraryFlowSourceArchive(
		f.preparation,
		async (requests) => {
			calls.push([...requests]);
			return requests.flatMap((q) => {
				const row = f.rows.get(q.receiptId);
				return row ? [row] : [];
			});
		},
	);
	expect(calls.map((r) => r.length)).toEqual([1, 4, 1]);
	expect(
		localStoryFlowSourceArchiveEvidence(a).requiredLegacyRefs,
	).toHaveLength(3);
	const pair = f.transcriptPair;
	if (!pair) throw new Error("Expected full transcript");
	pair.row.proofHash = "0".repeat(64);
	await expect(resolveRows(f)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("stops on missing audio transcript before any pointer lookup", async () => {
	const f = legacyFixture(1, "V4", 2, true);
	if (!f.transcriptPair) throw new Error("Expected audio fixture");
	f.rows.delete(f.transcriptPair.row.id);
	let lookups = 0;
	const { resolveLibraryFlowSourceArchive } = await import(
		"./library-flow-source-archive"
	);
	await expect(
		resolveLibraryFlowSourceArchive(f.preparation, async (requests) => {
			lookups++;
			return requests.flatMap((q) => {
				const row = f.rows.get(q.receiptId);
				return row ? [row] : [];
			});
		}),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(lookups).toBe(1);
});
// This timeout includes construction of 128 original cache fixtures. App RR remains 15 seconds.
// The test took 16.4 s on a CI runner with two workers, so 30 s left too little room.
it("measures complete 128-chunk source resolution with 512+128 fixed candidates", async () => {
	const fixtureStarted = performance.now(),
		f = legacyFixture(256),
		calls: number[] = [];
	expect(f.pairs).toHaveLength(128);
	const { resolveLibraryFlowSourceArchive } = await import(
		"./library-flow-source-archive"
	);
	const started = performance.now();
	const a = await resolveLibraryFlowSourceArchive(
		f.preparation,
		async (requests) => {
			calls.push(requests.length);
			return requests.flatMap((q) => {
				const row = f.rows.get(q.receiptId);
				return row ? [row] : [];
			});
		},
	);
	const elapsedMs = performance.now() - started,
		e = localStoryFlowSourceArchiveEvidence(a);
	expect(calls).toEqual([512, 128]);
	expect(e.requiredLegacyRefs).toHaveLength(256);
	console.info(
		JSON.stringify({
			syntheticSourceOnly: true,
			chunks: 128,
			pointerCandidates: 512,
			stageCandidates: 128,
			lookupCalls: calls.length,
			archiveJsonBytes: Buffer.byteLength(canonicalEditingJson(e.payload)),
			elapsedMs,
			fixtureAndResolutionElapsedMs: performance.now() - fixtureStarted,
		}),
	);
}, 60_000);
