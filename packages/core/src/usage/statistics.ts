import { z } from "zod";

/**
 *  — the dashboard's usage series, built from `UsageDailyStatistic`
 * rows the worker snapshots from Bitmovin's daily VOD / live statistics.
 *
 * Why a snapshot: individual encoding metadata expires, aggregates settle late,
 * and every list endpoint pages at ≤100 rows — so the dashboard never asks
 * the provider at request time. The worker sweeps every few hours, re-reads
 * the trailing `USAGE_REREAD_DAYS`, and the series is derived here from what
 * was stored. Coverage distinguishes missing snapshots from measured zero.
 */
export const USAGE_STATISTIC_KINDS = ["VOD", "LIVE"] as const;
export type UsageStatisticKind = (typeof USAGE_STATISTIC_KINDS)[number];

/** Default automatic import window; not a limit on aggregate history. */
export const USAGE_RETENTION_DAYS = 90;
/** Daily aggregates settle late; each sweep re-reads this many trailing days. */
export const USAGE_REREAD_DAYS = 3;
export const USAGE_PERIOD_DAYS = [7, 30, 90] as const;
export type UsagePeriodDays = (typeof USAGE_PERIOD_DAYS)[number];

export const USAGE_BUCKETS = ["SD", "HD", "UHD", "AUDIO", "UNKNOWN"] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** `yyyy-mm-dd` in UTC — the provider's calendar day. */
export function utcDayKey(d: Date): string {
	return d.toISOString().slice(0, 10);
}
export function utcDayStart(key: string): Date {
	return new Date(`${key}T00:00:00.000Z`);
}
export function addUtcDays(key: string, days: number): string {
	return utcDayKey(new Date(utcDayStart(key).getTime() + days * DAY_MS));
}

/** The SDK's daily statistics row, typed by the fields this module reads. */
export type ProviderDailyStatistics = {
	date?: Date | string;
	/** Joined from the separate Live options endpoint; never derived from minutes. */
	liveHdUnits?: number;
	bytesEncoded?: number;
	timeEncoded?: number;
	bytesEgress?: number;
	billableTransmuxingMinutes?: number;
	billableFeatureMinutes?: number;
	billableEncodingMinutes?: {
		encodingMode?: string;
		codec?: string;
		live?: boolean;
		billableMinutes?: Partial<Record<UsageBucket, number>>;
	}[];
	streams?: {
		codec?: string;
		resolution?: string;
		width?: number;
		height?: number;
		encodedSeconds?: number;
		billableMinutes?: number;
	}[];
	features?: { featureType?: string; billableMinutes?: number }[];
	billableEgressBytes?: {
		category?: string;
		outputType?: string;
		outputRegion?: string;
		bytes?: number;
	}[];
};

export const usageBreakdownSchema = z.object({
	/** Missing in legacy snapshots; missing is unknown, not zero. */
	liveHdUnits: z.number().nonnegative().optional(),
	buckets: z.record(z.enum(USAGE_BUCKETS), z.number()),
	/** Daily billing classes, not exact picture geometry. Absent in old snapshots. */
	encodingClasses: z
		.array(
			z.object({
				codec: z.string(),
				resolution: z.enum(USAGE_BUCKETS),
				billableMinutes: z.number(),
			}),
		)
		.optional(),
	transmuxingMinutes: z.number(),
	featureMinutes: z.number(),
	streams: z.array(
		z.object({
			codec: z.string(),
			resolution: z.string(),
			encodedSeconds: z.number().nullable(),
			billableMinutes: z.number(),
		}),
	),
	features: z.array(
		z.object({ featureType: z.string(), billableMinutes: z.number() }),
	),
	egress: z.array(
		z.object({
			category: z.string(),
			outputType: z.string(),
			region: z.string(),
			bytes: z.number(),
		}),
	),
});
export type UsageBreakdown = z.infer<typeof usageBreakdownSchema>;

