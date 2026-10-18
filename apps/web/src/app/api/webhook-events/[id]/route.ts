import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** Full row incl. raw payload — fetched on demand by the payload viewer. */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const event = await ctx.prisma.webhookEvent.findUnique({ where: { id } });
		if (!event) return jsonError(404, "Not found");
		const { receiverTokenHash: _internalTokenHash, ...publicEvent } = event;
		return NextResponse.json(publicEvent);
	} catch (err) {
		return routeError(err);
	}
}
