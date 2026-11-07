import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/client";
import type { AppPrismaClient } from "./client";

/** Produced only after independent account, Analysis, Encoding and final-result reads. */
export type VerifiedFinalAisaImport = {
	analysisId: string;
	encodingId: string;
	bitmovinAccountId: string;
	name: string;
	createdAt: Date;
	startedAt: Date;
	finishedAt: Date;
	observedAt: Date;
	snapshot: Prisma.InputJsonObject;
};
export class AisaLiveImportConflict extends Error {
	constructor() {
		super(
			"This Analysis or Encoding is already associated with another Live run",
		);
		this.name = "AisaLiveImportConflict";
	}
}
export type AisaLiveImportOutcome = {
	channelId: string;
	runId: string;
	imported: boolean;
};

/** No provider writes, queues or invented normal graph; one transaction binds a real final run. */
export async function persistFinalAisaImport(
	prisma: AppPrismaClient,
	proof: VerifiedFinalAisaImport,
	actor?: string | null,
): Promise<AisaLiveImportOutcome> {
	if (
		proof.snapshot.analysisId !== proof.analysisId ||
		proof.snapshot.encodingId !== proof.encodingId ||
		proof.snapshot.isFinal !== true
	) {
		throw new Error(
			"Final AISA import proof has inconsistent identities or finality",
		);
	}
	const where = {
		OR: [
			{ aisaAnalysisId: proof.analysisId },
			{ bitmovinEncodingId: proof.encodingId },
		],
	};
	const select = {
		id: true,
		liveChannelId: true,
		bitmovinEncodingId: true,
		aisaAnalysisId: true,
		liveChannel: { select: { bitmovinAccountId: true, origin: true } },
	} as const;
	type Existing = NonNullable<Awaited<ReturnType<typeof findExisting>>>;
	const existingOutcome = (run: Existing): AisaLiveImportOutcome => {
		if (
			run.aisaAnalysisId !== proof.analysisId ||
			run.bitmovinEncodingId !== proof.encodingId ||
			run.liveChannel.bitmovinAccountId !== proof.bitmovinAccountId ||
			run.liveChannel.origin !== "AISA_IMPORTED"
		)
			throw new AisaLiveImportConflict();
		return { channelId: run.liveChannelId, runId: run.id, imported: false };
	};
	const findExisting = () => prisma.liveChannelRun.findFirst({ where, select });
	try {
		return await prisma.$transaction(async (tx) => {
			const existing = await tx.liveChannelRun.findFirst({ where, select });
			if (existing) return existingOutcome(existing);
			const channelId = randomUUID();
			const runId = randomUUID();
			await tx.liveChannel.create({
				data: {
					id: channelId,
					name: proof.name,
					origin: "AISA_IMPORTED",
					status: "STOPPED",
					createdBy: actor ?? null,
					bitmovinAccountId: proof.bitmovinAccountId,
					bitmovinEncodingId: proof.encodingId,
					encoderStoppedConfirmedFor: proof.encodingId,
					plan: {
						planVersion: "aisa-live-import-v1",
						source: "AISA_LIVE",
						readOnly: true,
						analysisId: proof.analysisId,
						encodingId: proof.encodingId,
						bitmovin: { accountId: proof.bitmovinAccountId },
					},
					stepLog: [],
					createdAt: proof.createdAt,
				},
			});
			await tx.liveChannelRun.create({
				data: {
					id: runId,
					liveChannelId: channelId,
					seq: 1,
					status: "STOPPED",
					outputPrefix: "",
					stepLog: [],
					bitmovinEncodingId: proof.encodingId,
					encoderStoppedConfirmedFor: proof.encodingId,
					aisaAnalysisId: proof.analysisId,
					aisaStatus: "FINISHED",
					aisaSnapshot: proof.snapshot,
					aisaObservedAt: proof.observedAt,
					providerStatus: "FINISHED",
					providerStatusObservedAt: proof.observedAt,
					providerTerminalAt: proof.observedAt,
					providerFeederStopsEnqueuedAt: proof.observedAt,
					runningSince: proof.startedAt,
					endedAt: proof.finishedAt,
					createdAt: proof.createdAt,
				},
			});
			return { channelId, runId, imported: true };
		});
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "P2002"
		) {
			const existing = await findExisting();
			if (existing) return existingOutcome(existing);
			throw new AisaLiveImportConflict();
		}
		throw error;
	}
}
