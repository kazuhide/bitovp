import { NextResponse } from "next/server";
import { z } from "zod";
import { listQuerySchema, sanitizePage } from "@/lib/infrastructure/schemas";
import {
	STANDBY_POOL_LOG_TYPES,
	sanitizeStandbyPoolLog,
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

const logFilterSchema = z.object({
	eventType: z.enum(STANDBY_POOL_LOG_TYPES).optional(),
	/** Newest-first is what a "logs tail" wants; the SDK sorts by field:dir. */
	sort: z.enum(["createdAt:ASC", "createdAt:DESC"]).default("createdAt:DESC"),
});

/**
 * GET — the pool's event log (C6 paging + INFO/WARN/ERROR filter). This is where
 * Bitmovin explains WHY an instance went to ERROR, so it is the operator's first
 * stop when `errorEncodings > 0`.
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
	const filters = logFilterSchema.safeParse({
		eventType: url.searchParams.get("eventType") ?? undefined,
		sort: url.searchParams.get("sort") ?? undefined,
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
			const page = await api.encoding.live.standbyPools.logs.list(poolId, {
				offset: query.data.offset,
				limit: query.data.limit,
				...filters.data,
			});
			return NextResponse.json(sanitizePage(page, sanitizeStandbyPoolLog));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}
