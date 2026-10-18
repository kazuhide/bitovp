import { createVmafComputeCredentialStore } from "@bitovp/db";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse } from "@/lib/server/http";
import { vmafSettingsError } from "@/lib/server/vmaf-profile-settings";

export async function DELETE(
	req: Request,
	context: { params: Promise<{ id: string }> },
) {
	const { id } = await context.params;
	const invalid = invalidIdResponse(id);
	if (invalid) return invalid;
	try {
		const ctx = await getServerContext();
		await createVmafComputeCredentialStore(ctx.prisma, ctx.cipher).disable(id);
		await writeAuditLog(
			ctx,
			{
				method: "DELETE",
				path: "/api/settings/vmaf-credentials/[id]",
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
