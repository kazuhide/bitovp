import { NextResponse } from "next/server";
import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import { ROLE_HEADER } from "@/lib/auth/roles";
import { sanitizeSlateNormalization } from "@/lib/live-runtime/schemas";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** Rows the panel still cares about: everything in flight, plus a day of outcomes. */
const RECENT_MS = 24 * 60 * 60 * 1000;
const LIMIT = 50;

/**
 * GET — the channel's slate registrations in flight . A movie
 * registered from the channel page no longer appears at the provider at
 * once: the worker converts it first (or waits for the live input), and this
 * list is where the operator watches that happen — WAITING_FOR_INPUT,
 * QUEUED, NORMALIZING, REGISTERING, then READY (the content is now in the
 * provider list) or ERROR with the reason. Finished rows drop out after a
 * day. Reads are not RUNNING-gated, like the content list.
 */
/**
 * The same server-side derivation the channel GET uses for its ADMIN
 * disclosure: password mode's owner session, or a proxy-resolved principal
 * whose role header says ADMIN. Everyone else gets the row without its
 * technical text (`error`, `note`) — the panel gates the same way, as
 * defence in depth, but a VIEWER token must not read ffmpeg's tail from the
 * API either.
 */
function technicalDetailsAllowedFor(req: Request): boolean {
	const actor = req.headers.get(ACTOR_HEADER);
	const roleResolvedPrincipal =
		actor?.startsWith("user:") === true ||
		(actor?.startsWith("token:") === true && actor !== "token:unresolved");
	return (
		actor === "session" ||
		(roleResolvedPrincipal && req.headers.get(ROLE_HEADER) === "ADMIN")
	);
}

export async function GET(req: Request, { params }: RouteParams) {
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
		const rows = await ctx.prisma.slateNormalization.findMany({
			where: {
				liveChannelId: id,
				OR: [
					{ status: { notIn: ["READY", "ERROR"] } },
					{ updatedAt: { gte: new Date(Date.now() - RECENT_MS) } },
				],
			},
			orderBy: { createdAt: "desc" },
			take: LIMIT,
		});
		const technical = technicalDetailsAllowedFor(req);
		return NextResponse.json({
			items: rows.map((row) => {
				const item = sanitizeSlateNormalization(row);
				return technical ? item : { ...item, error: null, note: null };
			}),
		});
	} catch (err) {
		return routeError(err);
	}
}
