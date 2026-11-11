import { isDeepStrictEqual } from "node:util";
import {
	canonicalEditingJson,
	editingAnalysisBindingSchema,
	hashEditingEvidence as hash,
	type LocalStoryFlowTaskPolicyParts,
	localStoryFlowTaskPolicyPartsSchema,
	mediaTaskCacheKey,
	mediaTaskEnvelopeSchema,
	mediaTaskIntentHash,
	verifyPreparedNormalizationReceipt,
} from "@bitovp/core";
import {
	type AcceptedLocalStoryFlowContextNode,
	type AcceptedLocalStoryFlowRouteStep,
	type AdmittedFlowNative,
	admitFlowNativeObservation,
	admitLocalStoryFlowAcceptedOrigin,
	admittedFlowNativeEvidence,
	type BoundLocalStoryFlowAcceptedContext,
	type BoundLocalStoryFlowNativeExpectation,
	type BoundLocalStoryFlowNativeRoot,
	type BoundLocalStoryFlowSealedRecord,
	type BoundLocalStoryFlowSourceArchive,
	isLocalStoryFlowRuntimeFailureCode,
	LOCAL_STORY_FLOW_RUNTIME_POLICY,
	type LocalStoryFlowArchiveSourceSnapshots,
	type LocalStoryFlowArtifactProposal,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordRef,
	LocalStoryFlowRuntimeHistoryError,
	type LocalStoryFlowSourceTuple,
	localStoryFlowAcceptedContextNodePublication,
	localStoryFlowAcceptedOriginEvidence,
	localStoryFlowAcceptedRoutePublication,
	localStoryFlowContextSourceEvidence,
	localStoryFlowNativeExpectationEvidence,
	localStoryFlowNativeRootEvidence,
	localStoryFlowRecordIdentity,
	localStoryFlowRuntimeHistoryEvidence,
	localStoryFlowRuntimeIdentityEvidence,
	localStoryFlowRuntimeKey,
	localStoryFlowRuntimeKeys,
	localStoryFlowRuntimeSignature,
	localStoryFlowRuntimeStartRecord,
	localStoryFlowSealedRecordEvidence,
	localStoryFlowSourceArchiveContext,
	nativeRequestForOrigin,
	prepareLocalStoryFlowRuntimeIdentity,
	readLocalStoryFlowRuntimeHistory,
	readLocalStoryFlowSealedRecord,
	requireLocalStoryFlowRuntimeNativeKey,
} from "@bitovp/core/local-story-flow-hierarchy";
import {
	createLocalStoryLegacyTranscriptRecipe,
	type LocalStoryArtifactCacheRow,
	type LocalStoryLegacyArtifactRef,
	type LocalStoryLegacyTranscriptPrepared,
	readLocalStoryLegacyCacheRef,
} from "@bitovp/core/local-story-flow-server";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	type LibraryEvidenceReceipt,
	type LibraryMediaTask,
	LibraryMediaTaskEvidenceError,
	tenantOrganizationId,
	verifyLibraryMediaTaskEvidence,
} from "@bitovp/db";
import {
	localStoryFlowTaskLockKey,
	type OwnedLocalStoryFlowReadFence,
	validateLocalStoryFlowSourceArchiveReadFence,
} from "@bitovp/db/library-flow";
import type { createLocalSemanticClient } from "./local-semantic-client";
import {
	localStoryFlowPreparedPublicationEvidence,
	type PreparedLocalStoryFlowPublication,
} from "./local-story-flow-publication";
import type { VerifiedMediaTask } from "./media-task-execution";
import { MediaOperationError } from "./process";

export { LOCAL_STORY_FLOW_RUNTIME_POLICY } from "@bitovp/core/local-story-flow-hierarchy";

const KIND = "LOCAL_FLOW_PLAN_V1" as const;
const failureCodes = { has: isLocalStoryFlowRuntimeFailureCode };
type Ref = LocalStoryFlowRecordRef;
type Payload = Record<string, unknown>;
type Sealed = { ref: Ref; payload: Payload };
type RuntimePurpose =
	| "START"
	| "ATTEMPT"
	| "OUTCOME"
	| "CONTEXT_BINDING"
	| "ROUTE_PREFIX";
type RuntimeRow = Sealed & { key: LocalStoryFlowRecordKey };
const equal = (a: unknown, b: unknown) =>
	canonicalEditingJson(a) === canonicalEditingJson(b);
function requireRuntime(
	value: unknown,
	code = "LOCAL_STORY_ARTIFACT_UNVERIFIED",
): asserts value {
	if (!value) throw new MediaOperationError(code);
}
/** Shared failures contain only the fixed artifact code; live control failures stay outside this boundary. */
function shared<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof LocalStoryFlowRuntimeHistoryError)
			throw new MediaOperationError(error.code);
		throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	}
}
function sealProjection(row: LibraryEvidenceReceipt) {
	return {
		id: row.id,
		organizationId: row.organizationId,
		sourceId: row.sourceId,
		mediaVersionId: row.mediaVersionId,
		analysisRevisionId: row.analysisRevisionId,
		kind: row.kind,
		proof: row.proof,
		proofHash: row.proofHash,
	};
}
function tuple(
	task: LibraryMediaTask,
	verified: VerifiedMediaTask,
): LocalStoryFlowSourceTuple {
	const { identity } = verified.envelope;
	requireRuntime(
		task.kind === "GENERATE" &&
			task.analysisRevisionId &&
			verified.binding &&
			verified.media.sha256 &&
			identity.analysisRawHash &&
			identity.analysisDocumentHash,
	);
	return {
		version: "local-story-flow-source-tuple-v1",
		organizationId: task.organizationId,
		sourceId: verified.media.sourceId,
		mediaVersionId: verified.media.id,
		mediaSha256: verified.media.sha256,
		timeMapHash: hash(verified.media.timeMap),
		analysisRevisionId: task.analysisRevisionId,
		analysisRawHash: identity.analysisRawHash,
		analysisDocumentHash: identity.analysisDocumentHash,
		bindingHash: hash(verified.binding),
		preparedShotClockHash: identity.preparedShotClock
			? hash(identity.preparedShotClock)
			: null,
		normalizationReceiptHash: verified.preparedNormalization?.proofHash ?? null,
	};
}
export type ReservedLocalStoryFlowNative = Readonly<object>;
export type CapturedLocalStoryFlowNative = Readonly<object>;
type Reservation = {
	owner: object;
	start: RuntimeRow;
	attempt: RuntimeRow;
	expectation: BoundLocalStoryFlowNativeExpectation;
	used: boolean;
};
type Capture = {
	owner: object;
	reservation: Reservation;
	native: AdmittedFlowNative;
};
const reservations = new WeakMap<ReservedLocalStoryFlowNative, Reservation>();
const captures = new WeakMap<CapturedLocalStoryFlowNative, Capture>();
export type AcceptedLocalStoryFlowPublication = Readonly<object>;
type AcceptedPublicationRefs = {
	sourceArchiveRef: Ref;
	observationRef: Ref;
	artifactRef: Ref;
	cacheRef: Ref;
	outcomeRef: Ref;
};
export type LocalStoryFlowAcceptedPublicationEvidence =
	| (AcceptedPublicationRefs & {
			category: "CONTEXT";
			acceptedNode: AcceptedLocalStoryFlowContextNode;
			bindingRef: Ref;
	  })
	| (AcceptedPublicationRefs & {
			category: "ROUTE";
			acceptedStep: AcceptedLocalStoryFlowRouteStep;
			nativeRoot: BoundLocalStoryFlowNativeRoot;
			treeRef: Ref;
			prefixRef: Ref;
	  });
const acceptedPublications = new WeakMap<
	AcceptedLocalStoryFlowPublication,
	LocalStoryFlowAcceptedPublicationEvidence
