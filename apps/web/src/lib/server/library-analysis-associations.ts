import "server-only";
import { createHash } from "node:crypto";
import {
	cfrTimeMapSchema,
	editingAnalysisBindingSchema,
	hashEditingEvidence,
	sceneAnalysisDocumentSchema,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import type { AppTransactionClient } from "@bitovp/db";
import { z } from "zod";
import { requestOrganizationId } from "@/lib/passive-request";
import { getServerContext } from "./context";
import { EditingRequestError, json, mediaView } from "./library-editing-common";

export const associationQuerySchema = z.strictObject({
	mediaVersionId: z.uuid(),
	analysisRevisionId: z.uuid(),
});
const confirmationSchema = associationQuerySchema.extend({
	requestKey: z.uuid(),
	confirmation: z.strictObject({
		time: z.literal(true),
		geometry: z.literal(true),
		content: z.literal(true),
	}),
});

async function fixedTuple(
	db: Pick<
		AppTransactionClient,
		"libraryMediaVersion" | "sceneAnalysisRevision"
	>,
	input: z.infer<typeof associationQuerySchema>,
) {
	const media = await db.libraryMediaVersion.findUnique({
		where: { id: input.mediaVersionId },
	});
	if (media?.state !== "READY" || !media.sha256)
		throw new EditingRequestError(422, "MEDIA_NOT_READY");
	const analysis = await db.sceneAnalysisRevision.findFirst({
		where: { id: input.analysisRevisionId, sourceId: media.sourceId },
	});
	if (!analysis)
		throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
	return { media, analysis, map: cfrTimeMapSchema.parse(media.timeMap) };
}

export async function inspectAnalysisAssociation(value: unknown) {
	const input = associationQuerySchema.parse(value);
	const ctx = await getServerContext();
	const { media, analysis } = await fixedTuple(ctx.prisma, input);
	const records = await ctx.prisma.libraryAnalysisBinding.findMany({
		where: input,
		take: 26,
	});
	let association: string = "UNVERIFIED";
	try {
		association = verifyAutomaticAnalysisBinding({
			organizationId: requestOrganizationId(ctx),
			media,
			analysis,
			bindings: records.map((record) => record.proof),
		}).kind;
	} catch {
		// A review can still show a source whose association has not been recorded.
	}
	return {
		media: mediaView(ctx, media),
		analysis: {
			id: analysis.id,
			locale: analysis.locale,
			providerVersion: analysis.providerVersion,
			createdAt: analysis.createdAt.toISOString(),
			document: sceneAnalysisDocumentSchema.parse(analysis.document),
		},
		association,
	};
}

function associationReceiptId(organizationId: string, requestKey: string) {
	const bytes = createHash("sha256")
		.update(`bitovp:editor-association:v1:${organizationId}:${requestKey}`)
		.digest();
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** This records an operator's association; it does not attest provider input identity. */
export async function confirmAnalysisAssociation(
	value: unknown,
	actor: string | null,
) {
	const input = confirmationSchema.parse(value);
	const ctx = await getServerContext();
	const organizationId = requestOrganizationId(ctx);
	const receiptId = associationReceiptId(organizationId, input.requestKey);
	const intentHash = hashEditingEvidence({
		mediaVersionId: input.mediaVersionId,
		analysisRevisionId: input.analysisRevisionId,
		confirmation: input.confirmation,
	});
	return ctx.prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:association-request:${input.requestKey}`}, 0))`;
		// Serialize all attestations for this source pair, including different keys.
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${input.mediaVersionId}:${input.analysisRevisionId}`}, 0))`;
		const { media, analysis, map } = await fixedTuple(tx, input);
		const priorReceipt = await tx.libraryEvidenceReceipt.findUnique({
			where: { id: receiptId },
		});
		if (
			priorReceipt &&
			(priorReceipt.proof as { intentHash?: string }).intentHash !== intentHash
		)
			throw new EditingRequestError(409, "REQUEST_KEY_REUSED");
		const existing = await tx.libraryAnalysisBinding.findMany({
			where: {
				mediaVersionId: media.id,
				analysisRevisionId: analysis.id,
			},
			take: 26,
		});
		if (existing.length) {
			const binding = verifyAutomaticAnalysisBinding({
				organizationId,
				media,
				analysis,
				bindings: existing.map((record) => record.proof),
			});
			return { bindingKind: binding.kind, confirmed: true, existing: true };
		}
		if (priorReceipt)
			throw new EditingRequestError(409, "ASSOCIATION_WAS_REMOVED");
		const confirmedAt = new Date().toISOString();
		const confirmedBy = actor?.trim() || "local:anonymous";
		const proof = editingAnalysisBindingSchema.parse({
			schemaVersion: 1,
			kind: "EDITOR_ATTESTED",
			organizationId,
			sourceId: media.sourceId,
			locale: analysis.locale,
			analysisRevisionId: analysis.id,
			analysisRawHash: analysis.rawHash,
			analysisDocumentHash: hashEditingEvidence(analysis.document),
			mediaVersionId: media.id,
			mediaSha256: media.sha256,
			timeMapId: map.id,
			timeMapHash: hashEditingEvidence(media.timeMap),
			sourceStartUs: map.sourceStartUs,
			sourceEndUs: map.sourceEndUs,
			width: media.width,
			height: media.height,
			attestation: {
				receiptId,
				actor: confirmedBy,
				confirmedAt,
				scope: ["TIME", "GEOMETRY", "CONTENT"],
			},
		});
		const receipt = { schemaVersion: 1, intentHash, binding: proof };
		await tx.libraryEvidenceReceipt.create({
			data: {
				id: receiptId,
				sourceId: media.sourceId,
				mediaVersionId: media.id,
				analysisRevisionId: analysis.id,
				kind: "EDITOR_ATTESTATION",
				proof: json(receipt),
				proofHash: hashEditingEvidence(receipt),
				createdBy: confirmedBy,
			},
		});
		await tx.libraryAnalysisBinding.create({
			data: {
				mediaVersionId: media.id,
				analysisRevisionId: analysis.id,
				proof: json(proof),
				attestationReceiptId: receiptId,
			},
		});
		return { bindingKind: proof.kind, confirmed: true, existing: false };
	});
}
