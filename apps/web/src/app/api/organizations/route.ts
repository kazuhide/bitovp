import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/route-context";
import {
	listOrganizations,
	requirePlatformOwner,
	resolveSessionIdentity,
} from "@/lib/auth/tenancy";

const schema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	slug: z
		.string()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.max(100),
});
export async function GET(req: Request) {
	try {
		const { user } = await resolveSessionIdentity(req.headers);
		const organizations = user.platformOwner
			? await getIdentityPrisma().organization.findMany({
					select: {
						id: true,
						name: true,
						slug: true,
						active: true,
						allowedIpCidrs: true,
					},
					orderBy: { createdAt: "asc" },
				})
			: await listOrganizations(user.id);
		return NextResponse.json(
			{ organizations },
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		return authError(err);
	}
}
export async function POST(req: Request) {
	try {
		const { user } = await requirePlatformOwner(req.headers);
		const input = schema.safeParse(await req.json());
		if (!input.success)
			return NextResponse.json(
				{ error: "name and a URL-safe slug are required" },
				{ status: 400 },
			);
		const organization = await getIdentityPrisma().$transaction(async (tx) => {
			const org = await tx.organization.create({ data: input.data });
			await tx.membership.create({
				data: { userId: user.id, organizationId: org.id, role: "ADMIN" },
			});
			return org;
		});
		return NextResponse.json({ organization }, { status: 201 });
	} catch (err) {
		if ((err as { code?: string }).code === "P2002")
			return NextResponse.json(
				{ error: "Organization slug already exists" },
				{ status: 409 },
			);
		return authError(err);
	}
}
