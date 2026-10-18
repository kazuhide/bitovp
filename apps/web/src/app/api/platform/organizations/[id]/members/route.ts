import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { authError } from "@/lib/auth/route-context";
import { requirePlatformOwner } from "@/lib/auth/tenancy";
import { invalidIdResponse } from "@/lib/server/http";

/** Identity inventory only: recovery does not depend on the owner's selected organization. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		await requirePlatformOwner(req.headers);
		const { id } = await params;
		const invalid = invalidIdResponse(id);
		if (invalid) return invalid;
		const organization = await getIdentityPrisma().organization.findUnique({
			where: { id },
			select: { active: true },
		});
		if (!organization?.active)
			return NextResponse.json(
				{ error: "Organization is unavailable" },
				{ status: 404 },
			);
		const members = await getIdentityPrisma().membership.findMany({
			where: {
				organizationId: id,
				active: true,
				user: { active: true, mustChangePassword: false },
			},
			select: {
				role: true,
				user: {
					select: { id: true, displayName: true, email: true, active: true },
				},
			},
			orderBy: { userId: "asc" },
		});
		return NextResponse.json(
			members.map(({ role, user }) => ({ ...user, role })),
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		return authError(err);
	}
}
