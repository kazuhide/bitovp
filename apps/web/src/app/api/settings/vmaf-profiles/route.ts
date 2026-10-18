import { vmafExecutionProfileSaveSchema } from "@bitovp/core";
import { createVmafExecutionProfileStore } from "@bitovp/db";
import { NextResponse } from "next/server";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { jsonError, readJson } from "@/lib/server/http";
import { vmafSettingsError } from "@/lib/server/vmaf-profile-settings";

export async function GET() {
	try {
		return NextResponse.json({
			items: await createVmafExecutionProfileStore(
				(await getServerContext()).prisma,
			).list(),
		});
	} catch (error) {
		return vmafSettingsError(error);
	}
}
export async function POST(req: Request) {
	const parsed = vmafExecutionProfileSaveSchema.safeParse(await readJson(req));
	if (!parsed.success) return jsonError(400, "Invalid cloud execution profile");
	try {
		const ctx = await getServerContext();
		const row = await createVmafExecutionProfileStore(ctx.prisma).save(
			parsed.data,
		);
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: "/api/settings/vmaf-profiles",
				statusCode: 200,
				response: { id: row.id, version: row.version, enabled: row.enabled },
			},
			req,
		);
		return NextResponse.json(row);
	} catch (error) {
		return vmafSettingsError(error);
	}
}
