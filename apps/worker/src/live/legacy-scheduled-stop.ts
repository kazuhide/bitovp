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
			outcome: "PENDING",
			OR: [{ dispatchJobId: null }, { dispatchJobId: `sched-${scheduleId}` }],
		},
		select: {
			liveChannelRunId: true,
			liveChannel: {
				select: {
					status: true,
					liveEffectFenceVersion: true,
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
	let effect: LiveEffectIntent | undefined;
	if (
		channel.status === "STOPPING" &&
		run?.id === liveChannelRunId &&
		(!expectedRunId || expectedRunId === liveChannelRunId)
	) {
		const id = channel.bitmovinEncodingId
			? liveStopRunOwnsEncoding(run, channel.bitmovinEncodingId)
				? channel.bitmovinEncodingId
				: null
			: await bindArchivedStopTarget(prisma, liveChannelId, liveChannelRunId);
		if (!id) return { liveChannelRunId, effect };

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
