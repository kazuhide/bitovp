import "server-only";
import { LiveOptionsType } from "@bitmovin/api-sdk";
import { z } from "zod";
import {
	DAY_MS,
	type EncodingStatisticsResult,
	hasStatisticsPagination,
	inspectStatisticsPage,
	STATISTICS_PAGE_SIZE,
	type StatisticsRow,
	type StatisticsView,
} from "@/lib/encoding-statistics";
import { bitmovinClientFromBinding } from "./bitmovin";

const metric = z.number().finite().nonnegative().optional();
// Provider billing adjustments can reduce billed minutes below zero.
const billedMinutes = z.number().finite().optional();
const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const instant = date.transform((value) => new Date(value).toISOString());
const day = date.transform((value) =>
	value.length === 10 ? value : new Date(value).toISOString().slice(0, 10),
);
const totals = z.object({
	date: day.optional(),
	bytesEncodedTotal: metric,
	timeEncodedTotal: metric,
	bytesEgressTotal: metric,
});
const daily = z.object({
	date: day,
	bytesEncoded: metric,
	timeEncoded: metric,
	billableMinutes: billedMinutes,
	billableTransmuxingMinutes: billedMinutes,
});
const encoding = z.object({
	date: day,
	bytesEncoded: metric,
	timeEncoded: metric,
	bytesEgress: metric,
	billableTransmuxingMinutes: billedMinutes,
	billableFeatureMinutes: billedMinutes,
});
const vod = encoding.extend({ timeEnqueued: metric, realtimeFactor: metric });
const label = z.object({
	label: z.string(),
	billableMinutes: billedMinutes,
	billableTransmuxingMinutes: billedMinutes,
});
const dailyLabels = z
	.object({
		date: day,
		labels: z.array(daily.extend({ date: day.optional(), label: z.string() })),
	})
	.refine(({ date, labels }) =>
		labels.every(
			({ date: labelDate }) => labelDate === undefined || labelDate === date,
		),
	);
const cdn = z.object({
	from: instant,
	to: instant,
	storageUsageTotal: metric,
	transferUsageTotal: metric,
	usage: z.array(
		z.object({
			from: instant,
			to: instant,
			storageUsage: metric,
			transferUsage: metric,
		}),
	),
});
const liveOptions = z.object({
	encodingId: z.uuid(),
	type: z.enum(LiveOptionsType),
	unitsUsed: metric,
});
const liveIdentity = z.object({ id: z.uuid(), type: z.literal("LIVE") });
const envelope = z.object({
	status: z.literal("SUCCESS"),
	data: z.object({ result: z.unknown() }),
});
const safeInteger = z.number().int().nonnegative();
const providerPage = z.object({
	items: z.array(z.unknown()),
	totalCount: safeInteger,
	offset: safeInteger.optional(),
});

type Query = {
	view: StatisticsView;
	offset: number;
	label?: string;
	range?: { from: string; to: string };
	encodingId?: string;
};
type Binding = Parameters<typeof bitmovinClientFromBinding>[0];
export class ProviderEncodingNotFound extends Error {}

function row(data: Record<string, string | number | undefined>): StatisticsRow {
	const fields: StatisticsRow = {};
	for (const [key, value] of Object.entries(data))
		if (value !== undefined) fields[key] = value;
	return fields;
}

