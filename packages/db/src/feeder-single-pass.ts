import { FEEDER_PUBLISHER_CLAIM_HELD_WHERE } from "@bitovp/core";
import type { AppPrismaClient } from "./client";
import type { LiveEffectClaimHandle } from "./live-effect-claim";

export type FeederSinglePassDispatchFence = {
	id: string;
	ownerId: string;
	ownerGeneration: number;
	publisherGeneration: number;
};

/**
 * Commit the single pass's no-replay marker immediately before its process
 * spawn. Hold the channel lock before the effect and feeder locks, as live
 * STOP does when superseding an effect. A lost reply never erases the marker.
 */
export async function claimFeederSinglePassDispatch(
	prisma: AppPrismaClient,
	fence: FeederSinglePassDispatchFence,
	dispatchedAt: Date,
	claim: LiveEffectClaimHandle,
): Promise<boolean> {
	if (!["FEEDER_START", "FEEDER_COMMIT", "FEEDER_SPAWN"].includes(claim.action))
		return false;
	return prisma.$transaction(async (tx) => {
		const [channel] = await tx.$queryRaw<{ id: string }[]>`
			SELECT id FROM "LiveChannel"
			WHERE id = ${claim.liveChannelId}::uuid
				AND status = 'RUNNING'
				AND "bitmovinEncodingId" = ${claim.providerEncodingId}
				AND "liveEffectFenceVersion" = ${claim.generation}
			FOR UPDATE`;
		if (!channel) return false;
		const [held] = await tx.$queryRaw<{ id: string }[]>`
			SELECT c.id FROM "LiveEffectClaim" c
			WHERE c.id = ${claim.id}::uuid AND c.token = ${claim.token}::uuid
				AND c."idempotencyKey" = ${claim.idempotencyKey}
				AND c."liveChannelId" = ${claim.liveChannelId}::uuid
				AND c."liveChannelRunId" = ${claim.liveChannelRunId}::uuid
				AND c."providerEncodingId" = ${claim.providerEncodingId}
				AND c."targetId" = ${fence.id} AND c.action = ${claim.action}
				AND c.generation = ${claim.generation}
				AND c.state = 'DISPATCHING' AND c."expiresAt" > ${dispatchedAt}
				AND c."liveChannelRunId" = (
					SELECT r.id FROM "LiveChannelRun" r
					WHERE r."liveChannelId" = c."liveChannelId"
					ORDER BY r.seq DESC LIMIT 1
				)
				AND EXISTS (
					SELECT 1 FROM "LiveChannelRun" r WHERE r.id = c."liveChannelRunId"
					AND r.status = 'RUNNING' AND r."bitmovinEncodingId" = c."providerEncodingId"
				)
			FOR UPDATE OF c`;
		if (!held) return false;
		const { count } = await tx.feederSession.updateMany({
			where: {
				...fence,
				liveChannelId: claim.liveChannelId,
				liveChannelRunId: claim.liveChannelRunId,
				status: "DOWNLOADING",
				playbackMode: "ONCE",
				playbackDispatchedAt: null,
				...FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
			},
			data: { playbackDispatchedAt: dispatchedAt },
		});
		return count === 1;
	});
}
