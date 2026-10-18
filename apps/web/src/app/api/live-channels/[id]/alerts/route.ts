import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Channel alert state : OPEN events for the banner plus
 * recent history for the section under the heartbeat chart. Rule fields
 * ride along so the UI never joins client-side.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const channel = await ctx.prisma.liveChannel.findUnique({
			where: { id },
			select: { id: true },
		});
		if (!channel) {
			return jsonError(404, "Not found");
		}
		// review-83b I4: partition BEFORE the take — one shared take-50 let a
		// long-open alert (which ranks by its OLD openedAt) drop off the
		// banner once 50 newer events existed, while the dashboard still
		// counted it: the surface operators watch under-reported. Open
		// events are few by construction (one per rule per channel, the
		// partial unique index); history alone is capped.
		const ruleSelect = {
			rule: {
				select: {
					metric: true,
					severity: true,
					threshold: true,
					windowPolls: true,
				},
			},
		};
		const [open, history] = await Promise.all([
			ctx.prisma.alertEvent.findMany({
				where: { liveChannelId: id, resolvedAt: null },
				orderBy: { openedAt: "desc" },
				include: ruleSelect,
			}),
			ctx.prisma.alertEvent.findMany({
				where: { liveChannelId: id, resolvedAt: { not: null } },
				orderBy: { openedAt: "desc" },
				take: 50,
				include: ruleSelect,
			}),
		]);
		return NextResponse.json({ open, history });
	} catch (err) {
		return routeError(err);
	}
}
