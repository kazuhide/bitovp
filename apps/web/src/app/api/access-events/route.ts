import { getTenantPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/route-context";
import { requireOrganizationAdmin } from "@/lib/auth/tenancy";

const querySchema = z.strictObject({
	cursor: z.uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});
export async function GET(req: Request) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		const query = querySchema.safeParse(
			Object.fromEntries(new URL(req.url).searchParams),
		);
		if (!query.success)
			return NextResponse.json(
				{ error: "Invalid pagination" },
				{ status: 400 },
			);
		const prisma = getTenantPrisma(context.organizationId);
		const { cursor, limit } = query.data;
		// A guessed foreign cursor never reaches the database's pagination lookup.
		if (
			cursor &&
			!(await prisma.accessEvent.findUnique({
				where: { id: cursor },
				select: { id: true },
			}))
		)
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		const rows = await prisma.accessEvent.findMany({
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: {
				id: true,
				userDisplayName: true,
				userId: true,
				actor: true,
				method: true,
				path: true,
				clientIp: true,
				statusCode: true,
				createdAt: true,
			},
		});
		const events = rows.slice(0, limit);
		return NextResponse.json(
			{ events, nextCursor: rows.length > limit ? events.at(-1)?.id : null },
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (error) {
		return authError(error);
	}
}
