import { hasAisaLiveBinding, liveChannelJobSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import {
	CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
	scheduledStartJobId,
	scheduledStartScheduleId,
} from "../scheduler/schedule-outcome";
import { provisionJobGeneration } from "./reconcile-stranded-runs";

export type ProvisionAdmission =
	| { runId: string; generation: number }
	| { initial: true };

type ProvisionDelivery = {
	plannedLiveChannelRunId?: string | null;
	provisionFenceVersion?: number;
};

type ProvisionQueueJob = {
	data: unknown;
	timestamp?: number;
	getState(): Promise<string>;
};

export type ReadProvisionJob = (
	id: string,
) => Promise<ProvisionQueueJob | undefined>;

type ScheduledStartIdentity = {
	id: string;
	liveChannelId: string;
	liveChannelRunId: string;
	startAdmissionFenceVersion: number;
};

const bindingSelect = {
	origin: true,
	plan: true,
	stepLog: true,
	liveEffectFenceVersion: true,
	legacyAdmissionFenceVersion: true,
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
	const scheduleId = scheduledStartScheduleId(
		jobId,
		delivery.provisionFenceVersion,
	);
	// Old manual IDs contain only a producer clock, which may be sampled
	// after a later same-run revival. The SQL sweeper resumes the frozen
	// airing under a new generation-addressed job instead.
	if (!scheduleId || (delivery.provisionFenceVersion !== undefined && !runId))
		return null;
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
		if (delivery.provisionFenceVersion === undefined) {
			const latest = row.liveChannel?.runs[0];
			// The bare key alone is reusable. Only a delivery from the migration's
			// exact live admission can borrow its persisted generation.
			if (
				!latest?.legacyProvisionAdmissionAt ||
				latest.id !== row.liveChannelRunId ||
				row.liveChannel.legacyAdmissionFenceVersion !==
					row.startAdmissionFenceVersion ||
				row.liveChannel.liveEffectFenceVersion !==
					row.startAdmissionFenceVersion ||
				queuedAt === undefined ||
				!Number.isFinite(queuedAt) ||
				queuedAt < latest.legacyProvisionAdmissionAt.getTime()
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

export async function identifyProvisionJob(
	prisma: AppPrismaClient,
	channelId: string,
	id: string,
	job: ProvisionQueueJob,
) {
	const parsed = liveChannelJobSchema.safeParse(job.data);
	if (
		!parsed.success ||
		parsed.data.action !== "provision" ||
		parsed.data.params ||
		parsed.data.effect ||
		channelId !== parsed.data.liveChannelId
	)
		return null;
	const admission = await resolveProvisionAdmission(
		prisma,
		channelId,
		parsed.data,
		id,
		job.timestamp,
	);
	return admission ? { admission, data: parsed.data } : null;
}

export async function readRetainedScheduledStart(
	prisma: AppPrismaClient,
	readJob: ReadProvisionJob,
	start: ScheduledStartIdentity,
) {
	const id = scheduledStartJobId(start.id);
	const job = await readJob(id);
	if (!job) return null;
	const original = await identifyProvisionJob(
		prisma,
		start.liveChannelId,
		id,
		job,
	);
	if (
		!original ||
		!("runId" in original.admission) ||
		original.admission.runId !== start.liveChannelRunId ||
		original.admission.generation !== start.startAdmissionFenceVersion
	)
		return null;
	return { id, job, original, state: await job.getState() };
}

export async function recordRetainedScheduledStart(
	prisma: AppPrismaClient,
	start: ScheduledStartIdentity,
	retained: { id: string; state: string },
	at: Date,
): Promise<boolean> {
	const { count } = await prisma.liveSchedule.updateMany({
		where: {
			...start,
			action: "START",
			status: "FIRED",
			outcome: "PENDING",
			dispatchedAt: null,
			liveChannel: { liveEffectFenceVersion: start.startAdmissionFenceVersion },
		},
		data: {
			dispatchedAt: at,
			dispatchJobId: retained.id,
			// Retention may evict the job before the bounded recovery scan. Keep
			// the terminal observation with the handoff so it is never replayed.
			...(retained.state === "failed" && {
				outcome: "UNKNOWN",
				outcomeAt: at,
				outcomeNote: "The original Live startup job exhausted its deliveries.",
				outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
				outcomeEvidenceAt: at,
			}),
		},
	});
	return count === 1;
}
