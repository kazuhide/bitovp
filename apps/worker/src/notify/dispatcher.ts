import type { AppPrismaClient } from "@bitovp/db";
import { findProcessableWebhookEvents } from "@bitovp/db";

/**
 * Inbound webhook dispatcher ( PR3 — this is #16's missing
 * caller). Claims verified, unprocessed rows ATOMICALLY (updateMany on
 * processedAt: null — two workers race, exactly one wins each row) and
 * publishes the encoding id as a wake signal. NO state transition happens
 * here: the poll loops stay the single writer, this only makes their next
 * poll immediate. Rows with signatureValid=false are never even read —
 * findProcessableWebhookEvents filters them, the schema comment's contract,
 * now enforced by a caller that actually exists.
 */

export type DispatchStats = {
	claimed: number;
	published: number;
	/** Claimed rows whose payload names no encoding — processed, undispatchable. */
	unmapped: number;
};

function encodingIdOf(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.encodingId === "string") {
		return record.encodingId;
	}
	const encoding = record.encoding;
	if (
		typeof encoding === "object" &&
		encoding !== null &&
		typeof (encoding as Record<string, unknown>).id === "string"
	) {
		return (encoding as Record<string, unknown>).id as string;
	}
	return undefined;
}

export function createInboundDispatcher(deps: {
	prisma: AppPrismaClient;
	publish(encodingId: string): Promise<void>;
	now(): Date;
}) {
	return async function runOnce(): Promise<DispatchStats> {
		const rows = await findProcessableWebhookEvents(deps.prisma);
		const stats: DispatchStats = { claimed: 0, published: 0, unmapped: 0 };
		for (const row of rows) {
			const { count } = await deps.prisma.webhookEvent.updateMany({
				// processedAt: null in the WHERE is the atomicity: a concurrent
				// dispatcher that already claimed this row makes count 0 here.
				where: { id: row.id, processedAt: null },
				data: { processedAt: deps.now() },
			});
			if (count === 0) {
				continue;
			}
			stats.claimed += 1;
			const encodingId = encodingIdOf(row.raw);
			if (!encodingId) {
				stats.unmapped += 1;
				continue;
			}
			// Best-effort: a publish failure must not unclaim the row (the poll
			// covers it regardless) nor abort the batch.
			try {
				await deps.publish(encodingId);
				stats.published += 1;
			} catch (err) {
				console.error(
					"[dispatch] publish failed (poll covers it):",
					err instanceof Error ? err.message : err,
				);
			}
		}
		return stats;
	};
}
