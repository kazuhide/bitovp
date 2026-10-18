import {
	addUtcDays,
	buildUsageSeries,
	USAGE_PERIOD_DAYS,
	type UsageDayRow,
	usageBreakdownSchema,
	usageDateRangeSchema,
	usageLabelSchema,
	utcDayKey,
	utcDayStart,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { bitmovinClientForAccount } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError } from "@/lib/server/http";
import {
	LabelStatisticsError,
	labelStatisticsWireReader,
	readLabelUsage,
} from "@/lib/server/statistics-labels";

/**
 *  — the dashboard's usage series: Bitmovin's daily VOD / live
 * encoding statistics as snapshotted by the worker's usage sweep. Label
 * statistics use bounded provider reads on demand; account-wide charts retain
 * the sweep's stored rows (retention, paging, late aggregation). VIEWER
 * floor like every other dashboard read; account-scoped by `accountId`.
 */
const querySchema = z.object({
	days: z.coerce
		.number()
		.int()
		.refine((d) => (USAGE_PERIOD_DAYS as readonly number[]).includes(d), {
			message: `days must be one of ${USAGE_PERIOD_DAYS.join(", ")}`,
		})
		.default(30),
	accountId: z.string().uuid().optional(),
	label: usageLabelSchema.optional(),
});

export async function GET(req: Request) {
	const url = new URL(req.url);
	if (
		[...url.searchParams.keys()].some(
			(key) => url.searchParams.getAll(key).length !== 1,
		)
	)
		return jsonError(400, "Duplicate query parameter");
	const parsed = querySchema.safeParse({
		days: url.searchParams.get("days") ?? undefined,
		accountId: url.searchParams.get("accountId") ?? undefined,
		label: url.searchParams.get("label") ?? undefined,
	});
	if (!parsed.success) {
		return jsonError(400, "Validation failed", z.flattenError(parsed.error));
	}
	if (parsed.data.label && !parsed.data.accountId)
		return jsonError(400, "A label requires one account");
	const range =
		url.searchParams.has("from") || url.searchParams.has("to")
			? usageDateRangeSchema.safeParse({
					from: url.searchParams.get("from"),
					to: url.searchParams.get("to"),
				})
			: null;
	if (range && !range.success)
		return jsonError(400, "Validation failed", z.flattenError(range.error));
	try {
		const ctx = await getServerContext();
		const to = range?.success ? range.data.to : utcDayKey(new Date());
		const from = range?.success
			? range.data.from
			: addUtcDays(to, -(parsed.data.days - 1));
		if (parsed.data.label && parsed.data.accountId) {
			const accounts = await ctx.prisma.bitmovinAccount.findMany({
				select: { id: true, label: true },
			});
			const account = accounts.find((a) => a.id === parsed.data.accountId);
			if (!account) return jsonError(404, "Account not found");
			const wire = labelStatisticsWireReader();
			const api = await bitmovinClientForAccount(
				ctx,
				account.id,
				AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]),
				wire.observe,
			);
			if (!api) return jsonError(404, "Account not found");
			try {
				return NextResponse.json(
					await readLabelUsage(
						api,
						account,
						parsed.data.label,
						from,
						to,
						wire.take,
					),
					{ headers: { "Cache-Control": "private, no-store" } },
				);
			} catch (err) {
				if (err instanceof LabelStatisticsError) {
					if (err.status === 400)
						return jsonError(
							400,
							"Label statistics support one label and at most 90 days",
						);
					if (err.status === 404)
						return jsonError(
							404,
							"Statistics label not found for this account",
						);
				}
				return jsonError(502, "Label statistics unavailable");
			}
		}
		const accountScope = parsed.data.accountId
			? { bitmovinAccountId: parsed.data.accountId }
			: {};
		const [accounts, rows, cursors] = await Promise.all([
			ctx.prisma.bitmovinAccount.findMany({
				select: { id: true, label: true },
				orderBy: { label: "asc" },
			}),
			ctx.prisma.usageDailyStatistic.findMany({
				where: {
					date: { gte: utcDayStart(from), lte: utcDayStart(to) },
					...accountScope,
				},
				select: {
					bitmovinAccountId: true,
					date: true,
					kind: true,
					bytesEncoded: true,
					timeEncodedS: true,
					bytesEgress: true,
					billableMinutes: true,
					breakdown: true,
				},
			}),
			// Freshness comes from the sweep's cursors, never from row presence
			// (the provider omits quiet days — rev426 R2).
			ctx.prisma.usageSweepCursor.findMany({
				where: accountScope,
				select: {
					bitmovinAccountId: true,
					kind: true,
					sweptThrough: true,
					sweptAt: true,
				},
			}),
		]);
		if (
			parsed.data.accountId &&
			!accounts.some((a) => a.id === parsed.data.accountId)
		) {
			return jsonError(404, "Account not found");
		}
		const dayRows: UsageDayRow[] = [];
		for (const r of rows) {
			const breakdown = usageBreakdownSchema.safeParse(r.breakdown);
			// An unreadable snapshot cannot establish measured zero usage.
			if (!breakdown.success) return jsonError(500, "Stored usage unavailable");
			dayRows.push({
				bitmovinAccountId: r.bitmovinAccountId,
				date: utcDayKey(r.date),
				kind: r.kind,
				bytesEncoded: r.bytesEncoded,
				timeEncodedS: r.timeEncodedS,
				bytesEgress: r.bytesEgress,
				billableMinutes: r.billableMinutes,
				breakdown: breakdown.data,
			});
		}
		return NextResponse.json(
			buildUsageSeries({
				from,
				to,
				rows: dayRows,
				accounts,
				accountIds: parsed.data.accountId
					? [parsed.data.accountId]
					: accounts.map((a) => a.id),
				cursors: cursors.map((c) => ({
					bitmovinAccountId: c.bitmovinAccountId,
					kind: c.kind,
					sweptThrough: utcDayKey(c.sweptThrough),
					sweptAt: c.sweptAt,
				})),
			}),
		);
	} catch (err) {
		return routeError(err);
	}
}
