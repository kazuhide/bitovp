import { MEDIA_TASK_STATES } from "@bitovp/core";
import { z } from "zod";
import { MAX_LIBRARY_OFFSET } from "@/lib/library-catalog";

export const GENERATION_HISTORY_PAGE_SIZE = 25;
export const GENERATION_HISTORY_PERIODS = ["day", "week", "month"] as const;

export const generationHistoryFilters = z.strictObject({
	q: z.string().trim().max(200).default(""),
	state: z.enum(["", ...MEDIA_TASK_STATES]).default(""),
	period: z.enum(["", ...GENERATION_HISTORY_PERIODS]).default(""),
	offset: z.coerce.number().int().min(0).max(MAX_LIBRARY_OFFSET).default(0),
});

export type GenerationHistoryFilters = z.infer<typeof generationHistoryFilters>;

export function readGenerationHistoryFilters(
	value: Record<string, unknown>,
): GenerationHistoryFilters {
	return {
		q: generationHistoryFilters.shape.q.catch("").parse(value.q),
		state: generationHistoryFilters.shape.state.catch("").parse(value.state),
		period: generationHistoryFilters.shape.period.catch("").parse(value.period),
		offset: generationHistoryFilters.shape.offset.catch(0).parse(value.offset),
	};
}

export function generationHistorySearch(filters: GenerationHistoryFilters) {
	const search = new URLSearchParams();
	if (filters.q.trim()) search.set("q", filters.q.trim());
	if (filters.state) search.set("state", filters.state);
	if (filters.period) search.set("period", filters.period);
	if (filters.offset) search.set("offset", String(filters.offset));
	return search;
}

export const generationHistorySchema = z.object({
	items: z
		.array(
			z.object({
				taskId: z.uuid(),
				state: z.enum(MEDIA_TASK_STATES),
				contentTitle: z.string().nullable(),
				updatedAt: z.iso.datetime(),
				clips: z
					.array(
						z.object({
							projectId: z.uuid(),
							title: z.string(),
							exportId: z.uuid().nullable(),
						}),
					)
					.max(3),
			}),
		)
		.max(GENERATION_HISTORY_PAGE_SIZE),
	hasMore: z.boolean(),
});

export type GenerationHistory = z.infer<typeof generationHistorySchema>;
