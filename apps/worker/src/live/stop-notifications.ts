import { randomUUID } from "node:crypto";
import { EVENT_VERSION } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

type Deliver = (job: {
	data: unknown;
	beforeSend?: () => Promise<void>;
}) => Promise<unknown>;

const leaseMs = 60_000;
const maxAttempts = 5;
class DeliveryLeaseLost extends Error {}

/** The transaction that confirms STOP inserts the notification itself into this work queue. */
export function createStopNotificationSweep(
	prisma: AppPrismaClient,
	deliver: Deliver,
	publicBaseUrl?: string,
	now: () => Date = () => new Date(),
) {
	const base = (publicBaseUrl || "http://localhost:3000").replace(/\/$/, "");
	return async () => {
		const pending = await prisma.liveStopNotification.findMany({
			where: { nextAttemptAt: { lte: now() } },
			orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
			take: 16,
		});
		for (const row of pending) {
			const token = randomUUID();
			const owner = { id: row.id, leaseToken: token };
			const at = now();
			const claimed = await prisma.liveStopNotification.updateMany({
				where: {
					id: row.id,
					nextAttemptAt: { lte: at },
					failures: row.failures,
					leaseToken: row.leaseToken,
				},
				data: {
					leaseToken: token,
					nextAttemptAt: new Date(at.getTime() + leaseMs),
				},
			});
			if (!claimed.count) continue;

			let result: "PROCESSED" | "FAILED" = "PROCESSED";
			try {
				await deliver({
					data: {
						eventVersion: EVENT_VERSION,
						kind: row.kind,
						occurredAt: row.occurredAt.toISOString(),
						liveChannelId: row.channelId,
						name: row.channelName,
						link: `${base}/live/${row.channelId}`,
						...(row.kind === "CHANNEL_ERROR" && {
							error: "AISA_LIVE_TERMINAL_FAILURE",
						}),
					},
					// Each destination has a ten-second HTTP timeout. Refresh the lease at
					// each send so fan-out to many destinations can outlive the initial lease.
					beforeSend: async () => {
						const at = now();
						const renewed = await prisma.liveStopNotification.updateMany({
							where: { ...owner, nextAttemptAt: { gt: at } },
							data: { nextAttemptAt: new Date(at.getTime() + leaseMs) },
						});
						if (!renewed.count) throw new DeliveryLeaseLost();
					},
				});
			} catch (error) {
				if (error instanceof DeliveryLeaseLost) continue;
				result = "FAILED";
			}

			if (result === "FAILED" && row.failures + 1 < maxAttempts) {
				await prisma.liveStopNotification.updateMany({
					where: owner,
					data: {
						leaseToken: null,
						failures: { increment: 1 },
						nextAttemptAt: new Date(
							now().getTime() + 1_000 * 2 ** row.failures,
						),
					},
				});
				continue;
			}

			await prisma.$transaction(async (tx) => {
				const finished = await tx.liveStopNotification.deleteMany({
					where: owner,
				});
				if (!finished.count) return;
				await tx.liveChannelRun.updateMany({
					where: {
						id: row.id,
						liveChannelId: row.channelId,
						stopNotificationState: "PENDING",
					},
					data: { stopNotificationState: result },
				});
				if (result === "FAILED")
					console.warn(
						`[notify] STOP notification failed after ${maxAttempts} attempts for broadcast ${row.id}`,
					);
			});
		}
	};
}
