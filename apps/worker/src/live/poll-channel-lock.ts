import type { AppTransactionClient } from "@bitovp/db";

/** Call after locking the poll's exact run; never wait behind a channel transition. */
export async function tryLockCurrentPollChannel(
	tx: AppTransactionClient,
	channelId: string,
	runId: string,
	encodingId: string,
): Promise<boolean> {
	const channels = await tx.$queryRaw<{ id: string }[]>`
		SELECT id FROM "LiveChannel"
		WHERE id = ${channelId}::uuid
			AND "bitmovinEncodingId" = ${encodingId}
		FOR UPDATE SKIP LOCKED`;
	if (channels.length !== 1) return false;
	const latest = await tx.liveChannelRun.findFirst({
		where: { liveChannelId: channelId },
		orderBy: { seq: "desc" },
		select: { id: true },
	});
	return latest?.id === runId;
}
