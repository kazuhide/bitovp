import type { LiveChannelJob } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

/** DB cancellation survives a lost Redis enqueue, worker crash or failed delivery. */
export async function reconcileStartupCancellations(
	prisma: AppPrismaClient,
	enqueue: (job: LiveChannelJob, jobId: string) => Promise<void>,
): Promise<number> {
	const rows = await prisma.liveChannelRun.findMany({
		where: { cancelRequested: true, status: { not: "STOPPED" } },
		orderBy: { updatedAt: "asc" },
		take: 100,
		select: { id: true, liveChannelId: true },
	});
	let queued = 0;
	for (const row of rows) {
		const latest = await prisma.liveChannelRun.findFirst({
			where: { liveChannelId: row.liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true },
		});
		if (latest?.id !== row.id) continue;
		await enqueue(
			{
				liveChannelId: row.liveChannelId,
				action: "provision",
				params: { cancelRunId: row.id },
			},
			`cancel-start-${row.liveChannelId}-${row.id}`,
		);
		queued++;
	}
	return queued;
}
