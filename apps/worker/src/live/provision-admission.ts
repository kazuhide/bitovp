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
					dispatchedAt: true,
					firedAt: true,
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
		return {
			runId: row.liveChannelRunId,
			generation: row.startAdmissionFenceVersion,
		};
	}
	if (delivery.provisionFenceVersion !== undefined) return null;
	// Pre-upgrade jobs carried only a timestamped manual ID or sched-<id>.
	// Bound their possible admission by both the immutable migration fence and
	// their original enqueue time. A delayed callback must never target a revival.
	const time = legacyManual
		? Number(jobId?.slice(manualPrefix.length))
		: queuedAt !== undefined && row?.dispatchedAt
			? Math.min(queuedAt, row.dispatchedAt.getTime())
			: (queuedAt ?? row?.dispatchedAt?.getTime() ?? row?.firedAt?.getTime());
	if (time === undefined || !Number.isSafeInteger(time) || time <= 0)
		return null;
	const [channel, current] = await Promise.all([
		prisma.liveChannel.findUnique({
			where: { id: channelId },
			select: {
				legacyAdmissionFenceVersion: true,
				liveEffectFenceVersion: true,
				updatedAt: true,
			},
		}),
		prisma.liveChannelRun.findFirst({
			where: { liveChannelId: channelId },
			orderBy: { seq: "desc" },
			select: { id: true, seq: true, updatedAt: true },
		}),
	]);
	if (
		!channel ||
		channel.legacyAdmissionFenceVersion !== channel.liveEffectFenceVersion ||
		!current ||
		channel.updatedAt.getTime() > time ||
		current.updatedAt.getTime() > time ||
		(runId && runId !== current.id) ||
		(row?.liveChannelRunId && row.liveChannelRunId !== current.id)
	)
		return null;
	if (row && scheduleId) {
		// Promote a verified legacy job so its finish, retry and failure own exactly
		// one schedule even when its old payload and FIRED row had no run ID.
		const saved = await prisma.liveSchedule.updateMany({
			where: {
				id: scheduleId,
				action: "START",
				status: "FIRED",
				liveChannelId: channelId,
				liveChannelRunId: row.liveChannelRunId,
				startAdmissionFenceVersion: null,
				liveChannel: {
					legacyAdmissionFenceVersion: channel.liveEffectFenceVersion,
					liveEffectFenceVersion: channel.liveEffectFenceVersion,
					runs: {
						some: { id: current.id },
						none: { seq: { gt: current.seq } },
					},
				},
			},
			data: {
				liveChannelRunId: current.id,
				startAdmissionFenceVersion: channel.liveEffectFenceVersion,
			},
		});
		if (!saved.count) {
			const winner = await prisma.liveSchedule.findFirst({
				where: {
					id: scheduleId,
					liveChannelId: channelId,
					action: "START",
					status: "FIRED",
					liveChannelRunId: current.id,
					startAdmissionFenceVersion: channel.liveEffectFenceVersion,
				},
				select: { id: true },
			});
			if (!winner) return null;
		}
	}
	return { runId: current.id, generation: channel.liveEffectFenceVersion };
}
