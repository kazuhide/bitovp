import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * The channel's run history : seq, status,
 * window, encoding id, error — newest first. C6: capped at 100 (a channel
 * with more runs than that has a retention conversation coming, recorded as
 * the design's own open question #2). Step logs are NOT in the list — a
 * per-run log is heavy and rides the detail row's currentRun for the live
 * one; historical step logs stay queryable directly when a drill-down UI
 * earns its place.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const runs = await ctx.prisma.liveChannelRun.findMany({
			where: { liveChannelId: id },
			orderBy: { seq: "desc" },
			take: 100,
			select: {
				id: true,
				seq: true,
				status: true,
				bitmovinEncodingId: true,
				outputPrefix: true,
				runningSince: true,
				endedAt: true,
				queueSeconds: true,
				programStartAt: true,
				programEndAt: true,
				error: true,
				lastHeartbeatAt: true,
				createdAt: true,
			},
		});
		return NextResponse.json({ runs });
	} catch (err) {
		return routeError(err);
	}
}
