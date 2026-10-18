import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	normalizeAllowedIpCidrs,
	verifiedClientIp,
} from "@/lib/auth/ip-policy";
import { authError } from "@/lib/auth/route-context";
import { AuthContextError, requireOrganizationAdmin } from "@/lib/auth/tenancy";

const schema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	allowedIpCidrs: z.array(z.string()).max(100).optional(),
});
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		const { id } = await params;
		if (context.organizationId !== id)
			throw new AuthContextError(403, "Manage only your current organization");
		const organization = await getIdentityPrisma().organization.findUnique({
			where: { id },
			select: {
				id: true,
				name: true,
				slug: true,
				active: true,
				allowedIpCidrs: true,
			},
		});
		return NextResponse.json(
			{ organization, clientIp: verifiedClientIp(req.headers) },
			{ headers: { "cache-control": "private, no-store" } },
		);
	} catch (err) {
		return authError(err);
	}
}
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const context = await requireOrganizationAdmin(req.headers);
		if (!context.actorUserId)
			throw new AuthContextError(
				403,
				"Organization management requires users mode",
			);
		const { id } = await params;
		if (context.organizationId !== id)
			throw new AuthContextError(403, "Manage only your current organization");
		const input = schema.safeParse(await req.json());
		if (!input.success || Object.keys(input.data).length === 0)
			return NextResponse.json(
				{ error: "name or allowedIpCidrs required" },
				{ status: 400 },
			);
		let allowedIpCidrs: string[] | undefined;
		try {
			allowedIpCidrs =
				input.data.allowedIpCidrs === undefined
					? undefined
					: normalizeAllowedIpCidrs(input.data.allowedIpCidrs);
		} catch {
			return NextResponse.json(
				{
					error: "Invalid CIDR allowlist",
					details: { code: "TENANT_IP_INVALID" },
				},
				{ status: 400 },
			);
		}
		const organization = await getIdentityPrisma().organization.update({
			where: { id },
			data: { ...input.data, allowedIpCidrs },
			select: {
				id: true,
				name: true,
				slug: true,
				active: true,
				allowedIpCidrs: true,
			},
		});
		return NextResponse.json({ organization });
	} catch (err) {
		return authError(err);
	}
}
