import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeAllowedIpCidrs } from "@/lib/auth/ip-policy";
import { authError } from "@/lib/auth/route-context";
import { requirePlatformOwner } from "@/lib/auth/tenancy";

const schema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	active: z.boolean().optional(),
	allowedIpCidrs: z.array(z.string()).max(100).optional(),
});
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		await requirePlatformOwner(req.headers);
		const { id } = await params;
		const input = schema.safeParse(await req.json());
		if (!input.success || Object.keys(input.data).length === 0)
			return NextResponse.json(
				{ error: "name, active or allowedIpCidrs required" },
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
