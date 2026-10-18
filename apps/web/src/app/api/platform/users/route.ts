import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { authError } from "@/lib/auth/route-context";
import { requirePlatformOwner } from "@/lib/auth/tenancy";
export async function GET(req: Request) {
	try {
		await requirePlatformOwner(req.headers);
		const users = await getIdentityPrisma().user.findMany({
			select: {
				id: true,
				email: true,
				displayName: true,
				active: true,
				platformOwner: true,
				memberships: {
					select: { organizationId: true, role: true, active: true },
				},
			},
			orderBy: { createdAt: "asc" },
		});
		return NextResponse.json(
			{ users },
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		return authError(err);
	}
}
