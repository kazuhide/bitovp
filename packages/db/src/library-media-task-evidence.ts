import type { EditingAnalysisBinding } from "@bitovp/core";
import type { LibraryMediaTask, Prisma } from "../generated/client";
import type { AppTransactionClient } from "./client";
import {
	acceptLibraryMediaTaskEvidenceAnalysis,
	acceptLibraryMediaTaskEvidenceBindings,
	acceptLibraryMediaTaskEvidenceMedia,
	finishLibraryMediaTaskEvidenceRows,
	type LibraryMediaTaskEvidence,
	prepareLibraryMediaTaskEvidenceRows,
	rethrowLibraryMediaTaskNormalizationError,
} from "./library-media-task-evidence-rows";
import { getPreparedNormalizationReceipt } from "./library-normalization-clock";

export type { LibraryMediaTaskEvidence } from "./library-media-task-evidence-rows";
export { LibraryMediaTaskEvidenceError } from "./library-media-task-evidence-rows";

type BindingRows = Array<{ proof: Prisma.JsonValue }>;
type BindingReader = (
	tx: AppTransactionClient,
	organizationId: string,
	mediaVersionId: string,
	analysisRevisionId: string,
) => Promise<BindingRows>;

const lockedBindings: BindingReader = (
	tx,
	organizationId,
	mediaVersionId,
	analysisRevisionId,
) => tx.$queryRaw<BindingRows>`
		SELECT "proof" FROM "LibraryAnalysisBinding"
		WHERE "organizationId" = ${organizationId}::uuid AND "mediaVersionId" = ${mediaVersionId}::uuid AND "analysisRevisionId" = ${analysisRevisionId}::uuid
		FOR KEY SHARE`;
const readOnlyBindings: BindingReader = (
	tx,
	organizationId,
	mediaVersionId,
	analysisRevisionId,
) => tx.$queryRaw<BindingRows>`
		SELECT "proof" FROM "LibraryAnalysisBinding"
		WHERE "organizationId" = ${organizationId}::uuid AND "mediaVersionId" = ${mediaVersionId}::uuid AND "analysisRevisionId" = ${analysisRevisionId}::uuid`;

async function verifyEvidence(
	tx: AppTransactionClient,
	task: LibraryMediaTask,
	readBindings: BindingReader,
	expectedBinding?: EditingAnalysisBinding,
): Promise<LibraryMediaTaskEvidence> {
	const prepared = prepareLibraryMediaTaskEvidenceRows(task);
	const media = await tx.libraryMediaVersion.findUnique({
		where: { id: task.mediaVersionId },
	});
	const accepted = acceptLibraryMediaTaskEvidenceMedia(prepared, media);
	if (accepted.kind === "TRANSCRIBE") return accepted.evidence;
	const state = accepted.state;
	const analysis = await tx.sceneAnalysisRevision.findUnique({
		where: { id: state.envelope.input.analysisRevisionId },
	});
	const checkedAnalysis = acceptLibraryMediaTaskEvidenceAnalysis(
		state,
		analysis,
	);
	const records = await readBindings(
		tx,
		task.organizationId,
		state.media.id,
		checkedAnalysis.analysis.id,
	);
	const checked = acceptLibraryMediaTaskEvidenceBindings(
		checkedAnalysis,
		records,
		expectedBinding,
	);
	let preparedNormalization: Awaited<
		ReturnType<typeof getPreparedNormalizationReceipt>
	>;
	if (
		state.envelope.input.kind === "GENERATE" &&
		state.envelope.identity.preparedShotClock
	) {
		try {
			preparedNormalization = await getPreparedNormalizationReceipt({
				prisma: tx,
				organizationId: task.organizationId,
				media: state.media,
			});
		} catch (error) {
			rethrowLibraryMediaTaskNormalizationError(error);
		}
	}
	return finishLibraryMediaTaskEvidenceRows(checked, preparedNormalization);
}

/** Worker compatibility path: retain the original binding FOR KEY SHARE and validation order. */
export function verifyLibraryMediaTaskEvidence(
	tx: AppTransactionClient,
	task: LibraryMediaTask,
	expectedBinding?: EditingAnalysisBinding,
): Promise<LibraryMediaTaskEvidence> {
	return verifyEvidence(tx, task, lockedBindings, expectedBinding);
}

/** SELECT-only source projection. Tenant authorization and READ ONLY/RR transaction ownership remain caller responsibilities. */
export function getLibraryMediaTaskEvidenceReadOnly(
	tx: AppTransactionClient,
	task: LibraryMediaTask,
	expectedBinding?: EditingAnalysisBinding,
): Promise<LibraryMediaTaskEvidence> {
	return verifyEvidence(tx, task, readOnlyBindings, expectedBinding);
}
