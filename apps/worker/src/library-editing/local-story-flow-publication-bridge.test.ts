import { createHash } from "node:crypto";
import {
	editingAnalysisBindingSchema,
	hashEditingEvidence as hash,
	canonicalEditingJson as json,
	LOCAL_STORY_FLOW_CLOSURE_POLICY,
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	LOCAL_STORY_FLOW_H1_POLICY,
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	LOCAL_STORY_FLOW_SCOPE_POLICY,
	type LocalStoryFlowContextNodeEvidence,
	localStoryFlowContextSourceEvidence,
	localStoryFlowGenerationPolicyFingerprint,
	localStoryStageRegistry,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import {
	type AcceptedLocalStoryFlowContextNode,
	type AcceptedLocalStoryFlowRouteStep,
	acceptLocalStoryFlowContextWork,
	acceptLocalStoryFlowRouteWork,
	admitLocalStoryFlowArchiveTranscript,
	admittedFlowNativeEvidence,
	type BoundLocalStoryFlowAcceptedContext,
	type BoundLocalStoryFlowNativeExpectation,
	type BoundLocalStoryFlowSourceArchive,
	buildLocalStoryFlowAcceptedContext,
	createLocalStoryLegacyLedgerCacheRecipe,
	createLocalStoryLegacyLedgerStageRecipe,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
	type LocalStoryArtifactCacheRow,
	type LocalStoryFlowArchiveSourceSnapshots,
	type LocalStoryFlowRecordRef,
	localStoryFlowAcceptedContextNodePublication,
	localStoryFlowAcceptedContextPublication,
	localStoryFlowAcceptedRoutePublication,
	localStoryFlowArchiveLedgerRequests,
	localStoryFlowArchiveLedgerStageRequest,
	localStoryFlowArchivePreparationEvidence,
	localStoryFlowArchiveTranscriptEvidence,
	localStoryFlowContextWorkExpectation,
	localStoryFlowIdentityForModelPin,
	localStoryFlowNativeExpectationEvidence,
	localStoryFlowRecordIdentity,
	localStoryFlowRouteWorkExpectation,
	localStoryFlowSourceArchiveContext,
	localStoryFlowSourceArchiveEvidence,
	localStoryIdentityForModelPin,
	localStoryLegacyLedgerPrompt,
	nativeRequestForOrigin,
	nextLocalStoryFlowRouteWork,
	prepareLocalStoryFlowArchiveSource,
	prepareLocalStoryFlowContextWork,
} from "@bitovp/core/local-story-flow-server";
import {
	type AppPrismaClient,
	type LibraryMediaTask,
	localStoryFlowReadSourceEvidence,
	localStoryFlowTaskLockKey,
	TENANT_ORGANIZATION,
	validateLocalStoryFlowSourceArchiveReadFence,
	withLocalStoryFlowWorkerSourceSnapshot,
} from "@bitovp/db";
import { afterEach, expect, it, vi } from "vitest";
import type {
	LocalSemanticObservedResult,
	LocalSemanticRunInput,
} from "./local-semantic-client";
import {
	prepareLocalStoryFlowContextPublication,
	prepareLocalStoryFlowRoutePublication,
} from "./local-story-flow-publication";
import {
	acceptedLocalStoryFlowPublicationEvidence,
	capturedLocalStoryFlowNativeEvidence,
	createLocalStoryFlowRuntimeStore,
} from "./local-story-flow-runtime-store";
import type { VerifiedMediaTask } from "./media-task-execution";

// Real source admission, RR reader, bridge, seals, core and PUB. Only the
// tenant transport/catalog/native transport are synthetic. No DB/GPU/media IO.
const boundary = vi.hoisted(() => ({ tenant: vi.fn(), catalog: vi.fn() }));
vi.mock("../../../../packages/db/src/tenant-client", async (original) => ({
	...(await original<
		typeof import("../../../../packages/db/src/tenant-client")
	>()),
	getTenantPrisma: boundary.tenant,
}));
vi.mock(
	"../../../../packages/core/src/content-editing/local-story-flow-policy-catalog",
	async (original) => ({
		...(await original<
			typeof import("../../../../packages/core/src/content-editing/local-story-flow-policy-catalog")
		>()),
		resolveLocalStoryFlowPolicyCatalogForTaskIdentity: boundary.catalog,
	}),
);
const stores: Array<ReturnType<typeof createLocalStoryFlowRuntimeStore>> = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.dispose();
	vi.useRealTimers();
});
const org = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const pubId = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function publicationSourceFacts(
	count = 1,
	audio = false,
	normalized = false,
	attested = false,
) {
	const org = pubId(1),
		mediaId = pubId(2),
		sourceId = pubId(3),
		analysisId = pubId(4),
		duration = count * 3_000_000;
	const modelPin = { profile: "nvidia" as const, configId: pubId(5) };
	const policies = {
		version: "local-story-flow-task-policies-v1" as const,
		workflowPolicyHash: hash(LOCAL_STORY_FLOW_H1_POLICY),
		contextPolicyHash: hash(LOCAL_STORY_FLOW_CONTEXT_POLICY),
		closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		routePolicyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
		scopePolicyHash: hash(LOCAL_STORY_FLOW_SCOPE_POLICY),
		promptPolicyHash: hash(LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
		engineValidationPolicyHash: hash("SYNTHETIC_ENGINE_NOT_READY"),
		deliveryPolicyHash: hash("SYNTHETIC_DELIVERY_NOT_READY"),
	};
	const map = {
		id: pubId(6),
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
				id: pubId(7),
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
		rawHash: hash(raw),
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
		kind: attested ? "EDITOR_ATTESTED" : "FIXTURE_AUTHORED",
		...(attested
			? {
					attestation: {
						receiptId: pubId(77),
						actor: "synthetic operator",
						confirmedAt: "2026-11-07T00:00:00.000Z",
						scope: ["TIME", "GEOMETRY", "CONTENT"],
					},
				}
			: {}),
		organizationId: org,
		sourceId,
		locale: "en",
		analysisRevisionId: analysisId,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hash(analysis.document),
		mediaVersionId: mediaId,
		mediaSha256: media.sha256,
		timeMapId: map.id,
		timeMapHash: hash(map),
		sourceStartUs: 0,
		sourceEndUs: duration,
		width: 640,
		height: 360,
	});
	const input = mediaTaskCreateSchema.parse({
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: pubId(8),
		parameters: {
			contentId: pubId(9),
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
		timeMapHash: hash(map),
		bindingHash: hash(binding),
		bindingSnapshot: binding,
		localStoryModel: model,
		localStoryWorkflow: localStoryFlowIdentityForModelPin(modelPin, "FLOW"),
		transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		generationPolicyFingerprint:
			localStoryFlowGenerationPolicyFingerprint(policies),
	};
	const snapshots = {
		task: {
			id: taskId,
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
		normalizationSnapshot:
			null as LocalStoryFlowArchiveSourceSnapshots["normalizationSnapshot"],
	};
	if (normalized) {
		const count = map.editingEndFrame,
			durationUs = map.sourceEndUs;
		const source = {
			width: 640,
			height: 360,
			codec: "h264",
			fps: { num: 24, den: 1 },
			timeBase: { num: 1, den: 12288 },
			frameCount: (durationUs / 1_000_000) * 24,
			durationUs,
			videoPtsHash: "b".repeat(64),
			colorProfile: "BT709_8BIT_LIMITED",
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
			preparedSha256: media.sha256,
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
			indexMapHash: hash(sourceFrameIndex),
			recipeHash: hash({
				profile: "SDR_CFR30_INDEXED_V1",
				mode: "NORMALIZE",
				source,
				videoFilter:
					"fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=" +
					count +
					",setpts=N/(30*TB),setsar=1/1",
				audioFilter: null,
			}),
			organizationId: org,
			sourceId,
			mediaVersionId: mediaId,
			timeMapId: map.id,
		};
		const proofHash = hash(proof);
		snapshots.normalizationSnapshot = { proof, proofHash };
		Reflect.set(identity, "preparedShotClock", {
			version: "aisa-prepared-clock-v3",
			normalizationReceiptHash: proofHash,
		});
		snapshots.task.cacheKey = mediaTaskCacheKey(input, identity);
	}
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
type PubRequest = ReturnType<
	typeof localStoryFlowArchivePreparationEvidence
>["transcript"];
function publicationLegacyFixture(
	count = 1,
	version: "V1" | "V2" | "V3" | "V4" = "V4",
	seal: 1 | 2 = 2,
	audio = false,
	normalized = false,
	attested = false,
) {
	const f = publicationSourceFacts(count, audio, normalized, attested);
	function pair(q: PubRequest, value: unknown) {
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
						valueJson: json(value),
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
			proofHash: hash(proof),
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
				timeMapHash: hash(f.map),
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
		const requestKey = pubId(1000 + index),
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
				model: f.model.model,
				modelDigest: f.model.modelDigest,
				runtimeVersion: f.model.runtimeVersion,
				inputHash: body.inputHash,
				promptHash: createHash("sha256").update(prompt).digest("hex"),
				schemaHash: body.schemaHash,
				promptVersion: body.promptVersion,
				requestHash: hash(body),
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
						name: f.model.model,
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

type Row = Record<string, unknown>;
type Mode = "UPDATE" | "SHARE" | "KEY SHARE";
type LockEvent = {
	owner: string;
	op: "REQUEST" | "GRANT" | "RELEASE";
	resource: string;
	mode: Mode;
};
type PendingLock = {
	owner: string;
	resource: string;
	mode: Mode;
	resolve: () => void;
	reject: (e: unknown) => void;
};
function requireFixture(v: unknown): asserts v {
	if (!v) throw Error("SYNTHETIC_FIXTURE_INVALID");
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
class LockManager {
	events: LockEvent[] = [];
	cycles: string[][] = [];
	private held = new Map<string, Map<string, Mode>>();
	private pending: PendingLock[] = [];
	private firstRequests = new Set<string>();
	private barrier: ReturnType<typeof deferred<void>> | undefined;
	private requests: Array<{
		owner: string;
		resource: string;
		done: ReturnType<typeof deferred<void>>;
	}> = [];
	waitForRequest(owner: string, resource: string) {
		const done = deferred<void>();
		if (
			this.events.some(
				(e) =>
					e.op === "REQUEST" && e.owner === owner && e.resource === resource,
			)
		)
			done.resolve();
		else this.requests.push({ owner, resource, done });
		return done.promise;
	}
	parallelOwners = new Set<string>();
	sourceStarted = new Set<string>();
	lateTaskLocks: LockEvent[] = [];
	arm(owners: string[]) {
		this.parallelOwners = new Set(owners);
		this.firstRequests.clear();
		this.barrier = deferred<void>();
	}
	has(owner: string, resource: string, mode: Mode) {
		const m = this.held.get(resource)?.get(owner);
		return (
			m === "UPDATE" || m === mode || (m === "SHARE" && mode === "KEY SHARE")
		);
	}
	private blockers(owner: string, resource: string, mode: Mode) {
		return [...(this.held.get(resource) ?? [])]
			.filter(([o, m]) => o !== owner && (mode === "UPDATE" || m === "UPDATE"))
			.map(([o]) => o);
	}
	private cycleFrom(owner: string): string[] | null {
		const graph = new Map<string, string[]>();
		for (const p of this.pending)
			graph.set(p.owner, [
				...(graph.get(p.owner) ?? []),
				...this.blockers(p.owner, p.resource, p.mode),
			]);
		const path: string[] = [];
		function visit(o: string): string[] | null {
			if (path.includes(o)) return [...path, o];
			path.push(o);
			for (const next of graph.get(o) ?? []) {
				const c = visit(next);
				if (c) return c;
			}
			path.pop();
			return null;
		}
		return visit(owner);
	}
	async acquire(owner: string, resource: string, mode: Mode) {
		const event: LockEvent = { owner, op: "REQUEST", resource, mode };
		this.events.push(event);
		for (const w of this.requests.filter(
			(w) => w.owner === owner && w.resource === resource,
		))
			w.done.resolve();
		this.requests = this.requests.filter(
			(w) => w.owner !== owner || w.resource !== resource,
		);
		if (
			resource.startsWith("TASK:") &&
			this.sourceStarted.has(owner) &&
			!this.has(owner, resource, mode)
		)
			this.lateTaskLocks.push(event);
		const firstTask =
			resource.startsWith("TASK:") &&
			this.parallelOwners.has(owner) &&
			!this.firstRequests.has(owner);
		if (firstTask) {
			this.firstRequests.add(owner);
			if (this.firstRequests.size === this.parallelOwners.size)
				this.barrier?.resolve();
		}
		if (!this.blockers(owner, resource, mode).length) {
			const holders = this.held.get(resource) ?? new Map();
			const previous = holders.get(owner);
			const merged =
				previous === "UPDATE" || mode === "UPDATE"
					? "UPDATE"
					: previous === "SHARE" || mode === "SHARE"
						? "SHARE"
						: "KEY SHARE";
			holders.set(owner, merged);
			this.held.set(resource, holders);
			this.events.push({ owner, op: "GRANT", resource, mode });
		} else {
			await new Promise<void>((resolve, reject) => {
				const pending = { owner, resource, mode, resolve, reject };
				this.pending.push(pending);
				const cycle = this.cycleFrom(owner);
				if (cycle) {
					this.cycles.push(cycle);
					this.pending = this.pending.filter((p) => p !== pending);
					reject(Error("SYNTHETIC_LOCK_CYCLE"));
				}
			});
		}
		// Wait for both first REQUESTS, never both grants (which would deadlock the fake itself).
		if (firstTask) await this.barrier?.promise;
	}
	release(owner: string) {
		for (const [resource, holders] of this.held) {
			const mode = holders.get(owner);
			if (mode) {
				holders.delete(owner);
				this.events.push({ owner, resource, mode, op: "RELEASE" });
			}
			if (!holders.size) this.held.delete(resource);
		}
		this.sourceStarted.delete(owner);
		for (const p of [...this.pending])
			if (!this.blockers(p.owner, p.resource, p.mode).length) {
				this.pending = this.pending.filter((x) => x !== p);
				const holders = this.held.get(p.resource) ?? new Map();
				holders.set(p.owner, p.mode);
				this.held.set(p.resource, holders);
				this.events.push({
					owner: p.owner,
					resource: p.resource,
					mode: p.mode,
					op: "GRANT",
				});
				p.resolve();
			}
	}
}
const tables = [
	"libraryMediaTask",
	"librarySource",
	"libraryMediaVersion",
	"sceneAnalysisRevision",
	"libraryAnalysisBinding",
	"libraryEvidenceReceipt",
	"libraryFlowEvidencePin",
] as const;
type Table = (typeof tables)[number];
const sqlTable: Record<string, Table> = {
	LibraryMediaTask: "libraryMediaTask",
	LibrarySource: "librarySource",
	LibraryMediaVersion: "libraryMediaVersion",
	SceneAnalysisRevision: "sceneAnalysisRevision",
	LibraryAnalysisBinding: "libraryAnalysisBinding",
	LibraryEvidenceReceipt: "libraryEvidenceReceipt",
	LibraryFlowEvidencePin: "libraryFlowEvidencePin",
};
const rowKey = (table: Table, row: Row) =>
	table === "libraryFlowEvidencePin"
		? [row.organizationId, row.taskId, row.receiptId].join(":")
		: String(row.id);
const matching = (row: Row, where: Row = {}): boolean =>
	Object.entries(where).every(([key, value]) => {
		if (value && typeof value === "object" && "in" in value)
			return Array.isArray(value.in) && value.in.includes(row[key]);
		return row[key] === value;
	});
type Tx = {
	id: string;
	taskId: string | null;
	delta: Map<Table, Map<string, Row>>;
	snapshot: Map<Table, Map<string, Row>> | null;
	sawBridge: boolean;
	active: boolean;
};
function makeLab(count = 128, ageMs = 1000) {
	const facts = publicationLegacyFixture(count),
		manager = new LockManager();
	const committed = new Map<Table, Map<string, Row>>(
		tables.map((t) => [t, new Map()]),
	);
	const mono = performance.now(),
		epoch = Date.parse("2026-11-07T00:00:00Z"),
		now = () => epoch + Math.floor(performance.now() - mono);
	let nextTx = 0;
	const faults: {
		purpose: string | null;
		pin: boolean;
		afterWrite: ((purpose: string) => void) | null;
		hardRequirement: boolean;
	} = { purpose: null, pin: false, afterWrite: null, hardRequirement: false };
	const commits: string[] = [];
	const queries: Array<{ tx: string; sql: string; values: unknown[] }> = [];
	let gate:
		| undefined
		| {
				entered: ReturnType<typeof deferred<void>>;
				release: ReturnType<typeof deferred<void>>;
				reject?: unknown;
		  };
	const snapshot = (all: Map<Table, Map<string, Row>>) =>
		new Map(
			[...all].map(([t, rows]) => [
				t,
				new Map([...rows].map(([k, v]) => [k, structuredClone(v)])),
			]),
		);
	const view = (tx: Tx, t: Table) =>
		new Map([
			...((tx.snapshot ?? committed).get(t) ?? []),
			...(tx.delta.get(t) ?? []),
		]);
	const project = (row: Row, select?: Row) =>
		structuredClone(
			select
				? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
				: row,
		);
	function seed(t: Table, row: Row) {
		committed.get(t)?.set(rowKey(t, row), structuredClone(row));
	}
	seed("librarySource", {
		id: facts.media.sourceId,
		organizationId: org,
		state: "READY",
		snapshot: facts.analysis.raw,
	});
	seed("libraryMediaVersion", {
		...facts.media,
		durationUs: BigInt(facts.media.durationUs),
	});
	seed("sceneAnalysisRevision", facts.analysis);
	seed("libraryAnalysisBinding", {
		id: pubId(70),
		organizationId: org,
		mediaVersionId: facts.media.id,
		analysisRevisionId: facts.analysis.id,
		proof: facts.snapshots.bindingSnapshot,
		attestationReceiptId: null,
	});
	for (const row of facts.rows.values()) seed("libraryEvidenceReceipt", row);
	function createTask(id: string, targetFrames = 90) {
		const t = structuredClone(facts.snapshots.task);
		t.id = id;
		t.parameters.input.parameters.targetDurationFrames = targetFrames;
		t.parameters.input.requestKey = id;
		t.requestKey = id;
		t.requestHash = mediaTaskIntentHash(t.parameters.input);
		t.cacheKey = mediaTaskCacheKey(t.parameters.input, t.parameters.identity);
		const row = {
			...t,
			state: "RUNNING",
			phase: "ANALYZING_LOCAL_STORY",
			createdBy: null,
			result: null,
			progress: {},
			startedAt: new Date(epoch - ageMs),
			leaseUntil: new Date(epoch + 5_400_000),
			leaseToken: pubId(Number(id.slice(-3)) + 300),
			cancelRequestedAt: null,
		};
		seed("libraryMediaTask", row);
		return row as unknown as LibraryMediaTask;
	}
	const tasks = new Map<string, LibraryMediaTask>();
	const controller = new AbortController();
	function db(tx: Tx): AppPrismaClient {
		const delegates = Object.fromEntries(
			tables.map((table) => [
				table,
				{
					async findMany(
						args: {
							where?: Row;
							select?: Row;
							take?: number;
							orderBy?: unknown;
						} = {},
					) {
						if (gate && tx.sawBridge && table === "libraryEvidenceReceipt") {
							const g = gate;
							gate = undefined;
							g.entered.resolve();
							await g.release.promise;
							if (g.reject) throw g.reject;
						}
						const found = [...view(tx, table).values()]
							.filter((r) => matching(r, args.where))
							.sort((a, b) => rowKey(table, a).localeCompare(rowKey(table, b)))
							.slice(0, args.take ?? Infinity);
						return found.map((r) => project(r, args.select));
					},
					async findUnique(args: { where: Row; select?: Row }) {
						const row = [...view(tx, table).values()].find((r) =>
							matching(r, args.where),
						);
						return row ? project(row, args.select) : null;
					},
					async create({ data }: { data: Row }) {
						const purpose =
							typeof data.kind === "string" &&
							data.kind.startsWith("LOCAL_FLOW")
								? String(flowPayload(data).purpose)
								: "UNKNOWN";
						if (faults.purpose === purpose)
							throw Error("SYNTHETIC_INSERT_FAILURE");
						requireFixture(tx.active && !tx.snapshot);
						const key = rowKey(table, data);
						await manager.acquire(tx.id, `UNIQUE:${table}:${key}`, "UPDATE");
						if (view(tx, table).has(key))
							throw Error("SYNTHETIC_UNIQUE_CONFLICT");
						const map = tx.delta.get(table) ?? new Map();
						map.set(key, structuredClone(data));
						tx.delta.set(table, map);
						faults.afterWrite?.(purpose);
						return structuredClone(data);
					},
					async createMany({
						data,
						skipDuplicates,
					}: {
						data: Row[];
						skipDuplicates?: boolean;
					}) {
						requireFixture(tx.active && !tx.snapshot);
						if (faults.pin) throw Error("SYNTHETIC_PIN_FAILURE");
						let count = 0;
						for (const row of data) {
							const key = rowKey(table, row);
							await manager.acquire(tx.id, `UNIQUE:${table}:${key}`, "UPDATE");
							if (view(tx, table).has(key)) {
								requireFixture(skipDuplicates);
								continue;
							}
							requireFixture(
								table === "libraryFlowEvidencePin" &&
									view(tx, "libraryMediaTask").has(String(row.taskId)) &&
									view(tx, "libraryEvidenceReceipt").has(String(row.receiptId)),
							);
							const map = tx.delta.get(table) ?? new Map();
							map.set(key, structuredClone(row));
							tx.delta.set(table, map);
							count++;
						}
						faults.afterWrite?.("PIN");
						return { count };
					},
				},
			]),
		);
		async function raw(sql: string, values: unknown[], unsafe: boolean) {
			queries.push({ tx: tx.id, sql, values: structuredClone(values) });
			if (sql.includes("clock_timestamp")) return [{ nowMs: BigInt(now()) }];
			if (sql.includes("pg_advisory_xact_lock")) {
				await manager.acquire(tx.id, `ADV:${String(values[0])}`, "UPDATE");
				return 1;
			}
			const tableName = sql.match(/FROM "(\w+)"/)?.[1],
				table = tableName ? sqlTable[tableName] : undefined;
			requireFixture(table);
			if (unsafe) tx.sawBridge = true;
			const mode: Mode | undefined = sql.includes("FOR UPDATE")
				? "UPDATE"
				: sql.includes("FOR KEY SHARE")
					? "KEY SHARE"
					: sql.includes("FOR SHARE")
						? "SHARE"
						: undefined;
			let found = [...view(tx, table).values()];
			if (table === "libraryFlowEvidencePin")
				found = found.filter(
					(r) =>
						r.organizationId === values[0] &&
						r.taskId === values[1] &&
						r.receiptId === values[2],
				);
			else if (sql.includes("\"kind\" = 'NORMALIZATION_CAPTURE'"))
				found = found
					.filter(
						(r) =>
							r.organizationId === values[0] &&
							r.mediaVersionId === values[1] &&
							r.kind === "NORMALIZATION_CAPTURE",
					)
					.slice(0, 2);
			else if (
				table === "libraryAnalysisBinding" &&
				sql.includes('"mediaVersionId"')
			)
				found = found.filter(
					(r) =>
						r.organizationId === values[0] &&
						r.mediaVersionId === values[1] &&
						r.analysisRevisionId === values[2],
				);
			else
				found = found.filter(
					(r) => r.organizationId === values[0] && r.id === values[1],
				);
			if (mode) {
				for (const row of found) {
					const resource =
						table === "libraryMediaTask"
							? `TASK:${String(row.id)}`
							: `ROW:${table}:${rowKey(table, row)}`;
					if (table === "librarySource") manager.sourceStarted.add(tx.id);
					await manager.acquire(tx.id, resource, mode);
				}
			}
			// Re-read after row-lock grant, as READ COMMITTED does; RR reads use their fixed snapshot.
			if (table === "libraryMediaTask")
				found = found.map((r) => view(tx, table).get(String(r.id)) ?? r);
			if (sql.startsWith('SELECT "proof"'))
				return found.map((r) => ({ proof: r.proof }));
			if (unsafe)
				return found.map((r) => ({
					id: table === "libraryFlowEvidencePin" ? r.receiptId : r.id,
				}));
			if (sql.startsWith('SELECT "id" FROM'))
				return found.map((r) => ({ id: r.id }));
			if (table === "libraryEvidenceReceipt")
				return found.map((r) =>
					project(r, {
						id: true,
						organizationId: true,
						sourceId: true,
						mediaVersionId: true,
						analysisRevisionId: true,
						kind: true,
						proof: true,
						proofHash: true,
					}),
				);
			return structuredClone(found);
		}
		return {
			...delegates,
			[TENANT_ORGANIZATION]: org,
			$queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
				raw(strings.join("?"), values, false),
			$executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
				raw(strings.join("?"), values, false),
			$queryRawUnsafe: (sql: string, ...values: unknown[]) =>
				raw(sql, values, true),
		} as unknown as AppPrismaClient;
	}
	function client(readOnly: boolean, task: string | null): AppPrismaClient {
		return {
			[TENANT_ORGANIZATION]: org,
			$transaction: async <T>(run: (tx: AppPrismaClient) => Promise<T>) => {
				const tx: Tx = {
					id: (readOnly ? "RR" : "WRITE") + String(++nextTx),
					taskId: task,
					delta: new Map(),
					snapshot: readOnly ? snapshot(committed) : null,
					sawBridge: false,
					active: true,
				};
				const connection = db(tx);
				try {
					const result = await run(connection);
					if (!readOnly) {
						for (const [t, delta] of tx.delta)
							for (const [k, row] of delta)
								committed.get(t)?.set(k, structuredClone(row));
						commits.push(tx.id);
					}
					return result;
				} finally {
					tx.active = false;
					manager.release(tx.id);
				}
			},
		} as unknown as AppPrismaClient;
	}
	boundary.tenant
		.mockReset()
		.mockImplementation((authorized: string, opts: { readOnly: boolean }) => {
			expect(authorized).toBe(org);
			expect(opts).toEqual({ readOnly: true });
			return client(true, null);
		});
	boundary.catalog.mockReset().mockImplementation(() => ({
		status: "SUPPORTED",
		catalogVersion: "local-story-flow-policy-catalog-v1",
		policies: facts.policies,
		generationPolicyFingerprint: localStoryFlowGenerationPolicyFingerprint(
			facts.policies,
		),
	}));
	const nativeCalls: Array<{ taskId: string; requestKey: string }> = [],
		cleanupOnly = vi.fn();
	type Context = {
		task: LibraryMediaTask;
		store: ReturnType<typeof createLocalStoryFlowRuntimeStore>;
		archive: BoundLocalStoryFlowSourceArchive;
		fence: Awaited<
			ReturnType<typeof withLocalStoryFlowWorkerSourceSnapshot>
		>["readFence"];
		verified: VerifiedMediaTask;
		tail: LocalStoryFlowRecordRef | null;
	};
	async function source(task: LibraryMediaTask) {
		const read = await withLocalStoryFlowWorkerSourceSnapshot(
			{
				authorizedOrganizationId: org,
				generationTaskId: task.id,
				leaseToken: task.leaseToken ?? "",
				signal: controller.signal,
			},
			async (reader) => {
				const handle = await reader.source(),
					archive = await reader.resolveSourceArchive();
				return {
					archive,
					verified: localStoryFlowReadSourceEvidence(handle)
						.verified as VerifiedMediaTask,
				};
			},
		);
		return {
			archive: read.value.archive,
			verified: read.value.verified,
			fence: read.readFence,
		};
	}
	const responses = new Map<
		string,
		{
			expected: BoundLocalStoryFlowNativeExpectation;
			output: unknown;
			taskId: string;
		}
	>();
	async function context(id: string, targetFrames = 90): Promise<Context> {
		const task = tasks.get(id) ?? createTask(id, targetFrames);
		tasks.set(id, task);
		const initial = await source(task);
		const runtime = createLocalStoryFlowRuntimeStore({
			prisma: client(false, id),
			task,
			verified: initial.verified,
			leaseToken: task.leaseToken ?? "",
			connectionHash: hash("SYNTHETIC_CONNECTION"),
			policies: facts.policies,
			signal: controller.signal,
			client: {
				cleanupOnly,
				runObserved: vi.fn(async (input: LocalSemanticRunInput) => {
					const response = responses.get(input.requestKey);
					requireFixture(response);
					const expected = localStoryFlowNativeExpectationEvidence(
							response.expected,
						),
						request = nativeRequestForOrigin(response.expected, {
							organizationId: org,
							originTaskId: id,
						});
					expect(input.prompt).toBe(expected.prompt);
					expect(input.inputHash).toBe(request.body.inputHash);
					nativeCalls.push({ taskId: id, requestKey: input.requestKey });
					const receipt: LocalSemanticObservedResult["receipt"] = {
						version: "bitovp-semantic-receipt-v1" as const,
						profile: "nvidia" as const,
						model: "qwen3.8:27b-q8_0",
						modelDigest:
							"8f5fb6b71ea00052cbe8545738c55ce61112c4e571cb60ca4dad00b131766039",
						runtimeVersion: "0.40.14",
						inputHash: input.inputHash,
						promptHash: expected.promptHash,
						schemaHash: input.schemaHash,
						promptVersion:
							input.stage === "LOCAL_FLOW_ROUTE_V1"
								? ("local-story-flow-route-v1" as const)
								: ("local-story-flow-context-v1" as const),
						context: 8192 as const,
						maxOutputTokens: 1536 as const,
						thinking: false as const,
						requestHash: request.requestHash,
						elapsedMs: 1,
						apiStats: {
							promptEvalCount: 1,
							evalCount: 1,
							doneReason: "stop" as const,
							loadDurationNs: 1,
							promptEvalDurationNs: 1,
							evalDurationNs: 1,
						},
						placement: [
							{
								name: "synthetic",
								size: 1,
								sizeVram: 1,
								contextLength: 8192 as const,
							},
						],
						cleanupConfirmed: true as const,
						schemaVerified: false as const,
					};
					return {
						content: response.output,
						receipt,
						terminalJob: {
							id: request.jobId,
							stage: input.stage,
							state: "SUCCEEDED" as const,
							requestHash: request.requestHash,
							cleanupConfirmed: true,
							result: { content: JSON.stringify(response.output), receipt },
						},
					};
				}),
			},
		});
		stores.push(runtime);
		await runtime.start();
		return { task, store: runtime, ...initial, tail: null };
	}
	async function refresh(c: Context) {
		Object.assign(c, await source(c.task));
	}
	function output(
		c: Context,
		nodeId: string,
		children: AcceptedLocalStoryFlowContextNode[],
	) {
		const s = localStoryFlowContextSourceEvidence(
				localStoryFlowSourceArchiveContext(c.archive),
			),
			plan = s.layout.nodes.find((n) => n.nodeId === nodeId);
		requireFixture(plan);
		if (plan.phase === "LEAF") {
			const page = s.pages.find((p) => p.pageId === plan.pageId);
			requireFixture(page);
			const accountedItems = page.data.items.map((item) =>
				item.kind === "DERIVED_CHUNK_SUMMARY"
					? { kind: "SUMMARY" as const, summaryId: item.id }
					: { kind: "EVENT" as const, eventId: item.id },
			);
			const event = accountedItems.find((i) => i.kind === "EVENT");
			requireFixture(event);
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
						text: "The key is held.",
						supports: [event],
						witnesses: [{ id: "w0", allOf: [event] }],
					},
				],
				relations: [],
				unresolved: [],
			};
		}
		const e = children.map(
				(ch) =>
					localStoryFlowAcceptedContextNodePublication(ch).node.payload
						.nodeEvidence as LocalStoryFlowContextNodeEvidence,
			),
			w = e[0]?.witnessProofs[0]?.ref;
		requireFixture(w);
		return {
			version: "local-story-flow-context-output-v1",
			mode: "FLOW",
			phase: "MERGE",
			nodeId,
			accountedChildren: plan.children.map((nodeId) => ({
				kind: "CHILD_NODE",
				nodeId,
			})),
			claims: [
				{
					id: "c0",
					text: "The key is held.",
					supports: e.map((n) => {
						const ref = n.claimRefs[0];
						requireFixture(ref);
						return ref;
					}),
					witnesses: [{ id: "w0", allOf: [w] }],
				},
			],
			relations: faults.hardRequirement
				? [
						{
							kind: "REQUIRES",
							from: { kind: "OWN_CLAIM", claimId: "c0" },
							target: e.at(-1)?.claimRefs[0],
						},
					]
				: [],
			unresolved: [],
		};
	}
	async function capture(
		c: Context,
		nodeId: string,
		children: AcceptedLocalStoryFlowContextNode[] = [],
	) {
		const work = prepareLocalStoryFlowContextWork({
				archive: c.archive,
				nodeId,
				children,
			}),
			expected = localStoryFlowContextWorkExpectation(work),
			request = nativeRequestForOrigin(expected, {
				organizationId: org,
				originTaskId: c.task.id,
			});
		responses.set(request.body.requestKey, {
			expected,
			output: output(c, nodeId, children),
			taskId: c.task.id,
		});
		const r = await c.store.reserve(expected, null);
		requireFixture(r.status === "RESERVED");
		const captured = await c.store.runReserved(r.reservation),
			node = acceptLocalStoryFlowContextWork({
				work,
				native: capturedLocalStoryFlowNativeEvidence(captured).native,
			});
		return {
			capture: captured,
			node,
			prepared: prepareLocalStoryFlowContextPublication({ node }),
			reservation: r.reservation,
		};
	}
	async function publish(
		c: Context,
		p: Pick<Awaited<ReturnType<typeof capture>>, "capture" | "prepared">,
	) {
		const result = await c.store.publishAccepted(
				p.capture,
				p.prepared,
				c.fence,
			),
			e = acceptedLocalStoryFlowPublicationEvidence(result);
		if (e.category === "ROUTE") c.tail = e.prefixRef;
		return result;
	}
	async function completeContext(c: Context) {
		const layout = localStoryFlowContextSourceEvidence(
				localStoryFlowSourceArchiveContext(c.archive),
			).layout.nodes,
			nodes: AcceptedLocalStoryFlowContextNode[] = [],
			byId = new Map<string, AcceptedLocalStoryFlowContextNode>();
		for (const n of layout) {
			const children =
				n.phase === "LEAF"
					? []
					: n.children.map((id) => {
							const child = byId.get(id);
							requireFixture(child);
							return child;
						});
			const p = await capture(c, n.nodeId, children);
			await publish(c, p);
			nodes.push(p.node);
			byId.set(n.nodeId, p.node);
		}
		return {
			nodes,
			context: buildLocalStoryFlowAcceptedContext({
				archive: c.archive,
				nodes,
			}),
		};
	}
	async function routeCapture(
		c: Context,
		context: BoundLocalStoryFlowAcceptedContext,
		steps: AcceptedLocalStoryFlowRouteStep[],
	) {
		const next = nextLocalStoryFlowRouteWork({
			archive: c.archive,
			context,
			steps,
		});
		requireFixture(next.status === "NEXT");
		const expected = localStoryFlowRouteWorkExpectation(next.work),
			request = nativeRequestForOrigin(expected, {
				organizationId: org,
				originTaskId: c.task.id,
			});
		responses.set(request.body.requestKey, {
			expected,
			output: routeOutput(next.work),
			taskId: c.task.id,
		});
		const r = await c.store.reserve(expected, c.tail);
		requireFixture(r.status === "RESERVED");
		const captured = await c.store.runReserved(r.reservation),
			step = acceptLocalStoryFlowRouteWork({
				work: next.work,
				native: capturedLocalStoryFlowNativeEvidence(captured).native,
			});
		return {
			capture: captured,
			step,
			prepared: prepareLocalStoryFlowRoutePublication({ step }),
			reservation: r.reservation,
		};
	}
	function pauseBridge(reject?: unknown) {
		const g = { entered: deferred<void>(), release: deferred<void>(), reject };
		gate = g;
		return g;
	}
	return {
		facts,
		faults,
		manager,
		committed,
		tasks,
		nativeCalls,
		cleanupOnly,
		queries,
		commits,
		controller,
		context,
		refresh,
		capture,
		completeContext,
		routeCapture,
		publish,
		pauseBridge,
		seed,
		now,
		nextWriteOwner: () => `WRITE${String(nextTx + 1)}`,
	};
}
it("actual bridge publishes two CURRENT nodes through the same initially-unpinned worker RR fence", async () => {
	const f = makeLab(40),
		c = await f.context(pubId(2));
	expect(vi.isMockFunction(validateLocalStoryFlowSourceArchiveReadFence)).toBe(
		false,
	);
	const leaves = localStoryFlowContextSourceEvidence(
		localStoryFlowSourceArchiveContext(c.archive),
	).layout.nodes.filter((n) => n.phase === "LEAF");
	requireFixture(leaves.length >= 2);
	const initialPins = [
		...(f.committed.get("libraryFlowEvidencePin")?.values() ?? []),
	];
	expect(initialPins).toHaveLength(1);
	const a = await f.capture(c, leaves[0]?.nodeId ?? "");
	await f.publish(c, a);
	const b = await f.capture(c, leaves[1]?.nodeId ?? "");
	await f.publish(c, b);
	expect(f.nativeCalls).toHaveLength(2);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"cancel",
	"deadline",
] as const)("classifies authoritative %s when the actual bridge SELECT rejects before its trailing guard", async (reason) => {
	vi.useFakeTimers();
	const f = makeLab(4, reason === "deadline" ? 5_399_000 : 1000),
		c = await f.context(pubId(2));
	const node = localStoryFlowContextSourceEvidence(
		localStoryFlowSourceArchiveContext(c.archive),
	).layout.nodes[0];
	requireFixture(node);
	const p = await f.capture(c, node.nodeId),
		before = new Map([...(f.committed.get("libraryEvidenceReceipt") ?? [])]),
		beforePins = new Map([
			...(f.committed.get("libraryFlowEvidencePin") ?? []),
		]);
	const gate = f.pauseBridge(),
		promise = f.publish(c, p);
	await gate.entered.promise;
	if (reason === "cancel")
		f.controller.abort(new DOMException("PRIVATE_ABORT", "AbortError"));
	else vi.advanceTimersByTime(1001);
	gate.release.resolve();
	await expect(promise).rejects.toMatchObject({
		code:
			reason === "cancel" ? "CANCELED" : "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(beforePins);
	expect(f.nativeCalls).toHaveLength(1);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it("keeps an unrelated actual-bridge transport error fixed without adopting its private code or message", async () => {
	const f = makeLab(4),
		c = await f.context(pubId(2)),
		node = localStoryFlowContextSourceEvidence(
			localStoryFlowSourceArchiveContext(c.archive),
		).layout.nodes[0];
	requireFixture(node);
	const p = await f.capture(c, node.nodeId),
		gate = f.pauseBridge(
			Object.assign(Error("PRIVATE_SQL"), { code: "CANCELED" }),
		),
		promise = f.publish(c, p);
	await gate.entered.promise;
	gate.release.resolve();
	await expect(promise).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
async function parallelMerges(sameMerge: boolean, reverse = false) {
	const f = makeLab(),
		a = await f.context(pubId(reverse ? 90 : 2)),
		b = await f.context(pubId(reverse ? 2 : 90));
	const layout = localStoryFlowContextSourceEvidence(
		localStoryFlowSourceArchiveContext(a.archive),
	).layout.nodes;
	const leafIds = new Set(
		layout.filter((n) => n.phase === "LEAF").map((n) => n.nodeId),
	);
	const pairs = layout.filter(
		(n) => n.phase === "MERGE" && n.children.every((id) => leafIds.has(id)),
	);
	requireFixture(pairs.length >= 2);
	const selected = sameMerge ? [pairs[0]] : [pairs[0], pairs[1]],
		accepted = new Map<string, AcceptedLocalStoryFlowContextNode>();
	for (const pair of selected) {
		requireFixture(pair && pair.phase === "MERGE");
		for (const [index, id] of pair.children.entries()) {
			const c = index === 0 ? a : b;
			await f.refresh(c);
			const p = await f.capture(c, id);
			await f.publish(c, p);
			accepted.set(id, p.node);
		}
	}
	const left = selected[0],
		right = sameMerge ? left : selected[1];
	requireFixture(
		left && left.phase === "MERGE" && right && right.phase === "MERGE",
	);
	await f.refresh(a);
	await f.refresh(b);
	const children = (ids: string[]) =>
		ids.map((id) => {
			const n = accepted.get(id);
			requireFixture(n);
			return n;
		});
	const pa = await f.capture(a, left.nodeId, children(left.children)),
		pb = await f.capture(b, right.nodeId, children(right.children));
	// Owner IDs are assigned to transactions when the first publication clock/lock is requested.
	// The next two WRITE transactions are the concurrently invoked publication operations.
	const priorWrites = f.commits.length;
	// Derive next transaction IDs from the actual monotonically allocated trace (RR IDs included).
	const observedIds = f.queries.map((q) =>
		Number(q.tx.replace(/^(RR|WRITE)/, "")),
	);
	const sequence = Math.max(0, ...observedIds);
	f.manager.arm([
		`WRITE${String(sequence + 1)}`,
		`WRITE${String(sequence + 2)}`,
	]);
	const outcomes = await Promise.allSettled([
		f.publish(a, pa),
		f.publish(b, pb),
	]);
	return { f, a, b, outcomes, priorWrites };
}
function assertTaskOrder(r: Awaited<ReturnType<typeof parallelMerges>>) {
	for (const owner of r.f.manager.parallelOwners) {
		const events = r.f.manager.events.filter((e) => e.owner === owner),
			queries = r.f.queries.filter((q) => q.tx === owner),
			ownAdvisory = events.find(
				(e) => e.resource.startsWith("ADV:") && e.op === "REQUEST",
			);
		requireFixture(ownAdvisory);
		const current =
			ownAdvisory.resource ===
			`ADV:${String(localStoryFlowTaskLockKey(r.a.task.id))}`
				? r.a.task
				: r.b.task;
		expect(queries[0]?.sql).toContain("clock_timestamp");
		expect(events[0]).toEqual({
			owner,
			op: "REQUEST",
			resource: `ADV:${String(localStoryFlowTaskLockKey(current.id))}`,
			mode: "UPDATE",
		});
		expect(
			events
				.filter((e) => e.op === "REQUEST" && e.resource.startsWith("ADV:"))
				.every((e) => e.resource === ownAdvisory.resource),
		).toBe(true);
		for (const op of ["REQUEST", "GRANT"] as const) {
			const first = new Map<string, LockEvent>();
			for (const e of events.filter(
				(e) => e.op === op && e.resource.startsWith("TASK:"),
			))
				if (!first.has(e.resource)) first.set(e.resource, e);
			expect([...first.keys()]).toEqual(
				[r.a.task.id, r.b.task.id].sort().map((id) => `TASK:${id}`),
			);
			for (const [id, e] of first)
				expect(e.mode).toBe(id === `TASK:${current.id}` ? "UPDATE" : "SHARE");
		}
	}
}
it.each([
	false,
	true,
])("orders all Task lock requests without a cross-origin MERGE cycle (reverse UUIDs=%s)", async (reverse) => {
	const r = await parallelMerges(false, reverse);
	expect(r.f.manager.cycles).toEqual([]);
	assertTaskOrder(r);
	expect(r.outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
	expect(r.f.manager.lateTaskLocks).toEqual([]);
	expect(r.f.commits.length - r.priorWrites).toBe(2);
	expect(r.f.cleanupOnly).not.toHaveBeenCalled();
}, 15_000);
it("keeps one exact cache winner for concurrent same-MERGE captures, without a deadlock or retry", async () => {
	const r = await parallelMerges(true);
	expect(r.f.manager.cycles).toEqual([]);
	assertTaskOrder(r);
	expect(r.outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
	const rejected = r.outcomes.find((o) => o.status === "rejected");
	requireFixture(rejected?.status === "rejected");
	expect(rejected.reason).toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(r.f.commits.length - r.priorWrites).toBe(1);
	expect(r.f.cleanupOnly).not.toHaveBeenCalled();
}, 15_000);

it.each([
	"complete",
	"deadline",
] as const)("waits behind an ordinary current-only advisory/UPDATE guard (%s)", async (condition) => {
	if (condition === "deadline") vi.useFakeTimers();
	const f = makeLab(4, condition === "deadline" ? 5_399_000 : 1000),
		c = await f.context(pubId(2)),
		node = localStoryFlowContextSourceEvidence(
			localStoryFlowSourceArchiveContext(c.archive),
		).layout.nodes[0];
	requireFixture(node);
	const p = await f.capture(c, node.nodeId),
		before = new Map(f.committed.get("libraryEvidenceReceipt")),
		beforePins = new Map(f.committed.get("libraryFlowEvidencePin")),
		advisory = `ADV:${String(localStoryFlowTaskLockKey(c.task.id))}`;
	await f.manager.acquire("ORDINARY", advisory, "UPDATE");
	await f.manager.acquire("ORDINARY", `TASK:${c.task.id}`, "UPDATE");
	const owner = f.nextWriteOwner(),
		waiting = f.manager.waitForRequest(owner, advisory),
		pending = f.publish(c, p);
	await waiting;
	expect(
		f.manager.events.some(
			(e) => e.owner === owner && e.resource.startsWith("TASK:"),
		),
	).toBe(false);
	if (condition === "deadline") vi.advanceTimersByTime(1001);
	f.manager.release("ORDINARY");
	if (condition === "deadline") {
		await expect(pending).rejects.toMatchObject({
			code: "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
		});
		expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
		expect(f.committed.get("libraryFlowEvidencePin")).toEqual(beforePins);
	} else await expect(pending).resolves.toBeTypeOf("object");
	expect(f.manager.cycles).toEqual([]);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
	expect(f.nativeCalls).toHaveLength(1);
});

function routeOutput(
	work: Parameters<typeof localStoryFlowRouteWorkExpectation>[0],
) {
	const e = localStoryFlowNativeExpectationEvidence(
			localStoryFlowRouteWorkExpectation(work),
		),
		input = e.input;
	requireFixture(input.version === "local-story-flow-route-input-v1");
	const { phase, nodeId } = input,
		common = {
			version: "local-story-flow-route-output-v1",
			mode: "FLOW",
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
		const accountedChildren = input.data.children.map((c) => ({
			kind: "CHILD_NODE",
			nodeId: c.nodeId,
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
				message: "The key is held.",
				beats: events.map((event, i) => ({
					id: `b${i}`,
					role: "ACTION",
					eventIds: [event.eventId],
					requires: [],
				})),
				uncertainty: "Synthetic structural evidence only",
			},
		};
	}
	throw Error("SYNTHETIC_ROUTE_PHASE");
}
function flowPayload(row: Row): Row {
	const p = row.proof;
	requireFixture(
		p &&
			typeof p === "object" &&
			"valueJson" in p &&
			typeof p.valueJson === "string",
	);
	return JSON.parse(p.valueJson);
}
it("publishes CURRENT ROUTE ROOT and followup atomically through the actual same RR source bridge", async () => {
	const f = makeLab(4),
		c = await f.context(pubId(2)),
		context = await f.completeContext(c);
	const root = await f.routeCapture(c, context.context, []),
		accepted = acceptedLocalStoryFlowPublicationEvidence(
			await f.publish(c, root),
		);
	requireFixture(accepted.category === "ROUTE");
	expect(accepted.acceptedStep).toBe(root.step);
	expect(accepted.nativeRoot).toBe(
		localStoryFlowAcceptedRoutePublication(root.step).nativeRoot,
	);
	const firstRef = c.tail;
	requireFixture(firstRef);
	const next = await f.routeCapture(c, context.context, [root.step]),
		second = acceptedLocalStoryFlowPublicationEvidence(
			await f.publish(c, next),
		);
	requireFixture(second.category === "ROUTE");
	const prefixes = [
		...(f.committed.get("libraryEvidenceReceipt")?.values() ?? []),
	]
		.filter((r) => r.kind === "LOCAL_FLOW_PLAN_V1")
		.map(flowPayload)
		.filter((p) => p.purpose === "ROUTE_PREFIX")
		.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
	expect(prefixes).toHaveLength(2);
	expect(prefixes[0]?.previousPrefixRef).toBeNull();
	expect(prefixes[1]?.previousPrefixRef).toEqual(firstRef);
	expect(prefixes[0]?.nativeRootProof).toBe(prefixes[1]?.nativeRootProof);
	expect(prefixes[0]?.stepRef).toEqual(accepted.artifactRef);
	expect(prefixes[1]?.stepRef).toEqual(second.artifactRef);
	for (const ref of [
		accepted.sourceArchiveRef,
		accepted.treeRef,
		accepted.observationRef,
		accepted.artifactRef,
		accepted.cacheRef,
		accepted.outcomeRef,
		accepted.prefixRef,
		second.outcomeRef,
		second.prefixRef,
	])
		expect(
			f.committed
				.get("libraryFlowEvidencePin")
				?.has([org, c.task.id, ref.receiptId].join(":")),
		).toBe(true);
	expect(f.nativeCalls).toHaveLength(context.nodes.length + 2);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it("refuses ROOT when foreign accepted context has no current-task bindings, without synthesizing them", async () => {
	const f = makeLab(4),
		a = await f.context(pubId(2)),
		old = await f.completeContext(a),
		b = await f.context(pubId(90)),
		context = buildLocalStoryFlowAcceptedContext({
			archive: b.archive,
			nodes: old.nodes,
		}),
		p = await f.routeCapture(b, context, []),
		before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin"));
	await expect(f.publish(b, p)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});

type Lab = ReturnType<typeof makeLab>;
type LabContext = Awaited<ReturnType<Lab["context"]>>;
function currentRows(f: Lab, c: LabContext, purpose: string): Row[] {
	return [...(f.committed.get("libraryEvidenceReceipt")?.values() ?? [])]
		.filter((r) => r.kind === "LOCAL_FLOW_PLAN_V1")
		.filter((r) => {
			const p = flowPayload(r);
			return (
				p.purpose === purpose &&
				(p.taskId === c.task.id ||
					(purpose === "CONTEXT_BINDING" &&
						p.startRef &&
						typeof p.startRef === "object" &&
						"receiptId" in p.startRef &&
						p.startRef.receiptId === currentRows(f, c, "START")[0]?.id))
			);
		});
}
function seedBinding(
	f: Lab,
	c: LabContext,
	view: ReturnType<typeof localStoryFlowAcceptedContextNodePublication>,
	nodeId = view.node.payload.nodeId,
) {
	const start = currentRows(f, c, "START")[0];
	requireFixture(start);
	const a = localStoryFlowSourceArchiveEvidence(c.archive),
		sourceTuple = a.payload.sourceTuple;
	requireFixture(sourceTuple && typeof sourceTuple === "object");
	const key = {
			version: "local-story-flow-record-key-v1",
			purpose: "CONTEXT_BINDING",
			keyBody: { taskId: c.task.id, nodeId },
		},
		identity = localStoryFlowRecordIdentity({
			sourceTuple,
			kind: "LOCAL_FLOW_PLAN_V1",
			key,
		}),
		startRef = {
			kind: "LOCAL_FLOW_PLAN_V1",
			receiptId: start.id,
			cacheHash: (start.proof as { cacheHash: string }).cacheHash,
			inputKeyHash: localStoryFlowRecordIdentity({
				sourceTuple,
				kind: "LOCAL_FLOW_PLAN_V1",
				key: {
					version: "local-story-flow-record-key-v1",
					purpose: "START",
					keyBody: { taskId: c.task.id },
				},
			}).inputKeyHash,
			proofHash: start.proofHash,
		},
		payload = {
			version: "local-story-flow-runtime-context-binding-v1",
			purpose: "CONTEXT_BINDING",
			startRef,
			nodeRef: view.node.ref,
			nodeHash: view.node.payload.nodeHash,
			observationRef: view.observation.ref,
		},
		proof = {
			version: "local-story-cache-v2",
			cacheHash: identity.cacheHash,
			valueJson: json(payload),
		};
	const existing = f.committed
		.get("libraryEvidenceReceipt")
		?.get(identity.receiptId);
	if (existing) {
		expect(flowPayload(existing)).toEqual(payload);
		return;
	}
	// A valid cache-binding history fixture, not a cache-only publication API or DB write.
	f.seed("libraryEvidenceReceipt", {
		id: identity.receiptId,
		organizationId: org,
		sourceId: f.facts.media.sourceId,
		mediaVersionId: f.facts.media.id,
		analysisRevisionId: f.facts.analysis.id,
		kind: "LOCAL_FLOW_PLAN_V1",
		proof,
		proofHash: hash(proof),
		createdBy: null,
	});
	f.seed("libraryFlowEvidencePin", {
		organizationId: org,
		taskId: c.task.id,
		receiptId: identity.receiptId,
	});
}
it("preserves exact reconstructed NODE/OBS aliases with old MERGE children and no extra native calls", async () => {
	const f = makeLab(40),
		c = await f.context(pubId(2)),
		old = await f.completeContext(c);
	await f.refresh(c);
	const aliases = old.nodes.map((node) => {
		const v = localStoryFlowAcceptedContextNodePublication(node),
			work = prepareLocalStoryFlowContextWork({
				archive: c.archive,
				nodeId: v.node.payload.nodeId,
				children: v.children,
			}),
			alias = acceptLocalStoryFlowContextWork({ work, native: v.native }),
			copy = localStoryFlowAcceptedContextNodePublication(alias);
		expect(alias).not.toBe(node);
		expect(copy.node).toEqual(v.node);
		expect(copy.observation).toEqual(v.observation);
		expect(copy.cache).toEqual(v.cache);
		expect(admittedFlowNativeEvidence(copy.native).origin).toEqual(
			admittedFlowNativeEvidence(v.native).origin,
		);
		return alias;
	});
	const context = buildLocalStoryFlowAcceptedContext({
			archive: c.archive,
			nodes: aliases,
		}),
		all = new Set<AcceptedLocalStoryFlowContextNode>(),
		pending = [...localStoryFlowAcceptedContextPublication(context).nodes],
		refs = new Set<string>();
	while (pending.length) {
		const n = pending.pop();
		requireFixture(n);
		if (all.has(n)) continue;
		all.add(n);
		const v = localStoryFlowAcceptedContextNodePublication(n);
		refs.add(v.node.ref.receiptId);
		pending.push(...v.children);
	}
	expect(all.size).toBeGreaterThan(refs.size);
	expect(refs.size).toBe(aliases.length);
	const p = await f.routeCapture(c, context, []);
	await f.publish(c, p);
	expect(f.nativeCalls).toHaveLength(old.nodes.length + 1);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it("rejects an extra coherent current binding before ROOT without deleting or replacing it", async () => {
	const f = makeLab(4),
		c = await f.context(pubId(2)),
		ctx = await f.completeContext(c),
		first = ctx.nodes[0];
	requireFixture(first);
	seedBinding(f, c, localStoryFlowAcceptedContextNodePublication(first), "n62");
	const p = await f.routeCapture(c, ctx.context, []),
		before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin"));
	await expect(f.publish(c, p)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
});
it.each([
	"nativeRootProof",
	"progressHash",
] as const)("rejects a coherent current PREFIX %s that differs from the owned previous route", async (field) => {
	const f = makeLab(4),
		c = await f.context(pubId(2)),
		ctx = await f.completeContext(c),
		root = await f.routeCapture(c, ctx.context, []);
	await f.publish(c, root);
	const old = currentRows(f, c, "ROUTE_PREFIX")[0];
	requireFixture(old && c.tail);
	const body = flowPayload(old);
	delete body.prefixHash;
	body[field] = hash("SYNTHETIC_COHERENT_WRONG_MIRROR");
	const value = { ...body, prefixHash: hash(body) },
		proof = {
			version: "local-story-cache-v2",
			cacheHash: c.tail.cacheHash,
			valueJson: json(value),
		};
	old.proof = proof;
	old.proofHash = hash(proof);
	c.tail = { ...c.tail, proofHash: hash(proof) };
	const next = await f.routeCapture(c, ctx.context, [root.step]),
		before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin"));
	await expect(f.publish(c, next)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"TREE",
	"NATIVE_OBSERVATION",
	"STEP",
	"NATIVE_CACHE",
	"OUTCOME",
	"ROUTE_PREFIX",
	"PIN",
])("rolls back every CURRENT ROUTE record and pin on %s failure", async (purpose) => {
	const f = makeLab(4),
		c = await f.context(pubId(2)),
		ctx = await f.completeContext(c),
		p = await f.routeCapture(c, ctx.context, []),
		before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin")),
		calls = f.nativeCalls.length;
	if (purpose === "PIN") f.faults.pin = true;
	else f.faults.purpose = purpose;
	await expect(f.publish(c, p)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
	expect(c.tail).toBeNull();
	await expect(f.publish(c, p)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.nativeCalls).toHaveLength(calls);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"cancel",
	"deadline",
	"lease",
] as const)("rolls back ROUTE after a late authoritative %s", async (condition) => {
	vi.useFakeTimers();
	const f = makeLab(4, condition === "deadline" ? 5_399_000 : 1000),
		c = await f.context(pubId(2)),
		ctx = await f.completeContext(c),
		p = await f.routeCapture(c, ctx.context, []),
		before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin"));
	if (condition === "lease") {
		const row = f.committed.get("libraryMediaTask")?.get(c.task.id);
		requireFixture(row);
		row.leaseUntil = new Date(f.now() + 500);
	}
	f.faults.afterWrite = (purpose) => {
		if (purpose === "ROUTE_PREFIX") {
			if (condition === "cancel") f.controller.abort();
			else vi.advanceTimersByTime(condition === "lease" ? 501 : 1001);
		}
	};
	await expect(f.publish(c, p)).rejects.toMatchObject({
		code:
			condition === "cancel"
				? "CANCELED"
				: condition === "lease"
					? "LEASE_LOST"
					: "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
async function distributedRouteFixture(targetFrames = 180) {
	const f = makeLab(40),
		a = await f.context(pubId(2)),
		b = await f.context(pubId(90), targetFrames),
		layout = localStoryFlowContextSourceEvidence(
			localStoryFlowSourceArchiveContext(a.archive),
		).layout.nodes,
		nodes: AcceptedLocalStoryFlowContextNode[] = [],
		byId = new Map<string, AcceptedLocalStoryFlowContextNode>();
	for (const [i, n] of layout.entries()) {
		const owner = i % 2 ? a : b,
			children =
				n.phase === "LEAF"
					? []
					: n.children.map((id) => {
							const child = byId.get(id);
							requireFixture(child);
							return child;
						}),
			p = await f.capture(owner, n.nodeId, children);
		await f.publish(owner, p);
		nodes.push(p.node);
		byId.set(n.nodeId, p.node);
	}
	// Pre-existing current bindings are independently sealed fixture facts; no cache-only publisher is added.
	for (const owner of [a, b])
		for (const n of nodes)
			seedBinding(f, owner, localStoryFlowAcceptedContextNodePublication(n));
	const ca = buildLocalStoryFlowAcceptedContext({ archive: a.archive, nodes }),
		cb = buildLocalStoryFlowAcceptedContext({ archive: b.archive, nodes });
	return { f, a, b, nodes, ca, cb };
}
it("commits different-target ROUTE ROOTs with both foreign-origin Task lock sets and actual bridge validators", async () => {
	const { f, a, b, nodes, ca, cb } = await distributedRouteFixture(),
		pa = await f.routeCapture(a, ca, []),
		pb = await f.routeCapture(b, cb, []),
		sequence = Math.max(
			...f.queries.map((q) => Number(q.tx.replace(/^(RR|WRITE)/, ""))),
		);
	f.manager.arm([`WRITE${sequence + 1}`, `WRITE${sequence + 2}`]);
	const before = f.commits.length,
		outcomes = await Promise.allSettled([f.publish(a, pa), f.publish(b, pb)]);
	expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
	expect(f.manager.cycles).toEqual([]);
	expect(f.manager.lateTaskLocks).toEqual([]);
	expect(f.commits.length - before).toBe(2);
	expect(f.nativeCalls).toHaveLength(nodes.length + 2);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
	for (const owner of f.manager.parallelOwners) {
		const actual = [
			...new Map(
				f.manager.events
					.filter(
						(e) =>
							e.owner === owner &&
							e.op === "REQUEST" &&
							e.resource.startsWith("TASK:"),
					)
					.map((e) => [e.resource, e]),
			).keys(),
		];
		expect(actual).toEqual(
			[a.task.id, b.task.id].sort().map((id) => `TASK:${id}`),
		);
	}
});

it("publishes the complete ROOT/WITNESS/BRANCH/LEAF/FINALIZE chain while leaving final PLAN absent", async () => {
	const f = makeLab(40);
	f.faults.hardRequirement = true;
	const c = await f.context(pubId(2), 180),
		ctx = await f.completeContext(c),
		steps: AcceptedLocalStoryFlowRouteStep[] = [],
		phases: string[] = [];
	for (let i = 0; i < 64; i++) {
		const next = nextLocalStoryFlowRouteWork({
			archive: c.archive,
			context: ctx.context,
			steps,
		});
		if (next.status === "COMPLETE") break;
		const p = await f.routeCapture(c, ctx.context, steps),
			view = localStoryFlowAcceptedRoutePublication(p.step);
		phases.push(view.step.payload.stepEvidence.phase);
		await f.publish(c, p);
		steps.push(p.step);
	}
	expect(
		nextLocalStoryFlowRouteWork({
			archive: c.archive,
			context: ctx.context,
			steps,
		}).status,
	).toBe("COMPLETE");
	for (const phase of ["ROOT", "WITNESS", "BRANCH", "LEAF", "FINALIZE"])
		expect(phases).toContain(phase);
	expect(currentRows(f, c, "ROUTE_PREFIX")).toHaveLength(steps.length);
	expect(currentRows(f, c, "PLAN")).toEqual([]);
	expect(f.nativeCalls).toHaveLength(ctx.nodes.length + steps.length);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"CONFIRMED",
	"UNCONFIRMED",
] as const)("preserves original ROUTE FAILED/%s priority over cancellation and invalid source-fence data", async (cleanup) => {
	const f = makeLab(4),
		c = await f.context(pubId(2)),
		ctx = await f.completeContext(c),
		p = await f.routeCapture(c, ctx.context, []);
	await c.store.recordFailed(p.reservation, "SOURCE_CHANGED", cleanup);
	f.controller.abort();
	const before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin"));
	await expect(
		c.store.publishAccepted(p.capture, p.prepared, {}),
	).rejects.toMatchObject({
		code:
			cleanup === "UNCONFIRMED"
				? "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"
				: "SOURCE_CHANGED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"cancel",
	"deadline",
] as const)("keeps authoritative ROUTE %s after actual bridge SELECT rejection", async (condition) => {
	vi.useFakeTimers();
	const f = makeLab(4, condition === "deadline" ? 5_399_000 : 1000),
		c = await f.context(pubId(2)),
		ctx = await f.completeContext(c),
		p = await f.routeCapture(c, ctx.context, []),
		before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin")),
		gate = f.pauseBridge(),
		promise = f.publish(c, p);
	await gate.entered.promise;
	if (condition === "cancel")
		f.controller.abort(new DOMException("PRIVATE_ROUTE_ABORT", "AbortError"));
	else vi.advanceTimersByTime(1001);
	gate.release.resolve();
	await expect(promise).rejects.toMatchObject({
		code:
			condition === "cancel"
				? "CANCELED"
				: "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});

it.each([
	"startedAt",
	"startPin",
	"outcome",
] as const)("revalidates each foreign original %s before ROOT instead of trusting retained context handles", async (changed) => {
	const { f, a, b, ca } = await distributedRouteFixture(),
		p = await f.routeCapture(a, ca, []);
	if (changed === "startedAt") {
		const row = f.committed.get("libraryMediaTask")?.get(b.task.id);
		requireFixture(row && row.startedAt instanceof Date);
		row.startedAt = new Date(row.startedAt.getTime() + 1);
	}
	if (changed === "startPin") {
		const start = currentRows(f, b, "START")[0];
		requireFixture(start);
		f.committed
			.get("libraryFlowEvidencePin")
			?.delete([org, b.task.id, start.id].join(":"));
	}
	if (changed === "outcome") {
		const outcome = currentRows(f, b, "OUTCOME")[0];
		requireFixture(outcome);
		f.committed.get("libraryEvidenceReceipt")?.delete(String(outcome.id));
	}
	const before = new Map(f.committed.get("libraryEvidenceReceipt")),
		pins = new Map(f.committed.get("libraryFlowEvidencePin"));
	await expect(f.publish(a, p)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.committed.get("libraryEvidenceReceipt")).toEqual(before);
	expect(f.committed.get("libraryFlowEvidencePin")).toEqual(pins);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
it("keeps one exact CURRENT ROOT cache winner across two tasks without deadlock, re-adoption or retry", async () => {
	const { f, a, b, nodes, ca, cb } = await distributedRouteFixture(90),
		pa = await f.routeCapture(a, ca, []),
		pb = await f.routeCapture(b, cb, []),
		sequence = Math.max(
			...f.queries.map((q) => Number(q.tx.replace(/^(RR|WRITE)/, ""))),
		);
	f.manager.arm([`WRITE${sequence + 1}`, `WRITE${sequence + 2}`]);
	const before = f.commits.length,
		outcomes = await Promise.allSettled([f.publish(a, pa), f.publish(b, pb)]);
	expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
	const failed = outcomes.find((o) => o.status === "rejected");
	requireFixture(failed?.status === "rejected");
	expect(failed.reason).toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.manager.cycles).toEqual([]);
	expect(f.manager.lateTaskLocks).toEqual([]);
	expect(f.commits.length - before).toBe(1);
	expect(f.nativeCalls).toHaveLength(nodes.length + 2);
	expect(f.cleanupOnly).not.toHaveBeenCalled();
});
