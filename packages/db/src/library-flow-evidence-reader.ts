import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hashEditingEvidence as hash } from "@bitovp/core";
import {
	type BoundLocalStoryFlowSealedRecord,
	type BoundLocalStoryFlowSourceArchive,
	LOCAL_STORY_FLOW_SEAL_POLICY,
	type LocalStoryArtifactCacheRow,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordKind,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
	localStoryFlowSourceArchiveEvidence,
	prepareLocalStoryFlowArchiveSource,
	readLocalStoryFlowSealedRecord,
	resolveLocalStoryFlowPolicyCatalogForTaskIdentity,
} from "@bitovp/core/local-story-flow-server";
import type { LibraryMediaTask } from "../generated/client";
import type { AppTransactionClient } from "./client";
import { resolveLibraryFlowSourceArchive } from "./library-flow-source-archive";
import {
	getLibraryMediaTaskEvidenceReadOnly,
	type LibraryMediaTaskEvidence,
} from "./library-media-task-evidence";
import { getTenantPrisma, TENANT_ORGANIZATION } from "./tenant-client";

export class LocalStoryFlowReadError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowReadError";
	}
}
export const LOCAL_STORY_FLOW_DB_READ_POLICY = Object.freeze({
	version: "local-story-flow-db-read-v1",
	isolationLevel: "RepeatableRead",
	timeoutMs: 15_000,
	statementTimeoutMs: 5_000,
	runtimeKeys: 385,
	originNativeCount: 127,
} as const);
function requireRead(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowReadError();
}
function record(value: unknown, fields: readonly string[]) {
	try {
		requireRead(value && typeof value === "object");
		requireRead(Object.getPrototypeOf(value) === Object.prototype);
		requireRead(Object.getOwnPropertySymbols(value).length === 0);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		requireRead(Object.keys(descriptors).length === fields.length);
		return Object.fromEntries(
			fields.map((name) => {
				const d = descriptors[name];
				requireRead(d?.enumerable && "value" in d && d.value !== undefined);
				return [name, d.value];
			}),
		);
	} catch {
		throw new LocalStoryFlowReadError();
	}
}
/** Snapshot only JSON hints. Factory-owned handles are deliberately never copied. */
function jsonData(input: unknown): unknown {
	let nodes = 0;
	const active = new WeakSet<object>();
	const copy = (value: unknown, depth: number): unknown => {
		requireRead(
			++nodes <= LOCAL_STORY_FLOW_SEAL_POLICY.maxNodes &&
				depth <= LOCAL_STORY_FLOW_SEAL_POLICY.maxDepth,
		);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			requireRead(Number.isFinite(value));
			return value;
		}
		if (typeof value === "string") {
			requireRead(
				Buffer.byteLength(value, "utf8") <=
					LOCAL_STORY_FLOW_SEAL_POLICY.maxKeyBytes,
			);
			return value;
		}
		requireRead(
			typeof value === "object" && value !== null && !active.has(value),
		);
		const array = Array.isArray(value);
		requireRead(
			Object.getPrototypeOf(value) ===
				(array ? Array.prototype : Object.prototype) &&
				Object.getOwnPropertySymbols(value).length === 0,
		);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		active.add(value);
		try {
			if (array) {
				const length = descriptors.length;
				requireRead(
					length &&
						"value" in length &&
						!length.enumerable &&
						Number.isSafeInteger(length.value) &&
						length.value >= 0 &&
						length.value <= LOCAL_STORY_FLOW_SEAL_POLICY.maxNodes &&
						Object.keys(descriptors).length === length.value + 1,
				);
				return Array.from({ length: length.value }, (_, i) => {
					const d = descriptors[String(i)];
					requireRead(d?.enumerable && "value" in d && d.value !== undefined);
					return copy(d.value, depth + 1);
				});
			}
			return Object.fromEntries(
				Object.entries(descriptors).map(([key, d]) => {
					requireRead(d.enumerable && "value" in d && d.value !== undefined);
					return [key, copy(d.value, depth + 1)];
				}),
			);
		} finally {
			active.delete(value);
		}
	};
	try {
		return copy(input, 0);
	} catch {
		throw new LocalStoryFlowReadError();
	}
}
const uuid = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
		value,
	);
export function localStoryFlowTaskLockKey(taskId: string): bigint {
	requireRead(uuid(taskId));
	return BigInt.asIntN(
		64,
		BigInt(
			`0x${createHash("sha256").update(`flow-runtime-v1:${taskId}`).digest("hex").slice(0, 16)}`,
		),
	);
}
function requireOrganization(tx: AppTransactionClient, organizationId: string) {
	requireRead(
		(tx as unknown as Record<symbol, unknown>)[TENANT_ORGANIZATION] ===
			organizationId,
	);
}
type Row = Record<string, unknown>;
type Table =
	| "libraryMediaTask"
	| "librarySource"
	| "libraryMediaVersion"
	| "sceneAnalysisRevision"
	| "libraryAnalysisBinding"
	| "editProject"
	| "editRevision"
	| "libraryEvidenceReceipt"
	| "libraryFlowEvidencePin";
