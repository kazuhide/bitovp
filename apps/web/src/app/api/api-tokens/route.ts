import { getTenantPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { EXPERIMENT_TOKEN_PREFIX, mintToken } from "@/lib/auth/api-token";
import { isHumanActor } from "@/lib/auth/api-token-gate";
import { ENCODING_EXPERIMENT_SCOPE } from "@/lib/auth/encoding-experiment-scope";
import { authError } from "@/lib/auth/route-context";
import { AuthContextError, requireOrganizationAdmin } from "@/lib/auth/tenancy";

const schema = z
	.strictObject({
		name: z.string().trim().min(1).max(120),
		expiresDays: z.number().int().positive().max(36500).optional(),
		scope: z.literal(ENCODING_EXPERIMENT_SCOPE).optional(),
		role: z.enum(["VIEWER", "OPERATOR"]).optional(),
	})
	.refine((input) => input.scope !== undefined || input.role === undefined);
export async function GET(req: Request) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		const rows = await getTenantPrisma(
			context.organizationId,
		).apiToken.findMany({
			orderBy: { createdAt: "desc" },
			select: {
				id: true,
				name: true,
				prefix: true,
				role: true,
				scope: true,
				createdAt: true,
				expiresAt: true,
				revokedAt: true,
				lastUsedAt: true,
			},
		});
		return NextResponse.json(rows, {
			headers: { "cache-control": "private, no-store" },
		});
	} catch (err) {
		return authError(err);
	}
}
export async function POST(req: Request) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		if (!isHumanActor(context.actor))
			throw new AuthContextError(403, "Sign in to create a token");
		const input = schema.safeParse(await req.json());
		if (!input.success)
			return NextResponse.json(
				{
					error:
						"Body must include a name and may specify an expiry and experiment scope",
				},
				{ status: 400 },
			);
		const { secret, prefix, tokenHash } = mintToken(
			input.data.scope === undefined ? undefined : EXPERIMENT_TOKEN_PREFIX,
		);
		const row = await getTenantPrisma(context.organizationId).apiToken.create({
			data: {
				name: input.data.name,
				prefix,
				tokenHash,
				organizationId: context.organizationId,
				userId: context.actorUserId,
				createdBy: context.actor,
				role: input.data.role ?? "OPERATOR",
				...(input.data.scope === undefined ? {} : { scope: input.data.scope }),
				...(input.data.expiresDays === undefined
					? {}
					: {
							expiresAt: new Date(
								Date.now() + input.data.expiresDays * 86400000,
							),
						}),
			},
		});
		return NextResponse.json(
			{
				id: row.id,
				name: row.name,
				prefix: row.prefix,
				expiresAt: row.expiresAt,
				secret,
				...(input.data.scope === undefined
					? {}
					: { scope: row.scope, role: row.role }),
			},
			{ status: 201, headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		return authError(err);
	}
}
