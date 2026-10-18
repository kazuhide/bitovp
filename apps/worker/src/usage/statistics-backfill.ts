import {
	addUtcDays,
	summarizeProviderDay,
	USAGE_BACKFILL_SETTING_PREFIX,
	USAGE_STATISTIC_KINDS,
	type UsageBackfillProgress,
	usageBackfillJobSchema,
	usageBackfillProgressSchema,
	utcDayStart,
} from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient } from "@bitovp/db";
import { advanceUsageSweepCursor } from "./cursor";
import {
	completeUsageWindow,
	USAGE_SWEEP_CHUNK_DAYS,
	type UsageStatisticsProvider,
} from "./statistics-sweep";

type BackfillJob = {
	data: unknown;
	progress: unknown;
	updateProgress(progress: UsageBackfillProgress): Promise<unknown>;
};

/** Provider reads and idempotent snapshots only. No application-job filter. */
export function createUsageBackfillProcessor(deps: {
	prisma: AppPrismaClient;
	providerFor(accountId: string): Promise<UsageStatisticsProvider>;
}) {
	return async (job: BackfillJob) => {
		const data = usageBackfillJobSchema.parse(job.data);
		const days =
			(utcDayStart(data.to).getTime() - utcDayStart(data.from).getTime()) /
				86_400_000 +
			1;
		const totalChunks = Math.ceil(days / USAGE_SWEEP_CHUNK_DAYS) * 2;
		const previous = usageBackfillProgressSchema.safeParse(job.progress);
		const progress: UsageBackfillProgress = previous.success
			? previous.data
			: {
					completedChunks: 0,
					totalChunks,
					rowsUpserted: 0,
					through: {},
				};
		let expectedChunks = 0;
		let expectedRows = 0;
		for (const through of Object.values(progress.through)) {
			const processedDays =
				(utcDayStart(through).getTime() - utcDayStart(data.from).getTime()) /
					86_400_000 +
				1;
			if (
				processedDays < 1 ||
				through > data.to ||
				(through !== data.to && processedDays % USAGE_SWEEP_CHUNK_DAYS !== 0)
			) {
				throw new Error("Invalid statistics import checkpoint");
			}
			expectedChunks += Math.ceil(processedDays / USAGE_SWEEP_CHUNK_DAYS);
			expectedRows += processedDays;
		}
		if (
			progress.totalChunks !== totalChunks ||
			progress.completedChunks !== expectedChunks ||
			progress.rowsUpserted !== expectedRows
		) {
			throw new Error("Invalid statistics import checkpoint");
		}
		await job.updateProgress(progress);
		const assertOwner = async (tx: AppTransactionClient) => {
			// Wait for the POST transaction to commit its marker before reading it.
			const accounts = await tx.$queryRaw<{ id: string }[]>`
				SELECT id FROM "BitmovinAccount" WHERE id = ${data.accountId}::uuid FOR UPDATE
			`;
			const markers = await tx.$queryRaw<{ value: unknown }[]>`
				SELECT value FROM "AppSetting" WHERE key = ${`${USAGE_BACKFILL_SETTING_PREFIX}${data.accountId}`} FOR UPDATE
			`;
			if (!accounts.length || markers[0]?.value !== data.generation)
				throw new Error("Statistics import canceled by reset");
		};
		try {
			await deps.prisma.$transaction(assertOwner);
			const provider = await deps.providerFor(data.accountId);
			for (const kind of USAGE_STATISTIC_KINDS) {
				const through = progress.through[kind];
				for (
					let start = through ? addUtcDays(through, 1) : data.from;
					start <= data.to;
					start = addUtcDays(start, USAGE_SWEEP_CHUNK_DAYS)
				) {
					const endCandidate = addUtcDays(start, USAGE_SWEEP_CHUNK_DAYS - 1);
					const end = endCandidate < data.to ? endCandidate : data.to;
					const rows = completeUsageWindow(
						await provider.listDaily(kind, start, end),
						start,
						end,
					);
					const fetchedAt = new Date();
					await deps.prisma.$transaction(async (tx) => {
						// Reset removes this row before deleting statistics. Holding its
						// lock through the writes closes the check/delete/write race.
						await assertOwner(tx);
						for (const raw of rows) {
							const day = summarizeProviderDay(kind, raw);
							if (!day) throw new Error("Invalid statistics date");
							const snapshot = {
								bytesEncoded: day.bytesEncoded,
								timeEncodedS: day.timeEncodedS,
								bytesEgress: day.bytesEgress,
								billableMinutes: day.billableMinutes,
								breakdown: day.breakdown,
								fetchedAt,
							};
							const key = {
								bitmovinAccountId: data.accountId,
								date: utcDayStart(day.date),
								kind,
							};
							await tx.usageDailyStatistic.upsert({
								where: { bitmovinAccountId_date_kind: key },
								create: { ...key, ...snapshot },
								update: snapshot,
							});
						}
						if (data.automatic)
							await advanceUsageSweepCursor(
								tx,
								data.accountId,
								kind,
								end,
								fetchedAt,
							);
					});
					progress.through[kind] = end;
					progress.completedChunks += 1;
					progress.rowsUpserted += rows.length;
					await job.updateProgress(progress);
				}
			}
			return progress;
		} catch {
			// Provider errors may contain request credentials. Queue status is public.
			throw new Error("Statistics import failed; retry the request.");
		}
	};
}