type RowRead = {
	table: Table;
	where: Row;
	select?: Record<string, true>;
	take: number;
	expected: Row[];
	workerMaterialPins?: {
		kind: "VALIDATED_WORKER_SOURCE_MATERIAL";
		organizationId: string;
		taskId: string;
		eligible: Array<{
			organizationId: string;
			taskId: string;
			receiptId: string;
		}>;
	};
};
type ReadState = {
	tx: AppTransactionClient;
	organizationId: string;
	taskId: string;
	active: boolean;
	reads: Map<string, RowRead>;
	sourceCreated: boolean;
	origins: Set<string>;
	worker?: WorkerSourceAuthority;
	archive?: Promise<BoundLocalStoryFlowSourceArchive>;
	resolvedArchive?: BoundLocalStoryFlowSourceArchive;
};
type WorkerSourceAuthority = {
	leaseToken: string;
	signal: AbortSignal;
	monotonicDeadline: number;
};
function checkWorker(state: ReadState) {
	if (!state.worker) return;
	state.worker.signal.throwIfAborted();
	requireRead(performance.now() < state.worker.monotonicDeadline);
}
async function authorizeWorker(state: ReadState, task: LibraryMediaTask) {
	const worker = state.worker;
	requireRead(worker);
	checkWorker(state);
	const requestedAt = performance.now();
	const clock = await state.tx.$queryRaw<
		Array<{ nowMs: bigint }>
	>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`;
	const nowMs = Number(clock[0]?.nowMs),
		started = task.startedAt?.getTime();
	requireRead(
		clock.length === 1 &&
			Number.isSafeInteger(nowMs) &&
			Number.isSafeInteger(started),
	);
	const deadline = (started as number) + 90 * 60_000;
	requireRead(Number.isSafeInteger(deadline));
	worker.monotonicDeadline = Math.min(
		worker.monotonicDeadline,
		requestedAt + deadline - nowMs,
	);
	requireRead(
		task.state === "RUNNING" &&
			task.leaseToken === worker.leaseToken &&
			task.leaseUntil &&
			task.leaseUntil.getTime() > nowMs &&
			!task.cancelRequestedAt,
	);
	checkWorker(state);
}
export type BoundLocalStoryFlowReadSource = Readonly<object>;
export type LocalStoryFlowReadSourceEvidence = {
	task: LibraryMediaTask;
	verified: LibraryMediaTaskEvidence;
	sourceTuple: LocalStoryFlowSourceTuple;
	sourceRow: Row;
	analysisRow: Row;
	bindingRow: Row;
	ownerLinks: Array<{ presetId: string; project: Row; revision: Row }>;
};
const sources = new WeakMap<
	BoundLocalStoryFlowReadSource,
	{
		state: ReadState;
		evidence: LocalStoryFlowReadSourceEvidence;
	}
>();
const taskProofFields = [
	"id",
	"organizationId",
	"mediaVersionId",
	"analysisRevisionId",
	"parentTaskId",
	"kind",
	"requestKey",
	"requestHash",
	"cacheKey",
	"parameters",
	"state",
	"result",
	"startedAt",
	"createdBy",
];
const fenceRows = (
	table: Table,
	values: Row[],
	select?: Record<string, true>,
) =>
	structuredClone(
		table === "libraryMediaTask" && !select
			? values.map((r) =>
					Object.fromEntries(taskProofFields.map((k) => [k, r[k]])),
				)
			: values,
	);
async function rows(
	state: ReadState,
	table: Table,
	where: Row,
	select?: Record<string, true>,
	take = 2,
) {
	requireRead(state.active);
	checkWorker(state);
	const delegate = state.tx[table] as unknown as {
		findMany(args: unknown): Promise<Row[]>;
	};
	const result = await delegate.findMany({
		where: { ...where, organizationId: state.organizationId },
		take,
		...(select ? { select } : {}),
		orderBy:
			table === "libraryFlowEvidencePin"
				? [{ taskId: "asc" }, { receiptId: "asc" }]
				: { id: "asc" },
	});
	requireRead(state.active);
	checkWorker(state);
	requireRead(result.every((r) => r.organizationId === state.organizationId));
	result.sort((a, b) =>
		String(a.id ?? `${a.taskId}:${a.receiptId}`).localeCompare(
			String(b.id ?? `${b.taskId}:${b.receiptId}`),
		),
	);
	const readKey = hash({ table, where, select: select ?? null, take });
	const expected = fenceRows(table, result, select);
	const prior = state.reads.get(readKey);
	requireRead(!prior || isDeepStrictEqual(prior.expected, expected));
	state.reads.set(readKey, {
		table,
		where: structuredClone(where),
		...(select ? { select } : {}),
		take,
		expected,
	});
	return result;
}
async function one(
	state: ReadState,
	table: Table,
	where: Row,
	select?: Record<string, true>,
) {
	const result = await rows(state, table, where, select);
	requireRead(result.length === 1 && result[0]);
	return result[0];
}
export function localStoryFlowReadSourceEvidence(
	source: BoundLocalStoryFlowReadSource,
): LocalStoryFlowReadSourceEvidence {
	const found = sources.get(source);
	requireRead(found);
	return structuredClone(found.evidence);
}
const projectSelect = {
	id: true,
	organizationId: true,
	contentId: true,
	mediaVersionId: true,
	variant: true,
	createdBy: true,
} as const;
const presetVariants: Record<string, string> = {
	"portrait-clean": "PORTRAIT",
	"landscape-clean": "LANDSCAPE",
	"square-clean": "SQUARE",
};
async function sourceFor(
	state: ReadState,
): Promise<BoundLocalStoryFlowReadSource> {
	const task = (await one(state, "libraryMediaTask", {
		id: state.taskId,
	})) as unknown as LibraryMediaTask;
	requireRead(task.kind === "GENERATE");
	if (state.worker) await authorizeWorker(state, task);
	else requireRead(task.state === "SUCCEEDED");
	const verified = await getLibraryMediaTaskEvidenceReadOnly(state.tx, task);
	requireRead(state.active);
	const { envelope, media, binding } = verified;
	requireRead(
		envelope.input.kind === "GENERATE" && binding && task.analysisRevisionId,
	);
	const parameters = envelope.input.parameters;
	requireRead(
		parameters.policy === "LOCAL_STORY" &&
			parameters.storyMode === "FLOW" &&
			parameters.renderMode === "DRAFT" &&
			parameters.storyWorkflowVersion === "hierarchical-flow-v1",
	);
	const sourceRow = await one(state, "librarySource", { id: media.sourceId });
	await one(state, "libraryMediaVersion", { id: media.id });
	const analysisRow = await one(state, "sceneAnalysisRevision", {
		id: task.analysisRevisionId,
	});
	const bindingRow = await one(state, "libraryAnalysisBinding", {
		mediaVersionId: media.id,
		analysisRevisionId: task.analysisRevisionId,
	});
	if (bindingRow.attestationReceiptId !== null) {
		requireRead(uuid(bindingRow.attestationReceiptId));
		await sourceProof(
			state,
			bindingRow.attestationReceiptId,
			media.id,
			media.sourceId,
			binding,
		);
	}
	if (verified.preparedNormalization) {
		const receipt = await one(
			state,
			"libraryEvidenceReceipt",
			{
				mediaVersionId: media.id,
				kind: "NORMALIZATION_CAPTURE",
				proofHash: verified.preparedNormalization.proofHash,
			},
			receiptSelect,
		);
		requireRead(
			uuid(receipt.id) &&
				receipt.sourceId === media.sourceId &&
				receipt.analysisRevisionId === null,
		);
		await sourceMaterialPins(state, [receipt.id as string]);
	}
	const result = task.result as unknown as {
		projectIds: unknown[];
		presetIds: unknown[];
		projectId: unknown;
		renderMode: unknown;
	};
	if (!state.worker)
		requireRead(
			result &&
				Array.isArray(result.projectIds) &&
				result.projectIds.length >= 1 &&
				result.projectIds.length <= 3 &&
				result.projectIds.every(uuid) &&
				new Set(result.projectIds).size === result.projectIds.length &&
				result.projectId === result.projectIds[0] &&
				Array.isArray(result.presetIds) &&
				result.presetIds.length === result.projectIds.length &&
				result.renderMode === "DRAFT",
		);
	const ownerLinks: LocalStoryFlowReadSourceEvidence["ownerLinks"] = [];
	for (const [index, projectId] of (state.worker
		? []
		: result.projectIds
	).entries()) {
		const presetId = result.presetIds[index];
		requireRead(
			typeof presetId === "string" && Object.hasOwn(presetVariants, presetId),
		);
		const project = await one(
			state,
			"editProject",
			{ id: projectId },
			projectSelect,
		);
		const revision = await one(state, "editRevision", {
			projectId,
			revision: 1,
		});
		requireRead(
			project.contentId === parameters.contentId &&
				project.mediaVersionId === media.id &&
				project.variant === presetVariants[presetId] &&
				project.createdBy === task.createdBy &&
				revision.createdBy === task.createdBy,
		);
		const document = revision.document as Row | null;
		requireRead(
			document &&
				document.mediaVersionId === media.id &&
				document.timeMapId === verified.map.id &&
				document.analysisRevisionId === task.analysisRevisionId,
		);
		const automatic = document.autoGeneration as Row | null;
		requireRead(
			automatic &&
				automatic.renderMode === "DRAFT" &&
				hash(automatic.binding) === hash(binding),
		);
		ownerLinks.push({ presetId, project, revision });
	}
	const sourceTuple: LocalStoryFlowSourceTuple = {
		version: "local-story-flow-source-tuple-v1",
		organizationId: state.organizationId,
		sourceId: media.sourceId,
		mediaVersionId: media.id,
		mediaSha256: media.sha256 as string,
		timeMapHash: hash(media.timeMap),
		analysisRevisionId: task.analysisRevisionId,
		analysisRawHash: envelope.identity.analysisRawHash as string,
		analysisDocumentHash: envelope.identity.analysisDocumentHash as string,
		bindingHash: hash(binding),
		preparedShotClockHash: envelope.identity.preparedShotClock
			? hash(envelope.identity.preparedShotClock)
			: null,
		normalizationReceiptHash: verified.preparedNormalization?.proofHash ?? null,
	};
	const handle = Object.freeze({});
	localStoryFlowRecordIdentity({
		sourceTuple,
		kind: "LOCAL_FLOW_PLAN_V1",
		key: {
			version: "local-story-flow-record-key-v1",
			purpose: "START",
			keyBody: { taskId: state.taskId },
		},
	});
	sources.set(handle, {
		state,
		evidence: structuredClone({
			task,
			verified,
			sourceTuple,
			ownerLinks,
			sourceRow,
			analysisRow,
			bindingRow,
		}),
	});
	state.sourceCreated = true;
	return handle;
}
const receiptSelect = {
	id: true,
	organizationId: true,
	sourceId: true,
	mediaVersionId: true,
	analysisRevisionId: true,
	kind: true,
	proof: true,
	proofHash: true,
} as const;
const pinSelect = {
	organizationId: true,
	taskId: true,
	receiptId: true,
} as const;
async function pin(state: ReadState, receiptId: string) {
	await one(
		state,
		"libraryFlowEvidencePin",
		{ taskId: state.taskId, receiptId },
		pinSelect,
	);
}
async function sourceMaterialPins(state: ReadState, receiptIds: string[]) {
	const ids = [...new Set(receiptIds)].sort();
	requireRead(ids.length <= 257 && ids.every(uuid));
	if (!ids.length) return;
	const found = await rows(
		state,
		"libraryFlowEvidencePin",
		{ taskId: state.taskId, receiptId: { in: ids } },
		pinSelect,
		ids.length + 1,
	);
	requireRead(
		found.length <= ids.length &&
			new Set(found.map((p) => p.receiptId)).size === found.length &&
			found.every(
				(p) => p.taskId === state.taskId && ids.includes(p.receiptId as string),
			),
	);
	if (!state.worker) requireRead(found.length === ids.length);
	else {
		// Callers have completed the source/full-seal validator before reaching here.
		const materials = [...state.reads.values()].flatMap((r) =>
			r.table === "libraryEvidenceReceipt" ? r.expected : [],
		);
		const kinds = new Set([
			"LOCAL_STORY_TRANSCRIPT_V1",
			"LOCAL_STORY_LEDGER_V1",
			"NORMALIZATION_CAPTURE",
			"EDITOR_ATTESTATION",
		]);
		requireRead(
			ids.every((id) =>
				materials.some(
					(r) =>
						r.id === id &&
						r.organizationId === state.organizationId &&
						kinds.has(r.kind as string),
				),
			),
		);
		const key = hash({
			table: "libraryFlowEvidencePin",
			where: { taskId: state.taskId, receiptId: { in: ids } },
			select: pinSelect,
			take: ids.length + 1,
		});
		const read = state.reads.get(key);
		requireRead(read);
		read.workerMaterialPins = {
			kind: "VALIDATED_WORKER_SOURCE_MATERIAL",
			organizationId: state.organizationId,
			taskId: state.taskId,
			eligible: ids.map((receiptId) => ({
				organizationId: state.organizationId,
				taskId: state.taskId,
				receiptId,
			})),
		};
	}
}

function workerMaterialPins(state: ReadState, read: RowRead, current: Row[]) {
	const rule = read.workerMaterialPins;
	requireRead(
		state.worker &&
			rule &&
			rule.kind === "VALIDATED_WORKER_SOURCE_MATERIAL" &&
			rule.organizationId === state.organizationId &&
			rule.taskId === state.taskId &&
			read.table === "libraryFlowEvidencePin" &&
			isDeepStrictEqual(read.select, pinSelect),
	);
	const allowed = new Set(rule.eligible.map((p) => p.receiptId));
	requireRead(
		allowed.size === rule.eligible.length &&
			allowed.size > 0 &&
			allowed.size <= 257 &&
			rule.eligible.every(
				(p) =>
					p.organizationId === state.organizationId &&
					p.taskId === state.taskId &&
					uuid(p.receiptId),
			) &&
			isDeepStrictEqual(read.where, {
				taskId: state.taskId,
				receiptId: { in: [...allowed] },
			}) &&
			read.take === allowed.size + 1,
	);
	const byId = new Map<string, Row>();
	for (const row of current) {
		const p = record(row, ["organizationId", "taskId", "receiptId"]);
		requireRead(
			p.organizationId === state.organizationId &&
				p.taskId === state.taskId &&
				typeof p.receiptId === "string" &&
				allowed.has(p.receiptId) &&
				!byId.has(p.receiptId),
		);
		byId.set(p.receiptId, p);
	}
	requireRead(
		read.expected.every((p) =>
			isDeepStrictEqual(p, byId.get(p.receiptId as string)),
		),
	);
}
async function sourceProof(
	state: ReadState,
	receiptId: string,
	mediaId: string,
	sourceId: string,
	binding: LibraryMediaTaskEvidence["binding"],
) {
	const row = await one(
		state,
		"libraryEvidenceReceipt",
		{ id: receiptId },
		receiptSelect,
	);
	requireRead(row.mediaVersionId === mediaId && row.sourceId === sourceId);
	if (state.worker) {
		const proof = record(jsonData(row.proof), [
			"schemaVersion",
			"intentHash",
			"binding",
		]);
		requireRead(
			binding?.kind === "EDITOR_ATTESTED" &&
				binding.attestation?.receiptId === receiptId &&
				row.id === receiptId &&
				row.kind === "EDITOR_ATTESTATION" &&
				row.analysisRevisionId === binding.analysisRevisionId &&
				proof.schemaVersion === 1 &&
				hash(proof) === row.proofHash &&
				isDeepStrictEqual(proof.binding, binding) &&
				proof.intentHash ===
					hash({
						mediaVersionId: mediaId,
						analysisRevisionId: binding.analysisRevisionId,
						confirmation: { time: true, geometry: true, content: true },
					}),
		);
	}
	await sourceMaterialPins(state, [receiptId]);
}
type SealedInput = {
	source: BoundLocalStoryFlowReadSource;
	kind: LocalStoryFlowRecordKind;
	key: unknown;
	ref: unknown;
};
function sourceState(state: ReadState, source: unknown) {
	requireRead(state.active && source && typeof source === "object");
	const owned = sources.get(source);
	requireRead(owned && owned.state === state);
	return owned;
}
async function getSealed(
	state: ReadState,
	args: SealedInput,
): Promise<BoundLocalStoryFlowSealedRecord> {
	const input = record(args, ["source", "kind", "key", "ref"]);
	const owned = sourceState(state, input.source);
	const expected = {
		sourceTuple: owned.evidence.sourceTuple,
		kind: input.kind,
		key: jsonData(input.key),
	};
	const ref = copyRef(input.ref);
	const identity = localStoryFlowRecordIdentity(expected);
	const row = await one(
		state,
		"libraryEvidenceReceipt",
		{ id: identity.receiptId },
		receiptSelect,
	);
	const sealed = readLocalStoryFlowSealedRecord({ ...expected, ref, row });
	const evidence = localStoryFlowSealedRecordEvidence(sealed);
	if (
		[
			"START",
			"ATTEMPT",
			"OUTCOME",
			"CONTEXT_BINDING",
			"ROUTE_PREFIX",
			"PLAN",
			"SOURCE_ARCHIVE",
		].includes(evidence.key.purpose)
	)
		requireRead(evidence.key.keyBody.taskId === state.taskId);
	await pin(state, identity.receiptId);
	return sealed;
}
type KeyRef = { key: unknown; ref: unknown };
type RuntimeInput = {
	source: BoundLocalStoryFlowReadSource;
	sourceArchive: KeyRef;
	tree: KeyRef;
	plan: KeyRef;
};
export type LocalStoryFlowRuntimeReadSnapshot = {
	runtime: Array<{
		key: LocalStoryFlowRecordKey;
		record: BoundLocalStoryFlowSealedRecord | null;
	}>;
	sourceArchive: BoundLocalStoryFlowSealedRecord;
	tree: BoundLocalStoryFlowSealedRecord;
	plan: BoundLocalStoryFlowSealedRecord;
	pins: Array<{ organizationId: string; taskId: string; receiptId: string }>;
};
function runtimeKeys(taskId: string): LocalStoryFlowRecordKey[] {
	const keys: LocalStoryFlowRecordKey[] = [];
	const add = (purpose: LocalStoryFlowRecordKey["purpose"], extra: Row) =>
		keys.push({
			version: "local-story-flow-record-key-v1",
			purpose,
			keyBody: { taskId, ...extra },
		});
	add("START", {});
	for (let slot = 1; slot <= 127; slot++) {
		add("ATTEMPT", { slot });
		add("OUTCOME", { slot });
	}
	for (let ordinal = 1; ordinal <= 64; ordinal++)
		add("ROUTE_PREFIX", { ordinal });
	for (let node = 0; node < 63; node++)
		add("CONTEXT_BINDING", { nodeId: `n${node}` });
	return keys;
}
async function scanRuntime(
	state: ReadState,
	args: RuntimeInput,
): Promise<LocalStoryFlowRuntimeReadSnapshot> {
	const input = record(args, ["source", "sourceArchive", "tree", "plan"]);
	const pairs = Object.fromEntries(
		["sourceArchive", "tree", "plan"].map((field) => {
			const pair = record(input[field], ["key", "ref"]);
			return [field, { key: jsonData(pair.key), ref: copyRef(pair.ref) }];
		}),
	);
	const owned = sourceState(state, input.source),
		sourceTuple = owned.evidence.sourceTuple;
	const keys = runtimeKeys(state.taskId),
		kind = "LOCAL_FLOW_PLAN_V1" as const;
	const identities = keys.map((key) =>
		localStoryFlowRecordIdentity({ sourceTuple, kind, key }),
	);
	const ids = identities.map((x) => x.receiptId);
	const found = await rows(
		state,
		"libraryEvidenceReceipt",
		{ id: { in: ids } },
		receiptSelect,
		383,
	);
	requireRead(
		found.length <= 382 && found.every((r) => ids.includes(String(r.id))),
	);
	const byId = new Map(found.map((r) => [r.id, r]));
	requireRead(byId.size === found.length);
	const runtime = keys.map((key, index) => {
		const identity = identities[index];
		requireRead(identity);
		const row = byId.get(identity.receiptId);
		return {
			key,
			record: row
				? readLocalStoryFlowSealedRecord({
						sourceTuple,
						kind,
						key,
						row,
						ref: { kind, ...identity, proofHash: row.proofHash },
					})
				: null,
		};
	});
	requireRead(runtime[0]?.record);
	const receiptIds = found.map((r) => r.id);
	const pins = await rows(
		state,
		"libraryFlowEvidencePin",
		{ taskId: state.taskId, receiptId: { in: receiptIds } },
		pinSelect,
		383,
	);
	requireRead(
		pins.length === found.length &&
			new Set(pins.map((p) => p.receiptId)).size === found.length &&
			pins.every(
				(p) => p.taskId === state.taskId && receiptIds.includes(p.receiptId),
			),
	);
	const final: BoundLocalStoryFlowSealedRecord[] = [];
	for (const [field, finalKind, purpose] of [
		["sourceArchive", "LOCAL_FLOW_MANIFEST_V1", "SOURCE_ARCHIVE"],
		["tree", "LOCAL_FLOW_CONTEXT_V1", "TREE"],
		["plan", "LOCAL_FLOW_PLAN_V1", "PLAN"],
	] as const) {
		const pair = pairs[field];
		requireRead(pair);
		const sealed = await getSealed(state, {
			source: input.source as BoundLocalStoryFlowReadSource,
			kind: finalKind,
			key: pair.key,
			ref: pair.ref,
		});
		requireRead(
			localStoryFlowSealedRecordEvidence(sealed).key.purpose === purpose,
		);
		final.push(sealed);
	}
	const [sourceArchive, tree, plan] = final;
	requireRead(sourceArchive && tree && plan);
	return {
		runtime,
		sourceArchive,
		tree,
		plan,
		pins: pins.map((p) => ({
			organizationId: p.organizationId as string,
			taskId: p.taskId as string,
			receiptId: p.receiptId as string,
		})),
	};
}
type OriginInput = {
	source: BoundLocalStoryFlowReadSource;
	origin: unknown;
	outcomeRef: unknown;
	observationRef: unknown;
};
const originTaskSelect = Object.fromEntries(
	[
		"id",
		"organizationId",
		"mediaVersionId",
		"analysisRevisionId",
		"parentTaskId",
		"kind",
		"requestKey",
		"requestHash",
		"cacheKey",
		"parameters",
		"startedAt",
	].map((k) => [k, true]),
) as Record<string, true>;
function copyRef(value: unknown) {
	const ref = record(value, [
		"kind",
		"receiptId",
		"cacheHash",
		"inputKeyHash",
		"proofHash",
	]);
	requireRead(
		typeof ref.kind === "string" &&
			[
				"LOCAL_FLOW_MANIFEST_V1",
				"LOCAL_FLOW_CONTEXT_V1",
				"LOCAL_FLOW_ROUTE_V1",
				"LOCAL_FLOW_PLAN_V1",
			].includes(ref.kind) &&
			uuid(ref.receiptId),
	);
	for (const key of ["cacheHash", "inputKeyHash", "proofHash"])
		requireRead(
			typeof ref[key] === "string" && /^[a-f0-9]{64}$/.test(ref[key]),
		);
	return ref;
}
async function readOrigin(state: ReadState, args: OriginInput) {
	const input = record(args, [
		"source",
		"origin",
		"outcomeRef",
		"observationRef",
	]);
	const owned = sourceState(state, input.source);
	const origin = record(input.origin, [
		"organizationId",
		"originTaskId",
		"slot",
		"startRef",
		"attemptRef",
	]);
	requireRead(
		origin.organizationId === state.organizationId &&
			uuid(origin.originTaskId) &&
			typeof origin.slot === "number" &&
			Number.isSafeInteger(origin.slot) &&
			origin.slot >= 1 &&
			origin.slot <= 127,
	);
	const startRef = copyRef(origin.startRef),
		attemptRef = copyRef(origin.attemptRef),
		outcomeRef = copyRef(input.outcomeRef),
		observationRef = copyRef(input.observationRef);
	state.origins.add(`${origin.originTaskId}:${origin.slot}`);
	requireRead(
		state.origins.size <= LOCAL_STORY_FLOW_DB_READ_POLICY.originNativeCount,
	);
	const task = await one(
		state,
		"libraryMediaTask",
		{ id: origin.originTaskId },
		originTaskSelect,
	);
	const verified = await getLibraryMediaTaskEvidenceReadOnly(
		state.tx,
		task as unknown as LibraryMediaTask,
	);
	const t = owned.evidence.sourceTuple;
	requireRead(
		task.kind === "GENERATE" &&
			verified.envelope.input.kind === "GENERATE" &&
			verified.binding &&
			verified.envelope.input.parameters.storyWorkflowVersion ===
				"hierarchical-flow-v1" &&
			verified.media.id === t.mediaVersionId &&
			verified.media.sourceId === t.sourceId &&
			verified.media.sha256 === t.mediaSha256 &&
			hash(verified.media.timeMap) === t.timeMapHash &&
			task.analysisRevisionId === t.analysisRevisionId &&
			verified.envelope.identity.analysisRawHash === t.analysisRawHash &&
			verified.envelope.identity.analysisDocumentHash ===
				t.analysisDocumentHash &&
			hash(verified.binding) === t.bindingHash &&
			(verified.preparedNormalization?.proofHash ?? null) ===
				t.normalizationReceiptHash &&
			(verified.envelope.identity.preparedShotClock
				? hash(verified.envelope.identity.preparedShotClock)
				: null) === t.preparedShotClockHash,
	);
	const load = async (purpose: "START" | "ATTEMPT" | "OUTCOME", ref: Row) => {
		const kind = "LOCAL_FLOW_PLAN_V1" as const;
		const key = {
			version: "local-story-flow-record-key-v1",
			purpose,
			keyBody: {
				taskId: origin.originTaskId,
				...(purpose === "START" ? {} : { slot: origin.slot }),
			},
		};
		const identity = localStoryFlowRecordIdentity({
			sourceTuple: t,
			kind,
			key,
		});
		const row = await one(
			state,
			"libraryEvidenceReceipt",
			{ id: identity.receiptId },
			receiptSelect,
		);
		const sealed = readLocalStoryFlowSealedRecord({
			sourceTuple: t,
			kind,
			key,
			row,
			ref,
		});
		await pin(state, identity.receiptId);
		return sealed;
	};
	const start = await load("START", startRef),
		attempt = await load("ATTEMPT", attemptRef),
		outcome = await load("OUTCOME", outcomeRef);
	const s = localStoryFlowSealedRecordEvidence(start).payload,
		a = localStoryFlowSealedRecordEvidence(attempt).payload,
		o = localStoryFlowSealedRecordEvidence(outcome).payload;
	requireRead(
		s.taskId === origin.originTaskId &&
			a.taskId === origin.originTaskId &&
			o.taskId === origin.originTaskId &&
			a.slot === origin.slot &&
			o.slot === origin.slot &&
			o.status === "ACCEPTED" &&
			isDeepStrictEqual(a.startRef, startRef) &&
			isDeepStrictEqual(o.startRef, startRef) &&
			isDeepStrictEqual(o.attemptRef, attemptRef) &&
			isDeepStrictEqual(o.observationRef, observationRef),
	);
	await one(
		state,
		"libraryFlowEvidencePin",
		{ taskId: origin.originTaskId, receiptId: startRef.receiptId },
		pinSelect,
	);
	return { task, start, attempt, outcome };
}
export type LocalStoryFlowReadSnapshotReader = {
	source(): Promise<BoundLocalStoryFlowReadSource>;
	getSealed(input: SealedInput): Promise<BoundLocalStoryFlowSealedRecord>;
	scanRuntime(input: RuntimeInput): ReturnType<typeof scanRuntime>;
	readOrigin(input: OriginInput): ReturnType<typeof readOrigin>;
	resolveSourceArchive(): Promise<BoundLocalStoryFlowSourceArchive>;
};
async function resolveSourceArchive(
	state: ReadState,
): Promise<BoundLocalStoryFlowSourceArchive> {
	requireRead(state.active);
	checkWorker(state);
	state.archive ??= (async () => {
		const source = await sourceFor(state),
			s = localStoryFlowReadSourceEvidence(source);
		const catalog = resolveLocalStoryFlowPolicyCatalogForTaskIdentity(
			s.verified.envelope.identity,
		);
		requireRead(catalog.status === "SUPPORTED");
		requireRead(
			catalog.generationPolicyFingerprint ===
				s.verified.envelope.identity.generationPolicyFingerprint,
		);
		const m = s.verified.media,
			a = s.analysisRow,
			t = s.task;
		const snapshots = {
			task: {
				id: t.id,
				organizationId: t.organizationId,
				kind: t.kind,
				mediaVersionId: t.mediaVersionId,
				analysisRevisionId: t.analysisRevisionId,
				requestKey: t.requestKey,
				parentTaskId: t.parentTaskId,
				requestHash: t.requestHash,
				cacheKey: t.cacheKey,
				parameters: t.parameters,
			},
			mediaSnapshot: {
				id: m.id,
				organizationId: m.organizationId,
				sourceId: m.sourceId,
				state: m.state,
				sha256: m.sha256,
				durationUs: m.durationUs === null ? null : m.durationUs.toString(),
				width: m.width,
				height: m.height,
				fpsNum: m.fpsNum,
				fpsDen: m.fpsDen,
				timeMap: m.timeMap,
				probe: m.probe,
				storage: m.storage,
			},
			analysisSnapshot: {
				id: a.id,
				organizationId: a.organizationId,
				sourceId: a.sourceId,
				rawHash: a.rawHash,
				locale: a.locale,
				providerVersion: a.providerVersion,
				raw: a.raw,
				document: a.document,
			},
			bindingSnapshot: s.verified.binding,
			normalizationSnapshot: s.verified.preparedNormalization
				? {
						proof: s.verified.preparedNormalization.proof,
						proofHash: s.verified.preparedNormalization.proofHash,
					}
				: null,
		};
		const preparation = prepareLocalStoryFlowArchiveSource(
			snapshots,
			catalog.policies,
		);
		const archive = await resolveLibraryFlowSourceArchive(
			preparation,
			async (requests) => {
				const ids = [...new Set(requests.map((q) => q.receiptId))];
				return (await rows(
					state,
					"libraryEvidenceReceipt",
					{ id: { in: ids } },
					receiptSelect,
					ids.length + 1,
				)) as unknown as LocalStoryArtifactCacheRow[];
			},
		);
		await sourceMaterialPins(
			state,
			localStoryFlowSourceArchiveEvidence(archive).requiredLegacyRefs.map(
				(ref) => ref.receiptId,
			),
		);
		return archive;
	})();
	const archive = await state.archive;
	requireRead(state.active);
	checkWorker(state);
	state.resolvedArchive = archive;
	return archive;
}
export type OwnedLocalStoryFlowReadFence = Readonly<object>;
const fences = new WeakMap<
	OwnedLocalStoryFlowReadFence,
	{
		organizationId: string;
		taskId: string;
		reads: RowRead[];
		worker?: WorkerSourceAuthority;
		resolvedArchive?: BoundLocalStoryFlowSourceArchive;
	}
>();
const tableNames = {
	libraryMediaTask: "LibraryMediaTask",
	librarySource: "LibrarySource",
	libraryMediaVersion: "LibraryMediaVersion",
	sceneAnalysisRevision: "SceneAnalysisRevision",
	libraryAnalysisBinding: "LibraryAnalysisBinding",
	editProject: "EditProject",
	editRevision: "EditRevision",
	libraryEvidenceReceipt: "LibraryEvidenceReceipt",
	libraryFlowEvidencePin: "LibraryFlowEvidencePin",
} as const;
const lockOrder: readonly Table[] = [
	"librarySource",
	"libraryMediaVersion",
	"sceneAnalysisRevision",
	"libraryAnalysisBinding",
	"editProject",
	"editRevision",
	"libraryMediaTask",
	"libraryEvidenceReceipt",
	"libraryFlowEvidencePin",
];
async function lockRow(
	tx: AppTransactionClient,
	organizationId: string,
	table: Table,
	row: Row,
	mode: "UPDATE" | "SHARE" | "KEY SHARE",
) {
	const isPin = table === "libraryFlowEvidencePin";
	const rowId = isPin ? row.taskId : row.id;
	requireRead(uuid(rowId) && (!isPin || uuid(row.receiptId)));
	// Identifiers and lock modes come only from the fixed internal table map.
	const sql = isPin
		? `SELECT "receiptId" AS id FROM "LibraryFlowEvidencePin" WHERE "organizationId"=$1::uuid AND "taskId"=$2::uuid AND "receiptId"=$3::uuid FOR KEY SHARE`
		: `SELECT id FROM "${tableNames[table]}" WHERE "organizationId"=$1::uuid AND id=$2::uuid FOR ${mode}`;
	const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
		sql,
		organizationId,
		rowId,
		...(isPin ? [row.receiptId] : []),
	);
	requireRead(
		locked.length === 1 && locked[0]?.id === (isPin ? row.receiptId : rowId),
	);
}
/** Freshness/retention fence only; the caller keeps this write transaction through commit. */
export async function validateLocalStoryFlowReadFence(
	tx: AppTransactionClient,
	handle: OwnedLocalStoryFlowReadFence,
): Promise<void> {
	const fence = fences.get(handle);
	requireRead(fence);
	requireOrganization(tx, fence.organizationId);
	const taskLock = localStoryFlowTaskLockKey(fence.taskId);
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${taskLock})`;
	await lockRow(
		tx,
		fence.organizationId,
		"libraryMediaTask",
		{ id: fence.taskId },
		"UPDATE",
	);
	const state: ReadState = {
		tx,
		organizationId: fence.organizationId,
		taskId: fence.taskId,
		active: true,
		reads: new Map(),
		sourceCreated: true,
		origins: new Set(),
		...(fence.worker ? { worker: { ...fence.worker } } : {}),
	};
	for (const table of lockOrder) {
		const unique = new Map<string, Row>();
		for (const read of fence.reads.filter((r) => r.table === table))
			for (const row of read.expected) {
				if (table === "libraryMediaTask" && row.id === fence.taskId) continue;
				const key =
					table === "libraryFlowEvidencePin"
						? `${row.taskId}:${row.receiptId}`
						: String(row.id);
				unique.set(key, row);
			}
		if (table === "libraryFlowEvidencePin") {
			for (const read of fence.reads.filter((r) => r.workerMaterialPins)) {
				const current = await rows(
					state,
					read.table,
					read.where,
					read.select,
					read.take,
				);
				workerMaterialPins(state, read, current);
				for (const row of current)
					unique.set(`${row.taskId}:${row.receiptId}`, row);
			}
		}
		const mode = [
			"editRevision",
			"libraryEvidenceReceipt",
			"libraryFlowEvidencePin",
		].includes(table)
			? "KEY SHARE"
			: "SHARE";
		for (const [, row] of [...unique].sort(([a], [b]) => a.localeCompare(b)))
			await lockRow(tx, fence.organizationId, table, row, mode);
	}
	if (state.worker)
		await authorizeWorker(
			state,
			(await one(state, "libraryMediaTask", {
				id: state.taskId,
			})) as unknown as LibraryMediaTask,
		);
	for (const read of fence.reads) {
		const current = await rows(
			state,
			read.table,
			read.where,
			read.select,
			read.take,
		);
		if (read.workerMaterialPins) workerMaterialPins(state, read, current);
		else
			requireRead(
				isDeepStrictEqual(
					fenceRows(read.table, current, read.select),
					read.expected,
				),
			);
	}
	checkWorker(state);
}

