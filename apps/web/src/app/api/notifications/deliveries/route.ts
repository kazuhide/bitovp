import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { routeError } from "@/lib/server/http";
import { getNotifyQueue } from "@/lib/server/queue";

const PAGE_SIZE = 20;
type State = "FAILED" | "DELIVERED";

/** Ordinary deliveries live in BullMQ. Confirmed Live STOPs retain their result in SQL. */
export async function GET() {
	try {
		const { prisma } = await getServerContext();
		const queue = getNotifyQueue();
		async function recent(state: State) {
			const failed = state === "FAILED";
			const [jobs, stops] = await Promise.all([
				failed
					? queue.getFailed(0, PAGE_SIZE - 1)
					: queue.getCompleted(0, PAGE_SIZE - 1),
				prisma.liveStopNotification.findMany({
					where: {
						finishedAt: { not: null },
						skipped: false,
						failureReason: failed ? { not: null } : null,
					},
					orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
					take: PAGE_SIZE,
					select: {
						id: true,
						channelId: true,
						kind: true,
						occurredAt: true,
						finishedAt: true,
						failures: true,
						failureReason: true,
					},
				}),
			]);
			const rows = [
				...jobs.map((job) => ({
					id: job.id ?? "",
					state,
					kind: job.data?.kind ?? "UNKNOWN",
					occurredAt: job.data?.occurredAt ?? null,
					link: job.data?.link ?? null,
					attemptsMade: job.attemptsMade ?? 0,
					failedReason: failed ? (job.failedReason ?? null) : null,
					sortTime: job.finishedOn ?? 0,
				})),
				...stops.map((stop) => ({
					id: `live-stop-${stop.id}`,
					state,
					kind: stop.kind,
					occurredAt: stop.occurredAt.toISOString(),
					link: `/live/${stop.channelId}`,
					attemptsMade: stop.failures + (failed ? 0 : 1),
					failedReason: stop.failureReason,
					sortTime: stop.finishedAt?.getTime() ?? 0,
				})),
			];
			return rows
				.sort(
					(a, b) =>
						b.sortTime - a.sortTime || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
				)
				.slice(0, PAGE_SIZE)
				.map(({ sortTime: _sortTime, ...delivery }) => delivery);
		}
		const [failed, completed] = await Promise.all([
			recent("FAILED"),
			recent("DELIVERED"),
		]);
		return NextResponse.json({ failed, completed });
	} catch (err) {
		return routeError(err);
	}
}
