import {
	type NormalizationCaptureReceipt,
	verifyPreparedNormalizationReceipt,
} from "@bitovp/core";
import type {
	LibraryEvidenceReceipt,
	LibraryMediaVersion,
} from "../generated/client";
import type { AppTransactionClient } from "./client";

export class LibraryNormalizationClockError extends Error {
	readonly code = "NORMALIZATION_EVIDENCE_UNVERIFIED";
	constructor() {
		super("NORMALIZATION_EVIDENCE_UNVERIFIED");
		this.name = "LibraryNormalizationClockError";
	}
}

type Media = Pick<
	LibraryMediaVersion,
	| "id"
	| "organizationId"
	| "sourceId"
	| "sha256"
	| "width"
	| "height"
	| "timeMap"
>;

type NormalizationCaptureRow = Pick<
	LibraryEvidenceReceipt,
	| "organizationId"
	| "mediaVersionId"
	| "sourceId"
	| "kind"
	| "analysisRevisionId"
	| "proof"
	| "proofHash"
>;
type PreparedLibraryNormalizationClockRead = {
	readonly organizationId: string;
	readonly media: Media;
};

/** Internal calculation only; tenant authorization and row provenance stay with IO callers. */
export function prepareLibraryNormalizationClockRead(input: {
	organizationId: string;
	media: Media;
}): PreparedLibraryNormalizationClockRead {
	const { media, organizationId } = input;
	if (media.organizationId !== organizationId)
		throw new LibraryNormalizationClockError();
	return { media, organizationId };
}

/** Shared full-row validator. An empty, actually queried result keeps the old clock. */
export function verifyLibraryNormalizationClockRows(
	prepared: PreparedLibraryNormalizationClockRead,
	rows: readonly NormalizationCaptureRow[],
): { proof: NormalizationCaptureReceipt; proofHash: string } | undefined {
	const { media, organizationId } = prepared;
	if (!rows.length) return undefined;
	const row = rows[0];
	if (
		rows.length !== 1 ||
		!row ||
		row.organizationId !== organizationId ||
		row.mediaVersionId !== media.id ||
		row.sourceId !== media.sourceId ||
		row.kind !== "NORMALIZATION_CAPTURE" ||
		row.analysisRevisionId !== null ||
		!media.sha256 ||
		media.width === null ||
		media.height === null
	)
		throw new LibraryNormalizationClockError();
	try {
		const proof = verifyPreparedNormalizationReceipt({
			proof: row.proof,
			proofHash: row.proofHash,
			organizationId,
			sourceId: media.sourceId,
			mediaVersionId: media.id,
			preparedSha256: media.sha256,
			timeMap: media.timeMap,
			width: media.width,
			height: media.height,
		});
		return { proof, proofHash: row.proofHash };
	} catch {
		throw new LibraryNormalizationClockError();
	}
}

/** Absence keeps the old conservative clock; a present invalid witness never does. */
export async function getPreparedNormalizationReceipt(input: {
	prisma: AppTransactionClient;
	organizationId: string;
	media: Media;
}): Promise<
	{ proof: NormalizationCaptureReceipt; proofHash: string } | undefined
> {
	const prepared = prepareLibraryNormalizationClockRead(input);
	const { media, organizationId } = prepared;
	const rows = await input.prisma.libraryEvidenceReceipt.findMany({
		where: {
			organizationId,
			mediaVersionId: media.id,
			kind: "NORMALIZATION_CAPTURE",
		},
		take: 2,
	});
	return verifyLibraryNormalizationClockRows(prepared, rows);
}
