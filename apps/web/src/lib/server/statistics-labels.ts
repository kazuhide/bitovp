import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import {
	addUtcDays,
	buildLabelUsageSeries,
	LABEL_USAGE_MAX_DAYS,
	usageDateRangeSchema,
	usageLabelSchema,
	utcDayKey,
	utcDayStart,
} from "@bitovp/core";
import { z } from "zod";

const LIMIT = 100;
const MAX_ITEMS = 1000;
const WINDOW_DAYS = 25;
const pageSchema = z.object({
	items: z.array(z.unknown()).max(LIMIT),
	totalCount: z.number().int().nonnegative().max(MAX_ITEMS),
});

export type LabelCatalogPage = {
	labels: string[];
	offset: number;
	totalCount: number;
	nextOffset: number | null;
	readAt: string;
	source: "PROVIDER" | "CACHE";
};

export class LabelCatalogRestartError extends Error {}

// Successful metadata only, never daily metrics or credentials. Routes supply
// account + credential/tenant revision; each request still resolves its account.
const catalogCache = new Map<
	string,
	{ expires: number; page: LabelCatalogPage; scope: string }
>();
const catalogGenerations = new Map<string, symbol>();
const CATALOG_CACHE_MS = 60_000;
const MAX_CACHED_PAGES = 128;

export async function readLabelCatalogPage(
	api: BitmovinApi,
	options: {
		offset: number;
		label?: string;
		totalCount?: number;
		cacheScope?: string;
		refresh?: boolean;
	},
): Promise<LabelCatalogPage> {
	const { offset, label, totalCount, cacheScope, refresh } = options;
	if (
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset >= MAX_ITEMS ||
		(label !== undefined &&
			(!usageLabelSchema.safeParse(label).success || offset !== 0)) ||
		(refresh &&
			(offset !== 0 || label !== undefined || totalCount !== undefined))
	)
		throw new LabelStatisticsError(400, "Invalid label catalog query");
	const now = Date.now();
	for (const [key, entry] of catalogCache)
		if (entry.expires <= now) catalogCache.delete(key);
	const invalidateScope = (scope: string) => {
		for (const [key, entry] of catalogCache)
			if (entry.scope === scope) catalogCache.delete(key);
	};
	if (cacheScope && (refresh || !catalogGenerations.has(cacheScope))) {
		invalidateScope(cacheScope);
		if (!catalogGenerations.has(cacheScope)) {
			while (catalogGenerations.size >= MAX_CACHED_PAGES) {
				const oldest = catalogGenerations.keys().next().value;
				if (oldest !== undefined) {
					catalogGenerations.delete(oldest);
					invalidateScope(oldest);
				}
			}
		}
		catalogGenerations.set(cacheScope, Symbol());
	}
	const generation = cacheScope
		? catalogGenerations.get(cacheScope)
		: undefined;
	const key = cacheScope
		? JSON.stringify([cacheScope, offset, label ?? null])
		: undefined;
	const cached = key ? catalogCache.get(key) : undefined;
	if (cached) {
		if (totalCount !== undefined && cached.page.totalCount !== totalCount)
			throw new LabelCatalogRestartError("Label statistics pagination changed");
		return { ...cached.page, labels: [...cached.page.labels], source: "CACHE" };
	}
	const page = pageSchema.parse(
		await api.encoding.statistics.labels.list({
			limit: LIMIT,
			offset,
			...(label !== undefined ? { labels: label } : {}),
		}),
	);
	if (
		(totalCount !== undefined && page.totalCount !== totalCount) ||
		offset + page.items.length > page.totalCount ||
		(page.items.length === 0 && offset < page.totalCount)
	)
		throw new LabelCatalogRestartError("Label statistics pagination changed");
	const labels = page.items.map(
		(row) => z.object({ label: z.string().min(1).max(256) }).parse(row).label,
	);
	if (
		new Set(labels).size !== labels.length ||
		(label !== undefined &&
			(page.totalCount > 1 || labels.some((name) => name !== label)))
	)
		throw new Error("Invalid statistics label page");
	const result: LabelCatalogPage = {
		labels,
		offset,
		totalCount: page.totalCount,
		nextOffset:
			offset + labels.length < page.totalCount ? offset + labels.length : null,
		readAt: new Date().toISOString(),
		source: "PROVIDER",
	};
	if (key && cacheScope && catalogGenerations.get(cacheScope) === generation) {
		while (catalogCache.size >= MAX_CACHED_PAGES) {
			const oldest = catalogCache.keys().next().value;
			if (oldest !== undefined) catalogCache.delete(oldest);
		}
		catalogCache.set(key, {
			expires: Date.now() + CATALOG_CACHE_MS,
			page: result,
			scope: cacheScope,
		});
	}
	return { ...result, labels: [...result.labels] };
}

/** The SDK fills omitted arrays with []; retain the wire page before model coercion. */
export function labelStatisticsWireReader() {
	let page: unknown;
	let reading = false;
	return {
		async observe(url: string, response: Response) {
			if (
				!response.ok ||
				!/\/encoding\/statistics\/labels\/daily\//.test(new URL(url).pathname)
			)
				return;
			if (page !== undefined || reading)
				throw new Error("Label statistics wire page not consumed");
			reading = true;
			try {
				const body = z
					.object({ data: z.object({ result: pageSchema }) })
					.parse(await response.clone().json());
				page = body.data.result;
			} finally {
				reading = false;
			}
		},
		take() {
			if (page === undefined)
				throw new Error("Label statistics wire page missing");
			const result = page;
			page = undefined;
			return result;
		},
	};
}

