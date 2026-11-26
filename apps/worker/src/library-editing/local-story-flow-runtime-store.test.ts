import { createHash } from "node:crypto";
import {
	buildLocalStoryChunks,
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
	canonicalEditingJson,
	cfrTimeMapSchema,
	editingAnalysisBindingSchema,
	hashEditingEvidence as hash,
	LOCAL_STORY_FLOW_H1_POLICY,
	type LocalStoryInput,
	localStoryFlowGenerationPolicyFingerprint,
	localStoryFlowStageRegistry,
	localStoryStageRegistry,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import {
	type AcceptedLocalStoryFlowContextNode,
	acceptLocalStoryFlowContextWork,
	admitLocalStoryFlowArchiveTranscript,
	admittedFlowNativeEvidence,
	buildLocalStoryFlowContextNode,
	buildLocalStoryFlowContextTree,
	buildLocalStoryFlowRouteExpectation,
	buildLocalStoryFlowSourceArchive,
	contextNativeExpectation,
	LOCAL_STORY_FLOW_CLOSURE_POLICY,
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	LOCAL_STORY_FLOW_SCOPE_POLICY,
	type LocalStoryFlowArchiveSourceSnapshots,
	type LocalStoryFlowContextNodeEvidence,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowAcceptedContextNodePublication,
	localStoryFlowArchiveLedgerRequests,
	localStoryFlowArchiveLedgerStageRequest,
	localStoryFlowArchivePreparationEvidence,
	localStoryFlowArchiveTranscriptEvidence,
	localStoryFlowContextSourceEvidence,
	localStoryFlowContextWorkExpectation,
	localStoryFlowNativeExpectationEvidence,
	localStoryFlowNativeRequestIds,
	localStoryFlowRecordIdentity,
	localStoryFlowRuntimeKeys,
	localStoryFlowRuntimeSignature,
	localStoryFlowRuntimeStartRecord,
	localStoryFlowSourceArchiveContext,
	nativeRequestForOrigin,
	prepareLocalStoryFlowArchiveSource,
	prepareLocalStoryFlowContextSourceFromPin,
	prepareLocalStoryFlowContextWork,
	prepareLocalStoryFlowRuntimeIdentity,
	routeNativeExpectation,
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
import {
	type AppPrismaClient,
	type LibraryEvidenceReceipt,
	type LibraryMediaTask,
	LibraryMediaTaskEvidenceError,
	TENANT_ORGANIZATION,
} from "@bitovp/db";
import { localStoryFlowTaskLockKey } from "@bitovp/db/library-flow";
import { afterEach, expect, it, vi } from "vitest";
import {
	type LocalSemanticObservedResult,
	type LocalSemanticRunInput,
	localSemanticJobId,
} from "./local-semantic-client";
import { prepareLocalStoryFlowContextPublication } from "./local-story-flow-publication";
import {
	acceptedLocalStoryFlowPublicationEvidence,
	capturedLocalStoryFlowNativeEvidence,
	createLocalStoryFlowRuntimeStore,
} from "./local-story-flow-runtime-store";
import type { VerifiedMediaTask } from "./media-task-execution";
import { MediaOperationError } from "./process";

const mocked = vi.hoisted(() => ({ verify: vi.fn(), sourceFence: vi.fn() }));
vi.mock("@bitovp/db", async (original) => ({
	...(await original<typeof import("@bitovp/db")>()),
	verifyLibraryMediaTaskEvidence: mocked.verify,
}));
vi.mock("@bitovp/db/library-flow", async (original) => ({
	...(await original<typeof import("@bitovp/db/library-flow")>()),
	validateLocalStoryFlowSourceArchiveReadFence: mocked.sourceFence,
}));
const stores: Array<ReturnType<typeof createLocalStoryFlowRuntimeStore>> = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const org = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const lease = "00000000-0000-4000-8000-000000000003";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const json = canonicalEditingJson;

function ownedInput() {
	const pin = {
		profile: "nvidia" as const,
		configId: "44444444-4444-4444-8444-444444444444",
	};
	const model = localStoryIdentityForModelPin(pin),
		workflow = localStoryFlowIdentityForModelPin(pin, "FLOW");
	const map = cfrTimeMapSchema.parse({
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 3_000_000,
		editingStartFrame: 0,
		editingEndFrame: 90,
		fps: { num: 30, den: 1 },
	});
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "合成の鍵",
		description: "合成の人物が鍵を見つける。",
		timeMap: map,
		timeMapHash: hash(map),
		segments: [],
		scenes: [{ sceneId: "scene", text: "合成の場面", fields: [] }],
		shots: [
			{
				ref: "s0",
				sceneId: "scene",
				shotIndex: 0,
				fromFrame: 0,
				toFrame: 90,
				text: "合成の人物は鍵を見つける。",
				fields: [
					{
						kind: "AISA",
						pointer: "/shots/0",
						text: "合成の人物は鍵を見つける。",
					},
				],
			},
		],
		coverage: [{ ref: "s0", status: "ELIGIBLE" }],
	};
	const chunks = buildLocalStoryChunks(input),
		transcriptFingerprint = hash("synthetic transcript");
	const ledgers = [
		{
			summary: "人物が鍵を見つける。",
			events: [
				{
					id: "e0",
					label: "鍵を見つける",
					role: "ACTION" as const,
					refs: ["s0"],
					quotes: [{ ref: "s0", quote: "鍵を見つける。" }],
					subjects: ["人物"],
					uncertainty: "合成",
				},
			],
		},
	];
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
		},
		manifest = buildLocalStoryFlowManifest(h0),
		pages = buildLocalStoryFlowLeafPages(manifest);
	const source = prepareLocalStoryFlowContextSourceFromPin({
		h0,
		manifest,
		pages,
		workflow,
		pin,
		mode: "FLOW",
	});
	const policies = {
		version: "local-story-flow-task-policies-v1" as const,
		workflowPolicyHash: hash(LOCAL_STORY_FLOW_H1_POLICY),
		contextPolicyHash: hash(LOCAL_STORY_FLOW_CONTEXT_POLICY),
		closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		routePolicyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
		promptPolicyHash: hash(LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
		scopePolicyHash: hash("synthetic scope"),
		engineValidationPolicyHash: hash(
			"synthetic unimplemented engine, not READY",
		),
		deliveryPolicyHash: hash("synthetic unimplemented delivery, not READY"),
	};
	const expectation = contextNativeExpectation({
		source,
		nodeId: "n0",
		children: [],
		pin: { modelPin: pin, policies },
	});
	return { map, model, workflow, policies, expectation, source, pin };
}

// In-memory transaction/SQL contract fake. This is not PostgreSQL/RLS/commit evidence.
function fixture(
	ageMs = 1000,
	policyOverride: Partial<ReturnType<typeof ownedInput>["policies"]> = {},
	publication?: ReturnType<typeof publicationSource>,
) {
	const real = publication ?? ownedInput(),
		nowMs = Date.parse("2026-11-07T01:00:00Z"),
		controller = new AbortController();
	const policies = { ...real.policies, ...policyOverride };
	const task = {
		id: taskId,
		organizationId: org,
		kind: "GENERATE",
		mediaVersionId: real.map.mediaVersionId,
		analysisRevisionId: "55555555-5555-4555-8555-555555555555",
		requestKey: taskId,
		requestHash: hash("request"),
		cacheKey: hash("cache"),
		parentTaskId: null,
		createdBy: null,
		startedAt: new Date(nowMs - ageMs),
		state: "RUNNING",
		leaseToken: lease,
		leaseUntil: new Date(nowMs + 10_000_000),
		cancelRequestedAt: null,
	};
	if (publication) Object.assign(task, publication.snapshots.task);
	const media = publication
		? publication.snapshots.mediaSnapshot
		: {
				organizationId: org,
				id: real.map.mediaVersionId,
				sourceId: "66666666-6666-4666-8666-666666666666",
				sha256: hash("synthetic media"),
				timeMap: real.map,
			};
	const parameters = {
		contentId: "77777777-7777-4777-8777-777777777777",
		variants: 1,
		captions: "OFF",
		tracking: false,
		language: "auto",
		policy: "LOCAL_STORY",
		storyMode: "FLOW",
		renderMode: "DRAFT",
		storyWorkflowVersion: "hierarchical-flow-v1",
		targetDurationFrames: 90,
	};
	const verified = publication
		? ({
				media,
				map: real.map,
				binding: publication.snapshots.bindingSnapshot,
				envelope: publication.snapshots.task.parameters,
				preparedNormalization:
					publication.snapshots.normalizationSnapshot ?? undefined,
			} as unknown as VerifiedMediaTask)
		: ({
				media,
				map: real.map,
				binding: { marker: "synthetic independently checked binding" },
				envelope: {
					schemaVersion: 1,
					input: {
						kind: "GENERATE",
						mediaVersionId: media.id,
						analysisRevisionId: task.analysisRevisionId,
						requestKey: task.requestKey,
						parameters,
					},
					identity: {
						organizationId: org,
						mediaSha256: media.sha256,
						modelSha256: null,
						timeMapHash: hash(real.map),
						bindingHash: hash({
							marker: "synthetic independently checked binding",
						}),
						analysisRawHash: hash("raw"),
						analysisDocumentHash: hash("document"),
						localStoryModel: real.model,
						localStoryWorkflow: real.workflow,
						generationPolicyFingerprint:
							localStoryFlowGenerationPolicyFingerprint(policies),
					},
				},
			} as unknown as VerifiedMediaTask);
	const current = {
		...task,
		parameters: verified.envelope,
	} as unknown as LibraryMediaTask;
	const tuple: LocalStoryFlowSourceTuple = {
		version: "local-story-flow-source-tuple-v1",
		organizationId: org,
		sourceId: media.sourceId,
		mediaVersionId: media.id,
		mediaSha256: media.sha256,
		timeMapHash: hash(real.map),
		analysisRevisionId: task.analysisRevisionId,
		analysisRawHash: verified.envelope.identity.analysisRawHash as string,
		analysisDocumentHash: verified.envelope.identity
			.analysisDocumentHash as string,
		bindingHash: hash(verified.binding),
		preparedShotClockHash:
			publication?.identity &&
			Reflect.get(publication.identity, "preparedShotClock")
				? hash(Reflect.get(publication.identity, "preparedShotClock"))
				: null,
		normalizationReceiptHash:
			publication?.snapshots.normalizationSnapshot?.proofHash ?? null,
	};
	const rows = new Map<string, LibraryEvidenceReceipt>(
			publication
				? [...publication.legacyRows].map(([id, row]) => [
						id,
						structuredClone(row) as unknown as LibraryEvidenceReceipt,
					])
				: [],
		),
		pins = new Set<string>();
	const state = {
		nowMs,
		inTransaction: false,
		pinFailure: false,
		missingSource: "",
		sourceChanged: false,
		sourceFailure: false,
		writes: 0,
		modelContent: undefined as unknown,
		failPurpose: "",
		normalizationRows: [] as LibraryEvidenceReceipt[],
		clockResponseLatencyMs: 0,
		waitAt: "",
		waitOccurrence: 1,
		waitAdvanceMs: 0,
		abortAfterWait: false,
		duringObserved: undefined as (() => void) | undefined,
		beforeCommit: undefined as (() => void) | undefined,
	};
	const awaitedCounts = new Map<string, number>();
	function afterAwait(at: string) {
		const count = (awaitedCounts.get(at) ?? 0) + 1;
		awaitedCounts.set(at, count);
		if (state.waitAt !== at || state.waitOccurrence !== count) return;
		state.waitAt = "";
		if (state.waitAdvanceMs) vi.advanceTimersByTime(state.waitAdvanceMs);
		if (state.abortAfterWait) controller.abort();
	}
	const runtimeId = (purpose: "START" | "ATTEMPT" | "OUTCOME") =>
		localStoryFlowRecordIdentity({
			sourceTuple: tuple,
			kind: "LOCAL_FLOW_PLAN_V1",
			key: {
				version: "local-story-flow-record-key-v1",
				purpose,
				keyBody: purpose === "START" ? { taskId } : { taskId, slot: 1 },
			},
		}).receiptId;
	const native = localStoryFlowNativeExpectationEvidence(real.expectation);
	const ids = new Map([
		[runtimeId("START"), "START"],
		[runtimeId("ATTEMPT"), "ATTEMPT"],
		[runtimeId("OUTCOME"), "OUTCOME"],
		[
			localStoryFlowRecordIdentity({
				sourceTuple: tuple,
				kind: "LOCAL_FLOW_CONTEXT_V1",
				key: {
					version: "local-story-flow-record-key-v1",
					purpose: "NATIVE_CACHE",
					keyBody: { nativeKeyHash: native.nativeKeyHash },
				},
			}).receiptId,
			"CACHE",
		],
	]);
	const queries: string[] = [];
	const client = {
		runObserved: vi.fn(async (input: LocalSemanticRunInput) => {
			expect(state.inTransaction).toBe(false);
			const attempts = [...rows.values()].filter(
				(r) => payload(r).purpose === "ATTEMPT",
			);
			if (!publication) expect(attempts).toHaveLength(1);
			else
				expect(
					attempts.at(-1) &&
						payload(attempts.at(-1) as LibraryEvidenceReceipt).requestKey,
				).toBe(input.requestKey);
			expect(pins.has(attempts[0]?.id ?? "missing")).toBe(true);
			state.duringObserved?.();
			const requestBody = {
				version: "bitovp-semantic-job-v1",
				organizationId: input.organizationId,
				requestKey: input.requestKey,
				profile: "nvidia",
				stage: input.stage,
				prompt: input.prompt,
				inputHash: input.inputHash,
				promptVersion: "local-story-flow-context-v1",
				schemaHash: input.schemaHash,
			};
			const receipt: LocalSemanticObservedResult["receipt"] = {
				version: "bitovp-semantic-receipt-v1" as const,
				profile: "nvidia" as const,
				model: "qwen3.8:27b-q8_0",
				modelDigest:
					"8f5fb6b71ea00052cbe8545738c55ce61112c4e571cb60ca4dad00b131766039",
				runtimeVersion: "0.40.14",
				inputHash: input.inputHash,
				promptHash: digest(input.prompt),
				schemaHash: input.schemaHash,
				promptVersion: "local-story-flow-context-v1" as const,
				context: 8192 as const,
				maxOutputTokens: 1536 as const,
				thinking: false as const,
				requestHash: hash(requestBody),
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
						size: 2,
						sizeVram: 1,
						contextLength: 8192 as const,
					},
				],
				cleanupConfirmed: true as const,
				schemaVerified: false as const,
			};
			return {
				content: publication ? state.modelContent : { synthetic: true },
				receipt,
				terminalJob: {
					id: localSemanticJobId(org, input.requestKey),
					state: "SUCCEEDED" as const,
					stage: input.stage,
					requestHash: hash(requestBody),
					cleanupConfirmed: true,
					result: {
						content: publication
							? JSON.stringify(state.modelContent)
							: ' {"synthetic":true}\n',
						receipt,
					},
				},
			};
		}),
		cleanupOnly: vi.fn(async () => ({
			cleanupConfirmed: true as const,
			outcome: "TERMINAL" as const,
			state: "SUCCEEDED" as const,
		})),
	};
	const db = {
		[TENANT_ORGANIZATION]: org,
		$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			queries.push(sql);
			if (sql.includes("clock_timestamp")) {
				const measured = BigInt(state.nowMs);
				if (state.clockResponseLatencyMs)
					vi.advanceTimersByTime(state.clockResponseLatencyMs);
				return [{ nowMs: measured }];
			}
			if (sql.includes('FROM "LibraryEvidenceReceipt"')) {
				const found = sql.includes("\"kind\" = 'NORMALIZATION_CAPTURE'")
					? state.normalizationRows
					: [...rows.values()].filter((row) => row.id === values[1]);
				afterAwait("PUB_RECEIPT_READ");
				return structuredClone(
					found.map((row) => ({
						id: row.id,
						organizationId: row.organizationId,
						sourceId: row.sourceId,
						mediaVersionId: row.mediaVersionId,
						analysisRevisionId: row.analysisRevisionId,
						kind: row.kind,
						proof: row.proof,
						proofHash: row.proofHash,
					})),
				);
			}
			if (sql.includes('FROM "LibraryMediaTask"'))
				return [structuredClone(current)];
			for (const name of [
				"LibrarySource",
				"LibraryMediaVersion",
				"SceneAnalysisRevision",
				"LibraryAnalysisBinding",
			])
				if (sql.includes(`FROM "${name}"`)) {
					afterAwait(`QUERY:${name}`);
					return state.missingSource === name ? [] : [{ id: name }];
				}
			throw new Error("Unexpected fake SQL");
		},
		$executeRaw: vi.fn(async (_sql: TemplateStringsArray, _lock: bigint) => 1),
		libraryEvidenceReceipt: {
			findUnique: async ({ where }: { where: { id: string } }) => {
				const found = structuredClone(rows.get(where.id) ?? null);
				afterAwait(`FIND:${ids.get(where.id) ?? "OTHER"}`);
				return found;
			},
			findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
				afterAwait("SCAN");
				return structuredClone(
					[...rows.values()].filter((r) => where.id.in.includes(r.id)),
				);
			},
			create: async ({ data }: { data: LibraryEvidenceReceipt }) => {
				expect(state.inTransaction).toBe(true);
				state.writes++;
				if (state.failPurpose === payload(data).purpose)
					throw new Error("PRIVATE_INSERT_FAILURE");
				if (rows.has(data.id)) throw new Error("duplicate fake row");
				rows.set(data.id, structuredClone(data));
				afterAwait(`CREATE:${ids.get(data.id) ?? "OTHER"}`);
				afterAwait(`PUB_CREATE:${String(payload(data).purpose)}`);
				return structuredClone(data);
			},
		},
		libraryFlowEvidencePin: {
			createMany: async ({ data }: { data: Array<{ receiptId: string }> }) => {
				if (state.pinFailure) throw new Error("PRIVATE_PIN_FAILURE");
				for (const p of data) pins.add(p.receiptId);
				for (const p of data) {
					const row = rows.get(p.receiptId);
					if (row) afterAwait(`PUB_PIN:${String(payload(row).purpose)}`);
				}
				for (const p of data)
					afterAwait(`PIN:${ids.get(p.receiptId) ?? "OTHER"}`);
				return { count: data.length };
			},
			findMany: async ({ where }: { where: { receiptId: { in: string[] } } }) =>
				[...pins]
					.filter((id) => where.receiptId.in.includes(id))
					.map((receiptId) => ({ organizationId: org, taskId, receiptId })),
		},
		$transaction: async <T>(work: (tx: AppPrismaClient) => Promise<T>) => {
			const priorRows = structuredClone(rows),
				priorPins = new Set(pins);
			expect(state.inTransaction).toBe(false);
			state.inTransaction = true;
			try {
				const result = await work(db as unknown as AppPrismaClient);
				state.beforeCommit?.();
				return result;
			} catch (error) {
				rows.clear();
				for (const [k, v] of priorRows) rows.set(k, v);
				pins.clear();
				for (const id of priorPins) pins.add(id);
				throw error;
			} finally {
				state.inTransaction = false;
			}
		},
	};
	mocked.verify.mockImplementation(async () => {
		afterAwait("VERIFY");
		if (state.sourceFailure)
			throw new LibraryMediaTaskEvidenceError("SOURCE_CHANGED");
		return state.sourceChanged
			? { ...verified, media: { ...verified.media, sha256: hash("changed") } }
			: verified;
	});
	const options = {
		prisma: db as unknown as AppPrismaClient,
		task: current,
		verified,
		leaseToken: lease,
		connectionHash: hash("owned connection"),
		policies,
		client,
		signal: controller.signal,
	};
	const store = createLocalStoryFlowRuntimeStore(options);
	stores.push(store);
	function insert(
		kind: LocalStoryFlowRecordRef["kind"],
		key: LocalStoryFlowRecordKey,
		body: Record<string, unknown>,
	) {
		const id = localStoryFlowRecordIdentity({ sourceTuple: tuple, kind, key });
		const proof = {
				version: "local-story-cache-v2",
				cacheHash: id.cacheHash,
				valueJson: json(body),
			},
			proofHash = hash(proof);
		rows.set(id.receiptId, {
			id: id.receiptId,
			organizationId: org,
			sourceId: tuple.sourceId,
			mediaVersionId: tuple.mediaVersionId,
			analysisRevisionId: tuple.analysisRevisionId,
			kind,
			proof,
			proofHash,
			createdBy: null,
			createdAt: new Date(state.nowMs),
			jobId: null,
			encodingId: null,
		} as unknown as LibraryEvidenceReceipt);
		pins.add(id.receiptId);
		return { kind, ...id, proofHash };
	}
	function runtime(
		purpose: string,
		locator: string | number | null,
		body: Record<string, unknown>,
	) {
		return insert(
			"LOCAL_FLOW_PLAN_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose: purpose as LocalStoryFlowRecordKey["purpose"],
				keyBody:
					purpose === "START"
						? { taskId }
						: purpose === "CONTEXT_BINDING"
							? { taskId, nodeId: locator }
							: purpose === "ROUTE_PREFIX"
								? { taskId, ordinal: locator }
								: { taskId, slot: locator },
			},
			body,
		);
	}
	return {
		real,
		options,
		store,
		client,
		db,
		current,
		verified,
		tuple,
		state,
		rows,
		pins,
		queries,
		afterAwait,
		controller,
		insert,
		runtime,
	};
}
function payload(row: LibraryEvidenceReceipt): Record<string, unknown> {
	if (row.kind === "NORMALIZATION_CAPTURE" || row.kind === "EDITOR_ATTESTATION")
		return { purpose: row.kind };
	const proof = row.proof as { valueJson?: unknown };
	if (typeof proof.valueJson !== "string")
		throw new Error("invalid fake proof");
	return JSON.parse(proof.valueJson);
}
const getReservation = async (f: ReturnType<typeof fixture>) => {
	await f.store.start();
	const r = await f.store.reserve(f.real.expectation, null);
	if (r.status !== "RESERVED") throw new Error("Expected fake reservation");
	return r.reservation;
};

