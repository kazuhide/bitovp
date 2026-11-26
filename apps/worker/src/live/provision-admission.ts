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

type ScheduledStartReceipt = {
	dispatchJobId: string | null;
	dispatchedAt: Date | null;
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
			dispatchJobId: true,
			liveChannelRunId: true,
			startAdmissionFenceVersion: true,
			liveChannel: { select: bindingSelect },
		},
	});
	if (
		!row ||
		(row.dispatchJobId != null && row.dispatchJobId !== jobId) ||
		hasAisaLiveBinding(row.liveChannel, row.liveChannel?.runs[0])
	)
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

async function observeScheduledStart(
	prisma: AppPrismaClient,
	start: ScheduledStartIdentity,
	id: string,
	job: ProvisionQueueJob,
) {
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
	return { id, state: await job.getState() };
}

/** Select the exact retained START or reserve its canonical queue key before adding. */
export async function prepareScheduledStartDispatch(
	prisma: AppPrismaClient,
	readJob: ReadProvisionJob,
	start: ScheduledStartIdentity,
	receipt: ScheduledStartReceipt,
): Promise<{ id: string; state: string | null } | null> {
	const legacyId = scheduledStartJobId(start.id);
	const id = scheduledStartJobId(start.id, start.startAdmissionFenceVersion);
	if (receipt.dispatchJobId !== id) {
		if (receipt.dispatchJobId !== null && receipt.dispatchJobId !== legacyId)
			return null;
		const legacy = await readJob(legacyId);
		const observed =
			legacy && (await observeScheduledStart(prisma, start, legacyId, legacy));
		if (observed) return observed;
	}
	// A failed lookup cannot prove absence. A job already present under the
	// canonical key (for example, after a lost add reply) is adopted below.
	const job = await readJob(id);
	if (receipt.dispatchJobId !== id) {
		const reserved = await prisma.$transaction(async (tx) => {
			const [channel] = await tx.$queryRaw<{ id: string }[]>`
				SELECT id FROM "LiveChannel" WHERE id = ${start.liveChannelId}::uuid
					AND status = 'PROVISIONING' AND "provisionClaimedAt" IS NULL
					AND "liveEffectFenceVersion" = ${start.startAdmissionFenceVersion}
				FOR UPDATE`;
			if (!channel) return false;
			const run = await tx.liveChannelRun.findFirst({
				where: { liveChannelId: start.liveChannelId },
				orderBy: { seq: "desc" },
				select: { id: true, cancelRequested: true, status: true },
			});
			if (
				run?.id !== start.liveChannelRunId ||
				run.cancelRequested ||
				(run.status !== "PROVISIONING" && run.status !== "CREATED")
			)
				return false;
			const changed = await tx.liveSchedule.updateMany({
				where: {
					...pendingStart(start),
					dispatchJobId: receipt.dispatchJobId,
					dispatchedAt: receipt.dispatchedAt,
				},
				data: { dispatchJobId: id, dispatchedAt: null },
			});
			return changed.count === 1;
		});
		if (!reserved) return null;
	}
	return job
		? observeScheduledStart(prisma, start, id, job)
		: { id, state: null };
}

function pendingStart(start: ScheduledStartIdentity) {
	return {
		...start,
		action: "START",
		status: "FIRED",
		outcome: "PENDING",
		liveChannel: { liveEffectFenceVersion: start.startAdmissionFenceVersion },
	} as const;
}

export async function recordRetainedScheduledStart(
	prisma: AppPrismaClient,
	start: ScheduledStartIdentity,
	retained: { id: string; state: string },
	at: Date,
): Promise<false | "handoff" | "terminal"> {
	const owned = pendingStart(start);
	// Retention may evict the job before the next bounded recovery pass.
	const failure =
		retained.state === "failed"
			? ({
					outcome: "UNKNOWN",
					outcomeAt: at,
					outcomeNote:
						"The original Live startup job exhausted its deliveries.",
					outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
					outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
					outcomeEvidenceAt: at,
				} as const)
			: undefined;
	const { count } = await prisma.liveSchedule.updateMany({
		where: {
			...owned,
			dispatchedAt: null,
			OR: [{ dispatchJobId: null }, { dispatchJobId: retained.id }],
		},
		data: {
			dispatchedAt: at,
			dispatchJobId: retained.id,
			...failure,
		},
	});
	if (count === 1) return "handoff";
	if (!failure) return false;
	// A prior or concurrent observer may already have stamped the same job.
	// Preserve that handoff time while saving the new terminal observation.
	const updated = await prisma.liveSchedule.updateMany({
		where: {
			...owned,
			dispatchedAt: { not: null },
			dispatchJobId: retained.id,
		},
		data: failure,
	});
	return updated.count === 1 ? "terminal" : false;
}
