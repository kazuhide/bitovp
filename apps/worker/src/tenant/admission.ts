import {
	feederJobSchema,
	liveChannelJobSchema,
	orchestratorJobSchema,
	type QueueKey,
	slateNormalizeJobSchema,
	storageInspectJobSchema,
	vmafJobSchema,
	vodInputPreviewJobSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { retireRestartAdmission } from "../live/dead-job-outcome";
import { resolveProvisionAdmission } from "../live/provision-admission";
import {
	hasCommittedStart,
	suppressInactiveProvision,
} from "../live/reconcile-stranded-runs";
import { roleManifestStopPendingWhere } from "../orchestrator/manifest-stop-recovery";
import { claimableWhere } from "../orchestrator/processor";
import { scheduledStartScheduleId } from "../scheduler/schedule-outcome";
export const INACTIVE_ORGANIZATION_ERROR =
	"Organization is inactive; new work was suppressed";
export { hasCommittedStart } from "../live/reconcile-stranded-runs";
/** Deactivation blocks fresh work without killing a committed provider run or STOP. */
export async function admitInactiveOrganization(
	prisma: AppPrismaClient,
	key: QueueKey,
	payload: unknown,
	delivery: { id?: string; timestamp?: number } = {},
): Promise<boolean> {
	if (key === "notify") return true;
	if (key === "liveChannel") {
		const data = liveChannelJobSchema.parse(payload);
		if (data.action === "stop" || data.action === "heartbeat") return true;
		if (data.action === "restart") {
			if (data.effect?.action === "RESTART")
				await retireRestartAdmission(
					prisma,
					data.liveChannelId,
					data.effect,
					"INACTIVE_ORGANIZATION",
					INACTIVE_ORGANIZATION_ERROR,
					new Date(),
				);
			return false;
		}
		if (data.action === "provision") {
			const params = data.params as { cancelRunId?: string } | undefined;
			// The processor will require the stored cancellation on this exact run.
			if (params?.cancelRunId) return true;
			const admission = await resolveProvisionAdmission(
				prisma,
				data.liveChannelId,
				data,
				delivery.id,
				delivery.timestamp,
			);
			if (!admission) return false;
			return await suppressInactiveProvision(
				prisma,
				data.liveChannelId,
				admission,
				scheduledStartScheduleId(delivery.id, data.provisionFenceVersion),
				INACTIVE_ORGANIZATION_ERROR,
				new Date(),
			);
		}
		const scheduleId =
			data.effect?.scheduleId ??
			(typeof data.params === "object" && data.params !== null
				? (data.params as { scheduleId?: string }).scheduleId
				: undefined);
		if (scheduleId)
			await prisma.liveSchedule.updateMany({
				where: { id: scheduleId, status: { in: ["ARMED", "FIRED"] } },
				data: {
					status: "CANCELED",

					note: INACTIVE_ORGANIZATION_ERROR,
				},
			});

		return false;
	}
	if (key === "orchestrator") {
		const { encodingJobId: id } = orchestratorJobSchema.parse(payload);
		const row = await prisma.encodingJob.findUnique({
			where: { id },
			select: {
				cancelRequested: true,
				bitmovinEncodingId: true,
				stepLog: true,
				status: true,
				updatedAt: true,
			},
		});
		if (!row) return false;
		if (
			row.cancelRequested ||
			(row.bitmovinEncodingId &&
				hasCommittedStart(row.stepLog, "START_ENCODING")) ||
			row.status === "AWAITING_QC"
		)
			return true;
		const claimable = claimableWhere(id, ["QUEUED", "RUNNING"], new Date());
		if (
			await prisma.encodingJob.findFirst({
				where: {
					id,
					status: claimable.status,
					...roleManifestStopPendingWhere,
				},
				select: { id: true },
			})
		)
			return true;
		await prisma.encodingJob.updateMany({
			// A recovery marker, cancel, or renewed lease can commit during admission.
			where: {
				...claimable,
				cancelRequested: false,
				updatedAt: row.updatedAt,
				NOT: roleManifestStopPendingWhere,
			},
			data: {
				status: "ERROR",
				error: INACTIVE_ORGANIZATION_ERROR,
				attemptClaimedAt: null,
			},
		});
		return false;
	}
	if (key === "feederManager") {
		const data = feederJobSchema.parse(payload);
		if (data.action === "stop") return true;
		const row = await prisma.feederSession.findUnique({
			where: { id: data.feederSessionId },
			select: { status: true },
		});
		if (row?.status === "PUSHING") return true;
		await prisma.feederSession.updateMany({
			where: {
				id: data.feederSessionId,
				status: { in: ["CREATED", "DOWNLOADING"] },
			},
			data: { status: "ERROR", error: INACTIVE_ORGANIZATION_ERROR },
		});
		return false;
	}
	if (key === "vmafRunner") {
		const { vmafJobId: id } = vmafJobSchema.parse(payload);
		const row = await prisma.vmafJob.findUnique({
			where: { id },
			select: { status: true },
		});
		if (row?.status === "RUNNING") return true;
		await prisma.vmafJob.updateMany({
			where: { id, status: "PENDING" },
			data: { status: "ERROR", error: INACTIVE_ORGANIZATION_ERROR },
		});
		return false;
	}
	if (key === "storageInspect") {
		const { storageInspectionId: id } = storageInspectJobSchema.parse(payload);
		const row = await prisma.storageInspection.findUnique({
			where: { id },
			select: { status: true },
		});
		if (row?.status === "RUNNING") return true;
		await prisma.storageInspection.updateMany({
			where: { id, status: "PENDING" },
			data: { status: "ERROR", error: INACTIVE_ORGANIZATION_ERROR },
		});
		return false;
	}
	if (key === "vodInputPreview") {
		const { taskId: id } = vodInputPreviewJobSchema.parse(payload);
		await prisma.vodInputPreviewTask.updateMany({
			where: { id, status: { in: ["PENDING", "RUNNING"] } },
			data: {
				status: "CANCELED",
				stage: "CANCELED",
				cancelRequestedAt: new Date(),
				error: {
					code: "ORGANIZATION_INACTIVE",
					message: INACTIVE_ORGANIZATION_ERROR,
				},
			},
		});
		return false;
	}
	if (key === "slateNormalize") {
		const { slateNormalizationId: id } = slateNormalizeJobSchema.parse(payload);
		const row = await prisma.slateNormalization.findUnique({
			where: { id },
			select: { status: true },
		});
		if (row && ["NORMALIZING", "REGISTERING"].includes(row.status)) return true;
		await prisma.slateNormalization.updateMany({
			where: { id, status: { in: ["QUEUED", "WAITING_FOR_INPUT"] } },
			data: { status: "ERROR", error: INACTIVE_ORGANIZATION_ERROR },
		});
		return false;
	}
	return false; // Startup batches and statistics backfill have no independent work row.
}