>();
const publicationAttempts = new WeakSet<CapturedLocalStoryFlowNative>();
type ArchiveDependencyView = {
	sourceTuple: LocalStoryFlowSourceTuple;
	taskId: string;
	taskPayloadHash: string;
	taskPin: ReturnType<typeof localStoryFlowRuntimeIdentityEvidence>["taskPin"];
	mediaSnapshot: LocalStoryFlowArchiveSourceSnapshots["mediaSnapshot"];
	bindingSnapshot: unknown;
	normalizationSnapshot: LocalStoryFlowArchiveSourceSnapshots["normalizationSnapshot"];
	transcriptAdmission:
		| { status: "NO_AUDIO" }
		| {
				status: "READY";
				artifactRef: LocalStoryLegacyArtifactRef;
				artifactKey: unknown;
				transcript: Omit<LocalStoryLegacyTranscriptPrepared, "cached">;
		  };
	orderedLedgerAdmissions: Array<{
		pointerKey: unknown;
		pointerRef: LocalStoryLegacyArtifactRef;
		pointerBody: unknown;
		stageKey: unknown;
		stageRef: LocalStoryLegacyArtifactRef;
		stageBody: unknown;
	}>;
};
type PreparedRecord = {
	proposal: LocalStoryFlowArtifactProposal;
	proof: { version: string; cacheHash: string; valueJson: string };
	proofHash: string;
};
const treeRecords = new WeakMap<
	BoundLocalStoryFlowAcceptedContext,
	PreparedRecord
>();
const routeLayouts = new WeakMap<
	BoundLocalStoryFlowSourceArchive,
	ReturnType<typeof localStoryFlowContextSourceEvidence>["layout"]
>();
const archiveRecords = new WeakMap<
	BoundLocalStoryFlowSourceArchive,
	PreparedRecord
>();
/** Publication authority is created only after a committed transaction, never from a copied ref. */
export function acceptedLocalStoryFlowPublicationEvidence(
	handle: AcceptedLocalStoryFlowPublication,
): LocalStoryFlowAcceptedPublicationEvidence {
	const evidence = acceptedPublications.get(handle);
	requireRuntime(evidence);
	if (evidence.category === "ROUTE") {
		const { acceptedStep, nativeRoot, ...refs } = evidence;
		return { ...structuredClone(refs), acceptedStep, nativeRoot };
	}
	const { acceptedNode, ...refs } = evidence;
	return { ...structuredClone(refs), acceptedNode };
}
function prepareRecord(
	proposal: LocalStoryFlowArtifactProposal,
): PreparedRecord {
	const expected = localStoryFlowRecordIdentity({
		sourceTuple: proposal.sourceTuple,
		kind: proposal.kind,
		key: proposal.key,
	});
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: expected.cacheHash,
		valueJson: canonicalEditingJson(proposal.payload),
	};
	const proofHash = hash(proof);
	requireRuntime(
		equal(proposal.ref, { kind: proposal.kind, ...expected, proofHash }),
	);
	return { proposal, proof, proofHash };
}

/** Used by the later publication adapter; a copied DTO cannot manufacture a capture. */
export function capturedLocalStoryFlowNativeEvidence(
	handle: CapturedLocalStoryFlowNative,
) {
	const captured = captures.get(handle);
	requireRuntime(captured);
	return {
		native: captured.native,
		expectation: captured.reservation.expectation,
		startRef: structuredClone(captured.reservation.start.ref),
		attemptRef: structuredClone(captured.reservation.attempt.ref),
		slot: captured.reservation.attempt.payload.slot as number,
	};
}

