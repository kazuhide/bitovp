import { vmafComputeCredentialCreateSchema } from "@bitovp/core";
import { createVmafComputeCredentialStore } from "@bitovp/db";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { jsonError, readJson } from "@/lib/server/http";
import { vmafSettingsError } from "@/lib/server/vmaf-profile-settings";

export async function GET() {
	try {
		const ctx = await getServerContext();
		return NextResponse.json({
			items: await createVmafComputeCredentialStore(
				ctx.prisma,
				ctx.cipher,
			).list(),
		});
	} catch (error) {
		return vmafSettingsError(error);
	}
}
export async function POST(req: Request) {
	const parsed = vmafComputeCredentialCreateSchema.safeParse(
		await readJson(req),
	);
	if (!parsed.success) return jsonError(400, "Invalid cloud credential");
	try {
		const ctx = await getServerContext();
		const row = await createVmafComputeCredentialStore(
			ctx.prisma,
			ctx.cipher,
		).create(parsed.data);
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: "/api/settings/vmaf-credentials",
				statusCode: 201,
				response: { id: row.id, provider: row.provider },
			},
			req,
		);
		return NextResponse.json(row, { status: 201 });
	} catch (error) {
		return vmafSettingsError(error);
	}
}
