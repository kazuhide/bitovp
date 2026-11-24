import { randomUUID } from "node:crypto";
import type { AppPrismaClient } from "@bitovp/db";

/** A confirmed queue handoff and its notification intent survive the same commit. */
export async function recordScheduledStopHandoff(
	prisma: AppPrismaClient,
	row: { id: string; liveChannelId: string; liveChannelRunId: string },
	at: Date,
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const { count } = await tx.liveSchedule.updateMany({
			where: { ...row, action: "STOP", status: "FIRED", dispatchedAt: null },
			data: { dispatchedAt: at, dispatchJobId: `sched-${row.id}`, error: null },
		});
		if (!count) return;
		await tx.liveStopNotification.create({
			data: {
				id: randomUUID(),
				scheduleId: row.id,
				channelId: row.liveChannelId,
				channelName: "",
				kind: "SCHEDULE_FIRED",
				occurredAt: at,
				nextAttemptAt: at,
			},
		});
	});
}
