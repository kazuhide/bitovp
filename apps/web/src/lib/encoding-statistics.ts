export const statisticsViews = [
	"totals",
	"daily",
	"live",
	"vod",
	"labels",
	"daily-labels",
	"cdn",
	"live-options",
] as const;

export type StatisticsView = (typeof statisticsViews)[number];
export type StatisticsValue = number | string;
export type StatisticsRow = Record<string, StatisticsValue>;
export type StatisticsPage = {
	offset: number;
	totalCount: number;
	received: number;
	nextOffset: number | null;
};
export type EncodingStatisticsResult = {
	rows: StatisticsRow[];
	totals?: StatisticsRow;
	page?: StatisticsPage;
};

export const STATISTICS_PAGE_SIZE = 25;
export const CDN_MAX_DAYS = 100;
export const DAY_MS = 86_400_000;

export function hasStatisticsPagination(view: StatisticsView, range: boolean) {
	return (
		view !== "cdn" &&
		view !== "live-options" &&
		(view !== "totals" || range) &&
		(view !== "daily" || !range)
	);
}

/** The next request starts after the actual response rows, including short pages. */
export function inspectStatisticsPage(
	offset: number,
	totalCount: number,
	received: number,
	providerOffset: number | undefined,
	pageable: boolean,
): StatisticsPage | undefined {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(totalCount) ||
		totalCount < 0 ||
		!Number.isSafeInteger(received) ||
		received < 0 ||
		(providerOffset !== undefined && providerOffset !== offset)
	)
		return;
	const remaining = Math.max(0, totalCount - offset);
	if (
		received > remaining ||
		(received === 0 && remaining > 0) ||
		(pageable && received > STATISTICS_PAGE_SIZE)
	)
		return;
	return {
		offset,
		totalCount,
		received,
		nextOffset: pageable && received < remaining ? offset + received : null,
	};
}
