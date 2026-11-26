import { randomUUID } from "node:crypto";
import type { AppPrismaClient, AppTransactionClient, Prisma } from "@bitovp/db";

export const MISSED_UNOWNED_STOP_REASON =
	"The previous worker did not record which encoder generation it admitted. Open the channel, confirm the current broadcast and choose Stop if it should end.";

export type ScheduledStopAdmission = {
	providerEncodingId: string;
	admissionFenceVersion: number;
	stopDeliveryToken?: string;
};

const LEGACY_UNSTAMPED_STOP = {
	stopAdmissionFenceVersion: null,
	stopProviderEncodingId: null,
	stopDeliveryToken: null,
} as const;

/** The queue key is reused when a legacy schedule refires for the same airing. */
export function scheduledStopAdmissionWhere(
	admission?: ScheduledStopAdmission,
): Prisma.LiveScheduleWhereInput {
	if (!admission) return {};
	const { providerEncodingId, admissionFenceVersion } = admission;
	return {
		stopDeliveryToken: admission.stopDeliveryToken ?? null,
		OR: [
			{
				stopProviderEncodingId: providerEncodingId,
				stopAdmissionFenceVersion: admissionFenceVersion,
			},
			{
				stopAdmissionFenceVersion: null,
				stopProviderEncodingId: null,
				liveChannel: {
					bitmovinEncodingId: providerEncodingId,
					OR: [
						{ legacyAdmissionFenceVersion: admissionFenceVersion },
						{
							legacyAdmissionFenceVersion: null,
							liveEffectFenceVersion: admissionFenceVersion,
						},
					],
				},
			},
		],
	};
}

/** A terminal scheduling decision and its operator notification share a commit. */
export async function writeScheduledStopNotification(
	tx: AppTransactionClient,
	row: { id: string; liveChannelId: string },
	kind: "SCHEDULE_FIRED" | "SCHEDULE_MISSED",
	at: Date,
): Promise<void> {
	await tx.liveStopNotification.create({
		data: {
			id: randomUUID(),
			scheduleId: row.id,
			channelId: row.liveChannelId,
			channelName: "",
			kind,
			occurredAt: at,
			nextAttemptAt: at,
		},
	});
}

/** A confirmed queue handoff and its notification intent survive the same commit. */
export async function recordScheduledStopHandoff(
	prisma: AppPrismaClient,
	row: { id: string; liveChannelId: string; liveChannelRunId: string },
	at: Date,
	admission?: ScheduledStopAdmission | null,
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const { count } = await tx.liveSchedule.updateMany({
			where: {
				...row,
				...(admission === null
					? LEGACY_UNSTAMPED_STOP
					: scheduledStopAdmissionWhere(admission)),
				action: "STOP",
				status: "FIRED",
				dispatchedAt: null,
			},
			data: { dispatchedAt: at, dispatchJobId: `sched-${row.id}`, error: null },
		});
		if (!count) return;
		await writeScheduledStopNotification(tx, row, "SCHEDULE_FIRED", at);
	});
}
