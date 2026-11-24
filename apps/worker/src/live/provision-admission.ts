import type { AppPrismaClient } from "@bitovp/db";
import { legacyScheduleId } from "../scheduler/schedule-outcome";
import { provisionJobGeneration } from "./reconcile-stranded-runs";

export type ProvisionAdmission =
	| { runId: string; generation: number }
	| { initial: true };

type ProvisionDelivery = {
	plannedLiveChannelRunId?: string | null;
	provisionFenceVersion?: number;
};

/** Recover the original producer's identity. An arbitrary older job cannot adopt the current airing. */
export async function resolveProvisionAdmission(
	prisma: AppPrismaClient,
	channelId: string,
	delivery: ProvisionDelivery,
	jobId?: string,
	queuedAt?: number,
): Promise<ProvisionAdmission | null> {
	if (jobId === channelId || jobId === `probe-${channelId}`)
		return { initial: true };
	const runId = delivery.plannedLiveChannelRunId;
	const manualGeneration = provisionJobGeneration(channelId, runId, jobId);
	if (runId && manualGeneration !== undefined)
		return { runId, generation: manualGeneration };
	const scheduleId = legacyScheduleId(jobId);
	const manualPrefix = `${channelId}-provision-`;
	const legacyManual =
		jobId?.startsWith(manualPrefix) &&
		/^\d+$/.test(jobId.slice(manualPrefix.length));
	if (!scheduleId && !legacyManual) return null;
	const row = scheduleId
		? await prisma.liveSchedule.findFirst({
				where: {
					id: scheduleId,
					liveChannelId: channelId,
					action: "START",
					status: "FIRED",
				},
				select: {
					liveChannelRunId: true,
					startAdmissionFenceVersion: true,
				},
			})
		: null;
	if (scheduleId && !row) return null;
	if (row?.startAdmissionFenceVersion != null) {
		if (
			!row.liveChannelRunId ||
			(runId && row.liveChannelRunId !== runId) ||
			(delivery.provisionFenceVersion !== undefined &&
				delivery.provisionFenceVersion !== row.startAdmissionFenceVersion)
		)
			return null;
		// A pre-upgrade queued job can predate a later revival of the same
		// run even if its asynchronous dispatch ACK was recorded afterwards.
		if (
			delivery.provisionFenceVersion === undefined &&
			queuedAt !== undefined
		) {
			const run = await prisma.liveChannelRun.findFirst({
				where: { id: row.liveChannelRunId, liveChannelId: channelId },
				select: { legacyProvisionAdmissionAt: true },
			});
			if (
				run?.legacyProvisionAdmissionAt &&
				queuedAt < run.legacyProvisionAdmissionAt.getTime()
			)
				return null;
		}
		return {
			runId: row.liveChannelRunId,
			generation: row.startAdmissionFenceVersion,
		};
	}
	// The migration pins legacy scheduled admissions to their actual run. A
	// fresh Redis timestamp cannot supply the binding an old schedule lacked.
	if (scheduleId || delivery.provisionFenceVersion !== undefined) return null;
	const time = Number(jobId?.slice(manualPrefix.length));
	if (!Number.isSafeInteger(time) || time <= 0) return null;
	const channel = await prisma.liveChannel.findUnique({
		where: { id: channelId },
		select: {
			liveEffectFenceVersion: true,
			legacyAdmissionFenceVersion: true,
			runs: {
				orderBy: { seq: "desc" },
				take: 1,
				select: { id: true, legacyProvisionAdmissionAt: true },
			},
		},
	});
	const run = channel?.runs[0];
	if (
		!channel ||
		channel.legacyAdmissionFenceVersion !== channel.liveEffectFenceVersion ||
		!run?.legacyProvisionAdmissionAt ||
		run.legacyProvisionAdmissionAt.getTime() >
			Math.min(time, queuedAt ?? time) ||
		(runId && runId !== run.id)
	)
		return null;
	const scheduledOwner = await prisma.liveSchedule.findFirst({
		where: {
			liveChannelId: channelId,
			liveChannelRunId: run.id,
			action: "START",
			status: "FIRED",
			startAdmissionFenceVersion: channel.liveEffectFenceVersion,
		},
		select: { id: true },
	});
	if (scheduledOwner) return null;
	return { runId: run.id, generation: channel.liveEffectFenceVersion };
}