export async function readProviderStatistics(
	binding: Binding,
	query: Query,
	signal: AbortSignal,
): Promise<EncodingStatisticsResult> {
	let result: unknown;
	const api = bitmovinClientFromBinding(
		binding,
		signal,
		async (_url, response) => {
			if (response.ok)
				result = envelope.parse(await response.clone().json()).data.result;
		},
	);
	const pageQuery = { offset: query.offset, limit: STATISTICS_PAGE_SIZE };
	const labelQuery = {
		...pageQuery,
		...(query.label && { labels: query.label }),
	};
	const { range } = query;
	// The SDK takes date path parameters from local calendar parts. Use the
	// selected calendar day as a local Date so the serialized key stays exact.
	const bounds = range
		? ([
				new Date(`${range.from}T12:00:00`),
				new Date(`${range.to}T12:00:00`),
			] as const)
		: undefined;
	const { view } = query;
	const pageable = hasStatisticsPagination(view, !!range);
	let schema:
		| z.ZodType<Record<string, string | number | undefined>>
		| undefined;

	switch (view) {
		case "totals":
			if (!bounds) {
				await api.encoding.statistics.get();
				return { rows: [row(totals.parse(result))] };
			}
			await api.encoding.statistics.list(...bounds, pageQuery);
			schema = totals;
			break;
		case "daily":
			if (bounds)
				await api.encoding.statistics.daily.listByDateRange(...bounds);
			else await api.encoding.statistics.daily.list(pageQuery);
			schema = daily;
			break;
		case "live":
			if (bounds)
				await api.encoding.statistics.encodings.live.listByDateRange(
					...bounds,
					pageQuery,
				);
			else await api.encoding.statistics.encodings.live.list(pageQuery);
			schema = encoding;
			break;
		case "vod":
			if (bounds)
				await api.encoding.statistics.encodings.vod.listByDateRange(
					...bounds,
					pageQuery,
				);
			else await api.encoding.statistics.encodings.vod.list(pageQuery);
			schema = vod;
			break;
		case "labels":
			if (bounds)
				await api.encoding.statistics.labels.listByDateRange(
					...bounds,
					labelQuery,
				);
			else await api.encoding.statistics.labels.list(labelQuery);
			schema = label;
			break;
		case "daily-labels":
			if (bounds)
				await api.encoding.statistics.labels.daily.listByDateRange(
					...bounds,
					labelQuery,
				);
			else await api.encoding.statistics.labels.daily.list(labelQuery);
			break;
		case "cdn": {
			if (!range) throw new Error("Missing CDN date range");
			// CDN query parameters are ISO instants with an exclusive end.
			const from = new Date(range.from);
			const to = new Date(Date.parse(range.to) + DAY_MS);
			await api.encoding.statistics.cdn.usage.get({ from, to });
			const { usage, ...total } = cdn.parse(result);
			if (
				total.from !== from.toISOString() ||
				total.to !== to.toISOString() ||
				usage.some(
					(entry) =>
						entry.from < total.from ||
						entry.to > total.to ||
						entry.from >= entry.to,
				)
			)
				throw new Error("Unexpected CDN statistics interval");
			return { rows: usage.map(row), totals: row(total) };
		}
		case "live-options": {
			const { encodingId } = query;
			if (!encodingId) throw new Error("Missing encoding ID");
			try {
				await api.encoding.encodings.get(encodingId);
			} catch (err) {
				if ((err as { httpStatusCode?: number } | null)?.httpStatusCode === 404)
					throw new ProviderEncodingNotFound();
				throw err;
			}
			const parsed = liveIdentity.safeParse(result);
			if (!parsed.success || parsed.data.id !== encodingId)
				throw new ProviderEncodingNotFound();
			result = undefined;
			await api.encoding.statistics.encodings.live.options.get(encodingId);
			const options = liveOptions.parse(result);
			if (options.encodingId !== encodingId)
				throw new Error("Unexpected options encoding");
			return { rows: [row(options)] };
		}
	}

	const wire = providerPage.parse(result);
	const page = inspectStatisticsPage(
		query.offset,
		wire.totalCount,
		wire.items.length,
		wire.offset,
		pageable,
	);
	if (!page) throw new Error("Invalid statistics page");
	const rows = schema
		? wire.items.map((item) => row(schema.parse(item)))
		: wire.items.flatMap((item) => {
				const { date, labels } = dailyLabels.parse(item);
				return labels.map((item) => row({ ...item, date }));
			});
	for (const item of rows) {
		if (
			(query.label && item.label !== query.label) ||
			(query.range &&
				typeof item.date === "string" &&
				(item.date < query.range.from || item.date > query.range.to))
		)
			throw new Error("Unexpected statistics entry");
	}
	return { rows, page };
}
