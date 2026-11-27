import { usageDateRangeSchema, usageLabelSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	CDN_MAX_DAYS,
	DAY_MS,
	hasStatisticsPagination,
	statisticsViews,
} from "@/lib/encoding-statistics";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";
import {
	ProviderEncodingNotFound,
	readProviderStatistics,
} from "@/lib/server/provider-statistics";

const querySchema = z.strictObject({
	accountId: z.uuid().toLowerCase(),
	view: z.enum(statisticsViews),
	from: z.iso.date().optional(),
	to: z.iso.date().optional(),
	offset: z
		.string()
		.regex(/^\d+$/)
		.transform(Number)
		.pipe(z.int().nonnegative())
		.optional(),
	label: usageLabelSchema.optional(),
	encodingId: z.uuid().toLowerCase().optional(),
});

export async function GET(req: Request) {
	const response = await readStatistics(req);
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

async function readStatistics(req: Request) {
	const params = new URL(req.url).searchParams;
	const values = Object.fromEntries(params);
	if (params.size !== Object.keys(values).length)
		return jsonError(400, "Duplicate query parameter");
	const parsed = querySchema.safeParse(values);
	if (!parsed.success) return validationError(parsed.error);
	const { accountId, offset, view, from, to, label, encodingId } = parsed.data;
	if (
		!!from !== !!to ||
		(view === "cdn" && !from) ||
		(view === "live-options" && !!from) ||
		(view === "live-options") !== !!encodingId ||
		(offset !== undefined && !hasStatisticsPagination(view, !!from)) ||
		(label && view !== "labels" && view !== "daily-labels")
	)
		return jsonError(400, "Invalid statistics filters");
	const range = from && to ? { from, to } : undefined;
	if (range) {
		const dates = usageDateRangeSchema.safeParse(range);
		if (!dates.success) return validationError(dates.error);
		if (
			view === "cdn" &&
			(Date.parse(range.to) - Date.parse(range.from)) / DAY_MS >= CDN_MAX_DAYS
		)
			return jsonError(400, "CDN ranges are limited to 100 calendar days");
	}
	const timeout = AbortSignal.timeout(15_000);
	const signal = AbortSignal.any([req.signal, timeout]);
	try {
		signal.throwIfAborted();
		const ctx = await getServerContext();
		const binding = await ctx.bitmovinAccounts.revealForEncoding(accountId);
		signal.throwIfAborted();
		if (!binding) return jsonError(404, "Bitmovin account not found");
		try {
			return NextResponse.json(
				await readProviderStatistics(
					binding,
					{ view, offset: offset ?? 0, label, range, encodingId },
					signal,
				),
			);
		} catch (err) {
			if (signal.aborted) throw err;
			if (err instanceof ProviderEncodingNotFound)
				return jsonError(404, "Live encoding not found for this account");
			return jsonError(502, "Bitmovin statistics unavailable");
		}
	} catch (err) {
		if (timeout.aborted)
			return jsonError(504, "Bitmovin statistics request timed out");
		if (req.signal.aborted) return jsonError(499, "Request was cancelled");
		return routeError(err);
	}
}
