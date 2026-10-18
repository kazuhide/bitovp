import { usageLabelSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { bitmovinClientForAccount } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";
import {
	LabelCatalogRestartError,
	readLabelCatalogPage,
} from "@/lib/server/statistics-labels";

export async function GET(req: Request) {
	const response = await readCatalog(req);
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

async function readCatalog(req: Request) {
	const params = new URL(req.url).searchParams;
	if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
		return jsonError(400, "Duplicate query parameter");
	const parsed = z
		.strictObject({
			accountId: z.uuid(),
			offset: z.coerce.number().int().min(0).max(999).default(0),
			totalCount: z.coerce.number().int().min(0).max(1000).optional(),
			label: usageLabelSchema.optional(),
			refresh: z.literal("1").optional(),
		})
		.safeParse(Object.fromEntries(params));
	if (!parsed.success) return validationError(parsed.error);
	if (parsed.data.label && parsed.data.offset !== 0)
		return jsonError(400, "Exact label queries require offset zero");
	if (
		parsed.data.refresh &&
		(parsed.data.offset !== 0 ||
			parsed.data.label !== undefined ||
			parsed.data.totalCount !== undefined)
	)
		return jsonError(400, "Catalog refresh requires a new offset-zero query");
	try {
		const ctx = await getServerContext();
		const account = await ctx.bitmovinAccounts.get(parsed.data.accountId);
		if (!account) return jsonError(404, "Account not found");
		const api = await bitmovinClientForAccount(
			ctx,
			parsed.data.accountId,
			AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]),
		);
		if (!api) return jsonError(404, "Account not found");
		try {
			return NextResponse.json(
				await readLabelCatalogPage(api, {
					offset: parsed.data.offset,
					...(parsed.data.label ? { label: parsed.data.label } : {}),
					...(parsed.data.totalCount !== undefined
						? { totalCount: parsed.data.totalCount }
						: {}),
					...(parsed.data.refresh ? { refresh: true } : {}),
					cacheScope: JSON.stringify([
						account.id,
						account.updatedAt.toISOString(),
						account.tenantOrgId,
					]),
				}),
			);
		} catch (err) {
			return jsonError(
				502,
				"Statistics labels unavailable",
				err instanceof LabelCatalogRestartError ? { restart: true } : undefined,
			);
		}
	} catch (err) {
		return routeError(err);
	}
}
