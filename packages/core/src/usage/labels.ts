import { z } from "zod";
import { usageDateRangeSchema } from "./backfill";
import {
	addUtcDays,
	USAGE_BUCKETS,
	type UsageSeries,
	utcDayKey,
} from "./statistics";

/** Request-time label reads are bounded independently of stored account history. */
export const LABEL_USAGE_MAX_DAYS = 90;
export const usageLabelSchema = z
	.string()
	.min(1)
	.max(256)
	.refine(
		(value) =>
			!value.includes(",") &&
			[...value].every(
				(character) =>
					character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
			),
		"Select a single label without commas or control characters",
	);
const metric = z.number().finite();
const nullableMetric = metric.nullable();
const metricsSchema = z.object({
	billableEncodingMinutes: nullableMetric,
	bytesEncoded: nullableMetric,
	billableEgressBytes: nullableMetric,
});
export const labelUsageSeriesSchema = z.object({
	scope: z.literal("LABEL"),
	account: z.object({ id: z.string(), label: z.string() }),
	label: usageLabelSchema,
	from: z.string(),
	to: z.string(),
	days: z.array(metricsSchema.extend({ date: z.string() })),
	totals: metricsSchema,
	breakdown: z.array(
		z.object({
			codec: z.string(),
			resolution: z.string(),
			billableMinutes: metric,
		}),
	),
	coverage: z.object({ missingDays: z.number().int().nonnegative() }),
	refreshedAt: z.string(),
});
export type LabelUsageSeries = z.infer<typeof labelUsageSeriesSchema>;
export type DashboardUsageSeries = UsageSeries | LabelUsageSeries;
export function isLabelUsageSeries(
	data: DashboardUsageSeries,
): data is LabelUsageSeries {
	return "scope" in data && data.scope === "LABEL";
}

const labelRecordSchema = z.object({
	label: z.string(),
	date: z.union([z.date(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
	bytesEncoded: metric.optional(),
	billableEncodingMinutes: z
		.array(
			z.object({
				codec: z.string().optional(),
				billableMinutes: z
					.object(
						Object.fromEntries(
							USAGE_BUCKETS.map((bucket) => [bucket, metric.optional()]),
						),
					)
					.optional(),
			}),
		)
		.optional(),
	billableEgressBytes: z.array(z.object({ bytes: metric })).optional(),
});
const daySchema = z.object({
	date: z.union([z.date(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
	labels: z.array(labelRecordSchema),
});

/** Combined label statistics cannot establish separate VOD/Live byte totals or Units. */
export function buildLabelUsageSeries(input: {
	account: { id: string; label: string };
	label: string;
	from: string;
	to: string;
	rows: readonly unknown[];
	readAt: Date;
}): LabelUsageSeries {
	usageLabelSchema.parse(input.label);
	usageDateRangeSchema.parse({ from: input.from, to: input.to });
	if (
		(new Date(input.to).getTime() - new Date(input.from).getTime()) /
			86_400_000 >=
		LABEL_USAGE_MAX_DAYS
	)
		throw new Error("Label statistics range exceeds the read limit");
	const byDay = new Map<
		string,
		z.infer<typeof labelRecordSchema> | undefined
	>();
	for (const value of input.rows) {
		const row = daySchema.parse(value);
		const date = row.date instanceof Date ? utcDayKey(row.date) : row.date;
		if (
			date < input.from ||
			date > input.to ||
			byDay.has(date) ||
			utcDayKey(new Date(`${date}T00:00:00Z`)) !== date
		)
			throw new Error("Invalid label statistics date");
		if (
			row.labels.length > 1 ||
			row.labels.some(
				(label) =>
					label.label !== input.label ||
					(label.date !== undefined &&
						(label.date instanceof Date
							? utcDayKey(label.date)
							: label.date) !== date),
			)
		)
			throw new Error("Unexpected label statistics identity");
		byDay.set(date, row.labels[0]);
	}
	const breakdown = new Map<string, LabelUsageSeries["breakdown"][number]>();
	const days: LabelUsageSeries["days"] = [];
	for (let date = input.from; date <= input.to; date = addUtcDays(date, 1)) {
		const row = byDay.get(date);
		let minutes: number | null = row?.billableEncodingMinutes ? 0 : null;
		for (const entry of row?.billableEncodingMinutes ?? []) {
			if (
				!entry.billableMinutes ||
				!USAGE_BUCKETS.some(
					(bucket) => entry.billableMinutes?.[bucket] !== undefined,
				)
			) {
				minutes = null;
				continue;
			}
			for (const bucket of USAGE_BUCKETS) {
				const value = entry.billableMinutes[bucket] ?? 0;
				if (minutes !== null) minutes += value;
				if (value === 0) continue;
				const codec = entry.codec ?? "UNKNOWN";
				const key = JSON.stringify([codec, bucket]);
				const aggregated = breakdown.get(key) ?? {
					codec,
					resolution: bucket,
					billableMinutes: 0,
				};
				aggregated.billableMinutes += value;
				breakdown.set(key, aggregated);
			}
		}
		days.push({
			date,
			billableEncodingMinutes: minutes,
			bytesEncoded: row?.bytesEncoded ?? null,
			billableEgressBytes:
				row?.billableEgressBytes?.reduce(
					(sum, entry) => sum + entry.bytes,
					0,
				) ?? null,
		});
	}
	const total = (key: keyof z.infer<typeof metricsSchema>) =>
		days.some((day) => day[key] === null)
			? null
			: days.reduce((sum, day) => sum + (day[key] ?? 0), 0);
	return labelUsageSeriesSchema.parse({
		scope: "LABEL",
		account: input.account,
		label: input.label,
		from: input.from,
		to: input.to,
		days,
		totals: {
			billableEncodingMinutes: total("billableEncodingMinutes"),
			bytesEncoded: total("bytesEncoded"),
			billableEgressBytes: total("billableEgressBytes"),
		},
		breakdown: [...breakdown.values()].sort(
			(a, b) => b.billableMinutes - a.billableMinutes,
		),
		coverage: {
			missingDays: days.filter((day) =>
				Object.values(day).some((value) => value === null),
			).length,
		},
		refreshedAt: input.readAt.toISOString(),
	});
}
