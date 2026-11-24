import type { AppTransactionClient } from "./client";
import {
	liveChannelAccountId,
	unconfirmedRtmpEncoders,
} from "./live-effect-claim";

/** All archive writers take the channel lock before changing the current run. */
export async function readLockedLiveStartState(
	tx: AppTransactionClient,
	liveChannelId: string,
) {
	const [channel] = await tx.$queryRaw<
		{
			status: string;
			error: string | null;
			stepLog: unknown;
			plan: unknown;
			bitmovinAccountId: string | null;
		}[]
	>`SELECT "stepLog", plan, status, error, "bitmovinAccountId" FROM "LiveChannel" WHERE id = ${liveChannelId}::uuid FOR UPDATE`;
	if (!channel) return { channel: null, latest: null, archivesRetired: false };
	const latest = await tx.liveChannelRun.findFirst({
		where: { liveChannelId },
		orderBy: { seq: "desc" },
		select: {
			id: true,
			seq: true,
			status: true,
			cancelRequested: true,
			aisaAnalysisId: true,
			aisaStatus: true,
			aisaSnapshot: true,
			aisaFinalization: true,
			bitmovinEncodingId: true,
			stepLog: true,
			encoderStoppedConfirmedFor: true,
			providerStatus: true,
			providerStatusObservedAt: true,
			providerUnknownSince: true,
			providerTerminalAt: true,
			previousProviderEncodingIds: true,
			archivedRtmpAttempt: true,
			rtmpRetirementEvidence: true,
		},
	});
	const accountId = liveChannelAccountId(channel);
	const pending = unconfirmedRtmpEncoders(
		latest ?? { stepLog: [] },
		channel,
		accountId,
	);
	let archivesRetired = pending?.length === 0;
	// The channel log mirrors only its latest run. Older unretired rentals must
	// retain their own evidence, including legacy gaps recorded only in the step log.
	let before = latest?.seq ?? 0;
	while (archivesRetired && before > 1) {
		const prior = await tx.liveChannelRun.findMany({
			where: { liveChannelId, seq: { lt: before } },
			orderBy: { seq: "desc" },
			take: 32,
			select: {
				seq: true,
				stepLog: true,
				previousProviderEncodingIds: true,
				archivedRtmpAttempt: true,
				rtmpRetirementEvidence: true,
			},
		});
		archivesRetired = prior.every(
			(run) =>
				unconfirmedRtmpEncoders(run, { stepLog: [] }, accountId)?.length === 0,
		);
		if (prior.length < 32) break;
		before = prior.at(-1)?.seq ?? 0;
	}
	return { channel, latest, archivesRetired };
}
