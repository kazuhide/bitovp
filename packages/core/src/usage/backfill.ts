import { z } from "zod";
import { utcDayKey } from "./statistics";

/** Historical aggregate statistics are not limited to the routine sweep window. */
export const usageDateRangeSchema = z
	.object({ from: z.iso.date(), to: z.iso.date() })
	.refine((r) => r.from >= "2013-01-01" && r.from <= r.to, {
		message: "from must be between 2013-01-01 and to",
		path: ["from"],
	})
	.refine((r) => r.to <= utcDayKey(new Date()), {
		message: "to must not be in the future (UTC)",
		path: ["to"],
	});

export const usageStatisticsBackfillSchema = usageDateRangeSchema.safeExtend({
	accountId: z.uuid(),
});
export type UsageStatisticsBackfill = z.infer<
	typeof usageStatisticsBackfillSchema
>;
export const USAGE_BACKFILL_SETTING_PREFIX = "usage.backfill.";
export const usageBackfillDataSchema = usageStatisticsBackfillSchema.safeExtend(
	{
		automatic: z.literal(true).optional(),
	},
);
export const usageBackfillJobSchema = usageBackfillDataSchema.safeExtend({
	generation: z.uuid(),
});

export const usageBackfillProgressSchema = z.object({
	completedChunks: z.number().int().nonnegative(),
	totalChunks: z.number().int().positive(),
	rowsUpserted: z.number().int().nonnegative(),
	/** Resume only after all rows of a chunk have been stored. */
	through: z.object({
		VOD: z.iso.date().optional(),
		LIVE: z.iso.date().optional(),
	}),
});
export type UsageBackfillProgress = z.infer<typeof usageBackfillProgressSchema>;
export type UsageBackfillStatus = UsageStatisticsBackfill & {
	automatic?: true;
	status: "queued" | "running" | "completed" | "failed";
	completedChunks: number;
	totalChunks: number;
	rowsUpserted: number;
	error: string | null;
};

export const usageBackfillJobId = (accountId: string, generation: string) =>
	`usage-${accountId}-${generation}`;