export class LabelStatisticsError extends Error {
	constructor(
		readonly status: 400 | 404 | 502,
		message: string,
	) {
		super(message);
	}
}

/** Follow totalCount, including short nonterminal pages; never return a partial list. */
async function allPages(fetchPage: (offset: number) => Promise<unknown>) {
	const result: unknown[] = [];
	let expected: number | undefined;
	for (let pages = 0; pages < 20; pages += 1) {
		const page = pageSchema.parse(await fetchPage(result.length));
		expected ??= page.totalCount;
		if (
			page.totalCount !== expected ||
			result.length + page.items.length > expected
		)
			throw new Error("Label statistics pagination changed");
		result.push(...page.items);
		if (result.length === expected) return result;
		if (page.items.length === 0)
			throw new Error("Incomplete label statistics page");
	}
	throw new Error("Label statistics page limit reached");
}

export async function readLabelCatalog(api: BitmovinApi): Promise<string[]> {
	let requests = 0;
	let expected: number | undefined;
	const pages = new Map<number, Promise<z.infer<typeof pageSchema>>>();
	const read = (offset: number) => {
		const cached = pages.get(offset);
		if (cached) return cached;
		if (requests >= 20) throw new Error("Label statistics page limit reached");
		requests += 1;
		const page = api.encoding.statistics.labels
			.list({ limit: LIMIT, offset })
			.then((value) => {
				const parsed = pageSchema.parse(value);
				expected ??= parsed.totalCount;
				if (parsed.totalCount !== expected)
					throw new Error("Label statistics pagination changed");
				return parsed;
			});
		pages.set(offset, page);
		return page;
	};
	const first = await read(0);
	if (first.items.length === LIMIT) {
		const offsets: number[] = [];
		for (let offset = LIMIT; offset < first.totalCount; offset += LIMIT)
			offsets.push(offset);
		for (let index = 0; index < offsets.length; index += 3)
			await Promise.all(offsets.slice(index, index + 3).map(read));
	}
	const rows = await allPages(async (offset) => {
		const page = await read(offset);
		if (page.items.length < Math.min(LIMIT, page.totalCount - offset)) {
			// A short page changes the next offset: discard later guesses, then
			// continue sequentially from the actual received length without gaps.
			for (const key of pages.keys()) if (key > offset) pages.delete(key);
		}
		return page;
	});
	const labels = rows.map(
		(row) => z.object({ label: z.string().min(1).max(256) }).parse(row).label,
	);
	if (new Set(labels).size !== labels.length)
		throw new Error("Duplicate statistics label");
	return labels.sort((a, b) => a.localeCompare(b));
}

// SDK DATE path parameters use the process's local calendar, not UTC getters.
function pathDay(key: string) {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** Preserve wire metric presence while accepting calendar dates and zoned ISO dates. */
function statisticsDay(value: unknown): string {
	if (value instanceof Date) return utcDayKey(z.date().parse(value));
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
		return z.iso.date().parse(value);
	return utcDayKey(new Date(z.iso.datetime({ offset: true }).parse(value)));
}

function normalizeStatisticsDay(value: unknown) {
	const row = z
		.object({ date: z.unknown(), labels: z.array(z.unknown()) })
		.passthrough()
		.parse(value);
	return {
		...row,
		date: statisticsDay(row.date),
		labels: row.labels.map((value) => {
			const label = z
				.object({ date: z.unknown().optional() })
				.passthrough()
				.parse(value);
			return label.date === undefined
				? label
				: { ...label, date: statisticsDay(label.date) };
		}),
	};
}

export async function readLabelUsage(
	api: BitmovinApi,
	account: { id: string; label: string },
	label: string,
	from: string,
	to: string,
	wirePage?: () => unknown,
) {
	if (
		!usageLabelSchema.safeParse(label).success ||
		!usageDateRangeSchema.safeParse({ from, to }).success ||
		(utcDayStart(to).getTime() - utcDayStart(from).getTime()) / 86_400_000 >=
			LABEL_USAGE_MAX_DAYS
	)
		throw new LabelStatisticsError(
			400,
			`Label statistics support one label and at most ${LABEL_USAGE_MAX_DAYS} days`,
		);
	if (
		!(await readLabelCatalogPage(api, { offset: 0, label })).labels.includes(
			label,
		)
	)
		throw new LabelStatisticsError(
			404,
			"Statistics label not found for this account",
		);
	const rows: unknown[] = [];
	for (let start = from; start <= to; start = addUtcDays(start, WINDOW_DAYS)) {
		const candidate = addUtcDays(start, WINDOW_DAYS - 1);
		const end = candidate < to ? candidate : to;
		const window = await allPages(async (offset) => {
			const modeled =
				await api.encoding.statistics.labels.daily.listByDateRange(
					pathDay(start),
					pathDay(end),
					{
						labels: label,
						limit: LIMIT,
						offset,
					},
				);
			return wirePage ? wirePage() : modeled;
		});
		for (const value of window) {
			const row = normalizeStatisticsDay(value);
			if (row.date < start || row.date > end)
				throw new Error("Label statistics day outside requested window");
			rows.push(row);
		}
	}
	return buildLabelUsageSeries({
		account,
		label,
		from,
		to,
		rows,
		readAt: new Date(),
	});
}
