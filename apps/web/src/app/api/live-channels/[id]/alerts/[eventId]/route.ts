import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

const bodySchema = z.strictObject({ action: z.literal("resolve") });

/**
 * Manual resolve (review-83b C1's operator escape hatch): before this, no
 * product surface could close an open alert event — the only clear was
 * deleting the RULE, which cascade-deletes its whole alert history. The
 * orphan resolver handles channels/rules that leave the engine's reach;
 * this handles the operator who has SEEN a live CRIT and dealt with it.
 * CAS on resolvedAt: a racing engine-resolve wins benignly (409 says the
 * true state is already what was asked for).
 */
export async function PATCH(req: Request, { params }: RouteParams) {
	const { id, eventId } = await params;
	const invalid = invalidIdResponse(id) ?? invalidIdResponse(eventId);
	if (invalid) {
		return invalid;
	}
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const event = await ctx.prisma.alertEvent.findFirst({
			where: { id: eventId, liveChannelId: id },
			select: { id: true, resolvedAt: true },
		});
		if (!event) {
			return jsonError(404, "Not found");
		}
		if (event.resolvedAt !== null) {
			return jsonError(
				409,
				"Already resolved",
				customerErrorDetails("ALERT_ALREADY_RESOLVED"),
			);
		}
		const { count } = await ctx.prisma.alertEvent.updateMany({
			where: { id: eventId, resolvedAt: null },
			data: { resolvedAt: new Date() },
		});
		if (count === 0) {
			return jsonError(
				409,
				"Already resolved",
				customerErrorDetails("ALERT_ALREADY_RESOLVED"),
			);
		}
		return NextResponse.json({ id: eventId, resolved: true });
	} catch (err) {
		return routeError(err);
	}
}
