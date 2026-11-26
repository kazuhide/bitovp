import { NextResponse } from "next/server";
import { customerErrorDetails } from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import {
	latestScheduleBinding,
	lockLiveScheduleTarget,
	rejectLiveScheduleMutation,
} from "@/lib/server/live-channel-mutation-guard";

type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

/**
 * Cancel an ARMED schedule . The atomic-claim idiom: a
 * status-guarded updateMany, so a row the sweep claims in the same instant
 * is NOT cancelled out from under it — the loser sees count 0 and reports
 * the row's actual state instead of pretending.
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
	const { id, scheduleId } = await params;
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(scheduleId);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		return await ctx.prisma.$transaction(async (tx) => {
			await lockLiveScheduleTarget(tx, id);
			const channel = await tx.liveChannel.findUnique({
				where: { id },
				select: {
					origin: true,
					plan: true,
					stepLog: true,
					runs: latestScheduleBinding,
				},
			});
			if (!channel) return jsonError(404, "Not found");
			const refusal = rejectLiveScheduleMutation(channel, ctx.tenant, "CANCEL");
			if (refusal) return refusal;
			const { count } = await tx.liveSchedule.updateMany({
				where: { id: scheduleId, liveChannelId: id, status: "ARMED" },
				data: { status: "CANCELED" },
			});
			if (count === 1) {
				return NextResponse.json({ id: scheduleId, status: "CANCELED" });
			}
			const row = await tx.liveSchedule.findFirst({
				where: { id: scheduleId, liveChannelId: id },
				select: { status: true },
			});
			if (!row) {
				return jsonError(404, "Not found");
			}
			return jsonError(
				409,
				`Only ARMED schedules can be cancelled (status: ${row.status})`,
				customerErrorDetails("SCHEDULE_NOT_CANCELLABLE", {
					status: row.status,
				}),
			);
		});
	} catch (err) {
		return routeError(err);
	}
}