export type UsageDayRow = {
	/** Needed to establish complete multi-account Live Units, absent in old callers. */
	bitmovinAccountId?: string;
	date: string;
	kind: UsageStatisticKind;
	bytesEncoded: number;
	/** Legacy name: preserves raw provider timeEncoded; unit/meaning unverified. */
	timeEncodedS: number;
	bytesEgress: number;
	billableMinutes: number;
	breakdown: UsageBreakdown;
};

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNum(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyBuckets(): Record<UsageBucket, number> {
	return { SD: 0, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 };
}

/**
 * One provider day → one row. `null` when the provider gave no date (a row
 * without a day cannot be stored, and the sweep skips it loudly).
 * `billableMinutes` = encoding buckets + transmuxing + feature minutes —
 * a legacy application-derived sum, NOT the provider's reported total.
 * Keep it stable for API consumers; chart encoding-only bucket sums instead.
 */
export function summarizeProviderDay(
	kind: UsageStatisticKind,
	raw: ProviderDailyStatistics,
): UsageDayRow | null {
	const date =
		raw.date instanceof Date
			? raw.date
			: typeof raw.date === "string"
				? new Date(raw.date)
				: null;
	if (!date || Number.isNaN(date.getTime())) {
		return null;
	}
	const buckets = emptyBuckets();
	const encodingClasses: NonNullable<UsageBreakdown["encodingClasses"]> = [];
	for (const entry of raw.billableEncodingMinutes ?? []) {
		for (const bucket of USAGE_BUCKETS) {
			const minutes = num(entry.billableMinutes?.[bucket]);
			buckets[bucket] += minutes;
			if (minutes !== 0)
				encodingClasses.push({
					codec: entry.codec ?? "UNKNOWN",
					resolution: bucket,
					billableMinutes: minutes,
				});
		}
	}
	const encodingMinutes = USAGE_BUCKETS.reduce((t, b) => t + buckets[b], 0);
	const transmuxingMinutes = num(raw.billableTransmuxingMinutes);
	const featureMinutes = num(raw.billableFeatureMinutes);
	return {
		date: utcDayKey(date),
		kind,
		bytesEncoded: num(raw.bytesEncoded),
		timeEncodedS: num(raw.timeEncoded),
		bytesEgress: num(raw.bytesEgress),
		billableMinutes: encodingMinutes + transmuxingMinutes + featureMinutes,
		breakdown: {
			...(kind === "LIVE" && raw.liveHdUnits !== undefined
				? { liveHdUnits: raw.liveHdUnits }
				: {}),
			buckets,
			encodingClasses,
			transmuxingMinutes,
			featureMinutes,
			streams: (raw.streams ?? []).map((s) => ({
				codec: s.codec ?? "UNKNOWN",
				// Prefer the exact geometry: the SDK's `resolution` is the SD/HD/UHD
				// enum, which the bucket table already shows (rev426 O3).
				resolution:
					s.width && s.height
						? `${s.width}x${s.height}`
						: (s.resolution ?? "UNKNOWN"),
				encodedSeconds: nullableNum(s.encodedSeconds),
				billableMinutes: num(s.billableMinutes),
			})),
			features: (raw.features ?? []).map((f) => ({
				featureType: f.featureType ?? "UNKNOWN",
				billableMinutes: num(f.billableMinutes),
			})),
			egress: (raw.billableEgressBytes ?? []).map((e) => ({
				category: e.category ?? "UNKNOWN",
				outputType: e.outputType ?? "UNKNOWN",
				region: e.outputRegion ?? "UNKNOWN",
				bytes: num(e.bytes),
			})),
		},
	};
}

/** What `GET /api/dashboard/usage` answers. */
const kindTotalsSchema = z.object({
	/** Bucket sum only; excludes features/transmuxing, unlike the legacy total. */
	billableEncodingMinutes: z.number(),
	billableFeatureMinutes: z.number(),
	billableTransmuxingMinutes: z.number(),
	billableMinutes: z.number(),
	bytesEncoded: z.number(),
	bytesEgress: z.number(),
	timeEncodedS: z.number(),
});
export const usageSeriesSchema = z.object({
	/** Absent in legacy payloads; explicit snapshots establish complete reads. */
	coverage: z
		.object({
			days: z.array(
				z.object({ date: z.string(), VOD: z.boolean(), LIVE: z.boolean() }),
			),
			missingDays: z.number().int().nonnegative(),
		})
		.optional(),
	liveHd: z
		.object({
			days: z.array(
				z.object({
					date: z.string(),
					units: z.number().nonnegative().nullable(),
				}),
			),
			totalUnits: z.number().nonnegative().nullable(),
			missingDays: z.number().int().nonnegative(),
		})
		.optional(),
	from: z.string(),
	to: z.string(),
	days: z.array(
		z.object({
			date: z.string(),
			VOD: kindTotalsSchema,
			LIVE: kindTotalsSchema,
		}),
	),
	totals: z.object({ VOD: kindTotalsSchema, LIVE: kindTotalsSchema }),
	breakdown: z.object({
		buckets: z.object({
			VOD: z.record(z.enum(USAGE_BUCKETS), z.number()),
			LIVE: z.record(z.enum(USAGE_BUCKETS), z.number()),
		}),
		codecResolution: z.array(
			z.object({
				kind: z.enum(USAGE_STATISTIC_KINDS),
				codec: z.string(),
				resolution: z.string(),
				billableMinutes: z.number(),
				encodedSeconds: z.number().nullable(),
				/** Optional for old API payloads; current responses always distinguish sources. */
				source: z.enum(["STREAM", "ENCODING_CLASS"]).optional(),
			}),
		),
		/** Nonquiet account×day×kind records lacking codec detail, not calendar days. */
		codecResolutionMissingRows: z
			.object({
				VOD: z.number().int().nonnegative(),
				LIVE: z.number().int().nonnegative(),
			})
			.optional(),
		egress: z.array(
			z.object({ category: z.string(), region: z.string(), bytes: z.number() }),
		),
	}),
	accounts: z.array(z.object({ id: z.string(), label: z.string() })),
	/**
	 * The OLDEST successful read among the selected accounts × kinds, or null
	 * while any of them has never been swept. Derived from the sweep cursors,
	 * never from row presence: the provider omits quiet days (rev426 R2).
	 */
	refreshedAt: z.string().nullable(),
	/** Days in the range after the oldest cursor — not yet read for every selected account × kind. */
	pendingDays: z.number(),
});
export type UsageSeries = z.infer<typeof usageSeriesSchema>;

function emptyKindTotals() {
	return {
		billableEncodingMinutes: 0,
		billableFeatureMinutes: 0,
		billableTransmuxingMinutes: 0,
		billableMinutes: 0,
		bytesEncoded: 0,
		bytesEgress: 0,
		timeEncodedS: 0,
	};
}

/** One sweep cursor row: how far one account × kind has been read. */
export type UsageSweepCursorRow = {
	bitmovinAccountId: string;
	kind: UsageStatisticKind;
	/** `yyyy-mm-dd` (UTC), inclusive. */
	sweptThrough: string;
	sweptAt: Date;
};

/**
 * Freshness from the cursors, not from the rows: Bitmovin omits days with no
 * activity, so an absent row is not a pending day. Every selected account ×
 * kind must have been swept for the note to name a time; the oldest cursor
 * bounds both the time and the pending days (rev426 R2).
 */
export function usageFreshness(input: {
	from: string;
	to: string;
	accountIds: readonly string[];
	cursors: readonly UsageSweepCursorRow[];
}): { refreshedAt: string | null; pendingDays: number } {
	const dayCount =
		Math.round(
			(utcDayStart(input.to).getTime() - utcDayStart(input.from).getTime()) /
				DAY_MS,
		) + 1;
	let oldestThrough: string | null = null;
	let oldestAt: Date | null = null;
	for (const accountId of input.accountIds) {
		for (const kind of USAGE_STATISTIC_KINDS) {
			const cursor = input.cursors.find(
				(c) => c.bitmovinAccountId === accountId && c.kind === kind,
			);
			if (!cursor) {
				return { refreshedAt: null, pendingDays: dayCount };
			}
			if (oldestThrough === null || cursor.sweptThrough < oldestThrough) {
				oldestThrough = cursor.sweptThrough;
			}
			if (oldestAt === null || cursor.sweptAt < oldestAt) {
				oldestAt = cursor.sweptAt;
			}
		}
	}
	if (oldestThrough === null || oldestAt === null) {
		return { refreshedAt: null, pendingDays: dayCount };
	}
	let pendingDays = 0;
	for (let key = input.from; key <= input.to; key = addUtcDays(key, 1)) {
		if (key > oldestThrough) pendingDays += 1;
	}
	return { refreshedAt: oldestAt.toISOString(), pendingDays };
}

/**
 * Rows (possibly several accounts per day and kind) → the series for
 * [from, to], every day present, accounts summed, breakdown aggregated;
 * freshness from the cursors of the SELECTED accounts (`accountIds`).
 */
export function buildUsageSeries(input: {
	from: string;
	to: string;
	rows: UsageDayRow[];
	accounts: { id: string; label: string }[];
	/** The accounts the rows were selected for (all, or the filtered one). */
	accountIds: readonly string[];
	cursors: readonly UsageSweepCursorRow[];
}): UsageSeries {
	const byDay = new Map<
		string,
		{
			VOD: ReturnType<typeof emptyKindTotals>;
			LIVE: ReturnType<typeof emptyKindTotals>;
		}
	>();
	const totals = { VOD: emptyKindTotals(), LIVE: emptyKindTotals() };
	const buckets = { VOD: emptyBuckets(), LIVE: emptyBuckets() };
	const codecResolutionMissingRows = { VOD: 0, LIVE: 0 };
	const codecRes = new Map<
		string,
		UsageSeries["breakdown"]["codecResolution"][number]
	>();
	const egress = new Map<
		string,
		{ category: string; region: string; bytes: number }
	>();
	for (const row of input.rows) {
		if (row.date < input.from || row.date > input.to) {
			continue;
		}
		const day = byDay.get(row.date) ?? {
			VOD: emptyKindTotals(),
			LIVE: emptyKindTotals(),
		};
		for (const target of [day[row.kind], totals[row.kind]]) {
			target.billableEncodingMinutes += USAGE_BUCKETS.reduce(
				(sum, bucket) => sum + num(row.breakdown.buckets[bucket]),
				0,
			);
			target.billableFeatureMinutes += row.breakdown.featureMinutes;
			target.billableTransmuxingMinutes += row.breakdown.transmuxingMinutes;
			target.billableMinutes += row.billableMinutes;
			target.bytesEncoded += row.bytesEncoded;
			target.bytesEgress += row.bytesEgress;
			target.timeEncodedS += row.timeEncodedS;
		}
		byDay.set(row.date, day);
		for (const bucket of USAGE_BUCKETS) {
			buckets[row.kind][bucket] += row.breakdown.buckets[bucket] ?? 0;
		}
		// One source per account/day: streams and daily classes describe the
		// same encoding activity and must never be added to each other.
		const source =
			row.breakdown.streams.length > 0 ? "STREAM" : "ENCODING_CLASS";
		const entries =
			source === "STREAM"
				? row.breakdown.streams
				: (row.breakdown.encodingClasses ?? []).map((entry) => ({
						...entry,
						encodedSeconds: null,
					}));
		if (
			entries.length === 0 &&
			USAGE_BUCKETS.some((bucket) => num(row.breakdown.buckets[bucket]) !== 0)
		)
			codecResolutionMissingRows[row.kind] += 1;
		for (const s of entries) {
			const key = JSON.stringify([row.kind, source, s.codec, s.resolution]);
			const agg = codecRes.get(key) ?? {
				kind: row.kind,
				source,
				codec: s.codec,
				resolution: s.resolution,
				billableMinutes: 0,
				encodedSeconds: 0,
			};
			agg.billableMinutes += s.billableMinutes;
			agg.encodedSeconds =
				agg.encodedSeconds === null || s.encodedSeconds === null
					? null
					: agg.encodedSeconds + s.encodedSeconds;
			codecRes.set(key, agg);
		}
		for (const e of row.breakdown.egress) {
			const key = `${e.category}/${e.region}`;
			const agg = egress.get(key) ?? {
				category: e.category,
				region: e.region,
				bytes: 0,
			};
			agg.bytes += e.bytes;
			egress.set(key, agg);
		}
	}
	const days: UsageSeries["days"] = [];
	for (let key = input.from; key <= input.to; key = addUtcDays(key, 1)) {
		const day = byDay.get(key) ?? {
			VOD: emptyKindTotals(),
			LIVE: emptyKindTotals(),
		};
		days.push({ date: key, VOD: day.VOD, LIVE: day.LIVE });
	}
	const rowsByIdentity = new Map<string, UsageDayRow[]>();
	for (const row of input.rows) {
		const key = `${row.bitmovinAccountId}/${row.date}/${row.kind}`;
		const rows = rowsByIdentity.get(key) ?? [];
		rows.push(row);
		rowsByIdentity.set(key, rows);
	}
	const covered = (date: string, kind: UsageStatisticKind) =>
		input.accountIds.length > 0 &&
		input.accountIds.every(
			(account) =>
				rowsByIdentity.get(`${account}/${date}/${kind}`)?.length === 1,
		);
	const coverageDays = days.map(({ date }) => ({
		date,
		VOD: covered(date, "VOD"),
		LIVE: covered(date, "LIVE"),
	}));
	return {
		coverage: {
			days: coverageDays,
			missingDays: coverageDays.filter((day) => !day.VOD || !day.LIVE).length,
		},
		liveHd: buildLiveHdSeries(
			input,
			days.map(({ date }) => date),
			rowsByIdentity,
		),
		from: input.from,
		to: input.to,
		days,
		totals,
		breakdown: {
			buckets,
			codecResolutionMissingRows,
			codecResolution: [...codecRes.values()].sort(
				(a, b) => b.billableMinutes - a.billableMinutes,
			),
			egress: [...egress.values()].sort((a, b) => b.bytes - a.bytes),
		},
		accounts: input.accounts,
		...usageFreshness(input),
	};
}

function buildLiveHdSeries(
	input: { rows: UsageDayRow[]; accountIds: readonly string[] },
	dates: string[],
	rowsByIdentity: Map<string, UsageDayRow[]>,
): NonNullable<UsageSeries["liveHd"]> {
	const days = dates.map((date) => {
		let units: number | null = input.accountIds.length > 0 ? 0 : null;
		for (const account of input.accountIds) {
			const rows = rowsByIdentity.get(`${account}/${date}/LIVE`) ?? [];
			const value = rows[0]?.breakdown.liveHdUnits;
			if (
				rows.length !== 1 ||
				value === undefined ||
				!Number.isFinite(value) ||
				value < 0
			) {
				units = null;
				break;
			}
			units = (units ?? 0) + value;
		}
		return { date, units };
	});
	const missingDays = days.filter((day) => day.units === null).length;
	return {
		days,
		missingDays,
		totalUnits:
			missingDays > 0
				? null
				: days.reduce((sum, day) => sum + (day.units ?? 0), 0),
	};
}
