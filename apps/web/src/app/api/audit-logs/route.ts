import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { routeError, validationError } from "@/lib/server/http";

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.uuid().optional(),
});

/**
 * List projection deliberately excludes request/response payloads — the
 * table never shows them, and `GET /api/audit-logs/[id]` is where a reader
 * who wants one asks for it by id.
 *
 * `actor` DOES belong here (re-audit HIGH-7): without it the list cannot say
 * WHO acted, so a verification run's row and its own audit rows had nothing to
 * join on. It is `token:<id>` / `user:<id>` / "session" — an identifier, never
 * a credential.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { limit, cursor } = parsed.data;
	try {
		const ctx = await getServerContext();
		const rows = await ctx.prisma.auditLog.findMany({
			orderBy: [{ at: "desc" }, { id: "desc" }],
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: {
				id: true,
				at: true,
				actor: true,
				method: true,
				path: true,
				statusCode: true,
				durationMs: true,
				error: true,
				bitmovinAccountId: true,
			},
		});
		// Older registrar errors contain stringified receiver credentials that
		// the generic at-rest object redactor could not remove.
		const items = rows.slice(0, limit).map((row) =>
			row.actor === "worker:webhook-registrar"
				? {
						...row,
						error:
							row.error === null ? null : "Webhook provider operation failed",
					}
				: row,
		);
		return NextResponse.json({
			items,
			nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
		});
	} catch (err) {
		return routeError(err);
	}
}