/** The exact archive must have been resolved within this fence's read snapshot. */
export async function validateLocalStoryFlowSourceArchiveReadFence(
	tx: AppTransactionClient,
	handle: OwnedLocalStoryFlowReadFence,
	archive: BoundLocalStoryFlowSourceArchive,
): Promise<void> {
	const fence = fences.get(handle);
	requireRead(fence?.resolvedArchive && fence.resolvedArchive === archive);
	await validateLocalStoryFlowReadFence(tx, handle);
}

/** DB snapshot only. This is neither compiled FLOW readiness nor delivery admission. */
async function withReadSnapshot<T>(
	options: { authorizedOrganizationId: string; generationTaskId: string },
	read: (reader: LocalStoryFlowReadSnapshotReader) => Promise<T>,
	worker?: WorkerSourceAuthority,
) {
	const input = record(options, [
		"authorizedOrganizationId",
		"generationTaskId",
	]);
	requireRead(
		uuid(input.authorizedOrganizationId) && uuid(input.generationTaskId),
	);
	const organizationId = input.authorizedOrganizationId;
	const tenant = getTenantPrisma(organizationId, { readOnly: true });
	return tenant.$transaction(
		async (tx) => {
			requireOrganization(tx, organizationId);
			const state: ReadState = {
				tx,
				organizationId,
				taskId: input.generationTaskId as string,
				active: true,
				reads: new Map(),
				sourceCreated: false,
				origins: new Set(),
				...(worker ? { worker } : {}),
			};
			try {
				const value = await read(
					Object.freeze({
						source: () => sourceFor(state),
						getSealed: (input: SealedInput) => getSealed(state, input),
						scanRuntime: (input: RuntimeInput) => scanRuntime(state, input),
						readOrigin: (input: OriginInput) => readOrigin(state, input),
						resolveSourceArchive: () => resolveSourceArchive(state),
					}),
				);
				requireRead(state.sourceCreated);
				checkWorker(state);
				const readFence = Object.freeze({});
				fences.set(readFence, {
					organizationId,
					taskId: state.taskId,
					reads: structuredClone([...state.reads.values()]),
					...(state.worker ? { worker: { ...state.worker } } : {}),
					...(state.resolvedArchive
						? { resolvedArchive: state.resolvedArchive }
						: {}),
				});
				return { value, readFence };
			} finally {
				state.active = false;
			}
		},
		{
			isolationLevel: "RepeatableRead",
			timeout: 15_000,
			statementTimeoutMs: 5_000,
		},
	);
}

