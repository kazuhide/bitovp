import "server-only";
import type { EncodingPlan } from "@bitovp/core";
import { verifyInputTimelinePreparation } from "@bitovp/storage";
import { getServerContext } from "./context";
import { browserForCredentialId } from "./storage";

export async function validateVodInputPreparation(
	plan: EncodingPlan,
	allowExpired = false,
) {
	if (!plan.inputTimelinePreparation) return;
	const ctx = await getServerContext();
	if (!ctx.tenant || ctx.tenant.isImpersonating)
		throw new Error("INPUT_PREPARATION_INVALID");
	await verifyInputTimelinePreparation({
		plan,
		organizationId: ctx.tenant.organizationId,
		allowExpired,
		findTask: (id) =>
			ctx.prisma.vodInputPreviewTask.findUnique({ where: { id } }),
		browserFor: async (credentialId) => {
			const browser = await browserForCredentialId(
				ctx,
				credentialId,
				undefined,
				{ readTimeoutMs: 15_000 },
			);
			if (!browser) throw new Error("CREDENTIAL_UNAVAILABLE");
			return browser;
		},
		signal: AbortSignal.timeout(120_000),
	});
}
