import type { AppPrismaClient } from "@bitovp/db";
import type { createEventEnqueuer } from "../notify/emitter";

const jobPrefix = "live-stop-notification-";

/** If the producer lost the enqueue response, the consumer itself witnesses handoff before BullMQ can retire its job. */
export async function witnessStopNotificationQueue(
	prisma: AppPrismaClient,
	jobId: string | undefined,
) {
	if (!jobId?.startsWith(jobPrefix)) return;
	const id = jobId.slice(jobPrefix.length);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	)
		return;
	await prisma.liveChannelRun.updateMany({
		where: {
			id,
			stopNotificationAt: { not: null },
			stopNotificationQueuedAt: null,
		},
		data: { stopNotificationQueuedAt: new Date() },
	});
}

/** Replay committed STOP notifications independently of claim state and current channel generation. */
export function createStopNotificationSweep(
	prisma: AppPrismaClient,
	enqueue: ReturnType<typeof createEventEnqueuer>,
) {
	const pageSize = 16;
	let after: string | undefined;
	return async () => {
		const runs = await prisma.liveChannelRun.findMany({
			where: {
				stopNotificationAt: { not: null },
				stopNotificationQueuedAt: null,
				...(after ? { id: { gt: after } } : {}),
			},
			orderBy: { id: "asc" },
			take: pageSize,
			select: {
				id: true,
				liveChannelId: true,
				liveChannel: { select: { name: true } },
				stopNotificationKind: true,
				stopNotificationAt: true,
			},
		});
		after = runs.length === pageSize ? runs.at(-1)?.id : undefined;
		for (const run of runs) {
			const {
				stopNotificationKind: kind,
				stopNotificationAt: occurredAt,
				liveChannelId,
			} = run;
			if (
				!occurredAt ||
				(kind !== "CHANNEL_STOPPED" && kind !== "CHANNEL_ERROR")
			)
				continue;
			try {
				const common = {
					liveChannelId,
					name: run.liveChannel.name,
					path: `/live/${liveChannelId}`,
				};
				const event =
					kind === "CHANNEL_ERROR"
						? ({
								...common,
								kind,
								error: "AISA_LIVE_TERMINAL_FAILURE",
							} as const)
						: ({ ...common, kind } as const);
				await prisma.$transaction(async (tx) => {
					// Competing workers share this row lock. Queue failure rolls the stamp back.
					const claimed = await tx.liveChannelRun.updateMany({
						where: {
							id: run.id,
							stopNotificationQueuedAt: null,
							stopNotificationAt: occurredAt,
						},
						data: { stopNotificationQueuedAt: new Date() },
					});
					if (claimed.count === 1)
						await enqueue(event, {
							jobId: `${jobPrefix}${run.id}`,
							occurredAt,
						});
				});
			} catch {
				console.warn(
					`[notify] STOP event remains pending for broadcast ${run.id}`,
				);
			}
		}
	};
}
