import { NextResponse } from "next/server";
import { z } from "zod";
import { listQuerySchema, sanitizePage } from "@/lib/infrastructure/schemas";
import {
	STANDBY_POOL_ENCODING_STATUSES,
	sanitizeStandbyPoolEncoding,
} from "@/lib/live-runtime/schemas";
import {
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	routeError,
	validationError,
} from "@/lib/server/http";

type RouteParams = { params: Promise<{ poolId: string }> };

const statusFilterSchema = z.object({
	status: z.enum(STANDBY_POOL_ENCODING_STATUSES).optional(),
});

/**
 * GET — the encodings this pool is keeping warm (C6 paging; unlike the POOL
 * list, this sub-list DOES take offset/limit/status). Each READY row's
 * `ingestPoints[].streamKey` is readable connection material — the ledgered
 * display exception, masked in the audit log by redactSecrets.
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { poolId } = await params;
	const invalid = invalidIdResponse(poolId);
	if (invalid) {
		return invalid;
	}
	const url = new URL(req.url);
	const query = listQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
	}
	const filters = statusFilterSchema.safeParse({
		status: url.searchParams.get("status") ?? undefined,
	});
	if (!filters.success) {
		return validationError(filters.error);
	}
	try {
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(
			ctx,
			query.data.bitmovinAccountId,
		);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		try {
			const page = await api.encoding.live.standbyPools.encodings.list(poolId, {
				offset: query.data.offset,
				limit: query.data.limit,
				...filters.data,
			});
			return NextResponse.json(sanitizePage(page, sanitizeStandbyPoolEncoding));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}
