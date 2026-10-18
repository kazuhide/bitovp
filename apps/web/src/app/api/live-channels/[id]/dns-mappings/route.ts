import { NextResponse } from "next/server";
import { listQuerySchema, sanitizePage } from "@/lib/infrastructure/schemas";
import { sanitizeDnsMapping } from "@/lib/live-runtime/schemas";
import { bitmovinProxyError } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	routeError,
	validationError,
} from "@/lib/server/http";
import { resolveLiveEncoding } from "@/lib/server/live-channel-encoding";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/live-channels/[id]/dns-mappings — read-only list of the DNS ingest
 * mappings attached to THIS channel's encoding (C6 paging). Managing them
 * (create/delete) lives on the account-level surface at /api/live/dns-mappings;
 * the channel detail only shows the operator which hostname currently resolves
 * to their encoder.
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
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
	try {
		const ctx = await getServerContext();
		const resolved = await resolveLiveEncoding({
			ctx,
			channelId: id,
			bitmovinAccountId: query.data.bitmovinAccountId,
			requireRunning: false,
			subject: "DNS mappings",
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		try {
			const page = await resolved.api.encoding.live.encodings.dnsMappings.list(
				resolved.encodingId,
				{ offset: query.data.offset, limit: query.data.limit },
			);
			return NextResponse.json(sanitizePage(page, sanitizeDnsMapping));
		} catch (apiErr) {
			return bitmovinProxyError(apiErr);
		}
	} catch (err) {
		return routeError(err);
	}
}
