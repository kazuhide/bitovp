import {
	AutomaticBindingError,
	type CfrTimeMap,
	cfrTimeMapSchema,
	type EditingAnalysisBinding,
	hashEditingEvidence,
	type MediaTaskEnvelope,
	mediaTaskCacheKey,
	mediaTaskEnvelopeSchema,
	mediaTaskIntentHash,
	type SceneAnalysisDocument,
	sceneAnalysisDocumentSchema,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import type {
	LibraryMediaTask,
	LibraryMediaVersion,
	Prisma,
	SceneAnalysisRevision,
} from "../generated/client";
import {
	LibraryNormalizationClockError,
	prepareLibraryNormalizationClockRead,
	verifyLibraryNormalizationClockRows,
} from "./library-normalization-clock";

export class LibraryMediaTaskEvidenceError extends Error {
	constructor(
		readonly code:
			| "TASK_INTENT_INVALID"
			| "MEDIA_NOT_READY"
			| "SOURCE_CHANGED"
			| "NORMALIZATION_EVIDENCE_UNVERIFIED",
	) {
		super(code);
		this.name = "LibraryMediaTaskEvidenceError";
	}
}

// Calculation DTOs only. Authorization and actual row provenance stay with IO callers.
export type PreparedLibraryMediaTaskEvidenceRows = {
	task: LibraryMediaTask;
	envelope: MediaTaskEnvelope;
};
type PreparedNormalization = ReturnType<
	typeof verifyLibraryNormalizationClockRows
>;
export type LibraryMediaTaskEvidence = {
	envelope: MediaTaskEnvelope;
	media: LibraryMediaVersion;
	map: CfrTimeMap;
} & (
	| {
			analysisDocument: undefined;
			binding: undefined;
			preparedNormalization: undefined;
	  }
	| {
			analysisDocument: SceneAnalysisDocument;
			binding: EditingAnalysisBinding;
			preparedNormalization: PreparedNormalization;
	  }
);
type AnalysisEnvelope = MediaTaskEnvelope & {
	input: Exclude<MediaTaskEnvelope["input"], { kind: "TRANSCRIBE" }>;
};
export type CheckedLibraryMediaTaskMedia =
	PreparedLibraryMediaTaskEvidenceRows & {
		envelope: AnalysisEnvelope;
		media: LibraryMediaVersion;
		map: CfrTimeMap;
	};
export type CheckedLibraryMediaTaskAnalysis = CheckedLibraryMediaTaskMedia & {
	analysis: SceneAnalysisRevision;
};
export type CheckedLibraryMediaTaskBindings =
	CheckedLibraryMediaTaskAnalysis & {
		binding: EditingAnalysisBinding;
	};

export function prepareLibraryMediaTaskEvidenceRows(
	task: LibraryMediaTask,
): PreparedLibraryMediaTaskEvidenceRows {
	const envelope = mediaTaskEnvelopeSchema.parse(task.parameters),
		input = envelope.input,
		identity = envelope.identity;
	if (
		identity.organizationId !== task.organizationId ||
		input.kind !== task.kind ||
		input.mediaVersionId !== task.mediaVersionId ||
		input.requestKey !== task.requestKey ||
		mediaTaskIntentHash(input, task.parentTaskId) !== task.requestHash ||
		mediaTaskCacheKey(input, identity) !== task.cacheKey ||
		(input.kind !== "TRANSCRIBE" &&
			input.analysisRevisionId !== task.analysisRevisionId)
	)
		throw new LibraryMediaTaskEvidenceError("TASK_INTENT_INVALID");
	return { task, envelope };
}

export function acceptLibraryMediaTaskEvidenceMedia(
	prepared: PreparedLibraryMediaTaskEvidenceRows,
	media: LibraryMediaVersion | null,
):
	| { kind: "TRANSCRIBE"; evidence: LibraryMediaTaskEvidence }
	| { kind: "ANALYSIS_REQUIRED"; state: CheckedLibraryMediaTaskMedia } {
	const { task, envelope } = prepared,
		{ input, identity } = envelope;
	if (
		!media ||
		media.organizationId !== task.organizationId ||
		media.state !== "READY" ||
		!media.sha256
	)
		throw new LibraryMediaTaskEvidenceError("MEDIA_NOT_READY");
	const map = cfrTimeMapSchema.parse(media.timeMap);
	if (
		map.mediaVersionId !== media.id ||
		(identity.mediaSha256 && media.sha256 !== identity.mediaSha256) ||
		(identity.timeMapHash &&
			hashEditingEvidence(media.timeMap) !== identity.timeMapHash)
	)
		throw new LibraryMediaTaskEvidenceError("SOURCE_CHANGED");
	if (input.kind === "TRANSCRIBE")
		return {
			kind: "TRANSCRIBE",
			evidence: {
				envelope,
				media,
				map,
				analysisDocument: undefined,
				binding: undefined,
				preparedNormalization: undefined,
			},
		};
	return {
		kind: "ANALYSIS_REQUIRED",
		state: {
			task,
			envelope: envelope as AnalysisEnvelope,
			media,
			map,
		},
	};
}

export function acceptLibraryMediaTaskEvidenceAnalysis(
	state: CheckedLibraryMediaTaskMedia,
	analysis: SceneAnalysisRevision | null,
): CheckedLibraryMediaTaskAnalysis {
	const {
		task,
		envelope: { identity },
		media,
	} = state;
	if (
		!analysis ||
		analysis.organizationId !== task.organizationId ||
		analysis.sourceId !== media.sourceId ||
		hashEditingEvidence(analysis.document) !== identity.analysisDocumentHash ||
		analysis.rawHash !== identity.analysisRawHash
	)
		throw new AutomaticBindingError();
	return { ...state, analysis };
}

export function acceptLibraryMediaTaskEvidenceBindings(
	state: CheckedLibraryMediaTaskAnalysis,
	records: readonly { proof: Prisma.JsonValue }[],
	expectedBinding?: EditingAnalysisBinding,
): CheckedLibraryMediaTaskBindings {
	const {
		task,
		envelope: { identity },
		media,
		analysis,
	} = state;
	const binding = verifyAutomaticAnalysisBinding({
		organizationId: task.organizationId,
		media,
		analysis,
		bindings: records.map((row) => row.proof),
		binding: expectedBinding ?? identity.bindingSnapshot,
	});
	if (
		identity.bindingHash &&
		hashEditingEvidence(binding) !== identity.bindingHash
	)
		throw new AutomaticBindingError();
	return { ...state, binding };
}

export function finishLibraryMediaTaskEvidenceRows(
	state: CheckedLibraryMediaTaskBindings,
	preparedNormalization: PreparedNormalization,
): LibraryMediaTaskEvidence {
	const { envelope, media, map, analysis, binding } = state,
		{ input, identity } = envelope;
	if (
		input.kind === "GENERATE" &&
		identity.preparedShotClock &&
		(!preparedNormalization ||
			preparedNormalization.proofHash !==
				identity.preparedShotClock.normalizationReceiptHash)
	)
		throw new LibraryMediaTaskEvidenceError(
			"NORMALIZATION_EVIDENCE_UNVERIFIED",
		);
	return {
		envelope,
		media,
		map,
		analysisDocument: sceneAnalysisDocumentSchema.parse(analysis.document),
		binding,
		preparedNormalization,
	};
}

export type LibraryMediaTaskEvidenceRowBundle = {
	task: LibraryMediaTask;
	media: LibraryMediaVersion | null;
	analysis?: SceneAnalysisRevision | null;
	bindings?: readonly { proof: Prisma.JsonValue }[];
	normalization:
		| { queried: false }
		| {
				queried: true;
				rows: Parameters<typeof verifyLibraryNormalizationClockRows>[1];
		  };
};

export function rethrowLibraryMediaTaskNormalizationError(
	error: unknown,
): never {
	if (error instanceof LibraryNormalizationClockError)
		throw new LibraryMediaTaskEvidenceError(error.code);
	throw error;
}

/** Row facts only. This does not attest a tenant transaction, ownership or DB provenance. */
export function validateLibraryMediaTaskEvidenceRowBundle(
	bundle: LibraryMediaTaskEvidenceRowBundle,
	expectedBinding?: EditingAnalysisBinding,
): LibraryMediaTaskEvidence {
	const prepared = prepareLibraryMediaTaskEvidenceRows(bundle.task),
		media = acceptLibraryMediaTaskEvidenceMedia(prepared, bundle.media);
	if (media.kind === "TRANSCRIBE") return media.evidence;
	if (bundle.analysis === undefined) throw new AutomaticBindingError();
	const analysis = acceptLibraryMediaTaskEvidenceAnalysis(
		media.state,
		bundle.analysis,
	);
	if (bundle.bindings === undefined) throw new AutomaticBindingError();
	const state = acceptLibraryMediaTaskEvidenceBindings(
			analysis,
			bundle.bindings,
			expectedBinding,
		),
		{ input, identity } = state.envelope;
	let normalized: PreparedNormalization;
	if (input.kind === "GENERATE" && identity.preparedShotClock) {
		try {
			const clock = prepareLibraryNormalizationClockRead({
				organizationId: state.task.organizationId,
				media: state.media,
			});
			if (bundle.normalization.queried)
				normalized = verifyLibraryNormalizationClockRows(
					clock,
					bundle.normalization.rows,
				);
		} catch (error) {
			rethrowLibraryMediaTaskNormalizationError(error);
		}
	}
	return finishLibraryMediaTaskEvidenceRows(state, normalized);
}
