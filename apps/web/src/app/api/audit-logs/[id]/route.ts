import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * One audit row, whole — request and response included (re-audit HIGH-7).
 *
 * The list route omits the payloads because a table never shows them; the
 * audit's finding was that nothing could show them AT ALL, so the exact-id
 * readbacks it performed by hand could not be repeated from the Dashboard.
 *
 * Generic at-rest redaction does not cover legacy webhook receiver URLs or
 * credentials nested in SDK error strings. Registrar payloads are withheld
 * at read time too; other actors retain their existing redacted projection.
 * Inherits `/api/audit-logs`'s ADMIN floor by prefix (lib/auth/roles.ts).
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.auditLog.findUnique({ where: { id } });
		if (!row) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json(
			row.actor === "worker:webhook-registrar"
				? {
						...row,
						error:
							row.error === null ? null : "Webhook provider operation failed",
						request: row.request === null ? null : "[withheld]",
						response: row.response === null ? null : "[withheld]",
					}
				: row,
		);
	} catch (err) {
		return routeError(err);
	}
}
