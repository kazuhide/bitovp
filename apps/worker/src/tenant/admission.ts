import {
	feederJobSchema,
	liveChannelJobSchema,
	orchestratorJobSchema,
	type QueueKey,
	slateNormalizeJobSchema,
	storageInspectJobSchema,
	vmafJobSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
export const INACTIVE_ORGANIZATION_ERROR =
	"Organization is inactive; new work was suppressed";
export function hasCommittedStart(log: unknown, kind: string) {
	return (
		Array.isArray(log) &&
		log.some(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				entry.kind === kind &&
				["RUNNING", "DONE"].includes(entry.status),
		)
	);
}
/** Deactivation blocks fresh work without killing a committed provider run or STOP. */
export async function admitInactiveOrganization(
	prisma: AppPrismaClient,
	key: QueueKey,
	payload: unknown,
): Promise<boolean> {
	if (key === "notify") return true;
	if (key === "liveChannel") {
		const data = liveChannelJobSchema.parse(payload);
		if (data.action === "stop" || data.action === "heartbeat") return true;
		const row = await prisma.liveChannel.findUnique({
			where: { id: data.liveChannelId },
			select: {
				status: true,
				bitmovinEncodingId: true,
				stepLog: true,
			},
		});
		if (
			data.action === "provision" &&
			row?.bitmovinEncodingId &&
			hasCommittedStart(row.stepLog, "START_LIVE_ENCODING")
		)
			return true;
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
		if (data.action === "provision" || data.action === "restart") {
			const changed = await prisma.liveChannel.updateMany({
				where: {
					id: data.liveChannelId,
					status: { in: ["CREATED", "PROVISIONING"] },
				},
				data: {
					status: "ERROR",
					error: INACTIVE_ORGANIZATION_ERROR,
					provisionClaimedAt: null,
				},
			});
			if (changed.count > 0)
				await prisma.liveChannelRun.updateMany({
					where: {
						liveChannelId: data.liveChannelId,
						status: { in: ["CREATED", "PROVISIONING"] },
					},
					data: {
						status: "ERROR",
						error: INACTIVE_ORGANIZATION_ERROR,
						endedAt: new Date(),
					},
				});
		}
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
			},
		});
		if (
			row?.cancelRequested ||
			(row?.bitmovinEncodingId &&
				hasCommittedStart(row.stepLog, "START_ENCODING")) ||
			row?.status === "AWAITING_QC"
		)
			return true;
		await prisma.encodingJob.updateMany({
			where: { id, status: { in: ["QUEUED", "RUNNING"] } },
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
