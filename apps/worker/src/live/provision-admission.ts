import { hasAisaLiveBinding } from "@bitovp/core";
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

const bindingSelect = {
	origin: true,
	plan: true,
	stepLog: true,
	runs: {
		orderBy: { seq: "desc" },
		take: 1,
		select: {
			id: true,
			legacyProvisionAdmissionAt: true,
			aisaAnalysisId: true,
			aisaStatus: true,
			aisaSnapshot: true,
			stepLog: true,
		},
	},
} as const;

/** Recover the original producer's identity. An arbitrary older job cannot adopt the current airing. */
export async function resolveProvisionAdmission(
	prisma: AppPrismaClient,
	channelId: string,
	delivery: ProvisionDelivery,
	jobId?: string,
	queuedAt?: number,
	purpose: "identify" | "dispatch" = "identify",
): Promise<ProvisionAdmission | null> {
	if (jobId === channelId || jobId === `probe-${channelId}`)
		return { initial: true };
	const runId = delivery.plannedLiveChannelRunId;
	const manualGeneration = provisionJobGeneration(channelId, runId, jobId);
	if (runId && manualGeneration !== undefined) {
		if (
			delivery.provisionFenceVersion !== undefined &&
			delivery.provisionFenceVersion !== manualGeneration
		)
			return null;
		if (jobId?.startsWith("resume-provision-")) {
			// A generation-addressed upgrade ticket exists only for an ordinary,
			// already-admitted airing whose original producer could not be proved.
			const channel = await prisma.liveChannel.findFirst({
				where: {
					id: channelId,
					status: "PROVISIONING",
					liveEffectFenceVersion: manualGeneration,
					legacyAdmissionFenceVersion: manualGeneration,
					effectClaims: {
						none: {
							liveChannelRunId: runId,
							action: "RESTART",
							generation: manualGeneration,
						},
					},
					schedules: {
						none: {
							action: "START",
							status: "FIRED",
							liveChannelRunId: runId,
							startAdmissionFenceVersion: manualGeneration,
						},
					},
				},
				select: bindingSelect,
			});
			const run = channel?.runs[0];
			if (
				!channel ||
				run?.id !== runId ||
				!run.legacyProvisionAdmissionAt ||
				hasAisaLiveBinding(channel, run)
			)
				return null;
		}
		return { runId, generation: manualGeneration };
	}
	const scheduleId = legacyScheduleId(jobId);
	// Old manual IDs contain only a producer clock, which may be sampled
	// after a later same-run revival. The SQL sweeper resumes the frozen
	// airing under a new generation-addressed job instead.
	if (!scheduleId) return null;
	const row = await prisma.liveSchedule.findFirst({
		where: {
			id: scheduleId,
			liveChannelId: channelId,
			action: "START",
			status: "FIRED",
			...(purpose === "dispatch" ? { outcome: "PENDING" as const } : {}),
		},
		select: {
			liveChannelRunId: true,
			startAdmissionFenceVersion: true,
			liveChannel: { select: bindingSelect },
		},
	});
	if (!row || hasAisaLiveBinding(row.liveChannel, row.liveChannel?.runs[0]))
		return null;
	if (row.startAdmissionFenceVersion != null) {
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
	return null;
}
