import "server-only";
import { audioCopyRendition, type EncodingPlan } from "@bitovp/core";
import { resolveInspectedAudioSource } from "@bitovp/db";
import { verifyInputTimelinePreparation } from "@bitovp/storage";
import { getServerContext } from "./context";
import { browserForCredentialId } from "./storage";

export async function validateVodInputPreparation(
	plan: EncodingPlan,
	allowExpired = false,
) {
	const copy = audioCopyRendition(plan);
	if (!plan.inputTimelinePreparation && !copy) return;
	const ctx = await getServerContext();
	if (!ctx.tenant || ctx.tenant.isImpersonating)
		throw new Error("INPUT_PREPARATION_INVALID");
	if (copy) {
		if (
			!process.env.BITOVP_CAPTURE_INPUT_BASE_URL ||
			(process.env.BITOVP_CAPTURE_INPUT_SECRET?.length ?? 0) < 32
		)
			throw new Error("INPUT_CAPTURE_CONFIGURATION_INVALID");
		await resolveInspectedAudioSource(
			ctx.prisma,
			ctx.tenant.organizationId,
			plan,
		);
		return;
	}
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
