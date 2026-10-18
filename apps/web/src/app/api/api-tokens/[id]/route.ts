import { getTenantPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { authError } from "@/lib/auth/route-context";
import {
	AuthContextError,
	resolveAuthenticatedContext,
} from "@/lib/auth/tenancy";
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const context = await resolveAuthenticatedContext(req.headers);
		const { id } = await params;
		if (
			context.isImpersonating ||
			(context.actor.startsWith("token:")
				? context.actor !== `token:${id}`
				: context.role !== "ADMIN")
		)
			throw new AuthContextError(
				403,
				"A token may revoke only itself; organization administrators revoke other tokens",
			);
		const db = getTenantPrisma(context.organizationId);
		const changed = await db.apiToken.updateMany({
			where: { id, revokedAt: null },
			data: { revokedAt: new Date() },
		});
		if (
			changed.count === 0 &&
			!(await db.apiToken.findUnique({ where: { id }, select: { id: true } }))
		)
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		return new Response(null, { status: 204 });
	} catch (err) {
		return authError(err);
	}
}
