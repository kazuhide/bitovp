import type { AppPrismaClient } from "./client";

/**
 * THE query for webhook consumers (P1 orchestrator and beyond): only
 * signature-verified, not-yet-processed deliveries may drive state.
 * Unverified rows exist for diagnostics in Settings → Webhooks ONLY —
 * anyone on the internet can produce them (the receiver is public).
 */
export function findProcessableWebhookEvents(
	prisma: AppPrismaClient,
	limit = 100,
) {
	return prisma.webhookEvent.findMany({
		where: { signatureValid: true, processedAt: null },
		orderBy: { receivedAt: "asc" },
		take: Math.min(Math.max(limit, 1), 100),
	});
}