// These historical rows test sealed accounting, not P4 node/step grounding admission.
function syntheticRef(
	kind: LocalStoryFlowRecordRef["kind"],
	label: string,
): LocalStoryFlowRecordRef {
	const d = hash(label);
	return {
		kind,
		receiptId: `${d.slice(0, 8)}-${d.slice(8, 12)}-5${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`,
		cacheHash: hash(`${label}:cache`),
		inputKeyHash: hash(`${label}:key`),
		proofHash: hash(`${label}:proof`),
	};
}
async function seedHistory(
	f: ReturnType<typeof fixture>,
	context: number,
	route: number,
	sameSemantic = false,
	mutateNative?: (nativeKey: Record<string, unknown>) => void,
) {
	const start = await f.store.start();
	let tail: LocalStoryFlowRecordRef | null = null;
	const original = localStoryFlowNativeExpectationEvidence(f.real.expectation);
	for (let index = 0; index < context + route; index++) {
		const isContext = index < context,
			ordinal = index - context + 1,
			slot = index + 1;
		const stage = isContext ? "LOCAL_FLOW_CONTEXT_V1" : "LOCAL_FLOW_ROUTE_V1";
		const def = localStoryFlowStageRegistry().stages[stage];
		const policy = LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY;
		const originalPrompt = original.prompt;
		const prompt = sameSemantic
			? originalPrompt
			: `${isContext ? policy.contextInstruction : policy.routeInstruction}${policy.controlMarker}${json({ phase: isContext ? "LEAF" : ordinal === 1 ? "ROOT" : "LEAF", synthetic: slot })}${policy.dataMarker}${json({ synthetic: slot })}`;
		const nativeKey = {
			...original.nativeKey,
			stage,
			phase: isContext ? "LEAF" : ordinal === 1 ? "ROOT" : "LEAF",
			nodeId: isContext ? `n${index}` : "n0",
			coreInputHash: hash(`historical-input-${slot}`),
			promptVersion: def.promptVersion,
			schemaHash: def.schemaHash,
			promptHash: digest(prompt),
			relevantPolicyHashes: {
				workflowPolicyHash: f.real.policies.workflowPolicyHash,
				contextPolicyHash: f.real.policies.contextPolicyHash,
				promptPolicyHash: f.real.policies.promptPolicyHash,
				engineValidationPolicyHash: f.real.policies.engineValidationPolicyHash,
				...(isContext
					? {}
					: {
							closurePolicyHash: f.real.policies.closurePolicyHash,
							routePolicyHash: f.real.policies.routePolicyHash,
						}),
			},
			binding: isContext
				? original.nativeKey.binding
				: {
						kind: ordinal === 1 ? "ROOT" : "FOLLOWUP",
						treeHash: hash("historical synthetic tree"),
						targetFrames: 90,
					},
		};
		mutateNative?.(nativeKey);
		const nativeKeyHash = hash(nativeKey),
			ids = localStoryFlowNativeRequestIds({
				organizationId: org,
				originTaskId: taskId,
				nativeKeyHash,
			});
		const requestBody = {
			version: "bitovp-semantic-job-v1",
			organizationId: org,
			requestKey: ids.requestKey,
			profile: "nvidia",
			stage,
			prompt,
			inputHash: nativeKey.coreInputHash,
			promptVersion: def.promptVersion,
			schemaHash: def.schemaHash,
		};
		const attemptBody = {
			version: "local-story-flow-runtime-attempt-v1",
			purpose: "ATTEMPT",
			taskId,
			startRef: start.ref,
			slot,
			category: isContext ? "CONTEXT" : "ROUTE",
			nativeKeyHash,
			requestKey: ids.requestKey,
			jobId: ids.jobId,
			requestHash: hash(requestBody),
			coreInputHash: nativeKey.coreInputHash,
			promptHash: digest(prompt),
			expectedTailPrefixRef: isContext ? null : tail,
			reservedAtMs: f.state.nowMs,
			nativeKey,
			requestBody,
		};
		const attemptRef = f.runtime("ATTEMPT", slot, {
			...attemptBody,
			attemptHash: hash(attemptBody),
		});
		const observationRef = syntheticRef(stage, `observation-${slot}`),
			artifactRef = syntheticRef(stage, `artifact-${slot}`),
			artifactHash = hash(`artifact-${slot}`);
		f.runtime("OUTCOME", slot, {
			version: "local-story-flow-runtime-outcome-v1",
			purpose: "OUTCOME",
			taskId,
			startRef: start.ref,
			attemptRef,
			slot,
			completedAtMs: f.state.nowMs,
			status: "ACCEPTED",
			observationRef,
			acceptedArtifactRef: artifactRef,
			acceptedArtifactHash: artifactHash,
			...(isContext ? {} : { acceptedOrdinal: ordinal }),
		});
		if (isContext) {
			if (index < 63)
				f.runtime("CONTEXT_BINDING", `n${index}`, {
					version: "local-story-flow-runtime-context-binding-v1",
					purpose: "CONTEXT_BINDING",
					startRef: start.ref,
					nodeRef: artifactRef,
					nodeHash: artifactHash,
					observationRef,
				});
		} else if (ordinal <= 64) {
			const prefixBody = {
				version: "local-story-flow-runtime-prefix-v1",
				purpose: "ROUTE_PREFIX",
				taskId,
				startRef: start.ref,
				sourceArchiveRef: syntheticRef("LOCAL_FLOW_MANIFEST_V1", "archive"),
				treeRef: syntheticRef("LOCAL_FLOW_CONTEXT_V1", "tree"),
				ordinal,
				previousPrefixRef: tail,
				stepRef: artifactRef,
				stepHash: artifactHash,
				expectationHash: hash(`expectation-${ordinal}`),
				observationRef,
				nativeRootProof: hash("root"),
				progressHash: hash(`progress-${ordinal}`),
			};
			tail = f.runtime("ROUTE_PREFIX", ordinal, {
				...prefixBody,
				prefixHash: hash(prefixBody),
			});
		}
	}
	return { start, tail };
}
function ownedRouteExpectation(
	f: ReturnType<typeof fixture>,
	targetFrames = 90,
) {
	const s = localStoryFlowContextSourceEvidence(f.real.source),
		page = s.pages[0];
	if (s.layout.nodes.length !== 1 || !page)
		throw new Error("Expected one synthetic leaf");
	const accountedItems = page.data.items.map((item) =>
		item.kind === "DERIVED_CHUNK_SUMMARY"
			? { kind: "SUMMARY" as const, summaryId: item.id }
			: { kind: "EVENT" as const, eventId: item.id },
	);
	const event = accountedItems.find((item) => item.kind === "EVENT");
	if (!event) throw new Error("Missing synthetic event");
	const node = buildLocalStoryFlowContextNode({
		source: f.real.source,
		nodeId: "n0",
		children: [],
		output: {
			version: "local-story-flow-context-output-v1",
			mode: "FLOW",
			phase: "LEAF",
			nodeId: "n0",
			pageId: page.pageId,
			accountedItems,
			claims: [
				{
					id: "c0",
					text: "鍵を見つける。",
					supports: [event],
					witnesses: [{ id: "w0", allOf: [event] }],
				},
			],
			relations: [],
			unresolved: [],
		},
	});
	const tree = buildLocalStoryFlowContextTree({
		source: f.real.source,
		nodes: [node],
	});
	const route = buildLocalStoryFlowRouteExpectation({
		phase: "ROOT",
		source: f.real.source,
		tree,
		targetFrames,
	});
	return routeNativeExpectation({
		routeExpectation: route,
		pin: { modelPin: f.real.pin, policies: f.real.policies },
	});
}
function replaceRuntimePayload(
	f: ReturnType<typeof fixture>,
	purpose: string,
	update: (p: Record<string, unknown>) => void,
	index = 0,
) {
	const row = [...f.rows.values()].filter(
		(r) => payload(r).purpose === purpose,
	)[index];
	if (!row) throw new Error("Missing synthetic runtime row");
	const p = payload(row);
	update(p);
	const hashField =
		purpose === "ATTEMPT"
			? "attemptHash"
			: purpose === "ROUTE_PREFIX"
				? "prefixHash"
				: null;
	if (hashField) {
		delete p[hashField];
		p[hashField] = hash(p);
	}
	const proof = {
		...(row.proof as { version: string; cacheHash: string }),
		valueJson: json(p),
	};
	row.proof = proof;
	row.proofHash = hash(proof);
}

