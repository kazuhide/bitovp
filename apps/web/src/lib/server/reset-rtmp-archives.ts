import { classifyProviderStatusWord } from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	mergeRtmpRetirementEvidence,
	type Prisma,
	unconfirmedRtmpEncoders,
} from "@bitovp/db";
import type { EncoderPointer } from "./reset";

export class IncompleteRtmpArchive extends Error {
	constructor() {
		super(
			"An earlier RTMP rebuild has missing encoder identities. Verify the provider account before deleting this broadcast.",
		);
	}
}

const rtmpLog = { array_contains: [{ kind: "CREATE_INPUT_RTMP" }] };

/** The channel log belongs to the latest airing. Older airings use their own log. */
export async function readResetRtmpArchives(
	prisma: AppPrismaClient | AppTransactionClient,
	channelId?: string,
) {
	const rows = await prisma.liveChannelRun.findMany({
		where: {
			...(channelId ? { liveChannelId: channelId } : {}),
			OR: [
				{ previousProviderEncodingIds: { isEmpty: false } },
				{ stepLog: rtmpLog },
				{ liveChannel: { stepLog: rtmpLog } },
			],
		},
		select: {
			id: true,
			createdAt: true,
			status: true,
			stepLog: true,
			liveChannelId: true,
			bitmovinEncodingId: true,
			archivedRtmpAttempt: true,
			previousProviderEncodingIds: true,
			rtmpRetirementEvidence: true,
			liveChannel: {
				select: {
					id: true,
					name: true,
					status: true,
					createdAt: true,
					stepLog: true,
					bitmovinAccountId: true,
					runs: { orderBy: { seq: "desc" }, take: 1, select: { id: true } },
				},
			},
		},
	});
	const pointers: EncoderPointer[] = [];
	const incomplete = new Map<
		string,
		{ id: string; name: string; status: string }
	>();
	for (const row of rows) {
		const channel = row.liveChannel;
		const open = unconfirmedRtmpEncoders(
			row,
			channel.runs[0]?.id === row.id ? channel : { stepLog: [] },
			channel.bitmovinAccountId,
		);
		if (open === null)
			incomplete.set(channel.id, {
				id: channel.id,
				name: channel.name,
				status: channel.status,
			});
		// A gap can hide another identity. Keep each recorded identity actionable as well.
		for (const encodingId of new Set(
			open ??
				unconfirmedRtmpEncoders(
					{ ...row, stepLog: [] },
					{ stepLog: [] },
					channel.bitmovinAccountId,
				) ??
				[],
		)) {
			pointers.push({
				kind: "liveChannelRun",
				archivedRtmp: true,
				id: row.id,
				liveChannelId: channel.id,
				liveChannelCreatedAt: channel.createdAt,
				createdAt: row.createdAt,
				name: channel.name,
				status: row.status,
				bitmovinEncodingId: encodingId,
				bitmovinAccountId: channel.bitmovinAccountId,
			});
		}
	}
	return { pointers, incomplete: [...incomplete.values()] };
}

/** Append an exact terminal read to the run archive without transferring it to the current pointer. */
export async function confirmArchivedRtmpEncoding(
	prisma: AppPrismaClient,
	pointer: EncoderPointer,
	status: string,
) {
	const accountId = pointer.bitmovinAccountId;
	if (
		!accountId ||
		!pointer.liveChannelId ||
		classifyProviderStatusWord(status) !== "TERMINAL"
	)
		return false;
	return prisma.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${pointer.liveChannelId}::uuid FOR UPDATE`;
		await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE id = ${pointer.id}::uuid FOR UPDATE`;
		const run = await tx.liveChannelRun.findFirst({
			where: {
				id: pointer.id,
				liveChannelId: pointer.liveChannelId,
				createdAt: pointer.createdAt,
				status: pointer.status as Prisma.LiveChannelRunWhereInput["status"],
				previousProviderEncodingIds: { has: pointer.bitmovinEncodingId },
				liveChannel: { bitmovinAccountId: accountId },
			},
			select: { rtmpRetirementEvidence: true },
		});
		if (!run) return false;
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
