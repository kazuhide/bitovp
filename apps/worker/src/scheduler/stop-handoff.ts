import { randomUUID } from "node:crypto";
import type { AppPrismaClient, AppTransactionClient } from "@bitovp/db";

export const MISSED_UNOWNED_STOP_REASON =
	"The previous worker did not record which encoder generation it admitted. Open the channel, confirm the current broadcast and choose Stop if it should end.";

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
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const { count } = await tx.liveSchedule.updateMany({
			where: { ...row, action: "STOP", status: "FIRED", dispatchedAt: null },
			data: { dispatchedAt: at, dispatchJobId: `sched-${row.id}`, error: null },
		});
		if (!count) return;
		await writeScheduledStopNotification(tx, row, "SCHEDULE_FIRED", at);
	});
}
