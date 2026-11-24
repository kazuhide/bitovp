import { deriveProviderLifecycle } from "@bitovp/core";
import type { AppTransactionClient } from "./client";
import {
	liveChannelAccountId,
	liveStopFeederWhere,
	pendingAiringRetirement,
	readAiringEffectHistory,
	unresolvedOrphanLiveClaimTargets,
} from "./live-effect-claim";

/** All archive writers take the channel lock before changing the current run. */
export async function readLockedLiveStartState(
	tx: AppTransactionClient,
	liveChannelId: string,
) {
	const [channel] = await tx.$queryRaw<
		{
			resetOrphanEncoderEvidence: unknown;
			status: string;
			error: string | null;
			stepLog: unknown;
			plan: unknown;
			bitmovinAccountId: string | null;
			bitmovinEncodingId: string | null;
		}[]
	>`SELECT "stepLog", plan, status, error, "bitmovinAccountId", "bitmovinEncodingId", "resetOrphanEncoderEvidence" FROM "LiveChannel" WHERE id = ${liveChannelId}::uuid FOR UPDATE`;
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
	// Historical rows can have only the channel's primary pointer. The caller
	// still applies its normal lifecycle checks for that primary; every other
	// identity found in either log or the exact airing's journal needs a receipt.
	const pending = pendingAiringRetirement(
		{
			...(latest ?? { stepLog: [] }),
			bitmovinEncodingId:
				latest?.bitmovinEncodingId ?? channel.bitmovinEncodingId,
		},
		channel,
		latest ? await readAiringEffectHistory(tx, liveChannelId, latest.id) : [],
		accountId,
	);
	let archivesRetired = pending?.length === 0;
	if (archivesRetired) {
		// Read after the channel lock was acquired. Old claims have no run FK;
		// their surviving identity can be on a channel with no runs at all.
		const orphanClaims = await tx.$queryRaw<
			(Parameters<typeof unresolvedOrphanLiveClaimTargets>[0][number] & {
				liveChannelRunId: string;
			})[]
		>`
			SELECT c."liveChannelRunId", c.action, c."providerEncodingId", c.failure, c."stopProtocolVersion", c."stopOutcomeEvidence", c."stopSendEncodingIds", c."legacyUnsentStopIds"
			FROM "LiveEffectClaim" c WHERE c."liveChannelId" = ${liveChannelId}::uuid
			AND NOT EXISTS (SELECT 1 FROM "LiveChannelRun" r WHERE r.id = c."liveChannelRunId" AND r."liveChannelId" = c."liveChannelId")
		`;
		const byRun = new Map<string, typeof orphanClaims>();
		for (const claim of orphanClaims) {
			const sameRun = byRun.get(claim.liveChannelRunId);
			if (sameRun) sameRun.push(claim);
			else byRun.set(claim.liveChannelRunId, [claim]);
		}
		archivesRetired = [...byRun.values()].every(
			(history) =>
				unresolvedOrphanLiveClaimTargets(
					history,
					channel.resetOrphanEncoderEvidence,
					accountId,
				)?.length === 0,
		);
	}
	// Rows completed by an older worker can still have a publisher. Do not
	// transfer its ingest coordinates to the next airing before it drains.
	if (
		archivesRetired &&
		(channel.status === "STOPPED" ||
			(channel.status === "ERROR" &&
				(latest?.status === "STOPPED" ||
					deriveProviderLifecycle(latest, Date.now()) === "TERMINAL")))
	) {
		archivesRetired = !(await tx.feederSession.findFirst({
			where: liveStopFeederWhere(liveChannelId),
			select: { id: true },
		}));
	}
	// The channel log mirrors only its latest run. Older unretired rentals must
	// retain their own evidence, including legacy gaps recorded only in the step log.
	let before = latest?.seq ?? 0;
	while (archivesRetired && before > 1) {
		const prior = await tx.liveChannelRun.findMany({
			where: { liveChannelId, seq: { lt: before } },
			orderBy: { seq: "desc" },
			take: 32,
			select: {
				id: true,
				bitmovinEncodingId: true,
				seq: true,
				stepLog: true,
				previousProviderEncodingIds: true,
				archivedRtmpAttempt: true,
				rtmpRetirementEvidence: true,
			},
		});
		const history = await tx.liveEffectClaim.findMany({
			where: {
				liveChannelId,
				liveChannelRunId: { in: prior.map((r) => r.id) },
			},
		});
		archivesRetired = prior.every(
			(run) =>
				pendingAiringRetirement(
					run,
					{ stepLog: [] },
					history.filter((c) => c.liveChannelRunId === run.id),
					accountId,
				)?.length === 0,
		);
		if (prior.length < 32) break;
		before = prior.at(-1)?.seq ?? 0;
	}
	return { channel, latest, archivesRetired };
}
