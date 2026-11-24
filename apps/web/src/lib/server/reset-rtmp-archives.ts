import { classifyProviderStatusWord } from "@bitovp/core";
import {
	type AppPrismaClient,
	liveChannelAccountId,
	mergeRtmpRetirementEvidence,
	type Prisma,
	readResetRtmpArchives,
	reconcileOrphanLiveStops,
} from "@bitovp/db";
import type { EncoderPointer } from "./reset";
import { lockResetAccount, type ResetAccountSnapshot } from "./reset-provider";

export const INCOMPLETE_RTMP_ARCHIVE_MESSAGE =
	"This broadcast has missing encoder identities in its creation or stop history. Verify the provider account before deleting this broadcast.";

export class IncompleteRtmpArchive extends Error {
	constructor() {
		super(INCOMPLETE_RTMP_ARCHIVE_MESSAGE);
	}
}

export { readResetRtmpArchives } from "@bitovp/db";

/** Append an exact terminal read to the run archive without transferring it to the current pointer. */
export async function confirmArchivedRtmpEncoding(
	prisma: AppPrismaClient,
	pointer: EncoderPointer,
	status: string,
	account?: ResetAccountSnapshot,
) {
	const accountId = pointer.bitmovinAccountId;
	if (
		!accountId ||
		!pointer.liveChannelId ||
		pointer.kind === "encodingJob" ||
		classifyProviderStatusWord(status) !== "TERMINAL"
	)
		return false;
	return prisma.$transaction(async (tx) => {
		if (
			account &&
			(account.id !== accountId || !(await lockResetAccount(tx, account)))
		)
			return false;
		await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${pointer.liveChannelId}::uuid FOR UPDATE`;
		if (pointer.kind === "liveChannel") {
			const channel = await tx.liveChannel.findFirst({
				where: {
					id: pointer.id,
					createdAt: pointer.createdAt,
					status: pointer.status as Prisma.LiveChannelWhereInput["status"],
				},
				select: {
					origin: true,
					stepLog: true,
					runs: {
						orderBy: { seq: "desc" },
						take: 1,
						select: {
							stepLog: true,
							aisaAnalysisId: true,
							aisaStatus: true,
							aisaSnapshot: true,
						},
					},
					plan: true,
					bitmovinAccountId: true,
					resetOrphanEncoderEvidence: true,
				},
			});
			if (!channel || liveChannelAccountId(channel) !== accountId) return false;
			const current = await readResetRtmpArchives(tx, pointer.id);
			if (
				!current.pointers.some(
					(p) =>
						p.kind === "liveChannel" &&
						p.id === pointer.id &&
						p.bitmovinEncodingId === pointer.bitmovinEncodingId &&
						p.bitmovinAccountId === accountId,
				)
			)
				return false;
			const updated = await tx.liveChannel.update({
				select: { resetOrphanEncoderEvidence: true },
				where: { id: pointer.id },
				data: {
					resetOrphanEncoderEvidence: mergeRtmpRetirementEvidence(
						channel.resetOrphanEncoderEvidence,
						[
							{
								accountId,
								encodingId: pointer.bitmovinEncodingId,
								providerStatus: status,
								disposition: "TERMINAL",
								observedAt: new Date().toISOString(),
							},
						],
					),
				},
			});
			await reconcileOrphanLiveStops(
				tx,
				pointer.id,
				{ ...channel, ...updated },
				channel.runs[0],
			);
			return true;
		}
		await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE id = ${pointer.id}::uuid FOR UPDATE`;
		const run = await tx.liveChannelRun.findFirst({
			where: {
				id: pointer.id,
				liveChannelId: pointer.liveChannelId,
				createdAt: pointer.createdAt,
				status: pointer.status as Prisma.LiveChannelRunWhereInput["status"],
			},
			select: {
				rtmpRetirementEvidence: true,
				liveChannel: { select: { bitmovinAccountId: true, plan: true } },
			},
		});
		if (!run || liveChannelAccountId(run.liveChannel) !== accountId)
			return false;
		const archive = await readResetRtmpArchives(tx, pointer.liveChannelId);
		if (
			!archive.pointers.some(
				(candidate) =>
					candidate.id === pointer.id &&
					candidate.bitmovinEncodingId === pointer.bitmovinEncodingId &&
					candidate.bitmovinAccountId === accountId,
			)
		)
			return false;
		await tx.liveChannelRun.update({
			where: { id: pointer.id },
			data: {
				rtmpRetirementEvidence: mergeRtmpRetirementEvidence(
					run.rtmpRetirementEvidence,
					[
						{
							accountId,
							encodingId: pointer.bitmovinEncodingId,
							disposition: "TERMINAL",
							providerStatus: status,
							observedAt: new Date().toISOString(),
						},
					],
				),
			},
		});
		return true;
	});
}
