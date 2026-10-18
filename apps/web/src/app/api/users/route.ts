import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/route-context";
import {
	AuthContextError,
	requireOrganizationAdmin,
	requirePlatformOwner,
} from "@/lib/auth/tenancy";
import {
	generateTemporaryPassword,
	hashPassword,
	normalizeEmail,
	TEMP_PASSWORD_TTL_MS,
} from "@/lib/auth/users";

const schema = z.strictObject({
	email: z.string().email().max(320),
	displayName: z.string().min(1).max(120),
	role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
});
export async function GET(req: Request) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		if (!context.actorUserId)
			throw new AuthContextError(
				403,
				"User membership management requires users mode",
			);
		const memberships = await getIdentityPrisma().membership.findMany({
			where: { organizationId: context.organizationId },
			select: {
				role: true,
				active: true,
				user: {
					select: {
						id: true,
						email: true,
						displayName: true,
						mustChangePassword: true,
						lastLoginAt: true,
						createdAt: true,
					},
				},
			},
			orderBy: { user: { createdAt: "asc" } },
		});
		return NextResponse.json(
			{
				users: memberships.map((member) => ({
					...member.user,
					role: member.role,
					active: member.active,
				})),
			},
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		return authError(err);
	}
}
export async function POST(req: Request) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		if (!context.actorUserId)
			throw new AuthContextError(
				403,
				"User membership management requires users mode",
			);
		await requirePlatformOwner(req.headers);
		const input = schema.safeParse(await req.json());
		if (!input.success)
			return NextResponse.json(
				{ error: "email, displayName and role are required" },
				{ status: 400 },
			);
		const email = normalizeEmail(input.data.email);
		const db = getIdentityPrisma();
		const existing = await db.user.findUnique({
			where: { email },
			select: { id: true, email: true, displayName: true },
		});
		const temporaryPassword = existing ? null : generateTemporaryPassword();
		const user = await db.$transaction(async (tx) => {
			const created =
				existing ??
				(await tx.user.create({
					data: {
						email,
						displayName: input.data.displayName.trim(),
						passwordHash: hashPassword(temporaryPassword as string),
						mustChangePassword: true,
						passwordExpiresAt: new Date(Date.now() + TEMP_PASSWORD_TTL_MS),
					},
					select: { id: true, email: true, displayName: true },
				}));
			await tx.membership.create({
				data: {
					userId: created.id,
					organizationId: context.organizationId,
					role: input.data.role,
				},
			});
			return { ...created, role: input.data.role, active: true };
		});
		return NextResponse.json(
			{ user, ...(temporaryPassword ? { temporaryPassword } : {}) },
			{ status: 201, headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		if ((err as { code?: string }).code === "P2002")
			return NextResponse.json(
				{ error: "This membership already exists" },
				{ status: 409 },
			);
		return authError(err);
	}
}
