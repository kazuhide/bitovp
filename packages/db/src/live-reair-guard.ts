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
	const pending = unconfirmedRtmpEncoders(
		latest ?? { stepLog: [] },
		channel,
		liveChannelAccountId(channel),
	);
	return { channel, latest, archivesRetired: pending?.length === 0 };
}
