import {
	addUtcDays,
	type ProviderDailyStatistics,
	summarizeProviderDay,
	USAGE_REREAD_DAYS,
	USAGE_RETENTION_DAYS,
	USAGE_STATISTIC_KINDS,
	type UsageStatisticKind,
	utcDayKey,
	utcDayStart,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { BitmovinApi } from "../bitmovin/sdk-ctor";
import { createRetryingFetch } from "../orchestrator/retrying-fetch";
import { advanceUsageSweepCursor } from "./cursor";
import { mergeLiveOptionsStatistics } from "./live-options-statistics";

/**
 *  — the usage sweep: Bitmovin's daily VOD / live encoding statistics
 * per account, snapshotted into `UsageDailyStatistic`.
 *
 * Why a sweep and not a request-time read: daily aggregates settle late, list endpoints
 * page, and every dashboard render would otherwise cost provider calls and
 * key decrypts. The sweep is idempotent (upsert on account × date × kind),
 * re-reads the trailing `USAGE_REREAD_DAYS` so late aggregation lands, and
 * backfills the routine 90-day window on an empty table. Older aggregate
 * history is imported explicitly by the backfill queue. It reads only —
 * nothing at the provider is created or changed.
 *
 * Where it resumes from is a CURSOR per account × kind (`UsageSweepCursor`),
 * advanced only after a chunk of that kind was stored (rev426 R1). The
 * earlier watermark was the newest stored row per ACCOUNT: a live read that
 * failed after the VOD read had stored today advanced it to today, and the
 * live days in between were never read again. Row presence cannot be the watermark for a second
 * reason: the provider omits days with no activity.
 */

/** Every day-range call is chunked to this many days (the SDK method exposes no paging parameters; a page holds 25 items by default). */
export const USAGE_SWEEP_CHUNK_DAYS = 25;
export const USAGE_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
export const USAGE_SWEEP_FIRST_DELAY_MS = 30_000;

/** A successful aggregate window proves omitted quiet days, never malformed rows. */
export function completeUsageWindow(
	rows: ProviderDailyStatistics[],
	from: string,
	to: string,
): ProviderDailyStatistics[] {
	const byDay = new Map<string, ProviderDailyStatistics>();
	for (const row of rows) {
		const date = row.date instanceof Date ? row.date : new Date(row.date ?? "");
		if (!Number.isFinite(date.getTime()))
			throw new Error("Statistics date missing or invalid");
		const key = utcDayKey(date);
		if (key < from || key > to || byDay.has(key)) {
			throw new Error(
				"Statistics window contains an out-of-range or duplicate date",
			);
		}
		byDay.set(key, row);
	}
	const result: ProviderDailyStatistics[] = [];
	for (let key = from; key <= to; key = addUtcDays(key, 1)) {
		result.push(byDay.get(key) ?? { date: key });
	}
	return result;
}

export type UsageStatisticsProvider = {
	/** Inclusive `yyyy-mm-dd` day keys (the provider's UTC calendar). */
	listDaily(
		kind: UsageStatisticKind,
		fromKey: string,
		toKey: string,
	): Promise<ProviderDailyStatistics[]>;
};

/**
 * The SDK renders a `Date` path parameter with the process's LOCAL calendar
 * (`getFullYear/getMonth/getDate`), so a UTC midnight would read a day early
 * on any host west of UTC (rev426 R3). Build the local-calendar date whose
 * y/m/d IS the key, whatever the host's zone.
 */
export function localCalendarDay(key: string): Date {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function createUsageStatisticsProvider(deps: {
	revealBitmovinAccount(
		accountId: string,
	): Promise<{ apiKey: string; tenantOrgId: string | null }>;
	/** Test seam: the SDK constructor. */
	makeApi?: (args: { apiKey: string; tenantOrgId?: string }) => BitmovinApi;
}): (bitmovinAccountId: string) => Promise<UsageStatisticsProvider> {
	const makeApi =
		deps.makeApi ??
		((args) =>
			new BitmovinApi({
				apiKey: args.apiKey,
				...(args.tenantOrgId ? { tenantOrgId: args.tenantOrgId } : {}),
				fetch: createRetryingFetch(),
			}));
	return async (bitmovinAccountId) => {
		const account = await deps.revealBitmovinAccount(bitmovinAccountId);
		const api = makeApi({
			apiKey: account.apiKey,
			...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
		});
		return {
			async listDaily(kind, fromKey, toKey) {
				const from = localCalendarDay(fromKey);
				const to = localCalendarDay(toKey);
				const page =
					kind === "VOD"
						? await api.encoding.statistics.encodings.vod.daily.listByDateRange(
								from,
								to,
							)
						: await api.encoding.statistics.encodings.live.daily.listByDateRange(
								from,
								to,
							);
				const items = (page.items ?? []) as ProviderDailyStatistics[];
				// The response IS a page. A window with more records than items
				// would be snapshotted incomplete and never re-read (rev426 O1).
				const total = (page as { totalCount?: number }).totalCount ?? 0;
				if (total > items.length) {
					throw new Error(
						`usage statistics ${kind} ${fromKey}..${toKey}: the provider holds ${total} records but answered ${items.length}; window too wide`,
					);
				}
				const daily = completeUsageWindow(items, fromKey, toKey);
				if (kind === "VOD") return daily;
				const options =
					await api.encoding.statistics.encodings.live.options.listByDateRange({
						// Query Dates serialize as UTC ISO timestamps, unlike daily's
						// local-calendar PATH Dates. Keep the two contracts separate.
						from: utcDayStart(fromKey),
						to: utcDayStart(toKey),
						limit: 100,
						offset: 0,
					});
				return mergeLiveOptionsStatistics(daily, options, fromKey, toKey);
			},
		};
	};
}

export type UsageSweepStats = {
	accounts: number;
	rowsUpserted: number;
	skippedNoDate: number;
	errors: string[];
};

export type UsageSweepDeps = {
	prisma: AppPrismaClient;
	providerFor(bitmovinAccountId: string): Promise<UsageStatisticsProvider>;
	/** Internal maintenance only: reread all accounts/kinds through the normal
	 * bounded retention-window GET/upsert path, ignoring the cursor start. */
	rereadRetentionWindow?: boolean;
	now?: () => Date;
	log?: (line: string) => void;
};

/** The first day this sweep must read for one account × kind: the retention edge, or a re-read of the trailing days behind the cursor. */
export function usageSweepFrom(
	today: string,
	sweptThrough: string | null,
): string {
	const retentionEdge = addUtcDays(today, -(USAGE_RETENTION_DAYS - 1));
	if (sweptThrough === null) {
		return retentionEdge;
	}
	const reread = addUtcDays(sweptThrough, -USAGE_REREAD_DAYS);
	return reread > retentionEdge ? reread : retentionEdge;
}

function isRateLimit(err: unknown): boolean {
	return (err as { httpStatusCode?: number }).httpStatusCode === 429;
}

export async function sweepUsageStatistics(
	deps: UsageSweepDeps,
): Promise<UsageSweepStats> {
	const now = deps.now?.() ?? new Date();
	const log = deps.log ?? ((line) => console.log(line));
	const today = utcDayKey(now);
	const stats: UsageSweepStats = {
		accounts: 0,
		rowsUpserted: 0,
		skippedNoDate: 0,
		errors: [],
	};
	const accounts = await deps.prisma.bitmovinAccount.findMany({
		select: { id: true },
	});
	accountLoop: for (const account of accounts) {
		stats.accounts += 1;
		let provider: UsageStatisticsProvider;
		try {
			provider = await deps.providerFor(account.id);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			stats.errors.push(`${account.id}: ${message}`);
			log(`[usage-sweep] account ${account.id}: ${message}`);
			if (isRateLimit(err)) break;
			continue;
		}
		for (const kind of USAGE_STATISTIC_KINDS) {
			try {
				const cursor = await deps.prisma.usageSweepCursor.findUnique({
					where: {
						bitmovinAccountId_kind: { bitmovinAccountId: account.id, kind },
					},
					select: { sweptThrough: true },
				});
				const from = usageSweepFrom(
					today,
					deps.rereadRetentionWindow === true || !cursor
						? null
						: utcDayKey(cursor.sweptThrough),
				);
				for (
					let start = from;
					start <= today;
					start = addUtcDays(start, USAGE_SWEEP_CHUNK_DAYS)
				) {
					const endCandidate = addUtcDays(start, USAGE_SWEEP_CHUNK_DAYS - 1);
					const end = endCandidate < today ? endCandidate : today;
					const raws = await provider.listDaily(kind, start, end);
					const days = raws
						.map((raw) => summarizeProviderDay(kind, raw))
						.filter((d): d is NonNullable<typeof d> => {
							if (!d) stats.skippedNoDate += 1;
							return d !== null;
						})
						// provider order is not a contract (rev426 O2)
						.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
					for (const day of days) {
						await deps.prisma.usageDailyStatistic.upsert({
							where: {
								bitmovinAccountId_date_kind: {
									bitmovinAccountId: account.id,
									date: utcDayStart(day.date),
									kind,
								},
							},
							create: {
								bitmovinAccountId: account.id,
								date: utcDayStart(day.date),
								kind,
								bytesEncoded: day.bytesEncoded,
								timeEncodedS: day.timeEncodedS,
								bytesEgress: day.bytesEgress,
								billableMinutes: day.billableMinutes,
								breakdown: day.breakdown,
								fetchedAt: now,
							},
							update: {
								bytesEncoded: day.bytesEncoded,
								timeEncodedS: day.timeEncodedS,
								bytesEgress: day.bytesEgress,
								billableMinutes: day.billableMinutes,
								breakdown: day.breakdown,
								fetchedAt: now,
							},
						});
						stats.rowsUpserted += 1;
					}
					// Only now — after this chunk is stored — does the cursor move.
					await advanceUsageSweepCursor(
						deps.prisma,
						account.id,
						kind,
						end,
						now,
					);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				stats.errors.push(`${account.id}/${kind}: ${message}`);
				log(`[usage-sweep] account ${account.id} ${kind}: ${message}`);
				// A rate limit is account-independent: stop this tick, the next
				// one resumes from every cursor exactly where it stood.
				if (isRateLimit(err)) break accountLoop;
			}
		}
	}
	return stats;
}
