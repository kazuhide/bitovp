import { createHash } from "node:crypto";
import { z } from "zod";
import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	mediaTaskCacheKey,
	mediaTaskIntentHash,
} from "../content-production/identity";
import {
	localStoryFlowGenerationPolicyFingerprint,
	localStoryFlowTaskPolicyPartsSchema,
	resolveLocalStoryWorkflow,
} from "../content-production/local-story-workflow";
import { mediaTaskEnvelopeSchema } from "../content-production/schema";
import { canonicalEditingJson } from "./automatic-binding";
import {
	localStoryIdentityForModelPin,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import { LOCAL_STORY_FLOW_CLOSURE_POLICY } from "./local-story-flow-closure";
import {
	LOCAL_STORY_FLOW_CONTEXT_POLICY,
	localStoryFlowContextSourceEvidence,
	type PreparedLocalStoryFlowContextSource,
	prepareLocalStoryFlowContextSourceFromPin,
} from "./local-story-flow-context";
import { LOCAL_STORY_FLOW_H1_POLICY } from "./local-story-flow-contracts";
import {
	createLocalStoryLegacyLedgerCacheRecipe,
	createLocalStoryLegacyLedgerStageRecipe,
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
} from "./local-story-flow-legacy-ledger";
import {
	type LocalStoryArtifactCacheRow,
	type LocalStoryArtifactCacheScope,
	type LocalStoryLegacyArtifactRef,
	localStoryArtifactCacheHashes,
	readLocalStoryLegacyCacheRef,
} from "./local-story-flow-legacy-seals";
import {
	createLocalStoryLegacyTranscriptRecipe,
	type LocalStoryLegacyTranscriptPrepared,
} from "./local-story-flow-legacy-transcript";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import { LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY } from "./local-story-flow-native";
import { LOCAL_STORY_FLOW_ROUTE_POLICY } from "./local-story-flow-route";
import { LOCAL_STORY_FLOW_SCOPE_POLICY } from "./local-story-flow-scope";
import type {
	LocalStoryFlowRecordKey,
	LocalStoryFlowSourceTuple,
} from "./local-story-flow-seals";
import { validateLocalStoryFlowWorkflowIdentityForModelPin } from "./local-story-flow-stages";
import {
	buildLocalStoryChunks,
	buildLocalStoryInput,
	mergeLocalStoryLedgers,
} from "./local-story-input";
import {
	buildPreparedShotPartition,
	verifyPreparedNormalizationReceipt,
} from "./prepared-shot-partition";
import { cfrTimeMapSchema } from "./schema";
import {
	hashEditingEvidence as hash,
	verifyAutomaticAnalysisBinding,
} from "./verify-automatic-binding";

/** Source reconstruction only. This policy does not constitute delivery or DB authorization. */
export const LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY = Object.freeze({
	version: "local-story-flow-source-archive-policy-v1",
	snapshotRule: "independent-db-source-task-snapshots-v1",
	transcriptRule: "whole-sealed-v3-or-probe-no-audio-v1",
	ledgerRule: "all-chunks-original-pointer-stage-full-seals-v1",
	inputRule: "existing-input-chunks-full-corpus-h0-h1b-v1",
	legacyFamilies: Object.freeze(["V4", "V3", "V2", "V1"] as const),
	maxJsonBytes: 128 * 1024 * 1024,
	maxNodes: 4_000_000,
	maxDepth: 128,
});
export class LocalStoryFlowSourceArchiveError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowSourceArchiveError";
	}
}
function requireSource(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowSourceArchiveError();
}
function checked<T>(work: () => T): T {
	try {
		return work();
	} catch {
		throw new LocalStoryFlowSourceArchiveError();
	}
}
/** Unknown values are copied from descriptors before any schema or hash can invoke a getter. */
function copyJson(input: unknown): unknown {
	let nodes = 0;
	const active = new Set<object>();
	function copy(value: unknown, depth: number): unknown {
		requireSource(
			++nodes <= LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY.maxNodes &&
				depth <= LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY.maxDepth,
		);
		if (
			value === null ||
			typeof value === "boolean" ||
			typeof value === "string"
		)
			return value;
		if (typeof value === "number") {
			requireSource(Number.isFinite(value));
			return value;
		}
		requireSource(
			typeof value === "object" && value !== null && !active.has(value),
		);
		const array = Array.isArray(value);
		requireSource(
			Object.getPrototypeOf(value) ===
				(array ? Array.prototype : Object.prototype) &&
				Object.getOwnPropertySymbols(value).length === 0,
		);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		active.add(value);
		try {
			if (array) {
				const length = descriptors.length;
				requireSource(
					length &&
						"value" in length &&
						Number.isSafeInteger(length.value) &&
						length.value >= 0 &&
						length.value <= LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY.maxNodes &&
						Object.keys(descriptors).length === length.value + 1,
				);
				return Array.from({ length: length.value }, (_, i) => {
					const d = descriptors[String(i)];
					requireSource(d?.enumerable && "value" in d);
					return copy(d.value, depth + 1);
				});
			}
			return Object.fromEntries(
				Object.entries(descriptors).map(([name, d]) => {
					requireSource(d.enumerable && "value" in d);
					return [name, copy(d.value, depth + 1)];
				}),
			);
		} finally {
			active.delete(value);
		}
	}
	const data = copy(input, 0);
	requireSource(
		Buffer.byteLength(canonicalEditingJson(data)) <=
			LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY.maxJsonBytes,
	);
	return data;
}
const uuid = z.uuid().regex(/^[0-9a-f-]+$/),
	digest = z.string().regex(/^[0-9a-f]{64}$/);