/** No native work, media IO, or long CPU operation runs while holding a transaction. */
export function createLocalStoryFlowRuntimeStore(options: {
	prisma: AppPrismaClient;
	task: LibraryMediaTask;
	verified: VerifiedMediaTask;
	leaseToken: string;
	connectionHash: string;
	policies: LocalStoryFlowTaskPolicyParts;
	client: Pick<
		ReturnType<typeof createLocalSemanticClient>,
		"runObserved" | "cleanupOnly"
	>;
	signal: AbortSignal;
}) {
	const task = structuredClone(options.task),
		verified = structuredClone(options.verified);
	const policies = localStoryFlowTaskPolicyPartsSchema.parse(options.policies);
	const sourceTuple = tuple(task, verified);
	requireRuntime(tenantOrganizationId(options.prisma) === task.organizationId);
	requireRuntime(/^[a-f0-9]{64}$/.test(options.connectionHash));
	const runtimeIdentity = shared(() =>
		prepareLocalStoryFlowRuntimeIdentity({
			taskId: task.id,
			organizationId: task.organizationId,
			taskParameters: task.parameters,
			startedAtMs: task.startedAt?.getTime(),
			sourceTuple,
			policies,
		}),
	);
	const { taskPayloadHash, startedAtMs, deadlineAtMs } = shared(() =>
		localStoryFlowRuntimeIdentityEvidence(runtimeIdentity),
	);
	const owner = {};
	const deadlineController = new AbortController();
	const signal = AbortSignal.any([options.signal, deadlineController.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let started = false;
	let monotonicDeadline = Number.POSITIVE_INFINITY;
	const checkSignal = () => {
		if (disposed || options.signal.aborted)
			throw new MediaOperationError("CANCELED");
		if (performance.now() >= monotonicDeadline) deadlineController.abort();
		if (deadlineController.signal.aborted)
			throw new MediaOperationError("LOCAL_STORY_FLOW_DEADLINE_EXCEEDED");
	};
	function requireNativeTaskPin(nativeKey: Payload) {
		shared(() =>
			requireLocalStoryFlowRuntimeNativeKey(runtimeIdentity, nativeKey),
		);
	}
	const key = (
		purpose: RuntimePurpose,
		locator?: number | string,
	): LocalStoryFlowRecordKey =>
		shared(() => {
			if (purpose === "START")
				return localStoryFlowRuntimeKey(runtimeIdentity, { purpose });
			if (purpose === "CONTEXT_BINDING") {
				requireRuntime(typeof locator === "string");
				return localStoryFlowRuntimeKey(runtimeIdentity, {
					purpose,
					nodeId: locator,
				});
			}
			requireRuntime(typeof locator === "number");
			return purpose === "ROUTE_PREFIX"
				? localStoryFlowRuntimeKey(runtimeIdentity, {
						purpose,
						ordinal: locator,
					})
				: localStoryFlowRuntimeKey(runtimeIdentity, { purpose, slot: locator });
		});
	const identity = (recordKey: LocalStoryFlowRecordKey) =>
		localStoryFlowRecordIdentity({ sourceTuple, kind: KIND, key: recordKey });
	function sealed(
		row: LibraryEvidenceReceipt,
		recordKey: LocalStoryFlowRecordKey,
	): BoundLocalStoryFlowSealedRecord {
		const expected = identity(recordKey);
		const proof = row.proof as Record<string, unknown> | null;
		requireRuntime(proof && typeof row.proofHash === "string");
		const ref: Ref = { kind: KIND, ...expected, proofHash: row.proofHash };
		const record = readLocalStoryFlowSealedRecord({
			sourceTuple,
			kind: KIND,
			key: recordKey,
			ref,
			row: sealProjection(row),
		});
		return record;
	}
	function decode(
		row: LibraryEvidenceReceipt,
		recordKey: LocalStoryFlowRecordKey,
	): RuntimeRow {
		const record = sealed(row, recordKey),
			e = localStoryFlowSealedRecordEvidence(record);
		return { key: recordKey, ref: e.ref, payload: e.payload };
	}
	async function put(
		tx: AppTransactionClient,
		recordKey: LocalStoryFlowRecordKey,
		payload: Payload,
		controlPlane = false,
	): Promise<RuntimeRow> {
		if (!controlPlane) checkSignal();
		const expected = identity(recordKey),
			proof = {
				version: "local-story-cache-v2",
				cacheHash: expected.cacheHash,
				valueJson: canonicalEditingJson(payload),
			};
		const winner = await tx.libraryEvidenceReceipt.findUnique({
			where: { id: expected.receiptId },
		});
		if (!controlPlane) checkSignal();
		if (winner) {
			const read = decode(winner, recordKey);
			requireRuntime(equal(read.payload, payload));
			return read;
		}
		const row = await tx.libraryEvidenceReceipt.create({
			data: {
				id: expected.receiptId,
				organizationId: task.organizationId,
				sourceId: sourceTuple.sourceId,
				mediaVersionId: sourceTuple.mediaVersionId,
				analysisRevisionId: sourceTuple.analysisRevisionId,
				kind: KIND,
				proof,
				proofHash: hash(proof),
				createdBy: task.createdBy,
			},
		});
		if (!controlPlane) checkSignal();
		return decode(row, recordKey);
	}
	async function pin(
		tx: AppTransactionClient,
		refs: Ref[],
		controlPlane = false,
	) {
		if (!controlPlane) checkSignal();
		await tx.libraryFlowEvidencePin.createMany({
			data: [...new Set(refs.map((r) => r.receiptId))]
				.sort()
				.map((receiptId) => ({
					organizationId: task.organizationId,
					taskId: task.id,
					receiptId,
				})),
			skipDuplicates: true,
		});
		// Reject known expiry inside the transaction callback so its writes roll back.
		if (!controlPlane) checkSignal();
	}
	async function lockTask(tx: AppTransactionClient) {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(${localStoryFlowTaskLockKey(task.id)})`;
		const locked = await tx.$queryRaw<
			LibraryMediaTask[]
		>`SELECT * FROM "LibraryMediaTask" WHERE "organizationId" = ${task.organizationId}::uuid AND "id" = ${task.id}::uuid FOR UPDATE`;
		const clockRequestedAt = performance.now();
		const clock = await tx.$queryRaw<
			Array<{ nowMs: bigint }>
		>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`;
		const nowMs = Number(clock[0]?.nowMs),
			current = locked[0];
		requireRuntime(
			locked.length === 1 && clock.length === 1 && Number.isSafeInteger(nowMs),
		);
		// Count source locking, writes and commit latency against the same original deadline.
		monotonicDeadline = Math.min(
			monotonicDeadline,
			clockRequestedAt + deadlineAtMs - nowMs,
		);
		requireRuntime(
			current?.state === "RUNNING" &&
				current.organizationId === task.organizationId &&
				current.id === task.id &&
				current.leaseToken === options.leaseToken &&
				current.leaseUntil &&
				current.leaseUntil.getTime() > nowMs,
			"LEASE_LOST",
		);
		requireRuntime(
			hash(current.parameters) === taskPayloadHash &&
				current.startedAt?.getTime() === startedAtMs &&
				current.requestHash === task.requestHash &&
				current.cacheKey === task.cacheKey &&
				current.parentTaskId === task.parentTaskId &&
				current.kind === task.kind &&
				current.mediaVersionId === task.mediaVersionId &&
				current.analysisRevisionId === task.analysisRevisionId,
			"SOURCE_CHANGED",
		);
		return { current, nowMs };
	}
	async function positiveFence(
		tx: AppTransactionClient,
		locked: Awaited<ReturnType<typeof lockTask>>,
	) {
		const { current, nowMs } = locked;
		checkSignal();
		requireRuntime(!current.cancelRequestedAt, "CANCELED");
		requireRuntime(nowMs < deadlineAtMs, "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED");
		// Source rows use SHARE: KEY SHARE alone permits non-key source changes.
		const sources = await tx.$queryRaw<
			Array<{ id: string }>
		>`SELECT "id" FROM "LibrarySource" WHERE "organizationId" = ${task.organizationId}::uuid AND "id" = ${sourceTuple.sourceId}::uuid FOR SHARE`;
		const media = await tx.$queryRaw<
			Array<{ id: string }>
		>`SELECT "id" FROM "LibraryMediaVersion" WHERE "organizationId" = ${task.organizationId}::uuid AND "id" = ${sourceTuple.mediaVersionId}::uuid FOR SHARE`;
		const revisions = await tx.$queryRaw<
			Array<{ id: string }>
		>`SELECT "id" FROM "SceneAnalysisRevision" WHERE "organizationId" = ${task.organizationId}::uuid AND "id" = ${sourceTuple.analysisRevisionId}::uuid FOR SHARE`;
		const bindings = await tx.$queryRaw<
			Array<{ id: string }>
		>`SELECT "id" FROM "LibraryAnalysisBinding" WHERE "organizationId" = ${task.organizationId}::uuid AND "mediaVersionId" = ${sourceTuple.mediaVersionId}::uuid AND "analysisRevisionId" = ${sourceTuple.analysisRevisionId}::uuid FOR SHARE`;
		requireRuntime(
			sources.length === 1 &&
				media.length === 1 &&
				revisions.length === 1 &&
				bindings.length > 0,
			"SOURCE_CHANGED",
		);
		const rechecked = await verifyLibraryMediaTaskEvidence(
			tx,
			current,
			verified.binding,
		);
		requireRuntime(
			equal(tuple(current, rechecked), sourceTuple),
			"SOURCE_CHANGED",
		);
		checkSignal();
	}
	async function fence(tx: AppTransactionClient, controlPlane = false) {
		const locked = await lockTask(tx);
		if (!controlPlane) await positiveFence(tx, locked);
		return locked.nowMs;
	}
	function startPayload() {
		return shared(() =>
			localStoryFlowRuntimeStartRecord(runtimeIdentity, options.connectionHash),
		).payload;
	}
	const runtimeKeys = shared(() => localStoryFlowRuntimeKeys(runtimeIdentity));
	const keysById = new Map(runtimeKeys.map((k) => [identity(k).receiptId, k]));
	type Scan = {
		start: RuntimeRow;
		attempts: RuntimeRow[];
		outcomes: Map<number, RuntimeRow>;
		prefixes: RuntimeRow[];
		bindings: RuntimeRow[];
	};
	async function scan(tx: AppTransactionClient): Promise<Scan> {
		const rows = await tx.libraryEvidenceReceipt.findMany({
			where: {
				organizationId: task.organizationId,
				id: { in: [...keysById.keys()] },
			},
			take: LOCAL_STORY_FLOW_RUNTIME_POLICY.knownRuntimeKeys + 1,
		});
		requireRuntime(
			rows.length <= LOCAL_STORY_FLOW_RUNTIME_POLICY.knownRuntimeKeys &&
				new Set(rows.map((r) => r.id)).size === rows.length,
		);
		const records = rows.map((r) => {
			const k = keysById.get(r.id);
			requireRuntime(k);
			return sealed(r, k);
		});
		const pins = await tx.libraryFlowEvidencePin.findMany({
			where: {
				organizationId: task.organizationId,
				taskId: task.id,
				receiptId: {
					in: records.map(
						(r) => localStoryFlowSealedRecordEvidence(r).ref.receiptId,
					),
				},
			},
		});
		const evidence = shared(() =>
			localStoryFlowRuntimeHistoryEvidence(
				readLocalStoryFlowRuntimeHistory({
					identity: runtimeIdentity,
					records,
					pins: pins.map((p) => ({
						organizationId: p.organizationId,
						taskId: p.taskId,
						receiptId: p.receiptId,
					})),
				}),
			),
		);
		return {
			start: evidence.start,
			attempts: evidence.attempts,
			outcomes: new Map(
				evidence.outcomes.map((r) => [Number(r.payload.slot), r]),
			),
			prefixes: evidence.prefixes,
			bindings: evidence.bindings,
		};
	}
	function rethrowStoredFailure(state: Scan) {
		const failed = state.outcomes.get(state.attempts.length)?.payload;
		if (failed?.status !== "FAILED") return;
		requireRuntime(
			typeof failed.failureCode === "string" &&
				failureCodes.has(failed.failureCode),
		);
		throw new MediaOperationError(
			failed.cleanupStatus === "UNCONFIRMED"
				? "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"
				: failed.failureCode,
		);
	}
	async function liveHistory(tx: AppTransactionClient) {
		const locked = await lockTask(tx),
			state = await scan(tx);
		rethrowStoredFailure(state);
		await positiveFence(tx, locked);
		return { ...locked, state };
	}
	function signatureFor(nativeKey: Payload, request: Payload) {
		return shared(() =>
			localStoryFlowRuntimeSignature(runtimeIdentity, nativeKey, request),
		);
	}

	async function receipt(
		tx: AppTransactionClient,
		receiptId: string,
	): Promise<LocalStoryArtifactCacheRow> {
		const rows = await tx.$queryRaw<
			LocalStoryArtifactCacheRow[]
		>`SELECT "id","organizationId","sourceId","mediaVersionId","analysisRevisionId","kind","proof","proofHash" FROM "LibraryEvidenceReceipt" WHERE "organizationId" = ${task.organizationId}::uuid AND "id" = ${receiptId}::uuid FOR KEY SHARE`;
		checkSignal();
		requireRuntime(rows.length === 1 && rows[0]);
		return rows[0];
	}
	function expectedRow(record: PreparedRecord) {
		const { proposal: p } = record;
		return {
			id: p.ref.receiptId,
			organizationId: sourceTuple.organizationId,
			sourceId: sourceTuple.sourceId,
			mediaVersionId: sourceTuple.mediaVersionId,
			analysisRevisionId: sourceTuple.analysisRevisionId,
			kind: p.kind,
			proof: record.proof,
			proofHash: record.proofHash,
		};
	}
	async function readProposal(
		tx: AppTransactionClient,
		record: PreparedRecord,
	) {
		requireRuntime(
			isDeepStrictEqual(
				await receipt(tx, record.proposal.ref.receiptId),
				expectedRow(record),
			),
		);
		return readLocalStoryFlowSealedRecord({
			sourceTuple,
			kind: record.proposal.kind,
			key: record.proposal.key,
			ref: record.proposal.ref,
			row: expectedRow(record),
		});
	}
	async function putProposal(tx: AppTransactionClient, record: PreparedRecord) {
		checkSignal();
		const expected = expectedRow(record),
			existing = await tx.libraryEvidenceReceipt.findUnique({
				where: { id: expected.id },
			});
		checkSignal();
		if (existing) {
			// Exact immutable winner only: a cache for another observation cannot replace this capture.
			requireRuntime(isDeepStrictEqual(sealProjection(existing), expected));
		} else {
			const row = await tx.libraryEvidenceReceipt.create({
				data: { ...expected, createdBy: task.createdBy },
			});
			checkSignal();
			requireRuntime(isDeepStrictEqual(sealProjection(row), expected));
		}
		return record.proposal.ref;
	}
	async function pinVerifiedIds(
		tx: AppTransactionClient,
		ids: readonly string[],
	) {
		checkSignal();
		await tx.libraryFlowEvidencePin.createMany({
			data: [...new Set(ids)].sort().map((receiptId) => ({
				organizationId: task.organizationId,
				taskId: task.id,
				receiptId,
			})),
			skipDuplicates: true,
		});
		checkSignal();
	}
	type PublicationPlan = ReturnType<
		typeof localStoryFlowPreparedPublicationEvidence
	>;
	type ContextView = ReturnType<
		typeof localStoryFlowAcceptedContextNodePublication
	>;
	type RouteView = ReturnType<typeof localStoryFlowAcceptedRoutePublication>;
	type NativeDependency = {
		native: AdmittedFlowNative;
		expectation: BoundLocalStoryFlowNativeExpectation;
		observation: PreparedRecord;
		artifact: PreparedRecord;
		cache: PreparedRecord;
		artifactHash: string;
	};
	function nativeDependency(view: {
		native: AdmittedFlowNative;
		expectation: BoundLocalStoryFlowNativeExpectation;
		observation: LocalStoryFlowArtifactProposal;
		artifact: LocalStoryFlowArtifactProposal;
		cache: LocalStoryFlowArtifactProposal;
		artifactHash: unknown;
	}): NativeDependency {
		requireRuntime(
			typeof view.artifactHash === "string" &&
				/^[a-f0-9]{64}$/.test(view.artifactHash),
		);
		return {
			native: view.native,
			expectation: view.expectation,
			observation: prepareRecord(view.observation),
			artifact: prepareRecord(view.artifact),
			cache: prepareRecord(view.cache),
			artifactHash: view.artifactHash,
		};
	}
	function publicationDependencies(plan: PublicationPlan) {
		const roots =
				plan.category === "CONTEXT" ? plan.children : plan.contextNodes,
			pending = [...roots],
			seen = new Set<AcceptedLocalStoryFlowContextNode>(),
			nodes = new Map<
				string,
				{ view: ContextView; dependency: NativeDependency }
			>(),
			declared =
				plan.category === "ROUTE"
					? plan.contextNodes.map(localStoryFlowAcceptedContextNodePublication)
					: [];
		requireRuntime(roots.length <= 63);
		while (pending.length) {
			const handle = pending.pop();
			requireRuntime(handle);
			if (seen.has(handle)) continue;
			seen.add(handle);
			// Each owned seed has at most63 subtree handles. Alias work is bounded separately from semantic nodes.
			requireRuntime(seen.size <= Math.max(1, roots.length) * 63);
			const view = localStoryFlowAcceptedContextNodePublication(handle);
			requireRuntime(equal(view.node.sourceTuple, sourceTuple));
			// Even an exact alias can own differently reconstructed child handles; do not drop those edges.
			pending.push(...view.children);
			const old = nodes.get(view.node.ref.receiptId);
			if (old) {
				requireRuntime(
					equal(old.view.node, view.node) &&
						equal(old.view.observation, view.observation) &&
						equal(old.view.cache, view.cache) &&
						equal(
							admittedFlowNativeEvidence(old.view.native).origin,
							admittedFlowNativeEvidence(view.native).origin,
						) &&
						equal(
							localStoryFlowNativeExpectationEvidence(old.view.expectation)
								.nativeKey,
							localStoryFlowNativeExpectationEvidence(view.expectation)
								.nativeKey,
						),
				);
				continue;
			}
			nodes.set(view.node.ref.receiptId, {
				view,
				dependency: nativeDependency({
					...view,
					artifact: view.node,
					artifactHash: view.node.payload.nodeHash,
				}),
			});
			requireRuntime(nodes.size <= 63);
		}
		const previous: Array<{
			handle: AcceptedLocalStoryFlowRouteStep;
			view: RouteView;
			dependency: NativeDependency;
		}> = [];
		let route: RouteView | undefined;
		if (plan.category === "ROUTE") {
			route = localStoryFlowAcceptedRoutePublication(plan.acceptedStep);
			if (!routeLayouts.has(plan.archive))
				routeLayouts.set(
					plan.archive,
					localStoryFlowContextSourceEvidence(
						localStoryFlowSourceArchiveContext(plan.archive),
					).layout,
				);
			requireRuntime(
				route.archive === plan.archive &&
					route.context === plan.context &&
					route.native === plan.native &&
					route.expectation === plan.expectation &&
					route.previous === plan.previous &&
					route.nativeRoot === plan.nativeRoot &&
					route.progressHash === plan.progressHash &&
					equal(route.step, plan.artifact) &&
					equal(route.observation, plan.observation) &&
					equal(route.cache, plan.cache),
			);
			let handle = plan.previous;
			const seenSteps = new Set<AcceptedLocalStoryFlowRouteStep>();
			while (handle) {
				requireRuntime(!seenSteps.has(handle));
				seenSteps.add(handle);
				requireRuntime(seenSteps.size <= 63);
				const view = localStoryFlowAcceptedRoutePublication(handle);
				requireRuntime(
					view.archive === plan.archive &&
						view.context === plan.context &&
						view.nativeRoot === plan.nativeRoot &&
						equal(view.step.sourceTuple, sourceTuple),
				);
				previous.push({
					handle,
					view,
					dependency: nativeDependency({
						...view,
						artifact: view.step,
						artifactHash: view.step.payload.stepHash,
					}),
				});
				handle = view.previous;
			}
			previous.reverse();
		}
		const ids = new Set([task.id]);
		for (const dep of [...nodes.values()]
			.map((n) => n.dependency)
			.concat(previous.map((p) => p.dependency))) {
			const origin = admittedFlowNativeEvidence(dep.native).origin;
			requireRuntime(
				origin.organizationId === task.organizationId &&
					/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
						origin.originTaskId,
					),
			);
			ids.add(origin.originTaskId);
		}
		// Existing stage limits derive category-specific Task bounds; no namespace/policy/cap change.
		requireRuntime(ids.size <= (plan.category === "CONTEXT" ? 64 : 127));
		return {
			taskIds: [...ids].sort(),
			contexts: [...nodes.values()],
			declared,
			previous,
			route,
		};
	}
	type PublicationDependencies = ReturnType<typeof publicationDependencies>;
	async function lockPublicationTasks(
		tx: AppTransactionClient,
		ids: string[] | undefined,
	) {
		// Anchor before any advisory/row wait. A later fresh sample can only shorten it.
		const requestedAt = performance.now(),
			clock = await tx.$queryRaw<
				Array<{ nowMs: bigint }>
			>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`;
		const nowMs = Number(clock[0]?.nowMs);
		requireRuntime(clock.length === 1 && Number.isSafeInteger(nowMs));
		monotonicDeadline = Math.min(
			monotonicDeadline,
			requestedAt + deadlineAtMs - nowMs,
		);
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(${localStoryFlowTaskLockKey(task.id)})`;
		const rows = new Map<string, LibraryMediaTask>();
		let complete = ids !== undefined;
		for (const id of ids ?? [task.id]) {
			const locked =
				id === task.id
					? await tx.$queryRaw<
							LibraryMediaTask[]
						>`SELECT * FROM "LibraryMediaTask" WHERE "organizationId" = ${task.organizationId}::uuid AND "id" = ${id}::uuid FOR UPDATE`
					: await tx.$queryRaw<
							LibraryMediaTask[]
						>`SELECT * FROM "LibraryMediaTask" WHERE "organizationId" = ${task.organizationId}::uuid AND "id" = ${id}::uuid FOR SHARE`;
			const row = locked[0];
			if (
				locked.length !== 1 ||
				!row ||
				row.id !== id ||
				row.organizationId !== task.organizationId
			)
				complete = false;
			else rows.set(id, row);
		}
		// Let liveHistory retain stored S0/lease/source priority before a missing hint is rejected.
		return { rows, complete };
	}
	async function sourceDependencies(
		tx: AppTransactionClient,
		plan: PublicationPlan,
	) {
		// The proposal comes only from the owned archive factory; this narrows that closed generated layout, not an untrusted DTO.
		const a = plan.sourceArchive.payload as ArchiveDependencyView;
		requireRuntime(
			equal(a.sourceTuple, sourceTuple) &&
				a.taskId === task.id &&
				a.taskPayloadHash === taskPayloadHash &&
				equal(
					a.taskPin,
					localStoryFlowRuntimeIdentityEvidence(runtimeIdentity).taskPin,
				),
		);
		const scope = {
			task: { organizationId: task.organizationId },
			media: a.mediaSnapshot,
			taskIdentity: a.taskPin.identity,
			analysisRevisionId: sourceTuple.analysisRevisionId,
		};
		const checkedRefs = [];
		for (const admission of a.orderedLedgerAdmissions) {
			for (const entry of [
				{
					key: admission.pointerKey,
					ref: admission.pointerRef,
					body: admission.pointerBody,
				},
				{
					key: admission.stageKey,
					ref: admission.stageRef,
					body: admission.stageBody,
				},
			]) {
				const row = await receipt(tx, entry.ref.receiptId);
				readLocalStoryLegacyCacheRef({
					...scope,
					input: {
						kind: entry.ref.kind,
						key: entry.key,
						parse(value: unknown) {
							requireRuntime(equal(value, entry.body));
							return value;
						},
					},
					row,
					ref: entry.ref,
					check: checkSignal,
				});
				checkedRefs.push(entry.ref);
			}
		}
		if (a.transcriptAdmission.status === "READY") {
			const admission = a.transcriptAdmission;
			const artifactRef = admission.artifactRef;
			requireRuntime(artifactRef);
			const transcript = admission.transcript;
			const language = a.taskPin.parameters.language;
			requireRuntime(
				language === "ja" || language === "en" || language === "auto",
			);
			const recipe = createLocalStoryLegacyTranscriptRecipe({
				mediaSha256: sourceTuple.mediaSha256,
				timeMap: a.mediaSnapshot.timeMap,
				configuredModel: transcript.modelSha256
					? { sha256: transcript.modelSha256 }
					: null,
				language,
			});
			requireRuntime(equal(recipe.key, admission.artifactKey));
			const loaded = readLocalStoryLegacyCacheRef({
				...scope,
				analysisRevisionId: null,
				input: {
					kind: "LOCAL_STORY_TRANSCRIPT_V1",
					key: recipe.key,
					parse: recipe.parse,
					recoverLegacyTranscriptValue: recipe.recoverLegacyDerivedMean,
				},
				row: await receipt(tx, artifactRef.receiptId),
				ref: artifactRef,
				check: checkSignal,
			});
			const { cached: _cached, ...meaning } = recipe.ready({
				value: loaded.value,
				valueHash: loaded.hash,
				cached: true,
			});
			requireRuntime(equal(meaning, transcript));
			checkedRefs.push(artifactRef);
		}
		requireRuntime(
			checkedRefs.length <= 257 &&
				equal(
					[...checkedRefs].sort((a, b) =>
						a.receiptId.localeCompare(b.receiptId),
					),
					[...plan.requiredLegacyRefs].sort((a, b) =>
						a.receiptId.localeCompare(b.receiptId),
					),
				),
		);
		const ids = checkedRefs.map((ref) => ref.receiptId);
		// NORMALIZATION_CAPTURE is a separate proof domain, never cast to a FLOW/legacy ref.
		// Absence is freshly measured HERE; the earlier source RR did not necessarily read absence.
		const normalization = await tx.$queryRaw<
			LocalStoryArtifactCacheRow[]
		>`SELECT "id","organizationId","sourceId","mediaVersionId","analysisRevisionId","kind","proof","proofHash" FROM "LibraryEvidenceReceipt" WHERE "organizationId" = ${task.organizationId}::uuid AND "mediaVersionId" = ${sourceTuple.mediaVersionId}::uuid AND "kind" = 'NORMALIZATION_CAPTURE' LIMIT 2 FOR KEY SHARE`;
		checkSignal();
		if (a.normalizationSnapshot === null)
			requireRuntime(normalization.length === 0);
		else {
			const row = normalization[0];
			requireRuntime(normalization.length === 1 && row);
			requireRuntime(
				row.organizationId === task.organizationId &&
					row.sourceId === sourceTuple.sourceId &&
					row.mediaVersionId === sourceTuple.mediaVersionId &&
					row.analysisRevisionId === null &&
					row.kind === "NORMALIZATION_CAPTURE" &&
					isDeepStrictEqual(
						{ proof: row.proof, proofHash: row.proofHash },
						a.normalizationSnapshot,
					),
			);
			verifyPreparedNormalizationReceipt({
				proof: row.proof,
				proofHash: row.proofHash,
				organizationId: task.organizationId,
				sourceId: sourceTuple.sourceId,
				mediaVersionId: sourceTuple.mediaVersionId,
				preparedSha256: sourceTuple.mediaSha256,
				timeMap: a.mediaSnapshot.timeMap,
				width: a.mediaSnapshot.width,
				height: a.mediaSnapshot.height,
			});
			ids.push(row.id);
		}
		const binding = editingAnalysisBindingSchema.parse(a.bindingSnapshot);
		if (binding.kind === "EDITOR_ATTESTED") {
			requireRuntime(binding.attestation);
			const row = await receipt(tx, binding.attestation.receiptId);
			const proof = row.proof;
			requireRuntime(
				proof &&
					typeof proof === "object" &&
					!Array.isArray(proof) &&
					Object.keys(proof).sort().join(",") ===
						"binding,intentHash,schemaVersion",
			);
			requireRuntime(
				row.id === binding.attestation.receiptId &&
					row.organizationId === task.organizationId &&
					row.sourceId === sourceTuple.sourceId &&
					row.mediaVersionId === sourceTuple.mediaVersionId &&
					row.analysisRevisionId === sourceTuple.analysisRevisionId &&
					row.kind === "EDITOR_ATTESTATION" &&
					proof.schemaVersion === 1 &&
					hash(proof) === row.proofHash &&
					equal(proof.binding, binding) &&
					proof.intentHash ===
						hash({
							mediaVersionId: sourceTuple.mediaVersionId,
							analysisRevisionId: sourceTuple.analysisRevisionId,
							confirmation: { time: true, geometry: true, content: true },
						}),
			);
			ids.push(row.id);
		}
		return ids;
	}
	async function nativeDependencies(
		tx: AppTransactionClient,
		dependency: NativeDependency,
		prelocked: ReadonlyMap<string, LibraryMediaTask>,
	) {
		const obs = await readProposal(tx, dependency.observation);
		await readProposal(tx, dependency.artifact);
		await readProposal(tx, dependency.cache);
		const origin = admittedFlowNativeEvidence(dependency.native).origin;
		// All origin Task rows were locked before any source/receipt row; no upgrades or late locks.
		const original = prelocked.get(origin.originTaskId);
		checkSignal();
		requireRuntime(
			original &&
				original.id === origin.originTaskId &&
				original.organizationId === task.organizationId,
		);
		const envelope = mediaTaskEnvelopeSchema.parse(original.parameters);
		requireRuntime(
			envelope.input.kind === "GENERATE" &&
				original.kind === "GENERATE" &&
				original.mediaVersionId === sourceTuple.mediaVersionId &&
				original.analysisRevisionId === sourceTuple.analysisRevisionId &&
				original.requestKey === envelope.input.requestKey &&
				original.requestHash ===
					mediaTaskIntentHash(envelope.input, original.parentTaskId) &&
				original.cacheKey ===
					mediaTaskCacheKey(envelope.input, envelope.identity),
		);
		async function originalRecord(k: LocalStoryFlowRecordKey) {
			const id = localStoryFlowRecordIdentity({
					sourceTuple,
					kind: KIND,
					key: k,
				}),
				row = await receipt(tx, id.receiptId);
			return readLocalStoryFlowSealedRecord({
				sourceTuple,
				kind: KIND,
				key: k,
				ref: { kind: KIND, ...id, proofHash: row.proofHash },
				row,
			});
		}
		const start = await originalRecord({
			version: "local-story-flow-record-key-v1",
			purpose: "START",
			keyBody: { taskId: original.id },
		});
		const originalPin =
			localStoryFlowSealedRecordEvidence(start).payload.taskPin;
		requireRuntime(
			originalPin &&
				typeof originalPin === "object" &&
				!Array.isArray(originalPin) &&
				"policies" in originalPin,
		);
		const originalPolicies = localStoryFlowTaskPolicyPartsSchema.parse(
			originalPin.policies,
		);
		// The original DB envelope fingerprint independently binds all eight policy hashes.
		// No current Gateway/config comparison, nor rewriting the original START/receipt.
		const originIdentity = prepareLocalStoryFlowRuntimeIdentity({
			taskId: original.id,
			organizationId: original.organizationId,
			taskParameters: original.parameters,
			startedAtMs: original.startedAt?.getTime(),
			sourceTuple,
			policies: originalPolicies,
		});
		const attempt = await originalRecord(
				localStoryFlowRuntimeKey(originIdentity, {
					purpose: "ATTEMPT",
					slot: origin.slot,
				}),
			),
			outcome = await originalRecord(
				localStoryFlowRuntimeKey(originIdentity, {
					purpose: "OUTCOME",
					slot: origin.slot,
				}),
			);
		const admitted = admitLocalStoryFlowAcceptedOrigin({
			identity: originIdentity,
			expectation: dependency.expectation,
			start,
			attempt,
			outcome,
			observation: obs,
		});
		const e = localStoryFlowAcceptedOriginEvidence(admitted),
			o = localStoryFlowSealedRecordEvidence(outcome);
		requireRuntime(
			equal(o.payload.acceptedArtifactRef, dependency.artifact.proposal.ref) &&
				o.payload.acceptedArtifactHash === dependency.artifactHash &&
				equal(e.origin, origin),
		);
		const startId = localStoryFlowSealedRecordEvidence(start).ref.receiptId;
		const originalPins = await tx.libraryFlowEvidencePin.findMany({
			where: {
				organizationId: task.organizationId,
				taskId: original.id,
				receiptId: { in: [startId] },
			},
		});
		checkSignal();
		requireRuntime(
			originalPins.length === 1 &&
				originalPins[0]?.organizationId === task.organizationId &&
				originalPins[0]?.taskId === original.id &&
				originalPins[0]?.receiptId === startId,
		);
		return [
			dependency.artifact.proposal.ref.receiptId,
			dependency.observation.proposal.ref.receiptId,
			dependency.cache.proposal.ref.receiptId,
			startId,
			localStoryFlowSealedRecordEvidence(attempt).ref.receiptId,
			o.ref.receiptId,
		];
	}
	function routePrefix(
		state: Scan,
		plan: Extract<PublicationPlan, { category: "ROUTE" }>,
		view: RouteView,
		ordinal: number,
		previousPrefixRef: Ref | null,
	) {
		const body = {
			version: "local-story-flow-runtime-prefix-v1",
			purpose: "ROUTE_PREFIX",
			taskId: task.id,
			startRef: state.start.ref,
			sourceArchiveRef: plan.sourceArchive.ref,
			treeRef: plan.tree.ref,
			ordinal,
			previousPrefixRef,
			stepRef: view.step.ref,
			stepHash: view.step.payload.stepHash,
			expectationHash:
				view.step.payload.stepEvidence.expectation.expectationHash,
			observationRef: view.observation.ref,
			nativeRootProof: plan.nativeRootProof,
			progressHash: view.progressHash,
		};
		return { ...body, prefixHash: hash(body) };
	}
	function requireRouteHistory(
		state: Scan,
		plan: Extract<PublicationPlan, { category: "ROUTE" }>,
		deps: PublicationDependencies,
	) {
		const route = deps.route;
		requireRuntime(route);
		const layout = routeLayouts.get(plan.archive);
		requireRuntime(layout);
		requireRuntime(
			deps.declared.length === layout.nodes.length &&
				state.bindings.length === layout.nodes.length,
		);
		const nodeRefs = deps.declared.map((n, index) => {
			const binding = state.bindings[index],
				id = layout.nodes[index]?.nodeId;
			requireRuntime(
				binding &&
					id &&
					n.node.payload.nodeId === id &&
					equal(binding.key, key("CONTEXT_BINDING", id)) &&
					equal(binding.payload, {
						version: "local-story-flow-runtime-context-binding-v1",
						purpose: "CONTEXT_BINDING",
						startRef: state.start.ref,
						nodeRef: n.node.ref,
						nodeHash: n.node.payload.nodeHash,
						observationRef: n.observation.ref,
					}),
			);
			return n.node.ref;
		});
		requireRuntime(
			equal(plan.tree.payload.orderedNodeRefs, nodeRefs) &&
				equal(plan.tree.key.keyBody.orderedNodeRefs, nodeRefs) &&
				equal(plan.tree.payload.sourceArchiveRef, plan.sourceArchive.ref) &&
				equal(plan.tree.key.keyBody.sourceArchiveRef, plan.sourceArchive.ref),
		);
		requireRuntime(
			plan.nativeRootProof ===
				localStoryFlowNativeRootEvidence(plan.nativeRoot).nativeRootProof &&
				state.prefixes.length === deps.previous.length &&
				state.prefixes.length < 64,
		);
		const native = localStoryFlowNativeExpectationEvidence(plan.expectation);
		requireRuntime(
			native.nativeKey.stage === "LOCAL_FLOW_ROUTE_V1" &&
				(native.nativeKey.phase === "ROOT") === (deps.previous.length === 0) &&
				(plan.previous === null) === (deps.previous.length === 0),
		);
		for (const [index, prior] of deps.previous.entries()) {
			const prefix = state.prefixes[index];
			requireRuntime(
				prefix &&
					prior.view.previous ===
						(index === 0 ? null : deps.previous[index - 1]?.handle) &&
					equal(prefix.key, key("ROUTE_PREFIX", index + 1)) &&
					equal(
						prefix.payload,
						routePrefix(
							state,
							plan,
							prior.view,
							index + 1,
							index === 0 ? null : (state.prefixes[index - 1]?.ref ?? null),
						),
					),
			);
		}
		const last = deps.previous.at(-1);
		requireRuntime((last?.handle ?? null) === plan.previous);
		requireRuntime(
			!last || plan.progressHash !== last.view.progressHash,
			"LOCAL_STORY_FLOW_NO_PROGRESS",
		);
		return {
			ordinal: deps.previous.length + 1,
			payload: routePrefix(
				state,
				plan,
				route,
				deps.previous.length + 1,
				state.prefixes.at(-1)?.ref ?? null,
			),
		};
	}
	async function transaction<T>(
		work: (tx: AppTransactionClient) => Promise<T>,
	) {
		try {
			return await options.prisma.$transaction(work, {
				maxWait: 5_000,
				timeout: 15_000,
				statementTimeoutMs: 5_000,
			});
		} catch (error) {
			if (error instanceof MediaOperationError) throw error;
			if (error instanceof LibraryMediaTaskEvidenceError)
				throw new MediaOperationError(error.code);
			throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		}
	}
	return {
		signal,
		dispose() {
			disposed = true;
			clearTimeout(timer);
			deadlineController.abort();
		},
		async start() {
			const result = await transaction(async (tx) => {
				const locked = await lockTask(tx);
				const existing = await tx.libraryEvidenceReceipt.findUnique({
					where: { id: identity(key("START")).receiptId },
				});
				if (existing) rethrowStoredFailure(await scan(tx));
				await positiveFence(tx, locked);
				const start = await put(tx, key("START"), startPayload());
				await pin(tx, [start.ref]);
				return {
					...structuredClone(start),
					remainingMs: deadlineAtMs - locked.nowMs,
				};
			});
			checkSignal();
			clearTimeout(timer);
			timer = setTimeout(
				() => deadlineController.abort(),
				Math.max(0, monotonicDeadline - performance.now()),
			);
			timer.unref();
			started = true;
			return {
				...result,
				remainingMs: Math.max(0, monotonicDeadline - performance.now()),
			};
		},
		async reserve(
			expectation: BoundLocalStoryFlowNativeExpectation,
			expectedTailPrefixRef: Ref | null,
		): Promise<
			| { status: "CACHED"; record: BoundLocalStoryFlowSealedRecord }
			| { status: "RESERVED"; reservation: ReservedLocalStoryFlowNative }
		> {
			requireRuntime(started);
			const e = localStoryFlowNativeExpectationEvidence(expectation);
			const cacheKey: LocalStoryFlowRecordKey = {
				version: "local-story-flow-record-key-v1",
				purpose: "NATIVE_CACHE",
				keyBody: { nativeKeyHash: e.nativeKeyHash },
			};
			const cacheIdentity = localStoryFlowRecordIdentity({
				sourceTuple,
				kind: e.nativeKey.stage,
				key: cacheKey,
			});
			return transaction(async (tx) => {
				const { nowMs, state: s } = await liveHistory(tx);
				requireNativeTaskPin(e.nativeKey as unknown as Payload);
				requireRuntime(
					!s.attempts.some((a) => !s.outcomes.has(Number(a.payload.slot))),
					"LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
				);
				const cached = await tx.libraryEvidenceReceipt.findUnique({
					where: { id: cacheIdentity.receiptId },
				});
				checkSignal();
				if (cached) {
					const ref: Ref = {
						kind: e.nativeKey.stage,
						...cacheIdentity,
						proofHash: cached.proofHash,
					};
					return {
						status: "CACHED" as const,
						record: readLocalStoryFlowSealedRecord({
							sourceTuple,
							kind: e.nativeKey.stage,
							key: cacheKey,
							ref,
							row: sealProjection(cached),
						}),
					};
				}
				requireRuntime(
					s.start.payload.nativeConnectionHash === options.connectionHash,
					"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
				);
				const tail = s.prefixes.at(-1)?.ref ?? null;
				requireRuntime(equal(tail, expectedTailPrefixRef));
				const context = e.nativeKey.stage === "LOCAL_FLOW_CONTEXT_V1";
				requireRuntime(
					context
						? s.prefixes.length === 0 &&
								!s.attempts.some((a) => a.payload.category === "ROUTE")
						: e.nativeKey.phase === "ROOT"
							? tail === null
							: tail !== null,
				);
				const category = context ? "CONTEXT" : "ROUTE",
					count = s.attempts.filter(
						(a) => a.payload.category === category,
					).length;
				requireRuntime(
					s.attempts.length < 127 && count < (context ? 63 : 64),
					"LOCAL_STORY_FLOW_BUDGET_EXHAUSTED",
				);
				const request = nativeRequestForOrigin(expectation, {
					organizationId: task.organizationId,
					originTaskId: task.id,
				});
				const signature = signatureFor(
					e.nativeKey as unknown as Payload,
					request.body,
				);
				requireRuntime(
					!s.attempts.some(
						(a) =>
							signatureFor(
								a.payload.nativeKey as Payload,
								a.payload.requestBody as Payload,
							) === signature,
					),
					"LOCAL_STORY_FLOW_NO_PROGRESS",
				);
				const slot = s.attempts.length + 1,
					body = {
						version: "local-story-flow-runtime-attempt-v1",
						purpose: "ATTEMPT",
						taskId: task.id,
						startRef: s.start.ref,
						slot,
						category,
						nativeKeyHash: e.nativeKeyHash,
						requestKey: request.body.requestKey,
						jobId: request.jobId,
						requestHash: request.requestHash,
						coreInputHash: e.nativeKey.coreInputHash,
						promptHash: e.promptHash,
						expectedTailPrefixRef: tail,
						reservedAtMs: nowMs,
						nativeKey: e.nativeKey,
						requestBody: request.body,
					};
				const attempt = await put(tx, key("ATTEMPT", slot), {
					...body,
					attemptHash: hash(body),
				});
				await pin(tx, [attempt.ref]);
				const reservation = Object.freeze({});
				reservations.set(reservation, {
					owner,
					start: s.start,
					attempt,
					expectation,
					used: false,
				});
				return { status: "RESERVED" as const, reservation };
			});
		},
		async runReserved(
			reservation: ReservedLocalStoryFlowNative,
		): Promise<CapturedLocalStoryFlowNative> {
			const r = reservations.get(reservation);
			requireRuntime(r?.owner === owner && !r.used);
			r.used = true;
			// Reservation commit has returned before this first possible POST.
			await transaction(async (tx) => {
				const { state: s } = await liveHistory(tx);
				requireRuntime(
					equal(s.attempts.at(-1)?.ref, r.attempt.ref) &&
						!s.outcomes.has(Number(r.attempt.payload.slot)),
				);
			});
			checkSignal();
			const request = nativeRequestForOrigin(r.expectation, {
				organizationId: task.organizationId,
				originTaskId: task.id,
			});
			const observed = await options.client.runObserved({
				organizationId: task.organizationId,
				requestKey: request.body.requestKey,
				stage: request.body.stage,
				prompt: request.body.prompt,
				inputHash: request.body.inputHash,
				schemaHash: request.body.schemaHash,
				signal,
			});
			await transaction(async (tx) => {
				const { state: s } = await liveHistory(tx);
				requireRuntime(
					equal(s.attempts.at(-1)?.ref, r.attempt.ref) &&
						!s.outcomes.has(Number(r.attempt.payload.slot)),
				);
			});
			const e = localStoryFlowNativeExpectationEvidence(r.expectation),
				origin = {
					organizationId: task.organizationId,
					originTaskId: task.id,
					startRef: r.start.ref,
					attemptRef: r.attempt.ref,
					slot: Number(r.attempt.payload.slot),
				};
			const body = {
				version: "local-story-flow-native-observation-v1",
				purpose: "NATIVE_OBSERVATION",
				nativeKey: e.nativeKey,
				origin,
				requestBody: request.body,
				requestHash: request.requestHash,
				requestKey: request.body.requestKey,
				jobId: request.jobId,
				terminalJob: observed.terminalJob,
			};
			const native = admitFlowNativeObservation(r.expectation, {
				resolvedOrigin: {
					version: "local-story-flow-native-origin-contract-v1",
					kind: "CURRENT_CAPTURE",
					origin,
					sourceBindingHash: e.nativeKey.sourceBindingHash,
					workflowIdentityHash: hash(e.nativeKey.workflowIdentity),
					nativeKeyHash: e.nativeKeyHash,
					coreInputHash: e.nativeKey.coreInputHash,
					requestHash: request.requestHash,
					capture: {
						taskId: task.id,
						leaseToken: options.leaseToken,
						connectionHash: options.connectionHash,
					},
				},
				observation: { ...body, observationHash: hash(body) },
			});
			const handle = Object.freeze({});
			captures.set(handle, { owner, reservation: r, native });
			return handle;
		},

		async publishAccepted(
			capture: CapturedLocalStoryFlowNative,
			prepared: PreparedLocalStoryFlowPublication,
			sourceFence: OwnedLocalStoryFlowReadFence,
		): Promise<AcceptedLocalStoryFlowPublication> {
			const captured = captures.get(capture);
			requireRuntime(
				captured &&
					captured.owner === owner &&
					!publicationAttempts.has(capture),
			);
			// One-shot even on rollback/ambiguous commit. A second call cannot create/adopt another result.
			publicationAttempts.add(capture);
			let plan: PublicationPlan | undefined;
			let records: PreparedRecord[] | undefined;
			let dependencies: PublicationDependencies | undefined;
			try {
				plan = localStoryFlowPreparedPublicationEvidence(prepared);
				requireRuntime(
					plan.native === captured.native &&
						plan.expectation === captured.reservation.expectation,
				);
				let archive = archiveRecords.get(plan.archive);
				if (!archive) {
					archive = prepareRecord(plan.sourceArchive);
					archiveRecords.set(plan.archive, archive);
				}
				records = [
					archive,
					prepareRecord(plan.observation),
					prepareRecord(plan.artifact),
					prepareRecord(plan.cache),
				];
				if (plan.category === "ROUTE") {
					let tree = treeRecords.get(plan.context);
					if (!tree) {
						tree = prepareRecord(plan.tree);
						treeRecords.set(plan.context, tree);
					}
					records.splice(1, 0, tree);
				}
				dependencies = publicationDependencies(plan);
			} catch {
				/* Defer fixed rejection until the authoritative stored failure/control guards. */
			}
			const saved = await transaction(async (tx) => {
				const prelocked = await lockPublicationTasks(tx, dependencies?.taskIds);
				const { state, nowMs } = await liveHistory(tx);
				requireRuntime(plan && records && dependencies && prelocked.complete);
				const reservation = captured.reservation,
					slot = Number(reservation.attempt.payload.slot),
					attempt = state.attempts[slot - 1];
				requireRuntime(
					equal(state.start, reservation.start) &&
						attempt &&
						equal(attempt, reservation.attempt) &&
						state.attempts.length === slot &&
						!state.outcomes.has(slot) &&
						attempt.payload.category === plan.category,
				);
				const native = localStoryFlowNativeExpectationEvidence(
					plan.expectation,
				);
				requireNativeTaskPin(native.nativeKey);
				requireRuntime(
					native.nativeKey.stage ===
						(plan.category === "CONTEXT"
							? "LOCAL_FLOW_CONTEXT_V1"
							: "LOCAL_FLOW_ROUTE_V1") &&
						equal(native.nativeKey, attempt.payload.nativeKey) &&
						options.connectionHash ===
							state.start.payload.nativeConnectionHash &&
						equal(
							attempt.payload.expectedTailPrefixRef,
							state.prefixes.at(-1)?.ref ?? null,
						),
				);
				try {
					await validateLocalStoryFlowSourceArchiveReadFence(
						tx,
						sourceFence,
						plan.archive,
					);
				} catch (error) {
					if (
						error instanceof MediaOperationError ||
						error instanceof LibraryMediaTaskEvidenceError
					)
						throw error;
					// The actual bridge can reject before its trailing worker check.
					checkSignal();
					throw error;
				}
				checkSignal();
				const dependencyIds = await sourceDependencies(tx, plan);
				const route =
					plan.category === "ROUTE"
						? requireRouteHistory(state, plan, dependencies)
						: null;
				for (const { dependency } of dependencies.contexts)
					dependencyIds.push(
						...(await nativeDependencies(tx, dependency, prelocked.rows)),
					);
				for (const { dependency } of dependencies.previous)
					dependencyIds.push(
						...(await nativeDependencies(tx, dependency, prelocked.rows)),
					);
				if (plan.category === "ROUTE")
					dependencyIds.push(...state.bindings.map((b) => b.ref.receiptId));
				for (const record of records) await putProposal(tx, record);
				const observationRef = plan.observation.ref,
					artifactRef = plan.artifact.ref,
					artifactHash =
						plan.category === "CONTEXT"
							? plan.artifact.payload.nodeHash
							: plan.artifact.payload.stepHash;
				const outcome = await put(tx, key("OUTCOME", slot), {
					version: "local-story-flow-runtime-outcome-v1",
					purpose: "OUTCOME",
					taskId: task.id,
					startRef: state.start.ref,
					attemptRef: attempt.ref,
					slot,
					completedAtMs: nowMs,
					status: "ACCEPTED",
					observationRef,
					acceptedArtifactRef: artifactRef,
					acceptedArtifactHash: artifactHash,
					...(route ? { acceptedOrdinal: route.ordinal } : {}),
				});
				const publication = route
					? await put(tx, key("ROUTE_PREFIX", route.ordinal), route.payload)
					: await put(tx, key("CONTEXT_BINDING", native.nativeKey.nodeId), {
							version: "local-story-flow-runtime-context-binding-v1",
							purpose: "CONTEXT_BINDING",
							startRef: state.start.ref,
							nodeRef: artifactRef,
							nodeHash: artifactHash,
							observationRef,
						});
				await pinVerifiedIds(tx, [
					...dependencyIds,
					...records.map((r) => r.proposal.ref.receiptId),
					state.start.ref.receiptId,
					attempt.ref.receiptId,
					outcome.ref.receiptId,
					publication.ref.receiptId,
				]);
				await scan(tx);
				checkSignal();
				await positiveFence(tx, await lockTask(tx));
				const refs = {
					sourceArchiveRef: plan.sourceArchive.ref,
					observationRef,
					artifactRef,
					cacheRef: plan.cache.ref,
					outcomeRef: outcome.ref,
				};
				return plan.category === "ROUTE"
					? {
							...refs,
							category: "ROUTE" as const,
							acceptedStep: plan.acceptedStep,
							nativeRoot: plan.nativeRoot,
							treeRef: plan.tree.ref,
							prefixRef: publication.ref,
						}
					: {
							...refs,
							category: "CONTEXT" as const,
							acceptedNode: plan.acceptedNode,
							bindingRef: publication.ref,
						};
			});
			const handle = Object.freeze({});
			acceptedPublications.set(handle, saved);
			return handle;
		},
		async recoverUnconfirmed() {
			const state = await transaction(async (tx) => {
				await fence(tx, true);
				return scan(tx);
			});
			rethrowStoredFailure(state);
			const missing = state.attempts.filter(
				(a) => !state.outcomes.has(Number(a.payload.slot)),
			);
			if (!missing.length) return { unconfirmed: false as const };
			requireRuntime(
				missing.length === 1 &&
					state.start.payload.nativeConnectionHash === options.connectionHash,
				"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
			);
			const a = missing[0];
			requireRuntime(a);
			await options.client.cleanupOnly({
				jobId: String(a.payload.jobId),
				stage: (
					a.payload.requestBody as {
						stage: "LOCAL_FLOW_CONTEXT_V1" | "LOCAL_FLOW_ROUTE_V1";
					}
				).stage,
				requestHash: String(a.payload.requestHash),
			});
			// Even a terminal SUCCEEDED GET confirms stop only. It is never adopted as an observation.
			throw new MediaOperationError("LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED");
		},
		async recordFailed(
			reservation: ReservedLocalStoryFlowNative,
			failureCode: string,
			cleanupStatus: "CONFIRMED" | "UNCONFIRMED",
		) {
			const r = reservations.get(reservation);
			requireRuntime(
				r?.owner === owner &&
					failureCodes.has(failureCode) &&
					(cleanupStatus === "CONFIRMED" || cleanupStatus === "UNCONFIRMED"),
			);
			return transaction(async (tx) => {
				const nowMs = await fence(tx, true),
					state = await scan(tx),
					slot = Number(r.attempt.payload.slot);
				rethrowStoredFailure(state);
				requireRuntime(
					equal(state.attempts[slot - 1]?.ref, r.attempt.ref) &&
						!state.outcomes.has(slot),
				);
				const outcome = await put(
					tx,
					key("OUTCOME", slot),
					{
						version: "local-story-flow-runtime-outcome-v1",
						purpose: "OUTCOME",
						taskId: task.id,
						startRef: r.start.ref,
						attemptRef: r.attempt.ref,
						slot,
						completedAtMs: nowMs,
						status: "FAILED",
						failureCode:
							cleanupStatus === "UNCONFIRMED"
								? "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"
								: failureCode,
						cleanupStatus,
						observationRef: null,
					},
					true,
				);
				await pin(tx, [outcome.ref], true);
				return structuredClone(outcome);
			});
		},
	};
}
