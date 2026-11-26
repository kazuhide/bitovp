import { FEEDER_PUBLISHER_CLAIM_HELD_WHERE } from "@bitovp/core";
import type { AppPrismaClient } from "./client";
import type { LiveEffectClaimHandle } from "./live-effect-claim";

export type FeederSinglePassDispatchFence = {
	id: string;
	ownerId: string;
	ownerGeneration: number;
	publisherGeneration: number;
};

export type FeederSinglePassDispatchResult =
	| "DISPATCHED"
	| "REFUSED"
	| "STOPPED";

export async function hasSupersedingFeederStop(
	prisma: Pick<AppPrismaClient, "$queryRaw">,
	fence: Pick<
		LiveEffectClaimHandle,
		"liveChannelId" | "liveChannelRunId" | "providerEncodingId" | "generation"
	>,
): Promise<boolean> {
	const [stop] = await prisma.$queryRaw<{ id: string }[]>`
		SELECT c.id FROM "LiveChannel" c
		JOIN LATERAL (
			SELECT r.id, r.status, r."bitmovinEncodingId" FROM "LiveChannelRun" r
			WHERE r."liveChannelId" = c.id ORDER BY r.seq DESC LIMIT 1
		) current_run ON true
		WHERE c.id = ${fence.liveChannelId}::uuid
			AND c."bitmovinEncodingId" = ${fence.providerEncodingId}
			AND current_run.id = ${fence.liveChannelRunId}::uuid
			AND current_run."bitmovinEncodingId" = c."bitmovinEncodingId"
			AND c."liveEffectFenceVersion" > ${fence.generation}
			AND (
				-- A scheduled STOP advances the channel before its queue claim.
				(c.status = 'STOPPING' AND current_run.status IN ('RUNNING', 'STOPPING'))
				OR EXISTS (
					SELECT 1 FROM "LiveEffectClaim" stop
					WHERE stop."liveChannelId" = c.id
						AND stop."liveChannelRunId" = current_run.id
						AND stop."providerEncodingId" = c."bitmovinEncodingId"
						AND stop.action = 'STOP' AND stop.generation = c."liveEffectFenceVersion"
						AND stop.state IN ('DISPATCHING', 'ACKED', 'AMBIGUOUS', 'RESOLVED', 'FAILED')
				)
			)`;
	return Boolean(stop);
}

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
): Promise<FeederSinglePassDispatchResult> {
	if (!["FEEDER_START", "FEEDER_COMMIT", "FEEDER_SPAWN"].includes(claim.action))
		return "REFUSED";
	return prisma.$transaction(async (tx) => {
		const [channel] = await tx.$queryRaw<{ id: string }[]>`
			SELECT id FROM "LiveChannel"
			WHERE id = ${claim.liveChannelId}::uuid
				AND status = 'RUNNING'
				AND "bitmovinEncodingId" = ${claim.providerEncodingId}
				AND "liveEffectFenceVersion" = ${claim.generation}
			FOR UPDATE`;
		if (!channel) {
			// A new statement can see the STOP admission that won the channel
			// lock after the preceding SELECT took its snapshot.
			return (await hasSupersedingFeederStop(tx, claim))
				? "STOPPED"
				: "REFUSED";
		}
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
		if (!held) return "REFUSED";
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
		return count === 1 ? "DISPATCHED" : "REFUSED";
	});
}
