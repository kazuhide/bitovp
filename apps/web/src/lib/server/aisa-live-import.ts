import "server-only";
import {
	type AisaLiveImportOutcome,
	persistFinalAisaImport,
	type VerifiedFinalAisaImport,
} from "@bitovp/db";
import { z } from "zod";
import {
	aisaAnalysisSchema,
	aisaResultSchema,
} from "@/lib/aisa-live/contracts";
import { aisaLiveClientForAccount } from "./aisa-live-sdk";
import { actorFrom } from "./audit";
import { bitmovinClientForAccount } from "./bitmovin";
import type { ServerContext } from "./context";

export class AisaImportVerificationError extends Error {
	constructor(
		readonly httpStatusCode: number,
		readonly code: string,
	) {
		super(
			"AISA import requires the exact Analysis, final result and a confirmed FINISHED backing Encoding",
		);
		this.name = "AisaImportVerificationError";
	}
}
const date = z
	.preprocess(
		(value) => (value instanceof Date ? value.toISOString() : value),
		z.iso.datetime({ offset: true }),
	)
	.transform((value) => new Date(value));
const encodingSchema = z
	.object({
		id: z.uuid(),
		type: z.literal("LIVE"),
		startedAt: date,
		finishedAt: date,
	})
	.refine((value) => value.finishedAt >= value.startedAt);
const inputSchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	analysisId: z.uuid(),
});

/** Provider-read-only verification before idempotent local history import. */
export async function importFinalAisaAnalysis(
	ctx: ServerContext,
	input: { bitmovinAccountId: string; analysisId: string },
	req?: Request,
): Promise<AisaLiveImportOutcome> {
	if (!inputSchema.safeParse(input).success)
		throw new AisaImportVerificationError(400, "AISA_IMPORT_INVALID_INPUT");
	let proof: VerifiedFinalAisaImport;
	try {
		const client = await aisaLiveClientForAccount(ctx, input.bitmovinAccountId);
		const api = await bitmovinClientForAccount(
			ctx,
			input.bitmovinAccountId,
			AbortSignal.timeout(20_000),
		);
		if (!client || !api)
			throw new AisaImportVerificationError(
				404,
				"AISA_IMPORT_ACCOUNT_NOT_FOUND",
			);
		const resource = aisaAnalysisSchema.safeParse(
			await client.get(input.analysisId),
		);
		if (!resource.success || resource.data.analysisId !== input.analysisId)
			throw new AisaImportVerificationError(
				502,
				"AISA_IMPORT_IDENTITY_MISMATCH",
			);
		const analysis = resource.data;
		if (analysis.status !== "FINISHED" || !analysis.createdAt)
			throw new AisaImportVerificationError(409, "AISA_IMPORT_NOT_FINAL");
		const [encodingRaw, statusRaw, snapshotRaw] = await Promise.all([
			api.encoding.encodings.get(analysis.encodingId),
			api.encoding.encodings.status(analysis.encodingId),
			client.latest(input.analysisId),
		]);
		const encoding = encodingSchema.safeParse(encodingRaw);
		const snapshot = aisaResultSchema.safeParse(snapshotRaw);
		if (
			!encoding.success ||
			encoding.data.id !== analysis.encodingId ||
			!snapshot.success ||
			snapshot.data.analysisId !== analysis.analysisId ||
			snapshot.data.encodingId !== analysis.encodingId
		)
			throw new AisaImportVerificationError(
				502,
				"AISA_IMPORT_IDENTITY_MISMATCH",
			);
		if (statusRaw.status !== "FINISHED" || !snapshot.data.isFinal)
			throw new AisaImportVerificationError(409, "AISA_IMPORT_NOT_FINAL");
		proof = {
			analysisId: analysis.analysisId,
			encodingId: analysis.encodingId,
			bitmovinAccountId: input.bitmovinAccountId,
			name: analysis.name || `AISA Live ${analysis.analysisId}`,
			createdAt: new Date(analysis.createdAt),
			startedAt: encoding.data.startedAt,
			finishedAt: encoding.data.finishedAt,
			observedAt: new Date(),
			snapshot: snapshot.data,
		};
	} catch (error) {
		if (error instanceof AisaImportVerificationError) throw error;
		throw new AisaImportVerificationError(
			502,
			"AISA_IMPORT_PROVIDER_UNAVAILABLE",
		);
	}
	return persistFinalAisaImport(ctx.prisma, proof, req ? actorFrom(req) : null);
}