it("commits START/ATTEMPT pins before native and returns only an owned, once-used capture", async () => {
	const f = fixture(),
		reservation = await getReservation(f),
		capture = await f.store.runReserved(reservation);
	const evidence = capturedLocalStoryFlowNativeEvidence(capture);
	expect(evidence.slot).toBe(1);
	expect(
		admittedFlowNativeEvidence(evidence.native).terminalJob.result?.content,
	).toBe(' {"synthetic":true}\n');
	expect(() =>
		capturedLocalStoryFlowNativeEvidence(structuredClone(capture)),
	).toThrow();
	await expect(f.store.runReserved(reservation)).rejects.toBeInstanceOf(
		MediaOperationError,
	);
	expect(f.client.runObserved).toHaveBeenCalledOnce();
	expect(
		[...f.rows.values()]
			.map(payload)
			.map((p) => p.purpose)
			.sort(),
	).toEqual(["ATTEMPT", "START"]);
});
it("rolls back the receipt if atomic pin insertion fails", async () => {
	const f = fixture();
	f.state.pinFailure = true;
	await expect(f.store.start()).rejects.toBeDefined();
	expect(f.rows.size).toBe(0);
	expect(f.pins.size).toBe(0);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it.each([
	"LibrarySource",
	"LibraryMediaVersion",
	"SceneAnalysisRevision",
	"LibraryAnalysisBinding",
])("rejects a missing %s SHARE row before START or native", async (name) => {
	const f = fixture();
	f.state.missingSource = name;
	await expect(f.store.start()).rejects.toMatchObject({
		code: "SOURCE_CHANGED",
	});
	expect(f.rows.size).toBe(0);
});
it("converts the shared DB source error to the old worker error class", async () => {
	const f = fixture();
	f.state.sourceFailure = true;
	const r = f.store.start();
	await expect(r).rejects.toBeInstanceOf(MediaOperationError);
	await expect(r).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});
it("arms only the remaining original DB deadline, without extending it on reclaim", async () => {
	vi.useFakeTimers();
	const f = fixture(5_399_000);
	await f.store.start();
	expect(f.store.signal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1001);
	expect(f.store.signal.aborted).toBe(true);
	await expect(f.store.reserve(f.real.expectation, null)).rejects.toMatchObject(
		{ code: "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED" },
	);
	expect(f.client.runObserved).not.toHaveBeenCalled();
	f.store.dispose();
	expect(vi.getTimerCount()).toBe(0);
});
it("does not re-arm a timer after disposal while START commit was pending", async () => {
	vi.useFakeTimers();
	const f = fixture();
	f.state.beforeCommit = () => f.store.dispose();
	await expect(f.store.start()).rejects.toMatchObject({ code: "CANCELED" });
	expect(vi.getTimerCount()).toBe(0);
});
it("a positive outer cache hit consumes no new reservation or native call", async () => {
	const f = fixture();
	await f.store.start();
	const e = localStoryFlowNativeExpectationEvidence(f.real.expectation);
	f.insert(
		"LOCAL_FLOW_CONTEXT_V1",
		{
			version: "local-story-flow-record-key-v1",
			purpose: "NATIVE_CACHE",
			keyBody: { nativeKeyHash: e.nativeKeyHash },
		},
		{
			version: "local-story-flow-native-cache-v1",
			purpose: "NATIVE_CACHE",
			nativeKeyHash: e.nativeKeyHash,
			observationRef: "P4 will separately admit this synthetic pointer",
		},
	);
	expect((await f.store.reserve(f.real.expectation, null)).status).toBe(
		"CACHED",
	);
	expect(
		[...f.rows.values()].map(payload).filter((p) => p.purpose === "ATTEMPT"),
	).toHaveLength(0);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("recovers an unfinished reservation with cleanup only and never adopts SUCCEEDED", async () => {
	const f = fixture();
	await getReservation(f);
	const recovered = createLocalStoryFlowRuntimeStore(f.options);
	stores.push(recovered);
	await expect(recovered.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
	});
	expect(f.client.cleanupOnly).toHaveBeenCalledOnce();
	expect(f.client.runObserved).not.toHaveBeenCalled();
	expect(
		[...f.rows.values()].map(payload).some((p) => p.purpose === "OUTCOME"),
	).toBe(false);
});
it("does not contact a different connection to clean an unknown reservation", async () => {
	const f = fixture();
	await getReservation(f);
	const recovered = createLocalStoryFlowRuntimeStore({
		...f.options,
		connectionHash: hash("different runtime"),
	});
	stores.push(recovered);
	await expect(recovered.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
	});
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"cancel",
	"source",
	"deadline",
])("allows only FAILED control-plane publication after %s", async (reason) => {
	const f = fixture(),
		r = await getReservation(f);
	if (reason === "cancel") f.current.cancelRequestedAt = new Date();
	if (reason === "source") f.state.sourceChanged = true;
	if (reason === "deadline") f.state.nowMs += 5_400_000;
	await expect(
		f.store.recordFailed(r, "SOURCE_CHANGED", "CONFIRMED"),
	).resolves.toMatchObject({ payload: { status: "FAILED" } });
	expect(
		[...f.rows.values()]
			.map(payload)
			.every((p) =>
				["START", "ATTEMPT", "OUTCOME"].includes(String(p.purpose)),
			),
	).toBe(true);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("writes nothing after lease loss, including FAILED", async () => {
	const f = fixture(),
		r = await getReservation(f),
		before = structuredClone(f.rows);
	f.current.leaseUntil = new Date(0);
	await expect(
		f.store.recordFailed(r, "CANCELED", "CONFIRMED"),
	).rejects.toMatchObject({ code: "LEASE_LOST" });
	expect(f.rows).toEqual(before);
});
it.each([
	"cancel",
	"source",
	"lease",
])("does not return a capture after post-native %s", async (reason) => {
	const f = fixture(),
		r = await getReservation(f);
	f.state.duringObserved = () => {
		if (reason === "cancel") f.current.cancelRequestedAt = new Date();
		if (reason === "source") f.state.sourceChanged = true;
		if (reason === "lease") f.current.leaseUntil = new Date(0);
	};
	await expect(f.store.runReserved(r)).rejects.toBeInstanceOf(
		MediaOperationError,
	);
	expect(f.client.runObserved).toHaveBeenCalledOnce();
});
it.each([
	"pin",
	"proof",
	"payload",
])("fails closed on a corrupt runtime %s", async (fault) => {
	const f = fixture();
	await f.store.start();
	const row = [...f.rows.values()][0];
	if (!row) throw new Error("missing synthetic start");
	if (fault === "pin") f.pins.delete(row.id);
	if (fault === "proof") row.proofHash = hash("wrong proof");
	if (fault === "payload") {
		const p = payload(row);
		p.caps = null;
		const proof = {
			version: "local-story-cache-v2",
			cacheHash: (row.proof as { cacheHash: string }).cacheHash,
			valueJson: json(p),
		};
		row.proof = proof;
		row.proofHash = hash(proof);
	}
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});

it("uses the same task lock namespace as the readonly reader", async () => {
	const f = fixture();
	expect(localStoryFlowTaskLockKey(taskId)).toBe(-7729866101415729106n);
	await f.store.start();
	expect(f.db.$executeRaw.mock.calls[0]?.[1]).toBe(-7729866101415729106n);
});
it.each([
	[63, 0],
	[0, 64],
	[63, 64],
])("accepts complete sealed boundary history context=%i route=%i without a native call", async (context, route) => {
	const f = fixture();
	await seedHistory(f, context, route);
	await expect(f.store.recoverUnconfirmed()).resolves.toEqual({
		unconfirmed: false,
	});
	expect(f.client.runObserved).not.toHaveBeenCalled();
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	[64, 0],
	[0, 65],
])("rejects sealed history beyond category caps context=%i route=%i", async (context, route) => {
	const f = fixture();
	await seedHistory(f, context, route);
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it("refuses a 64th CONTEXT reservation before any native call", async () => {
	const f = fixture();
	await seedHistory(f, 63, 0);
	await expect(f.store.reserve(f.real.expectation, null)).rejects.toMatchObject(
		{ code: "LOCAL_STORY_FLOW_BUDGET_EXHAUSTED" },
	);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it.each([
	"CONTEXT_BINDING",
	"ROUTE_PREFIX",
])("rejects ACCEPTED without its atomic %s", async (purpose) => {
	const f = fixture();
	await seedHistory(
		f,
		purpose === "CONTEXT_BINDING" ? 1 : 0,
		purpose === "ROUTE_PREFIX" ? 1 : 0,
	);
	for (const [id, row] of f.rows)
		if (payload(row).purpose === purpose) f.rows.delete(id);
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"acceptedArtifactHash",
	"observationRef",
	"acceptedArtifactRef",
])("rejects an ACCEPTED %s inconsistent with its binding", async (field) => {
	const f = fixture();
	await seedHistory(f, 1, 0);
	replaceRuntimePayload(f, "OUTCOME", (p) => {
		p[field] =
			field === "acceptedArtifactHash"
				? hash("other")
				: syntheticRef("LOCAL_FLOW_CONTEXT_V1", "other");
	});
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("does not require a current reservation for cache-derived binding and prefix records", async () => {
	const f = fixture();
	await seedHistory(f, 1, 1);
	for (const [id, row] of f.rows)
		if (["ATTEMPT", "OUTCOME"].includes(String(payload(row).purpose)))
			f.rows.delete(id);
	await expect(f.store.recoverUnconfirmed()).resolves.toEqual({
		unconfirmed: false,
	});
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("rejects a missing first slot rather than treating the second as the next reservation", async () => {
	const f = fixture();
	await seedHistory(f, 2, 0);
	for (const [id, row] of f.rows) {
		const p = payload(row);
		if (["ATTEMPT", "OUTCOME"].includes(String(p.purpose)) && p.slot === 1)
			f.rows.delete(id);
	}
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("rejects same semantic native input even when coreInputHash and deterministic job identity change", async () => {
	const f = fixture();
	await seedHistory(f, 1, 0, true);
	await expect(f.store.reserve(f.real.expectation, null)).rejects.toMatchObject(
		{ code: "LOCAL_STORY_FLOW_NO_PROGRESS" },
	);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("rolls back an ATTEMPT and refuses POST when its pin insertion fails", async () => {
	const f = fixture();
	await f.store.start();
	f.state.pinFailure = true;
	await expect(f.store.reserve(f.real.expectation, null)).rejects.toMatchObject(
		{ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" },
	);
	expect([...f.rows.values()].map(payload).map((p) => p.purpose)).toEqual([
		"START",
	]);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("does not reinterpret cleanup-unconfirmed as parent cancellation", async () => {
	const f = fixture();
	await getReservation(f);
	f.controller.abort();
	f.client.cleanupOnly.mockRejectedValueOnce(
		new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"),
	);
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
	});
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("converts malformed sealed JSON to a fixed worker error without retaining its text", async () => {
	const f = fixture();
	await f.store.start();
	const row = [...f.rows.values()][0];
	if (!row) throw new Error("Missing synthetic start");
	const proof = {
		...(row.proof as object),
		valueJson: "SECRET_SYNTHETIC_MALFORMED",
	};
	row.proof = proof;
	row.proofHash = hash(proof);
	const rejected = f.store.recoverUnconfirmed();
	await expect(rejected).rejects.toBeInstanceOf(MediaOperationError);
	await expect(rejected).rejects.toMatchObject({
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});

it("subtracts START transaction latency from the original remaining deadline", async () => {
	vi.useFakeTimers();
	const f = fixture(5_399_000);
	f.state.beforeCommit = () => {
		vi.advanceTimersByTime(600);
	};
	await f.store.start();
	await vi.advanceTimersByTimeAsync(401);
	expect(f.store.signal.aborted).toBe(true);
});
it("requires this store to arm the original deadline before reserving after reclaim", async () => {
	const f = fixture();
	await f.store.start();
	const reclaimed = createLocalStoryFlowRuntimeStore(f.options);
	stores.push(reclaimed);
	await expect(
		reclaimed.reserve(f.real.expectation, null),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect([...f.rows.values()].map(payload).map((p) => p.purpose)).toEqual([
		"START",
	]);
});

it("rejects an ACCEPTED timestamp outside the original deadline", async () => {
	const f = fixture();
	await seedHistory(f, 1, 0);
	replaceRuntimePayload(f, "OUTCOME", (p) => {
		const startedAt = f.current.startedAt;
		if (!startedAt) throw new Error("Missing synthetic start time");
		p.completedAtMs = startedAt.getTime() + 5_400_000;
	});
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
});
it("does not capture a native result after the same reservation was durably failed", async () => {
	const f = fixture(),
		r = await getReservation(f);
	f.state.duringObserved = () => {
		const row = [...f.rows.values()].find(
			(row) => payload(row).purpose === "ATTEMPT",
		);
		if (!row) throw new Error("Missing synthetic ATTEMPT");
		const attempt = payload(row);
		const attemptRef = {
			kind: "LOCAL_FLOW_PLAN_V1",
			receiptId: row.id,
			cacheHash: (row.proof as { cacheHash: string }).cacheHash,
			inputKeyHash: hash({
				version: "local-story-flow-record-key-v1",
				purpose: "ATTEMPT",
				keyBody: { taskId, slot: 1 },
			}),
			proofHash: row.proofHash,
		};
		f.runtime("OUTCOME", 1, {
			version: "local-story-flow-runtime-outcome-v1",
			purpose: "OUTCOME",
			taskId,
			startRef: attempt.startRef,
			attemptRef,
			slot: 1,
			completedAtMs: f.state.nowMs,
			status: "FAILED",
			failureCode: "CANCELED",
			cleanupStatus: "CONFIRMED",
			observationRef: null,
		});
	};
	await expect(f.store.runReserved(r)).rejects.toMatchObject({
		code: "CANCELED",
	});
});
it("records cleanup-unconfirmed with S0 priority over an ordinary fixed failure", async () => {
	const f = fixture(),
		r = await getReservation(f);
	await expect(
		f.store.recordFailed(r, "CANCELED", "UNCONFIRMED"),
	).resolves.toMatchObject({
		payload: {
			failureCode: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
			cleanupStatus: "UNCONFIRMED",
		},
	});
});
it("rejects an unknown failure code without storing text", async () => {
	const f = fixture(),
		r = await getReservation(f),
		before = structuredClone(f.rows);
	await expect(
		f.store.recordFailed(r, "SYNTHETIC_RAW_ERROR_SENTINEL", "CONFIRMED"),
	).rejects.toMatchObject({ message: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
});
it("refuses unowned reservation handles before transaction or native work", async () => {
	const f = fixture();
	await f.store.start();
	await expect(f.store.runReserved(Object.freeze({}))).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.client.runObserved).not.toHaveBeenCalled();
});

const contextPolicyFields = [
	"workflowPolicyHash",
	"contextPolicyHash",
	"promptPolicyHash",
	"engineValidationPolicyHash",
] as const;
const routePolicyFields = [
	...contextPolicyFields,
	"closurePolicyHash",
	"routePolicyHash",
] as const;
for (const [stage, fields] of [
	["CONTEXT", contextPolicyFields],
	["ROUTE", routePolicyFields],
] as const) {
	it.each(
		fields,
	)(`rejects an owned ${stage} expectation differing from task pin %s before reservation`, async (field) => {
		const f = fixture(1000, { [field]: hash("different pinned policy") });
		await f.store.start();
		const expectation =
			stage === "CONTEXT" ? f.real.expectation : ownedRouteExpectation(f);
		await expect(f.store.reserve(expectation, null)).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect([...f.rows.values()].map(payload).map((p) => p.purpose)).toEqual([
			"START",
		]);
		expect(f.client.runObserved).not.toHaveBeenCalled();
	});
	it.each(
		fields,
	)(`rejects resealed ${stage} history differing from task pin %s`, async (field) => {
		const f = fixture();
		await seedHistory(
			f,
			stage === "CONTEXT" ? 1 : 0,
			stage === "ROUTE" ? 1 : 0,
			false,
			(nativeKey) => {
				const parts = nativeKey.relevantPolicyHashes;
				if (!parts || typeof parts !== "object")
					throw new Error("Missing synthetic policy parts");
				Reflect.set(parts, field, hash("different reserved policy"));
			},
		);
		await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect(f.client.runObserved).not.toHaveBeenCalled();
		expect(f.client.cleanupOnly).not.toHaveBeenCalled();
	});
}
it("accepts the owned ROOT expectation at the original pinned target", async () => {
	const f = fixture();
	await f.store.start();
	await expect(
		f.store.reserve(ownedRouteExpectation(f), null),
	).resolves.toMatchObject({ status: "RESERVED" });
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("rejects a legal owned ROOT duration different from the original task", async () => {
	const f = fixture();
	await f.store.start();
	await expect(
		f.store.reserve(ownedRouteExpectation(f, 120), null),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect([...f.rows.values()].map(payload).map((p) => p.purpose)).toEqual([
		"START",
	]);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("rejects a resealed route reservation at a different pinned target", async () => {
	const f = fixture();
	await seedHistory(f, 0, 1, false, (nativeKey) => {
		const binding = nativeKey.binding;
		if (!binding || typeof binding !== "object")
			throw new Error("Missing synthetic binding");
		Reflect.set(binding, "targetFrames", 120);
	});
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it("counts DB clock response latency from before query emission", async () => {
	vi.useFakeTimers();
	const f = fixture(5_399_000);
	f.state.clockResponseLatencyMs = 800;
	await f.store.start();
	await vi.advanceTimersByTimeAsync(201);
	expect(f.store.signal.aborted).toBe(true);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("does not publish START after the original deadline elapsed during the clock response", async () => {
	vi.useFakeTimers();
	const f = fixture(5_399_000);
	f.state.clockResponseLatencyMs = 1001;
	await expect(f.store.start()).rejects.toMatchObject({
		code: "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
	});
	expect(f.rows.size).toBe(0);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("does not extend a reclaimed deadline by its second DB clock response", async () => {
	vi.useFakeTimers();
	const f = fixture(5_399_000);
	await f.store.start();
	await vi.advanceTimersByTimeAsync(400);
	f.state.nowMs += 400;
	f.state.clockResponseLatencyMs = 300;
	const reclaimed = createLocalStoryFlowRuntimeStore(f.options);
	stores.push(reclaimed);
	await reclaimed.start();
	await vi.advanceTimersByTimeAsync(301);
	expect(reclaimed.signal.aborted).toBe(true);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});

const fixedFailures = [
	"LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
	"LOCAL_STORY_FLOW_NO_PROGRESS",
	"LOCAL_STORY_FLOW_BUDGET_EXHAUSTED",
	"LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
	"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
	"LOCAL_SEMANTIC_JOB_FAILED",
	"CANCELED",
	"SOURCE_CHANGED",
] as const;
async function operationAfterFailure(
	f: ReturnType<typeof fixture>,
	operation: string,
	reservation: Awaited<ReturnType<typeof getReservation>>,
) {
	if (operation === "recover") return f.store.recoverUnconfirmed();
	if (operation === "reserve") return f.store.reserve(f.real.expectation, null);
	if (operation === "start") return f.store.start();
	return f.store.runReserved(reservation);
}
for (const operation of ["recover", "reserve", "start", "run"] as const) {
	it.each(
		fixedFailures,
	)(`retains CONFIRMED failure %s on ${operation} without create or cleanup`, async (code) => {
		const f = fixture(),
			r = await getReservation(f);
		await f.store.recordFailed(r, code, "CONFIRMED");
		const before = structuredClone(f.rows);
		await expect(operationAfterFailure(f, operation, r)).rejects.toMatchObject({
			code,
		});
		expect(f.rows).toEqual(before);
		expect(f.client.runObserved).not.toHaveBeenCalled();
		expect(f.client.cleanupOnly).not.toHaveBeenCalled();
	});
	it.each([
		"none",
		"abort",
		"deadline",
		"source",
	])(`retains stored S0 before %s on ${operation}`, async (condition) => {
		const f = fixture(),
			r = await getReservation(f);
		await f.store.recordFailed(r, "CANCELED", "UNCONFIRMED");
		const before = structuredClone(f.rows);
		if (condition === "abort") f.controller.abort();
		if (condition === "deadline") f.state.nowMs += 5_400_000;
		if (condition === "source") f.state.sourceChanged = true;
		await expect(operationAfterFailure(f, operation, r)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(f.rows).toEqual(before);
		expect(f.client.runObserved).not.toHaveBeenCalled();
		expect(f.client.cleanupOnly).not.toHaveBeenCalled();
	});
}

for (const stage of ["CONTEXT", "ROUTE"] as const) {
	it.each([
		"missing",
		"extra",
	])(`rejects ${stage} reserved policy key-set %s`, async (change) => {
		const f = fixture();
		await seedHistory(
			f,
			stage === "CONTEXT" ? 1 : 0,
			stage === "ROUTE" ? 1 : 0,
			false,
			(nativeKey) => {
				const parts = nativeKey.relevantPolicyHashes;
				if (!parts || typeof parts !== "object")
					throw new Error("Missing synthetic policy parts");
				if (change === "missing")
					Reflect.deleteProperty(parts, "engineValidationPolicyHash");
				else
					Reflect.set(
						parts,
						"scopePolicyHash",
						f.real.policies.scopePolicyHash,
					);
			},
		);
		await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect(f.client.cleanupOnly).not.toHaveBeenCalled();
	});
}
it.each([
	"recover",
	"reserve",
])("does not turn retained S0 into cleanup/write permission after lease loss on %s", async (operation) => {
	const f = fixture(),
		r = await getReservation(f);
	await f.store.recordFailed(r, "CANCELED", "UNCONFIRMED");
	f.current.leaseUntil = new Date(0);
	const before = structuredClone(f.rows);
	await expect(operationAfterFailure(f, operation, r)).rejects.toMatchObject({
		code: "LEASE_LOST",
	});
	expect(f.rows).toEqual(before);
	expect(f.client.runObserved).not.toHaveBeenCalled();
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});

for (const mode of ["deadline", "abort"] as const) {
	it.each([
		"QUERY:LibrarySource",
		"VERIFY",
		"FIND:START",
		"CREATE:START",
		"PIN:START",
	])(`rolls back START when ${mode} becomes known during awaited %s`, async (at) => {
		vi.useFakeTimers();
		const f = fixture(5_399_000);
		f.state.waitAt = at;
		f.state.waitOccurrence = at === "FIND:START" ? 2 : 1;
		f.state.waitAdvanceMs = mode === "deadline" ? 1001 : 0;
		f.state.abortAfterWait = mode === "abort";
		await expect(f.store.start()).rejects.toMatchObject({
			code:
				mode === "deadline" ? "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED" : "CANCELED",
		});
		expect(f.state.waitAt).toBe("");
		expect(f.rows.size).toBe(0);
		expect(f.pins.size).toBe(0);
		if (at.startsWith("QUERY") || at === "VERIFY" || at.startsWith("FIND"))
			expect(f.state.writes).toBe(0);
		expect(f.client.runObserved).not.toHaveBeenCalled();
	});
	it.each([
		"QUERY:LibrarySource",
		"VERIFY",
		"FIND:CACHE",
		"FIND:ATTEMPT",
		"CREATE:ATTEMPT",
		"PIN:ATTEMPT",
	])(`rolls back ATTEMPT when ${mode} becomes known during awaited %s`, async (at) => {
		vi.useFakeTimers();
		const f = fixture(5_399_000);
		await f.store.start();
		const before = structuredClone(f.rows),
			pins = new Set(f.pins),
			writes = f.state.writes;
		f.state.waitAt = at;
		f.state.waitOccurrence =
			at === "QUERY:LibrarySource" || at === "VERIFY" ? 2 : 1;
		f.state.waitAdvanceMs = mode === "deadline" ? 1001 : 0;
		f.state.abortAfterWait = mode === "abort";
		await expect(
			f.store.reserve(f.real.expectation, null),
		).rejects.toMatchObject({
			code:
				mode === "deadline" ? "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED" : "CANCELED",
		});
		expect(f.state.waitAt).toBe("");
		expect(f.rows).toEqual(before);
		expect(f.pins).toEqual(pins);
		if (at.startsWith("QUERY") || at === "VERIFY" || at.startsWith("FIND"))
			expect(f.state.writes).toBe(writes);
		expect(f.client.runObserved).not.toHaveBeenCalled();
	});
	it(`rejects a positive cache result arriving after ${mode} without new writes`, async () => {
		vi.useFakeTimers();
		const f = fixture(5_399_000);
		await f.store.start();
		const e = localStoryFlowNativeExpectationEvidence(f.real.expectation);
		f.insert(
			"LOCAL_FLOW_CONTEXT_V1",
			{
				version: "local-story-flow-record-key-v1",
				purpose: "NATIVE_CACHE",
				keyBody: { nativeKeyHash: e.nativeKeyHash },
			},
			{
				version: "local-story-flow-native-cache-v1",
				purpose: "NATIVE_CACHE",
				nativeKeyHash: e.nativeKeyHash,
				observationRef: "outer cache fixture; P4 admission separate",
			},
		);
		const before = structuredClone(f.rows),
			pins = new Set(f.pins);
		f.state.waitAt = "FIND:CACHE";
		f.state.waitAdvanceMs = mode === "deadline" ? 1001 : 0;
		f.state.abortAfterWait = mode === "abort";
		await expect(
			f.store.reserve(f.real.expectation, null),
		).rejects.toMatchObject({
			code:
				mode === "deadline" ? "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED" : "CANCELED",
		});
		expect(f.state.waitAt).toBe("");
		expect(f.rows).toEqual(before);
		expect(f.pins).toEqual(pins);
		expect(f.client.runObserved).not.toHaveBeenCalled();
	});
}
it("keeps the FAILED control-plane exception when abort and expiry arrive during its pin await", async () => {
	vi.useFakeTimers();
	const f = fixture(5_399_000),
		r = await getReservation(f);
	f.controller.abort();
	f.state.waitAt = "PIN:OUTCOME";
	f.state.waitAdvanceMs = 1001;
	await expect(
		f.store.recordFailed(r, "CANCELED", "UNCONFIRMED"),
	).resolves.toMatchObject({
		payload: {
			status: "FAILED",
			failureCode: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		},
	});
	expect(f.state.waitAt).toBe("");
	expect(
		[...f.rows.values()]
			.map(payload)
			.map((p) => p.purpose)
			.sort(),
	).toEqual(["ATTEMPT", "OUTCOME", "START"]);
	expect(f.client.runObserved).not.toHaveBeenCalled();
});
it("retains sealed S0 priority when runtime-history await itself crosses the deadline", async () => {
	vi.useFakeTimers();
	const f = fixture(5_399_000),
		r = await getReservation(f);
	await f.store.recordFailed(r, "CANCELED", "UNCONFIRMED");
	const before = structuredClone(f.rows);
	f.state.waitAt = "SCAN";
	f.state.waitOccurrence = 3;
	f.state.waitAdvanceMs = 1001;
	await expect(f.store.recoverUnconfirmed()).rejects.toMatchObject({
		code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
	});
	expect(f.state.waitAt).toBe("");
	expect(f.rows).toEqual(before);
	expect(f.client.runObserved).not.toHaveBeenCalled();
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});

it("keeps the complete-fixture old worker START/key/request golden across pure delegation", async () => {
	const f = fixture(),
		id = prepareLocalStoryFlowRuntimeIdentity({
			taskId,
			organizationId: org,
			taskParameters: f.current.parameters,
			startedAtMs: f.current.startedAt?.getTime(),
			sourceTuple: f.tuple,
			policies: f.real.policies,
		});
	const actual = await f.store.start(),
		expected = localStoryFlowRuntimeStartRecord(id, f.options.connectionHash);
	expect(actual.key).toEqual(expected.key);
	expect(actual.payload).toEqual(expected.payload);
	const request = nativeRequestForOrigin(f.real.expectation, {
		organizationId: org,
		originTaskId: taskId,
	});
	await f.store.reserve(f.real.expectation, null);
	const attempt = [...f.rows.values()]
		.map(payload)
		.find((p) => p.purpose === "ATTEMPT");
	expect(attempt?.requestBody).toEqual(request.body);
	const e = localStoryFlowNativeExpectationEvidence(f.real.expectation);
	const signature = localStoryFlowRuntimeSignature(
		id,
		e.nativeKey,
		request.body,
	);
	const values = {
		startHash: hash(actual.payload),
		keyCatalogHash: hash(localStoryFlowRuntimeKeys(id)),
		requestHash: request.requestHash,
		nativeKeyHash: e.nativeKeyHash,
		signature,
	};
	expect(values).toEqual({
		startHash:
			"dc9a06cbed14764166f049fd68882b860823dd6d7129b43ae580de75e91ef184",
		keyCatalogHash:
			"b089c78ef25806651eced18f73d45a1156c45379d79b3f278397e2356a6ed903",
		requestHash:
			"80c41f941d1a6d740668acff27e4ec5b7695d82b52088342eed1d0168d50b5fd",
		nativeKeyHash:
			"5993e991d70b6ef83cd129de1854c96e56c19dea400d52903fbee01ff6c5a7b9",
		signature:
			"0e7d5f4cd48fb1fa190f43794cd5b9532efb0fb71bc48ea6c5cd2d5b61931f37",
	});
});

it("rejects a forged publication capture without source/PUB/DB/native effects", async () => {
	const f = fixture(),
		before = structuredClone(f.rows);
	await expect(f.store.publishAccepted({}, {}, {})).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.rows).toEqual(before);
	expect(f.state.writes).toBe(0);
	expect(f.client.runObserved).not.toHaveBeenCalled();
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it("rejects a getter-bearing unknown publication handle without evaluating it", async () => {
	const f = fixture(),
		get = vi.fn(() => {
			throw new Error("PRIVATE_PUB_SENTINEL");
		});
	const capture = Object.defineProperty({}, "native", {
		get,
		enumerable: true,
	});
	await expect(f.store.publishAccepted(capture, {}, {})).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(get).not.toHaveBeenCalled();
	expect(f.state.writes).toBe(0);
});

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

function publicationSource(
	count = 1,
	audio = false,
	normalized = false,
	attested = false,
) {
	const f = publicationLegacyFixture(
			count,
			"V4",
			2,
			audio,
			normalized,
			attested,
		),
		archive = buildLocalStoryFlowSourceArchive({
			transcript: f.t,
			ledgers: f.pairs,
		});
	const source = localStoryFlowSourceArchiveContext(archive),
		map = cfrTimeMapSchema.parse(f.map),
		pin = { profile: f.model.profile, configId: f.model.configId };
	const work = prepareLocalStoryFlowContextWork({
		archive,
		nodeId: "n0",
		children: [],
	});
	return {
		...f,
		archive,
		source,
		map,
		pin,
		workflow: f.identity.localStoryWorkflow,
		expectation: localStoryFlowContextWorkExpectation(work),
		legacyRows: f.rows,
	};
}
function publicationFixture(
	count = 1,
	audio = false,
	normalized = false,
	attested = false,
) {
	const src = publicationSource(count, audio, normalized, attested),
		f = fixture(1000, {}, src),
		fence = Object.freeze({});
	const original = structuredClone(src.snapshots);
	mocked.sourceFence.mockReset();
	mocked.sourceFence.mockImplementation(async (tx, actualFence, archive) => {
		expect(f.state.inTransaction).toBe(true);
		expect(tx).toBe(f.db);
		f.afterAwait("PUB_SOURCE_FENCE");
		if (
			actualFence !== fence ||
			archive !== src.archive ||
			json(src.snapshots) !== json(original)
		)
			throw new Error("PRIVATE_SOURCE_FENCE_REJECTED");
	});
	return { ...f, src, fence };
}
function requireSynthetic(v: unknown): asserts v {
	if (!v) throw new Error("Missing synthetic data");
}
function contextOutput(
	f: ReturnType<typeof publicationFixture>,
	nodeId: string,
	children: AcceptedLocalStoryFlowContextNode[],
) {
	const s = localStoryFlowContextSourceEvidence(f.src.source),
		plan = s.layout.nodes.find((n) => n.nodeId === nodeId);
	if (!plan) throw new Error("Missing synthetic layout");
	if (plan.phase === "LEAF") {
		const page = s.pages.find((p) => p.pageId === plan.pageId);
		if (!page) throw new Error("Missing synthetic page");
		const accountedItems = page.data.items.map((item) =>
			item.kind === "DERIVED_CHUNK_SUMMARY"
				? { kind: "SUMMARY" as const, summaryId: item.id }
				: { kind: "EVENT" as const, eventId: item.id },
		);
		const event = accountedItems.find((item) => item.kind === "EVENT");
		if (!event) throw new Error("No synthetic event");
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
		(c) =>
			localStoryFlowAcceptedContextNodePublication(c).node.payload
				.nodeEvidence as LocalStoryFlowContextNodeEvidence,
	);
	const witness = e[0]?.witnessProofs[0]?.ref;
	requireSynthetic(witness);
	return {
		version: "local-story-flow-context-output-v1",
		mode: "FLOW",
		phase: "MERGE",
		nodeId,
		accountedChildren: plan.children.map((nodeId) => ({
			kind: "CHILD_NODE" as const,
			nodeId,
		})),
		claims: [
			{
				id: "c0",
				text: "The key is observed.",
				supports: e.map((child) => {
					const ref = child.claimRefs[0];
					requireSynthetic(ref);
					return ref;
				}),
				witnesses: [{ id: "w0", allOf: [witness] }],
			},
		],
		relations: [],
		unresolved: [],
	};
}
async function publicationCapture(
	f: ReturnType<typeof publicationFixture>,
	nodeId = "n0",
	children: AcceptedLocalStoryFlowContextNode[] = [],
) {
	const work = prepareLocalStoryFlowContextWork({
			archive: f.src.archive,
			nodeId,
			children,
		}),
		expectation = localStoryFlowContextWorkExpectation(work);
	f.state.modelContent = contextOutput(f, nodeId, children);
	const r = await f.store.reserve(expectation, null);
	if (r.status !== "RESERVED")
		throw new Error("Expected synthetic reservation");
	const capture = await f.store.runReserved(r.reservation),
		native = capturedLocalStoryFlowNativeEvidence(capture).native;
	const node = acceptLocalStoryFlowContextWork({ work, native }),
		prepared = prepareLocalStoryFlowContextPublication({ node });
	return { capture, prepared, node, reservation: r.reservation };
}
it("atomically commits CURRENT CONTEXT records and source dependency pins before returning an owned result", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		before = f.state.writes;
	const accepted = await f.store.publishAccepted(
		p.capture,
		p.prepared,
		f.fence,
	);
	expect(accepted).toBeTypeOf("object");
	expect(f.state.inTransaction).toBe(false);
	expect(f.state.writes - before).toBe(6);
	const purposes = [...f.rows.values()]
		.filter((row) => row.kind.startsWith("LOCAL_FLOW"))
		.map((row) => payload(row).purpose);
	expect(purposes.sort()).toEqual(
		[
			"START",
			"ATTEMPT",
			"SOURCE_ARCHIVE",
			"NATIVE_OBSERVATION",
			"NODE",
			"NATIVE_CACHE",
			"OUTCOME",
			"CONTEXT_BINDING",
		].sort(),
	);
	expect([...f.rows.keys()].every((id) => f.pins.has(id))).toBe(true);
	expect(f.client.runObserved).toHaveBeenCalledTimes(1);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
});
it.each([
	"SOURCE_ARCHIVE",
	"NATIVE_OBSERVATION",
	"NODE",
	"NATIVE_CACHE",
	"OUTCOME",
	"CONTEXT_BINDING",
])("rolls back the whole CONTEXT publication on %s insert failure", async (purpose) => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		rows = structuredClone(f.rows),
		pins = new Set(f.pins);
	f.state.failPurpose = purpose;
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(rows);
	expect(f.pins).toEqual(pins);
	expect(f.client.runObserved).toHaveBeenCalledTimes(1);
});
it("rolls back all inserts when dependency pin insertion fails", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		rows = structuredClone(f.rows),
		pins = new Set(f.pins);
	f.state.pinFailure = true;
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(rows);
	expect(f.pins).toEqual(pins);
});

it("publishes a whole admitted ASRv3 dependency using the old seal recipe", async () => {
	const f = publicationFixture(1, true);
	await f.store.start();
	const p = await publicationCapture(f);
	await f.store.publishAccepted(p.capture, p.prepared, f.fence);
	expect(f.src.transcriptPair).not.toBeNull();
	expect(f.pins.has(f.src.transcriptPair?.ref.receiptId ?? "missing")).toBe(
		true,
	);
});
it("returns an owned accepted node only after commit and detaches saved ref DTOs", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	let result: Awaited<ReturnType<typeof f.store.publishAccepted>> | undefined;
	f.state.beforeCommit = () => expect(result).toBeUndefined();
	result = await f.store.publishAccepted(p.capture, p.prepared, f.fence);
	const first = acceptedLocalStoryFlowPublicationEvidence(result);
	requireSynthetic(first.category === "CONTEXT");
	expect(first.acceptedNode).toBe(p.node);
	first.observationRef.proofHash = "0".repeat(64);
	expect(
		acceptedLocalStoryFlowPublicationEvidence(result).observationRef.proofHash,
	).not.toBe(first.observationRef.proofHash);
	expect(() =>
		acceptedLocalStoryFlowPublicationEvidence(structuredClone(result)),
	).toThrow();
});
it.each([
	"copied",
	"getter",
	"differentExpectation",
] as const)("rejects %s prepared authority while preserving pending history", async (variant) => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows),
		pins = new Set(f.pins),
		get = vi.fn();
	let prepared = p.prepared;
	if (variant === "copied") prepared = structuredClone(prepared);
	if (variant === "getter")
		prepared = Object.defineProperty({}, "native", { get, enumerable: true });
	if (variant === "differentExpectation") {
		const work = prepareLocalStoryFlowContextWork({
			archive: f.src.archive,
			nodeId: "n0",
			children: [],
		});
		prepared = prepareLocalStoryFlowContextPublication({
			node: acceptLocalStoryFlowContextWork({
				work,
				native: capturedLocalStoryFlowNativeEvidence(p.capture).native,
			}),
		});
	}
	await expect(
		f.store.publishAccepted(p.capture, prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(get).not.toHaveBeenCalled();
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
});
it("rejects a capture owned by another runtime without consuming the original capture", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	const other = createLocalStoryFlowRuntimeStore(f.options),
		before = structuredClone(f.rows);
	await expect(
		other.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
	await f.store.publishAccepted(p.capture, p.prepared, f.fence);
	other.dispose();
});
it.each([
	"fence",
	"media",
	"analysis",
	"binding",
] as const)("rejects a different %s source snapshot without any publication writes", async (variant) => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows),
		pins = new Set(f.pins);
	if (variant === "media") f.src.snapshots.mediaSnapshot.durationUs = "9999";
	if (variant === "analysis")
		f.src.snapshots.analysisSnapshot.providerVersion = "changed";
	if (variant === "binding") f.src.snapshots.bindingSnapshot.width++;
	await expect(
		f.store.publishAccepted(
			p.capture,
			p.prepared,
			variant === "fence" ? Object.freeze({}) : f.fence,
		),
	).rejects.toMatchObject({
		code:
			variant === "binding"
				? "SOURCE_CHANGED"
				: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
});
it.each([
	"missing",
	"corrupt",
] as const)("rejects %s legacy dependency and never recreates it", async (variant) => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	const entry = f.src.pairs[0]?.stage;
	expect(entry).toBeDefined();
	if (!entry) throw new Error("Missing synthetic stage");
	if (variant === "missing") f.rows.delete(entry.row.id);
	else {
		const row = f.rows.get(entry.row.id);
		if (!row) throw new Error("Missing row");
		row.proofHash = "0".repeat(64);
	}
	const before = structuredClone(f.rows),
		pins = new Set(f.pins);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
	expect(f.client.runObserved).toHaveBeenCalledTimes(1);
});
it("requires a fresh empty normalization SELECT when the archive snapshot is null", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	f.state.normalizationRows = [
		{
			...f.src.pairs[0]?.stage.row,
			kind: "NORMALIZATION_CAPTURE",
		} as LibraryEvidenceReceipt,
	];
	const before = structuredClone(f.rows),
		pins = new Set(f.pins);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(
		f.queries.some(
			(q) =>
				q.includes("LIMIT 2 FOR KEY SHARE") &&
				q.includes("'NORMALIZATION_CAPTURE'"),
		),
	).toBe(true);
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
});
it("rejects a different observation cache winner atomically", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	const proposal = localStoryFlowAcceptedContextNodePublication(p.node).cache;
	f.insert(proposal.kind, proposal.key, {
		...proposal.payload,
		observationHash: "f".repeat(64),
	});
	const before = structuredClone(f.rows),
		pins = new Set(f.pins);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
});
it("rejects a concurrent second publication before creating duplicate rows", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	const first = f.store.publishAccepted(p.capture, p.prepared, f.fence);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	await first;
	expect(f.client.runObserved).toHaveBeenCalledTimes(1);
	expect(
		[...f.rows.values()].map(payload).filter((p) => p.purpose === "OUTCOME"),
	).toHaveLength(1);
});
it("does not retry a failed publication or expose accepted authority after a commit failure", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows),
		pins = new Set(f.pins);
	f.state.beforeCommit = () => {
		throw new Error("PRIVATE_COMMIT_FAILURE");
	};
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	const writes = f.state.writes;
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
	expect(f.state.writes).toBe(writes);
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"UNCONFIRMED",
	"CONFIRMED",
] as const)("preserves sealed %s failure priority before rejecting malformed publication metadata", async (cleanup) => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	await f.store.recordFailed(p.reservation, "CANCELED", cleanup);
	const before = structuredClone(f.rows);
	f.controller.abort();
	await expect(
		f.store.publishAccepted(p.capture, {}, f.fence),
	).rejects.toMatchObject({
		code:
			cleanup === "UNCONFIRMED"
				? "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"
				: "CANCELED",
	});
	expect(f.rows).toEqual(before);
	expect(mocked.sourceFence).not.toHaveBeenCalled();
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
it.each([
	"PUB_SOURCE_FENCE",
	"PUB_RECEIPT_READ",
	"PUB_CREATE:SOURCE_ARCHIVE",
	"PUB_CREATE:NATIVE_OBSERVATION",
	"PUB_CREATE:NODE",
	"PUB_CREATE:NATIVE_CACHE",
	"PUB_CREATE:OUTCOME",
	"PUB_CREATE:CONTEXT_BINDING",
	"PUB_PIN:NODE",
	"PUB_PIN:CONTEXT_BINDING",
])("rolls back all publication writes when cancellation arrives after %s", async (at) => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows),
		pins = new Set(f.pins);
	f.state.waitAt = at;
	f.state.abortAfterWait = true;
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "CANCELED" });
	expect(f.state.waitAt).toBe("");
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
	expect(f.client.runObserved).toHaveBeenCalledTimes(1);
});
it.each([
	"PUB_SOURCE_FENCE",
	"PUB_RECEIPT_READ",
	"PUB_CREATE:NODE",
	"PUB_PIN:CONTEXT_BINDING",
])("rolls back publication if original deadline elapses at %s", async (at) => {
	vi.useFakeTimers();
	const f = publicationFixture();
	f.state.nowMs += 5_398_000;
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows),
		pins = new Set(f.pins);
	f.state.waitAt = at;
	f.state.waitAdvanceMs = 1001;
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED" });
	expect(f.state.waitAt).toBe("");
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
});
it("checks the full pending history before publishing and preserves a lost lease", async () => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows);
	f.current.leaseToken = "00000000-0000-4000-8000-000000000099";
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LEASE_LOST" });
	expect(f.rows).toEqual(before);
	expect(mocked.sourceFence).not.toHaveBeenCalled();
});
it("publishes a MERGE with every child's independently sealed accepted origin", async () => {
	const f = publicationFixture(33);
	await f.store.start();
	const layout = localStoryFlowContextSourceEvidence(f.src.source).layout.nodes,
		accepted = new Map<string, AcceptedLocalStoryFlowContextNode>();
	expect(layout.some((n) => n.phase === "MERGE")).toBe(true);
	for (const n of layout) {
		const children = (n.phase === "MERGE" ? n.children : []).map((id) => {
			const child = accepted.get(id);
			if (!child) throw new Error("Missing accepted child");
			return child;
		});
		const p = await publicationCapture(f, n.nodeId, children);
		await f.store.publishAccepted(p.capture, p.prepared, f.fence);
		accepted.set(n.nodeId, p.node);
	}
	expect(accepted.size).toBe(layout.length);
	expect([...f.rows.keys()].every((id) => f.pins.has(id))).toBe(true);
});

function normalizationRow(
	f: ReturnType<typeof publicationFixture>,
): LibraryEvidenceReceipt {
	const snapshot = f.src.snapshots.normalizationSnapshot;
	requireSynthetic(snapshot);
	return {
		id: pubId(78),
		organizationId: org,
		sourceId: f.tuple.sourceId,
		mediaVersionId: f.tuple.mediaVersionId,
		analysisRevisionId: null,
		kind: "NORMALIZATION_CAPTURE",
		proof: snapshot.proof,
		proofHash: snapshot.proofHash,
	} as LibraryEvidenceReceipt;
}
it("pins the independently verified actual normalization receipt ID in its own domain", async () => {
	const f = publicationFixture(1, false, true);
	const row = normalizationRow(f);
	f.rows.set(row.id, row);
	f.state.normalizationRows = [row];
	await f.store.start();
	const p = await publicationCapture(f);
	await f.store.publishAccepted(p.capture, p.prepared, f.fence);
	expect(f.pins.has(row.id)).toBe(true);
	expect(f.rows.get(row.id)).toEqual(row);
});
it.each([
	"missing",
	"duplicate",
	"proof",
	"wrongId",
] as const)("rejects %s normalization candidate without synthesizing a replacement", async (variant) => {
	const f = publicationFixture(1, false, true);
	const row = normalizationRow(f);
	f.state.normalizationRows =
		variant === "missing"
			? []
			: variant === "duplicate"
				? [row, { ...row, id: pubId(79) }]
				: [
						variant === "proof"
							? { ...row, proofHash: "0".repeat(64) }
							: { ...row, organizationId: pubId(99) },
					];
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows),
		pins = new Set(f.pins);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
});
function editorRow(
	f: ReturnType<typeof publicationFixture>,
): LibraryEvidenceReceipt {
	const binding = f.src.snapshots.bindingSnapshot;
	requireSynthetic(binding.attestation);
	const proof = {
		schemaVersion: 1,
		intentHash: hash({
			mediaVersionId: f.tuple.mediaVersionId,
			analysisRevisionId: f.tuple.analysisRevisionId,
			confirmation: { time: true, geometry: true, content: true },
		}),
		binding,
	};
	return {
		id: binding.attestation.receiptId,
		organizationId: org,
		sourceId: f.tuple.sourceId,
		mediaVersionId: f.tuple.mediaVersionId,
		analysisRevisionId: f.tuple.analysisRevisionId,
		kind: "EDITOR_ATTESTATION",
		proof: JSON.parse(JSON.stringify(proof)),
		proofHash: hash(proof),
		encodingId: null,
		jobId: null,
		createdBy: null,
		createdAt: new Date("2026-11-07T01:00:00Z"),
	};
}
it("pins the full editor-attestation receipt without treating the binding row as a receipt", async () => {
	const f = publicationFixture(1, false, false, true),
		row = editorRow(f);
	f.rows.set(row.id, row);
	await f.store.start();
	const p = await publicationCapture(f);
	await f.store.publishAccepted(p.capture, p.prepared, f.fence);
	expect(f.pins.has(row.id)).toBe(true);
	expect(f.rows.get(row.id)).toEqual(row);
});
it.each([
	"missing",
	"intent",
	"seal",
] as const)("rejects %s attestation authority before publication", async (variant) => {
	const f = publicationFixture(1, false, false, true),
		row = editorRow(f);
	if (variant === "intent") {
		const proof = {
			schemaVersion: 1,
			intentHash: "f".repeat(64),
			binding: f.src.snapshots.bindingSnapshot,
		};
		row.proof = proof;
		row.proofHash = hash(proof);
	}
	if (variant === "seal") row.proofHash = "0".repeat(64);
	if (variant !== "missing") f.rows.set(row.id, row);
	await f.store.start();
	const p = await publicationCapture(f),
		before = structuredClone(f.rows),
		pins = new Set(f.pins);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
});

it.each([
	"observation",
	"node",
	"cache",
] as const)("rejects a missing child's %s full seal instead of pinning its bare UUID", async (member) => {
	const f = publicationFixture(33);
	await f.store.start();
	const layout = localStoryFlowContextSourceEvidence(f.src.source).layout.nodes,
		accepted = new Map<string, AcceptedLocalStoryFlowContextNode>();
	for (const n of layout.filter((n) => n.phase === "LEAF")) {
		const p = await publicationCapture(f, n.nodeId);
		await f.store.publishAccepted(p.capture, p.prepared, f.fence);
		accepted.set(n.nodeId, p.node);
	}
	const merge = layout.find((n) => n.phase === "MERGE");
	requireSynthetic(merge && merge.phase === "MERGE");
	const children = merge.children.map((id) => {
		const child = accepted.get(id);
		requireSynthetic(child);
		return child;
	});
	const p = await publicationCapture(f, merge.nodeId, children),
		first = children[0];
	requireSynthetic(first);
	const dependency =
		localStoryFlowAcceptedContextNodePublication(first)[member];
	f.rows.delete(dependency.ref.receiptId);
	const before = structuredClone(f.rows),
		pins = new Set(f.pins);
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});

it.each([
	new MediaOperationError("LEASE_LOST"),
	new LibraryMediaTaskEvidenceError("SOURCE_CHANGED"),
])("retains trusted bridge guard $code over a concurrent signal abort", async (error) => {
	const f = publicationFixture();
	await f.store.start();
	const p = await publicationCapture(f);
	const before = structuredClone(f.rows),
		pins = new Set(f.pins);
	mocked.sourceFence.mockImplementationOnce(async () => {
		f.controller.abort();
		throw error;
	});
	await expect(
		f.store.publishAccepted(p.capture, p.prepared, f.fence),
	).rejects.toMatchObject({ code: error.code });
	expect(f.rows).toEqual(before);
	expect(f.pins).toEqual(pins);
	expect(f.client.cleanupOnly).not.toHaveBeenCalled();
});
