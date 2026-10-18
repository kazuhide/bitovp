"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Translator } from "@/lib/i18n/context";
import { LIST_LIMIT_MAX, type PageDto } from "@/lib/infrastructure/schemas";

/**
 * Offset-paged list fetch for the infrastructure proxy routes (C6): Bitmovin
 * caps every list at limit 100, so a single request can NEVER see more than
 * 100 items — pages append via "Load more" and totalCount is surfaced so a
 * 140-item account cannot silently render as 100.
 *
 * `url` must already contain a query string (the hook appends &limit/&offset).
 */
export function useOffsetList<T>(queryKey: readonly unknown[], url: string) {
	const query = useInfiniteQuery({
		queryKey,
		queryFn: ({ pageParam }) =>
			apiFetch<PageDto<T>>(
				`${url}&limit=${LIST_LIMIT_MAX}&offset=${pageParam}`,
			),
		initialPageParam: 0,
		getNextPageParam: (last: PageDto<T>, pages: PageDto<T>[]) => {
			const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
			if (last.totalCount !== undefined) {
				return loaded < last.totalCount ? loaded : null;
			}
			// No totalCount from upstream — a full page means more may exist.
			return last.items.length >= LIST_LIMIT_MAX ? loaded : null;
		},
	});
	const items = query.data?.pages.flatMap((page) => page.items) ?? [];
	const totalCount = query.data?.pages.at(-1)?.totalCount;
	return { ...query, items, totalCount };
}

/**
 * Footer copy for the list: "3 of 140" (or just "3" if upstream omits totalCount).
 *
 * Takes the translator rather than formatting English here — the word between the
 * two numbers is copy, and this helper is the only place it appears.
 */
export function shownOfTotal(
	shown: number,
	totalCount: number | undefined,
	t: Translator,
) {
	return totalCount !== undefined
		? t("settingsX.shownOfTotal", { shown, total: totalCount })
		: String(shown);
}