export async function withLocalStoryFlowReadSnapshot<T>(
	options: { authorizedOrganizationId: string; generationTaskId: string },
	read: (reader: LocalStoryFlowReadSnapshotReader) => Promise<T>,
) {
	return withReadSnapshot(options, read);
}
export type LocalStoryFlowWorkerSourceSnapshotReader = Pick<
	LocalStoryFlowReadSnapshotReader,
	"source" | "resolveSourceArchive"
>;
export async function withLocalStoryFlowWorkerSourceSnapshot<T>(
	options: {
		authorizedOrganizationId: string;
		generationTaskId: string;
		leaseToken: string;
		signal: AbortSignal;
	},
	read: (reader: LocalStoryFlowWorkerSourceSnapshotReader) => Promise<T>,
) {
	const input = record(options, [
		"authorizedOrganizationId",
		"generationTaskId",
		"leaseToken",
		"signal",
	]);
	requireRead(uuid(input.leaseToken) && input.signal instanceof AbortSignal);
	return withReadSnapshot(
		{
			authorizedOrganizationId: input.authorizedOrganizationId as string,
			generationTaskId: input.generationTaskId as string,
		},
		(reader) =>
			read(
				Object.freeze({
					source: reader.source,
					resolveSourceArchive: reader.resolveSourceArchive,
				}),
			),
		{
			leaseToken: input.leaseToken as string,
			signal: input.signal,
			monotonicDeadline: Infinity,
		},
	);
}
