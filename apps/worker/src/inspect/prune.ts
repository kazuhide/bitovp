import type { AppPrismaClient } from "@bitovp/db";

/**
 * : StorageInspection rows accumulate one per inspect, forever, and
 * each holds CUSTOMER data — bucket name, object key, probed media metadata.
 * This prunes by AGE alone (the `createdAt(sort: Desc)` index was kept for
 * exactly this), riding the 30s heartbeat sweep as a cheap indexed delete
 * that usually removes nothing.
 *
 * DECISION, recorded in the row: history is KEPT within the window rather
 * than collapsed to latest-per-object — the latest-only surfacing (#25) is a
 * UI gap, and collapsing storage would forever destroy the history a future
 * history view needs. Default 30 days; 0 disables.
 */
export const INSPECTION_RETENTION_DAYS_DEFAULT = 30;

export function createInspectionPrune(deps: {
	prisma: AppPrismaClient;
	retentionDays?: number;
	now(): string;
}) {
	const days = deps.retentionDays ?? INSPECTION_RETENTION_DAYS_DEFAULT;
	return async function pruneInspections(): Promise<number> {
		if (days === 0) {
			return 0;
		}
		const cutoff = new Date(
			new Date(deps.now()).getTime() - days * 24 * 60 * 60 * 1000,
		);
		const { count } = await deps.prisma.storageInspection.deleteMany({
			where: { createdAt: { lt: cutoff } },
		});
		return count;
	};
}
