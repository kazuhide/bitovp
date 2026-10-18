import { z } from "zod";
import { usageStatisticsBackfillSchema } from "./backfill";
import {
	addUtcDays,
	USAGE_REREAD_DAYS,
	USAGE_RETENTION_DAYS,
	USAGE_STATISTIC_KINDS,
	type UsageStatisticKind,
	utcDayKey,
} from "./statistics";

export const USAGE_REFRESH_TTL_MS = 15 * 60_000;
export const USAGE_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000;
export const usageStatisticsRefreshSchema = z.strictObject({
	accountId: z.uuid(),
	mode: z.literal("automatic"),
});
export const usageStatisticsRequestSchema = z.union([
	usageStatisticsRefreshSchema,
	usageStatisticsBackfillSchema.safeExtend({ mode: z.never().optional() }),
]);
export type UsageRefreshCursor = {
	kind: UsageStatisticKind;
	sweptThrough: Date;
	sweptAt: Date;
};

export function usageRefreshRange(
	now: Date,
	cursors: UsageRefreshCursor[],
): { from: string; to: string } {
	const today = utcDayKey(now);
	const initialFrom = addUtcDays(today, -(USAGE_RETENTION_DAYS - 1));
	const starts = USAGE_STATISTIC_KINDS.map((kind) => {
		const cursor = cursors.find((row) => row.kind === kind);
		return cursor
			? addUtcDays(utcDayKey(cursor.sweptThrough), -USAGE_REREAD_DAYS)
			: initialFrom;
	});
	const oldest = starts.sort()[0] ?? initialFrom;
	return {
		from:
			oldest < "2013-01-01" ? "2013-01-01" : oldest > today ? today : oldest,
		to: today,
	};
}
export function usageRefreshIsFresh(
	now: Date,
	cursors: UsageRefreshCursor[],
): boolean {
	const today = utcDayKey(now);
	return USAGE_STATISTIC_KINDS.every((kind) => {
		const row = cursors.find((cursor) => cursor.kind === kind);
		return (
			row !== undefined &&
			utcDayKey(row.sweptThrough) >= today &&
			row.sweptAt.getTime() > now.getTime() - USAGE_REFRESH_TTL_MS &&
			row.sweptAt.getTime() <= now.getTime()
		);
	});
}
