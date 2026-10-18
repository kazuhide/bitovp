import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/route-context";
import { AuthContextError, requirePlatformOwner } from "@/lib/auth/tenancy";
import {
	generateTemporaryPassword,
	hashPassword,
	invalidateUserCache,
	TEMP_PASSWORD_TTL_MS,
} from "@/lib/auth/users";

const schema = z.strictObject({
	active: z.boolean().optional(),
	resetPassword: z.literal(true).optional(),
});
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { user: actor } = await requirePlatformOwner(req.headers);
		const { id } = await params;
		const input = schema.safeParse(await req.json());
		if (!input.success || Object.keys(input.data).length === 0)
			return NextResponse.json(
				{ error: "active or resetPassword required" },
				{ status: 400 },
			);
		if (
			id === actor.id &&
			(input.data.active === false || input.data.resetPassword)
		)
			throw new AuthContextError(
				409,
				"Use another owner for this account action",
			);
		const temporaryPassword = input.data.resetPassword
			? generateTemporaryPassword()
			: null;
		const passwordHash = temporaryPassword
			? hashPassword(temporaryPassword)
			: null;
		const user = await getIdentityPrisma().$transaction(
			async (tx) => {
				const target = await tx.user.findUnique({
					where: { id },
					select: { id: true, platformOwner: true, active: true },
				});
				if (!target) throw new AuthContextError(403, "User is unavailable");
				if (
					target.platformOwner &&
					target.active &&
					input.data.active === false &&
					(await tx.user.count({
						where: { platformOwner: true, active: true, id: { not: id } },
					})) === 0
				)
					throw new AuthContextError(409, "Keep an active platform owner");
				return tx.user.update({
					where: { id },
					data: {
						...(input.data.active === undefined
							? {}
							: { active: input.data.active }),
						...(passwordHash
							? {
									passwordHash,
									mustChangePassword: true,
									passwordExpiresAt: new Date(
										Date.now() + TEMP_PASSWORD_TTL_MS,
									),
								}
							: {}),
						sessionsValidFrom: new Date(),
						sessionGeneration: { increment: 1 },
					},
					select: {
						id: true,
						email: true,
						displayName: true,
						active: true,
						platformOwner: true,
					},
				});
			},
			{ isolationLevel: "Serializable" },
		);
		invalidateUserCache(id);
		return NextResponse.json(
			{ user, ...(temporaryPassword ? { temporaryPassword } : {}) },
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		if ((err as { code?: string }).code === "P2034")
			return NextResponse.json(
				{ error: "Concurrent account edit — retry" },
				{ status: 409 },
			);
		return authError(err);
	}
}