const taskSchema = z.strictObject({
	id: uuid,
	organizationId: uuid,
	kind: z.literal("GENERATE"),
	mediaVersionId: uuid,
	analysisRevisionId: uuid,
	requestKey: uuid,
	requestHash: digest,
	cacheKey: digest,
	parentTaskId: uuid.nullable(),
	parameters: z.unknown(),
});
const mediaSchema = z.strictObject({
	id: uuid,
	organizationId: uuid,
	sourceId: uuid,
	state: z.literal("READY"),
	sha256: digest,
	durationUs: z.string().regex(/^\d+$/).nullable(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	fpsNum: z.number().int().positive().nullable(),
	fpsDen: z.number().int().positive().nullable(),
	timeMap: z.unknown(),
	probe: z.unknown(),
	storage: z.unknown(),
});
const analysisSchema = z.strictObject({
	id: uuid,
	organizationId: uuid,
	sourceId: uuid,
	rawHash: digest,
	locale: z.string(),
	providerVersion: z.string(),
	raw: z.unknown(),
	document: z.unknown(),
});
const snapshotsSchema = z.strictObject({
	task: taskSchema,
	mediaSnapshot: mediaSchema,
	analysisSnapshot: analysisSchema,
	bindingSnapshot: z.unknown(),
	normalizationSnapshot: z
		.strictObject({ proof: z.unknown(), proofHash: digest })
		.nullable(),
});
export type LocalStoryFlowArchiveSourceSnapshots = z.infer<
	typeof snapshotsSchema
>;
type Preparation = {
	snapshots: LocalStoryFlowArchiveSourceSnapshots;
	envelope: z.infer<typeof mediaTaskEnvelopeSchema>;
	policies: z.infer<typeof localStoryFlowTaskPolicyPartsSchema>;
	sourceTuple: LocalStoryFlowSourceTuple;
	taskPin: Record<string, unknown>;
	taskPinHash: string;
	taskPayloadHash: string;
	map: ReturnType<typeof cfrTimeMapSchema.parse>;
	analysis: ReturnType<typeof sceneAnalysisDocumentSchema.parse>;
	partition: ReturnType<typeof buildPreparedShotPartition> | undefined;
	transcriptRecipe: ReturnType<typeof createLocalStoryLegacyTranscriptRecipe>;
	hasAudio: boolean;
	model: ReturnType<typeof localStoryIdentityForModelPin>;
};
export type PreparedLocalStoryFlowArchiveSource = Readonly<object>;
export type AdmittedLocalStoryFlowArchiveTranscript = Readonly<object>;
export type BoundLocalStoryFlowSourceArchive = Readonly<object>;
const preparations = new WeakMap<
	PreparedLocalStoryFlowArchiveSource,
	Preparation
>();
type Transcript = {
	preparation: Preparation;
	prepared: LocalStoryLegacyTranscriptPrepared;
	admission: Record<string, unknown>;
	input: ReturnType<typeof buildLocalStoryInput>;
	chunks: ReturnType<typeof buildLocalStoryChunks>;
};
const transcripts = new WeakMap<
	AdmittedLocalStoryFlowArchiveTranscript,
	Transcript
>();
type Archive = {
	key: LocalStoryFlowRecordKey;
	payload: Record<string, unknown>;
	source: PreparedLocalStoryFlowContextSource;
	requiredLegacyRefs: LocalStoryLegacyArtifactRef[];
};
const archives = new WeakMap<BoundLocalStoryFlowSourceArchive, Archive>();
function preparation(handle: PreparedLocalStoryFlowArchiveSource) {
	const value = preparations.get(handle);
	requireSource(value);
	return value;
}
function transcript(handle: unknown) {
	requireSource(typeof handle === "object" && handle !== null);
	const value = transcripts.get(handle);
	requireSource(value);
	return value;
}
function scope(
	p: Preparation,
	forTranscript = false,
): LocalStoryArtifactCacheScope {
	return {
		task: { organizationId: p.snapshots.task.organizationId },
		media: p.snapshots.mediaSnapshot,
		taskIdentity: p.envelope.identity,
		analysisRevisionId: forTranscript ? null : p.snapshots.analysisSnapshot.id,
	};
}
function legacyRequest(
	p: Preparation,
	kind: "LOCAL_STORY_TRANSCRIPT_V1" | "LOCAL_STORY_LEDGER_V1",
	key: unknown,
) {
	const hashes = localStoryArtifactCacheHashes({
		...scope(p, kind === "LOCAL_STORY_TRANSCRIPT_V1"),
		input: { kind, key },
	});
	const bytes = createHash("sha1")
		.update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
		.update(
			`bitovp-semantic:${p.snapshots.task.organizationId}:artifact:${hashes.cacheHash}`,
		)
		.digest()
		.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 15) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
	const s = bytes.toString("hex"),
		receiptId = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
	return { kind, key: structuredClone(key), ...hashes, receiptId };
}
/** Server callers supply independently read snapshots and the supported compiled policy catalog. */
export function prepareLocalStoryFlowArchiveSource(
	snapshots: unknown,
	policies: unknown,
): PreparedLocalStoryFlowArchiveSource {
	return checked(() => {
		const copied = copyJson(snapshots),
			s = snapshotsSchema.parse(copied);
		requireSource(canonicalEditingJson(s) === canonicalEditingJson(copied));
		const parts = localStoryFlowTaskPolicyPartsSchema.parse(copyJson(policies));
		const { task, mediaSnapshot: media, analysisSnapshot: analysis } = s;
		const envelope = mediaTaskEnvelopeSchema.parse(task.parameters),
			input = envelope.input,
			identity = envelope.identity;
		requireSource(
			canonicalEditingJson(envelope) === canonicalEditingJson(task.parameters),
		);
		requireSource(
			input.kind === "GENERATE" &&
				resolveLocalStoryWorkflow(input.parameters) === "HIERARCHICAL_FLOW_V1",
		);
		requireSource(
			identity.organizationId === task.organizationId &&
				media.organizationId === task.organizationId &&
				analysis.organizationId === task.organizationId &&
				input.mediaVersionId === task.mediaVersionId &&
				media.id === task.mediaVersionId &&
				input.analysisRevisionId === task.analysisRevisionId &&
				analysis.id === task.analysisRevisionId &&
				analysis.sourceId === media.sourceId &&
				input.requestKey === task.requestKey &&
				mediaTaskIntentHash(input, task.parentTaskId) === task.requestHash &&
				mediaTaskCacheKey(input, identity) === task.cacheKey,
		);
		requireSource(
			identity.mediaSha256 === media.sha256 &&
				identity.timeMapHash === hash(media.timeMap) &&
				identity.analysisRawHash === analysis.rawHash &&
				identity.analysisDocumentHash === hash(analysis.document),
		);
		requireSource(
			identity.localStoryModel &&
				identity.localStoryWorkflow &&
				identity.generationPolicyFingerprint ===
					localStoryFlowGenerationPolicyFingerprint(parts),
		);
		const pin = {
			profile: identity.localStoryModel.profile,
			configId: identity.localStoryModel.configId,
		};
		const model = localStoryIdentityForModelPin(pin);
		requireSource(
			canonicalEditingJson(model) ===
				canonicalEditingJson(identity.localStoryModel),
		);
		validateLocalStoryFlowWorkflowIdentityForModelPin(
			identity.localStoryWorkflow,
			pin,
			"FLOW",
		);
		for (const [key, value] of Object.entries({
			workflowPolicyHash: hash(LOCAL_STORY_FLOW_H1_POLICY),
			contextPolicyHash: hash(LOCAL_STORY_FLOW_CONTEXT_POLICY),
			closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
			routePolicyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
			scopePolicyHash: hash(LOCAL_STORY_FLOW_SCOPE_POLICY),
			promptPolicyHash: hash(LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY),
		}))
			requireSource(parts[key as keyof typeof parts] === value);
		const map = cfrTimeMapSchema.parse(media.timeMap);
		requireSource(map.mediaVersionId === media.id);
		const binding = verifyAutomaticAnalysisBinding({
			organizationId: task.organizationId,
			media,
			analysis,
			bindings: [s.bindingSnapshot],
			binding: identity.bindingSnapshot,
		});
		requireSource(
			canonicalEditingJson(binding) ===
				canonicalEditingJson(s.bindingSnapshot) &&
				identity.bindingHash === hash(binding),
		);
		let partition: ReturnType<typeof buildPreparedShotPartition> | undefined;
		if (identity.preparedShotClock) {
			requireSource(
				s.normalizationSnapshot &&
					s.normalizationSnapshot.proofHash ===
						identity.preparedShotClock.normalizationReceiptHash,
			);
			const normalized = verifyPreparedNormalizationReceipt({
				proof: s.normalizationSnapshot.proof,
				proofHash: s.normalizationSnapshot.proofHash,
				organizationId: task.organizationId,
				sourceId: media.sourceId,
				mediaVersionId: media.id,
				preparedSha256: media.sha256,
				timeMap: map,
				width: media.width,
				height: media.height,
			});
			partition = buildPreparedShotPartition({
				analysis: analysis.document,
				timeMap: map,
				normalization: normalized,
			});
		} else requireSource(s.normalizationSnapshot === null);
		const sourceTuple: LocalStoryFlowSourceTuple = {
			version: "local-story-flow-source-tuple-v1",
			organizationId: task.organizationId,
			sourceId: media.sourceId,
			mediaVersionId: media.id,
			mediaSha256: media.sha256,
			timeMapHash: hash(media.timeMap),
			analysisRevisionId: analysis.id,
			analysisRawHash: analysis.rawHash,
			analysisDocumentHash: hash(analysis.document),
			bindingHash: hash(binding),
			preparedShotClockHash: identity.preparedShotClock
				? hash(identity.preparedShotClock)
				: null,
			normalizationReceiptHash: s.normalizationSnapshot?.proofHash ?? null,
		};
		const taskPin = {
			version: "local-story-flow-task-pin-v1",
			parameters: input.parameters,
			identity,
			policies: parts,
		};
		const probe =
			media.probe &&
			typeof media.probe === "object" &&
			!Array.isArray(media.probe)
				? (media.probe as Record<string, unknown>)
				: {};
		requireSource(
			Array.isArray(probe.streams) &&
				probe.streams.length > 0 &&
				probe.streams.length <= 64 &&
				probe.streams.every(
					(stream) =>
						stream !== null &&
						typeof stream === "object" &&
						!Array.isArray(stream) &&
						"codec_type" in stream &&
						["video", "audio", "subtitle", "data", "attachment"].includes(
							String(stream.codec_type),
						),
				) &&
				probe.streams.some(
					(stream) =>
						stream !== null &&
						typeof stream === "object" &&
						"codec_type" in stream &&
						stream.codec_type === "video",
				),
		);
		const hasAudio =
			Array.isArray(probe.streams) &&
			probe.streams.some(
				(stream) =>
					stream &&
					typeof stream === "object" &&
					"codec_type" in stream &&
					stream.codec_type === "audio",
			);
		const transcriptRecipe = createLocalStoryLegacyTranscriptRecipe({
			mediaSha256: media.sha256,
			timeMap: map,
			configuredModel: identity.modelSha256
				? { sha256: identity.modelSha256 }
				: null,
			language: input.parameters.language,
		});
		const handle = Object.freeze({});
		preparations.set(handle, {
			snapshots: s,
			envelope,
			policies: parts,
			sourceTuple,
			taskPin,
			taskPinHash: hash(taskPin),
			taskPayloadHash: hash(task.parameters),
			map,
			analysis: sceneAnalysisDocumentSchema.parse(analysis.document),
			partition,
			transcriptRecipe,
			hasAudio,
			model,
		});
		return handle;
	});
}
export function localStoryFlowArchivePreparationEvidence(
	handle: PreparedLocalStoryFlowArchiveSource,
) {
	return checked(() => {
		const p = preparation(handle);
		return structuredClone({
			sourceTuple: p.sourceTuple,
			taskPin: p.taskPin,
			taskPinHash: p.taskPinHash,
			taskPayloadHash: p.taskPayloadHash,
			hasAudio: p.hasAudio,
			transcript: legacyRequest(
				p,
				p.transcriptRecipe.kind,
				p.transcriptRecipe.key,
			),
		});
	});
}
export type LocalStoryFlowLegacyRecordPair = {
	ref: LocalStoryLegacyArtifactRef;
	row: LocalStoryArtifactCacheRow;
};
const legacyPairSchema = z.strictObject({
	ref: z.strictObject({
		kind: z.enum([
			"LOCAL_STORY_TRANSCRIPT_V1",
			"LOCAL_STORY_LEDGER_V1",
			"LOCAL_STORY_BLUEPRINT_V1",
			"LOCAL_CAPTION_TRANSLATION_V1",
		]),
		receiptId: uuid,
		cacheHash: digest,
		inputKeyHash: digest,
		proofHash: digest,
	}),
	row: z.strictObject({
		id: uuid,
		organizationId: uuid,
		sourceId: uuid.nullable(),
		mediaVersionId: uuid.nullable(),
		analysisRevisionId: uuid.nullable(),
		kind: z.string(),
		proof: z.json(),
		proofHash: digest,
	}),
});
function parseLegacyPair(value: unknown) {
	const copied = copyJson(value),
		parsed = legacyPairSchema.parse(copied);
	// Schema normalization must never erase a field from an original sealed proof.
	requireSource(canonicalEditingJson(parsed) === canonicalEditingJson(copied));
	return parsed;
}
/** Rows and refs come from a tenant-scoped read. No parser callback, migration or builder is accepted. */
export function admitLocalStoryFlowArchiveTranscript(
	handle: PreparedLocalStoryFlowArchiveSource,
	provided: LocalStoryFlowLegacyRecordPair | null,
): AdmittedLocalStoryFlowArchiveTranscript {
	return checked(() => {
		const p = preparation(handle),
			pair = provided === null ? null : parseLegacyPair(provided),
			recipe = p.transcriptRecipe;
		let prepared: LocalStoryLegacyTranscriptPrepared,
			admission: Record<string, unknown>;
		if (!p.hasAudio) {
			requireSource(pair === null);
			prepared = recipe.absent(
				{ status: "NO_AUDIO", warning: "SOURCE_HAS_NO_AUDIO" },
				[],
			);
			const { cached: _cached, ...meaning } = prepared;
			admission = {
				status: "NO_AUDIO",
				absenceKey: recipe.key,
				warning: "SOURCE_HAS_NO_AUDIO",
				transcript: meaning,
			};
		} else {
			requireSource(
				pair && Object.keys(pair).length === 2 && pair.ref.kind === recipe.kind,
			);
			const loaded = readLocalStoryLegacyCacheRef({
				...scope(p, true),
				input: {
					kind: recipe.kind,
					key: recipe.key,
					parse: recipe.parse,
					recoverLegacyTranscriptValue: recipe.recoverLegacyDerivedMean,
				},
				row: pair.row,
				ref: pair.ref,
				check() {},
			});
			prepared = recipe.ready({
				value: loaded.value,
				valueHash: loaded.hash,
				cached: true,
			});
			requireSource(prepared.status === "READY");
			const { cached: _cached, ...meaning } = prepared;
			admission = {
				status: "READY",
				artifactKey: recipe.key,
				artifactRef: pair.ref,
				transcript: meaning,
			};
		}
		requireSource(
			p.envelope.identity.transcriptionPolicyFingerprint ===
				prepared.qualityPolicyFingerprint,
		);
		const input = buildLocalStoryInput({
				analysis: p.analysis,
				timeMap: p.map,
				...(p.partition ? { preparedPartition: p.partition } : {}),
				segments: prepared.segments,
			}),
			chunks = buildLocalStoryChunks(input);
		requireSource(chunks.length > 0);
		const result = Object.freeze({});
		transcripts.set(result, {
			preparation: p,
			prepared,
			admission,
			input,
			chunks,
		});
		return result;
	});
}
export function localStoryFlowArchiveLedgerRequests(
	handle: AdmittedLocalStoryFlowArchiveTranscript,
	chunkIndex: number,
) {
	return checked(() => {
		const t = transcript(handle),
			chunk = t.chunks[chunkIndex];
		requireSource(Number.isSafeInteger(chunkIndex) && chunkIndex >= 0 && chunk);
		return LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY.legacyFamilies.map(
			(version) => {
				const recipe = ledgerRecipe(t, chunkIndex, version);
				return {
					version,
					...legacyRequest(t.preparation, "LOCAL_STORY_LEDGER_V1", recipe.key),
				};
			},
		);
	});
}
/** Full ordered input/chunks for bounded row resolution; never a selected or shortened corpus. */
export function localStoryFlowArchiveTranscriptEvidence(
	handle: AdmittedLocalStoryFlowArchiveTranscript,
) {
	return checked(() => {
		const t = transcript(handle);
		return structuredClone({
			transcriptAdmission: t.admission,
			transcriptFingerprint: t.prepared.fingerprint,
			fullInput: t.input,
			chunks: t.chunks,
		});
	});
}
/** Admit the original pointer before resolving its fixed stage row. */
export function localStoryFlowArchiveLedgerStageRequest(
	handle: AdmittedLocalStoryFlowArchiveTranscript,
	chunkIndex: number,
	supplied: LocalStoryFlowLegacyRecordPair,
) {
	return checked(() => {
		const t = transcript(handle),
			pair = parseLegacyPair(supplied);
		const candidates = localStoryFlowArchiveLedgerRequests(
			handle,
			chunkIndex,
		).filter(
			(r) =>
				r.receiptId === pair.ref.receiptId &&
				r.cacheHash === pair.ref.cacheHash &&
				r.inputKeyHash === pair.ref.inputKeyHash,
		);
		requireSource(candidates.length === 1);
		const candidate = candidates[0];
		requireSource(candidate);
		const recipe = ledgerRecipe(t, chunkIndex, candidate.version);
		const pointer = readLocalStoryLegacyCacheRef({
			...scope(t.preparation),
			input: {
				kind: "LOCAL_STORY_LEDGER_V1",
				key: recipe.key,
				parse: recipe.parse,
			},
			row: pair.row,
			ref: pair.ref,
			check() {},
		});
		const chunk = t.chunks[chunkIndex];
		requireSource(chunk);
		const stage = createLocalStoryLegacyLedgerStageRecipe({
			identity: t.preparation.model,
			input: t.input,
			chunk,
			transcriptFingerprint: t.prepared.fingerprint,
			definition: localStoryStageRegistry().stages.LOCAL_LEDGER_V1,
			prompt: pointer.value.prompt,
			organizationId: t.preparation.snapshots.task.organizationId,
		});
		return {
			...legacyRequest(t.preparation, "LOCAL_STORY_LEDGER_V1", stage.key),
			pointerBody: structuredClone(pointer.value),
		};
	});
}
function ledgerRecipe(
	t: Transcript,
	chunkIndex: number,
	version: "V1" | "V2" | "V3" | "V4",
) {
	const chunk = t.chunks[chunkIndex];
	requireSource(chunk);
	const common = {
		identity: t.preparation.model,
		input: t.input,
		chunk,
		transcriptFingerprint: t.prepared.fingerprint,
		definition: localStoryStageRegistry().stages.LOCAL_LEDGER_V1,
	};
	return createLocalStoryLegacyLedgerCacheRecipe(
		version === "V4"
			? {
					...common,
					version,
					validationPolicyVersion:
						LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions.V4,
				}
			: { ...common, version },
	);
}
export type LocalStoryFlowArchiveLedgerPair = {
	pointer: LocalStoryFlowLegacyRecordPair;
	stage: LocalStoryFlowLegacyRecordPair;
};
export function buildLocalStoryFlowSourceArchive(options: {
	transcript: AdmittedLocalStoryFlowArchiveTranscript;
	ledgers: readonly LocalStoryFlowArchiveLedgerPair[];
}): BoundLocalStoryFlowSourceArchive {
	return checked(() => {
		requireSource(Object.getPrototypeOf(options) === Object.prototype);
		const descriptors = Object.getOwnPropertyDescriptors(options);
		requireSource(
			Object.getOwnPropertySymbols(options).length === 0 &&
				Object.keys(descriptors).sort().join(",") === "ledgers,transcript" &&
				descriptors.transcript &&
				"value" in descriptors.transcript &&
				descriptors.transcript.enumerable &&
				descriptors.ledgers &&
				"value" in descriptors.ledgers &&
				descriptors.ledgers.enumerable,
		);
		const t = transcript(descriptors.transcript.value),
			p = t.preparation;
		const pairData = copyJson(descriptors.ledgers.value);
		const pairs = z
			.array(
				z.strictObject({ pointer: legacyPairSchema, stage: legacyPairSchema }),
			)
			.parse(pairData);
		requireSource(
			canonicalEditingJson(pairs) === canonicalEditingJson(pairData),
		);
		requireSource(Array.isArray(pairs) && pairs.length === t.chunks.length);
		const requiredLegacyRefs: LocalStoryLegacyArtifactRef[] = [];
		if (t.admission.status === "READY")
			requiredLegacyRefs.push(
				t.admission.artifactRef as LocalStoryLegacyArtifactRef,
			);
		const admissions = pairs.map((pair, chunkIndex) => {
			requireSource(
				pair &&
					Object.keys(pair).sort().join(",") === "pointer,stage" &&
					Object.keys(pair.pointer).sort().join(",") === "ref,row" &&
					Object.keys(pair.stage).sort().join(",") === "ref,row",
			);
			const candidates = localStoryFlowArchiveLedgerRequests(
				descriptors.transcript.value as AdmittedLocalStoryFlowArchiveTranscript,
				chunkIndex,
			).filter(
				(r) =>
					r.cacheHash === pair.pointer.ref.cacheHash &&
					r.inputKeyHash === pair.pointer.ref.inputKeyHash,
			);
			requireSource(candidates.length === 1);
			const candidate = candidates[0];
			requireSource(candidate);
			const recipe = ledgerRecipe(t, chunkIndex, candidate.version),
				pointer = readLocalStoryLegacyCacheRef({
					...scope(p),
					input: {
						kind: "LOCAL_STORY_LEDGER_V1",
						key: recipe.key,
						parse: recipe.parse,
					},
					row: pair.pointer.row,
					ref: pair.pointer.ref,
					check() {},
				});
			const chunk = t.chunks[chunkIndex];
			requireSource(chunk);
			const stageRecipe = createLocalStoryLegacyLedgerStageRecipe({
				identity: p.model,
				input: t.input,
				chunk,
				transcriptFingerprint: t.prepared.fingerprint,
				definition: localStoryStageRegistry().stages.LOCAL_LEDGER_V1,
				prompt: pointer.value.prompt,
				organizationId: p.snapshots.task.organizationId,
			});
			const stage = readLocalStoryLegacyCacheRef({
				...scope(p),
				input: {
					kind: "LOCAL_STORY_LEDGER_V1",
					key: stageRecipe.key,
					parse: stageRecipe.parse,
				},
				row: pair.stage.row,
				ref: pair.stage.ref,
				check() {},
			});
			requireSource(hash(stageRecipe.key) === pointer.value.stageKeyHash);
			const ledgerRef = {
				chunkIndex,
				stageInputHash: hash(recipe.stageInput),
				promptHash: createHash("sha256")
					.update(pointer.value.prompt)
					.digest("hex"),
				schemaHash: stageRecipe.key.schemaHash,
				stageKeyHash: hash(stageRecipe.key),
				ledgerHash: hash(stage.value.output),
			};
			requiredLegacyRefs.push(pair.pointer.ref, pair.stage.ref);
			return {
				chunkIndex,
				transcriptFingerprint: t.prepared.fingerprint,
				pointerKey: recipe.key,
				pointerRef: pair.pointer.ref,
				pointerBody: pointer.value,
				stageKey: stageRecipe.key,
				stageRef: pair.stage.ref,
				stageBody: stage.value,
				acceptedPrompt: pointer.value.prompt,
				validationPolicyVersion:
					LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.validationPolicyVersions.V4,
				resolvedLedger: stage.value.output,
				ledgerRef,
			};
		});
		const ledgers = admissions.map((a) => a.resolvedLedger),
			fullCorpus = mergeLocalStoryLedgers({
				input: t.input,
				chunks: t.chunks,
				ledgers,
			});
		const h0 = {
			input: t.input,
			chunks: t.chunks,
			ledgers,
			model: p.model,
			transcriptFingerprint: t.prepared.fingerprint,
			ledgerRefs: admissions.map((a) => a.ledgerRef),
		};
		const manifest = buildLocalStoryFlowManifest(h0),
			pages = buildLocalStoryFlowLeafPages(manifest);
		const workflow = p.envelope.identity.localStoryWorkflow;
		requireSource(workflow);
		const source = prepareLocalStoryFlowContextSourceFromPin({
			h0,
			manifest,
			pages,
			workflow,
			pin: { profile: p.model.profile, configId: p.model.configId },
			mode: "FLOW",
		});
		const sourceRecipeHash = hash(LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY),
			taskId = p.snapshots.task.id;
		const body = {
			version: "local-story-flow-source-archive-v1",
			purpose: "SOURCE_ARCHIVE",
			sourceTuple: p.sourceTuple,
			taskPin: p.taskPin,
			taskId,
			taskPayloadHash: p.taskPayloadHash,
			sourceRecipeHash,
			mediaSnapshot: p.snapshots.mediaSnapshot,
			analysisSnapshot: p.snapshots.analysisSnapshot,
			bindingSnapshot: p.snapshots.bindingSnapshot,
			normalizationSnapshot: p.snapshots.normalizationSnapshot,
			transcriptAdmission: t.admission,
			orderedLedgerAdmissions: admissions,
			fullInput: t.input,
			chunks: t.chunks,
			fullCorpus,
			inputHash: hash(t.input),
			corpusHash: hash(fullCorpus),
			manifest,
			pages,
			workflow,
			sourceEvidence: localStoryFlowContextSourceEvidence(source),
		};
		const key: LocalStoryFlowRecordKey = {
			version: "local-story-flow-record-key-v1",
			purpose: "SOURCE_ARCHIVE",
			keyBody: {
				sourceTuple: p.sourceTuple,
				taskId,
				taskPayloadHash: p.taskPayloadHash,
				taskPinHash: p.taskPinHash,
				sourceRecipeHash,
			},
		};
		requireSource(
			Buffer.byteLength(canonicalEditingJson(body)) <=
				LOCAL_STORY_FLOW_SOURCE_ARCHIVE_POLICY.maxJsonBytes,
		);
		const handle = Object.freeze({});
		archives.set(handle, {
			key,
			payload: { ...body, archiveHash: hash(body) },
			source,
			requiredLegacyRefs,
		});
		return handle;
	});
}
export function localStoryFlowSourceArchiveEvidence(
	handle: BoundLocalStoryFlowSourceArchive,
) {
	return checked(() => {
		const a = archives.get(handle);
		requireSource(a);
		return structuredClone({
			key: a.key,
			payload: a.payload,
			requiredLegacyRefs: a.requiredLegacyRefs,
		});
	});
}
export function localStoryFlowSourceArchiveContext(
	handle: BoundLocalStoryFlowSourceArchive,
): PreparedLocalStoryFlowContextSource {
	return checked(() => {
		const a = archives.get(handle);
		requireSource(a);
		return a.source;
	});
}
/** Rebuild all full-source evidence from independent snapshots and sealed rows, then compare. */
export function validateLocalStoryFlowSourceArchive(
	value: unknown,
	options: {
		transcript: AdmittedLocalStoryFlowArchiveTranscript;
		ledgers: readonly LocalStoryFlowArchiveLedgerPair[];
	},
): BoundLocalStoryFlowSourceArchive {
	return checked(() => {
		const actual = copyJson(value),
			rebuilt = buildLocalStoryFlowSourceArchive(options),
			expected = localStoryFlowSourceArchiveEvidence(rebuilt);
		requireSource(
			canonicalEditingJson(actual) === canonicalEditingJson(expected.payload),
		);
		return rebuilt;
	});
}
