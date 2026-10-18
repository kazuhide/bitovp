import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { routeError, validationError } from "@/lib/server/http";

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.uuid().optional(),
	// rev414 R4: heartbeat pushes (one per interval per live encoding) would
	// bury every FINISHED/ERROR delivery within minutes; they are listed only
	// on request.
	includeHeartbeats: z.enum(["1", "true"]).optional(),
});

/** Lean projection (no raw payload) + cursor pagination (C6). */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		includeHeartbeats: url.searchParams.get("includeHeartbeats") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { limit, cursor, includeHeartbeats } = parsed.data;
	try {
		const ctx = await getServerContext();
		const rows = await ctx.prisma.webhookEvent.findMany({
			...(includeHeartbeats
				? {}
				: { where: { eventType: { not: "LIVE_ENCODING_HEARTBEAT" } } }),
			orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: {
				id: true,
				eventType: true,
				externalEventId: true,
				signatureValid: true,
				receivedAt: true,
				processedAt: true,
			},
		});
		const items = rows.slice(0, limit);
		return NextResponse.json({
			items,
			nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
		});
	} catch (err) {
		return routeError(err);
	}
}
