type Page = { offset: number; limit: number };
type CollectionResult<Row> = {
	items?: Row[];
	totalCount?: number;
	offset?: number;
};

/** Validate the full provider response before using any row from the visible window. */
export function inspectChildWindow<Row extends { id?: string }>(
	result: CollectionResult<Row> | undefined,
	page: Page,
	wholeCollection: boolean,
	validId: (id: string) => boolean,
	targetId?: string,
) {
	const total = result?.totalCount;
	const rows = result?.items;
	const start = wholeCollection ? page.offset : 0;
	const end = start + page.limit;
	if (
		typeof total !== "number" ||
		!Number.isSafeInteger(total) ||
		total < 0 ||
		!Array.isArray(rows) ||
		(result?.offset !== undefined &&
			result.offset !== (wholeCollection ? 0 : page.offset))
	)
		return;
	if (
		wholeCollection
			? rows.length > total || (rows.length === 0 && total > 0)
			: rows.length !== Math.min(page.limit, Math.max(0, total - page.offset))
	)
		return;

	const seen = new Set<string>();
	let containsTarget = false;
	for (const [index, row] of rows.entries()) {
		const id = row?.id;
		if (typeof id !== "string" || seen.has(id) || !validId(id)) return;
		seen.add(id);
		if (id === targetId && index >= start && index < end) containsTarget = true;
	}
	return {
		rows,
		start,
		end,
		total,
		available: wholeCollection ? rows.length : total,
		containsTarget,
	};
}
