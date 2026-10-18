import { NextResponse } from "next/server";
import { listQuerySchema, sanitizePage } from "@/lib/infrastructure/schemas";
import { sanitizeRtmpInput } from "@/lib/live-runtime/schemas";
import {
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";

/**
 * GET /api/live/rtmp-inputs — the account's RTMP inputs (C6 paging), projected
 * to `{id, name}`.
 *
 * Exists so a plan can PIN a specific RTMP input instead of letting the live
 * executor resolve one by listing the account (which refuses when the account
 * has more than one — STATUS ). No UI here: the live wizard's picker
 * consumes this route in a later PR.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const query = listQuerySchema.safeParse({
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? undefined,
		offset: url.searchParams.get("offset") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!query.success) {
		return validationError(query.error);
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
			const page = await api.encoding.inputs.rtmp.list({
				offset: query.data.offset,
				limit: query.data.limit,
			});
			return NextResponse.json(sanitizePage(page, sanitizeRtmpInput));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}
