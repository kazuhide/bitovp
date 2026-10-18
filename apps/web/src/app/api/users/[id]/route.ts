import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/route-context";
import { AuthContextError, requireOrganizationAdmin } from "@/lib/auth/tenancy";

const schema = z.strictObject({
	role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]).optional(),
	active: z.boolean().optional(),
});
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		if (!context.actorUserId)
			throw new AuthContextError(
				403,
				"User membership management requires users mode",
			);
		const { id } = await params;
		const input = schema.safeParse(await req.json());
		if (!input.success || Object.keys(input.data).length === 0)
			return NextResponse.json(
				{
					error: "Only organization role and membership active can be changed",
				},
				{ status: 400 },
			);
		const updated = await getIdentityPrisma().$transaction(
			async (tx) => {
				const where = {
					userId_organizationId: {
						userId: id,
						organizationId: context.organizationId,
					},
				};
				const target = await tx.membership.findUnique({ where });
				if (!target)
					throw new AuthContextError(403, "No membership in this organization");
				if (
					target.active &&
					target.role === "ADMIN" &&
					(input.data.active === false ||
						(input.data.role && input.data.role !== "ADMIN"))
				) {
					const others = await tx.membership.count({
						where: {
							organizationId: context.organizationId,
							active: true,
							role: "ADMIN",
							userId: { not: id },
							user: { active: true },
						},
					});
					if (others === 0)
						throw new AuthContextError(
							409,
							"Promote another active organization administrator first",
						);
				}
				const member = await tx.membership.update({
					where,
					data: input.data,
					include: {
						user: {
							select: {
								id: true,
								email: true,
								displayName: true,
								mustChangePassword: true,
							},
						},
					},
				});
				return { ...member.user, role: member.role, active: member.active };
			},
			{ isolationLevel: "Serializable" },
		);
		return NextResponse.json({ user: updated });
	} catch (err) {
		if ((err as { code?: string }).code === "P2034")
			return NextResponse.json(
				{ error: "Concurrent membership edit — retry" },
				{ status: 409 },
			);
		return authError(err);
	}
}
