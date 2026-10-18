import { createVmafExecutionProfileStore } from "@bitovp/db";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { jsonError } from "@/lib/server/http";
import { vmafSettingsError } from "@/lib/server/vmaf-profile-settings";

export async function DELETE(
	req: Request,
	context: { params: Promise<{ id: string }> },
) {
	const { id } = await context.params;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id))
		return jsonError(400, "Invalid profile id");
	try {
		const ctx = await getServerContext();
		await createVmafExecutionProfileStore(ctx.prisma).disable(id);
		await writeAuditLog(
			ctx,
			{
				method: "DELETE",
				path: "/api/settings/vmaf-profiles/[id]",
				statusCode: 204,
				response: { id, disabled: true },
			},
			req,
		);
		return new Response(null, { status: 204 });
	} catch (error) {
		return vmafSettingsError(error);
	}
}
