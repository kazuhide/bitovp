import type { LiveEffectIntent } from "@bitovp/core";
import {
	type AppPrismaClient,
	bindArchivedStopTarget,
	liveStopRunOwnsEncoding,
} from "@bitovp/db";

/** A retained bare queue job only gains authority from its specific, preclaimed airing. */
export async function readLegacyScheduledStop(
	prisma: AppPrismaClient,
	scheduleId: string,
	liveChannelId: string,
	expectedRunId?: string | null,
) {
	const receipt = await prisma.liveSchedule.findFirst({
		where: {
			id: scheduleId,
			liveChannelId,
			action: "STOP",
			status: "FIRED",
			outcome: { in: ["PENDING", "FAILED"] },
			OR: [{ dispatchJobId: null }, { dispatchJobId: `sched-${scheduleId}` }],
		},
		select: {
			outcome: true,
			outcomeEvidenceKind: true,
			stopAdmissionFenceVersion: true,
			stopProviderEncodingId: true,
			liveChannelRunId: true,
			liveChannel: {
				select: {
					status: true,
					liveEffectFenceVersion: true,
					legacyAdmissionFenceVersion: true,
					bitmovinEncodingId: true,
					runs: {
						orderBy: { seq: "desc" },
						take: 1,
						select: { id: true, bitmovinEncodingId: true, stepLog: true },
					},
				},
			},
		},
	});
	if (!receipt?.liveChannelRunId) return null;
	const { liveChannelRunId, liveChannel: channel } = receipt;
	const run = channel.runs[0];
	if (expectedRunId && expectedRunId !== liveChannelRunId)
		return { liveChannelRunId };
	// A legacy payload is immutable in BullMQ. After its first worker adopted
	// the job, its durable pre-send failure is the authority for later retries.
	if (receipt.outcome === "FAILED") {
		if (
			receipt.outcomeEvidenceKind !== "EFFECT_FAILED" ||
			channel.status !== "ERROR" ||
			run?.id !== liveChannelRunId ||
			!channel.bitmovinEncodingId
		)
			return { liveChannelRunId };
		const claim = await prisma.liveEffectClaim.findFirst({
			where: {
				idempotencyKey: `schedule:${scheduleId}:stop`,
				action: "STOP",
				scheduleId,
				liveChannelId,
				liveChannelRunId,
				providerEncodingId: channel.bitmovinEncodingId,
				state: "FAILED",
				generation: channel.liveEffectFenceVersion,
				stopProtocolVersion: 1,
				stopSendEncodingIds: { isEmpty: true },
			},
			select: {
				idempotencyKey: true,
				providerEncodingId: true,
				generation: true,
			},
		});
		if (!claim || !liveStopRunOwnsEncoding(run, claim.providerEncodingId))
			return { liveChannelRunId };
		return {
			liveChannelRunId,
			alreadyAdopted: true,
			effect: {
				idempotencyKey: claim.idempotencyKey,
				action: "STOP" as const,
				scheduleId,
				liveChannelRunId,
				providerEncodingId: claim.providerEncodingId,
				admissionFenceVersion: claim.generation,
			},
		};
	}
	let effect: LiveEffectIntent | undefined;
	if (
		channel.status === "STOPPING" &&
		(receipt.stopAdmissionFenceVersion ??
			channel.legacyAdmissionFenceVersion) != null &&
		(receipt.stopAdmissionFenceVersion ??
			channel.legacyAdmissionFenceVersion) === channel.liveEffectFenceVersion &&
		run?.id === liveChannelRunId &&
		(!expectedRunId || expectedRunId === liveChannelRunId)
	) {
		const id = channel.bitmovinEncodingId
			? liveStopRunOwnsEncoding(run, channel.bitmovinEncodingId)
				? channel.bitmovinEncodingId
				: null
			: await bindArchivedStopTarget(prisma, liveChannelId, liveChannelRunId);
		if (
			!id ||
			(receipt.stopProviderEncodingId && receipt.stopProviderEncodingId !== id)
		)
			return { liveChannelRunId, effect };

		effect = {
			idempotencyKey: `schedule:${scheduleId}:stop`,
			action: "STOP",
			scheduleId,
			liveChannelRunId,
			providerEncodingId: id,
			admissionFenceVersion: channel.liveEffectFenceVersion,
		};
	}
	return { liveChannelRunId, effect };
}
