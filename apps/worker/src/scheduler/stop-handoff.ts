import type { AppPrismaClient } from "@bitovp/db";
import type { EmitProductEvent } from "../notify/emitter";

/** Both the producer's accepted add and the exact consumer prove the same queue handoff. */
export async function recordScheduledStopHandoff(
	prisma: AppPrismaClient,
	row: { id: string; liveChannelId: string; liveChannelRunId: string },
	at: Date,
	emitEvent?: EmitProductEvent,
): Promise<void> {
	const { count } = await prisma.liveSchedule.updateMany({
		where: { ...row, action: "STOP", status: "FIRED", dispatchedAt: null },
		data: { dispatchedAt: at, dispatchJobId: `sched-${row.id}`, error: null },
	});
	if (count)
		await emitEvent?.(
			{
				kind: "SCHEDULE_FIRED",
				scheduleId: row.id,
				liveChannelId: row.liveChannelId,
				path: `/live/${row.liveChannelId}`,
			},
			at,
		);
}
